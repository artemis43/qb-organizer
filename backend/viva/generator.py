# qb-organizer/backend/viva/generator.py
"""Viva question & answer generation pipeline.

Uses existing textbook knowledge (chapters, chunks, embeddings) to:
1. Generate examiner-style viva questions from chapter topics
2. Generate point-answer format responses using RAG
3. Auto-tag explainedTerms
4. Classify question importance

Flow:
  Chapters (topics + key_terms) → Claude generates questions
  Questions + ChromaDB chunks → Claude generates direct answers
  Answers + key_terms → auto-tagger extracts explainedTerms
"""

import json
import logging
import uuid
from datetime import datetime, timezone

from config import settings
from core import embedder
from claude.client import get_claude_client
from state import db as database
from viva.auto_tagger import get_subject_key_terms, _build_term_set, extract_explained_terms

logger = logging.getLogger(__name__)

# ── Prompts ───────────────────────────────────────────────────────

QUESTION_GEN_SYSTEM = """You are a senior medical examiner conducting viva voce for Indian MBBS students.

Given a textbook chapter with its topics and summary, generate viva questions that follow
the natural flow of an oral examination.

RULES:
1. Questions should progress from basic → applied (how a real viva flows)
2. Start with definition/classification questions (openers)
3. Follow with mechanism/pathology/clinical feature questions
4. End with management/clinical application questions
5. Each question should be standalone and clear
6. Avoid compound questions (ask ONE thing per question)

For each question, mark:
- importance: "must_know" (asked in 80%+ of vivas), "standard" (common follow-up), "advanced" (deep-dive)
- topic_name: The specific sub-topic this question belongs to
- difficulty: 1 (basic), 2 (intermediate), 3 (advanced)

Respond with ONLY valid JSON:
{
  "questions": [
    {
      "topic_name": "specific sub-topic name",
      "question_text": "the viva question",
      "importance": "must_know|standard|advanced",
      "difficulty": 1
    }
  ]
}"""


ANSWER_GEN_SYSTEM = """You are a senior medical professor helping a student prepare for MBBS viva voce.

STRICT RULES:
1. Answer ONLY the question asked. Be direct and to the point.
2. Do NOT add introductory context or concluding summary.
3. Use ONLY the provided textbook content as source material.
4. Write as if speaking in a viva — concise, structured, factual.
5. Use short sentences. Prefer lists/points for enumerable content.
6. If the question asks "What is X?" — start with the definition directly.
7. If the question asks "Enumerate/List" — give the list directly, no preamble.

OUTPUT FORMAT — respond with ONLY valid JSON:
{
  "answers": [
    {
      "question_index": 0,
      "answer_text": "The direct answer to the question."
    }
  ]
}"""


# ── Question Generation ──────────────────────────────────────────

async def generate_viva_questions(
    subject: str,
    textbook_id: str,
    chapter_ids: list[str] = None,
    questions_per_chapter: int = 8,
    progress_callback=None,
) -> dict:
    """Generate viva questions from textbook chapters.

    Args:
        subject: Subject name (e.g. "Orthopaedics")
        textbook_id: Textbook to source from
        chapter_ids: Specific chapters (or all if None)
        questions_per_chapter: Target questions per chapter
        progress_callback: SSE progress callback
    """
    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("viva_gen", current, total, msg)
        logger.info(msg)

    # Load chapters
    if chapter_ids:
        chapters = []
        for cid in chapter_ids:
            ch = await database.fetch_one("chapters", cid)
            if ch:
                chapters.append(ch)
    else:
        chapters = await database.fetch_all(
            "chapters", "textbook_id = ?", (textbook_id,), "chapter_number ASC"
        )

    if not chapters:
        return {"error": "No chapters found", "generated": 0}

    textbook = await database.fetch_one("textbooks", textbook_id)
    textbook_name = textbook["name"] if textbook else subject

    await notify(f"Generating viva questions for {len(chapters)} chapters", 0, len(chapters))

    total_generated = 0
    all_question_ids = []

    for idx, ch in enumerate(chapters):
        ch_name = ch.get("name", "Unknown")

        # Parse chapter metadata
        summary = ch.get("summary", "")
        topics_raw = ch.get("topics", "[]")
        key_terms_raw = ch.get("key_terms", "[]")

        if isinstance(topics_raw, str):
            try:
                topics = json.loads(topics_raw)
            except json.JSONDecodeError:
                topics = []
        else:
            topics = topics_raw or []

        if isinstance(key_terms_raw, str):
            try:
                key_terms = json.loads(key_terms_raw)
            except json.JSONDecodeError:
                key_terms = []
        else:
            key_terms = key_terms_raw or []

        if not summary and not topics:
            await notify(f"Skipping {ch_name} — no KB data", idx + 1, len(chapters))
            continue

        # Build prompt
        prompt = (
            f"TEXTBOOK: {textbook_name}\n"
            f"CHAPTER: {ch_name}\n\n"
            f"SUMMARY:\n{summary}\n\n"
            f"TOPICS COVERED:\n{', '.join(str(t) for t in topics)}\n\n"
            f"KEY TERMS:\n{', '.join(str(t) for t in key_terms)}\n\n"
            f"Generate {questions_per_chapter} viva questions covering the important topics "
            f"in this chapter. Ensure a mix of must_know, standard, and advanced questions."
        )

        try:
            client = get_claude_client()
            response = await client.request(
                messages=[{"role": "user", "content": prompt}],
                system=QUESTION_GEN_SYSTEM,
                model=settings.haiku_model,
                task_type="viva_question_gen",
                subject=subject,
                request_id=f"viva_qgen_{uuid.uuid4().hex[:8]}",
            )

            questions = response.get("questions", [])

            # Store each question
            for q in questions:
                q_id = f"vq_{uuid.uuid4().hex[:10]}"
                await database.insert("viva_questions", {
                    "id": q_id,
                    "subject": subject,
                    "chapter_name": ch_name,
                    "topic_name": q.get("topic_name", ch_name),
                    "question_text": q.get("question_text", ""),
                    "answer_text": "",  # filled in answer generation phase
                    "importance": q.get("importance", "standard"),
                    "source_chapter_id": ch["id"],
                    "difficulty": q.get("difficulty", 1),
                    "status": "generated",
                })
                all_question_ids.append(q_id)
                total_generated += 1

        except Exception as e:
            logger.error(f"Question generation failed for {ch_name}: {e}")
            await notify(f"Error on {ch_name}: {e}", idx + 1, len(chapters))
            continue

        await notify(
            f"Ch {idx + 1}/{len(chapters)}: {ch_name} → {len(questions)} questions",
            idx + 1, len(chapters)
        )

    await notify(f"Question generation complete: {total_generated} questions", len(chapters), len(chapters))

    return {
        "generated": total_generated,
        "chapters_processed": len(chapters),
        "question_ids": all_question_ids,
    }


# ── Answer Generation ─────────────────────────────────────────────

ANSWER_BATCH_SIZE = 10  # Questions per Claude call (higher = fewer API calls = lower cost)

async def generate_viva_answers(
    question_ids: list[str],
    subject: str,
    progress_callback=None,
) -> dict:
    """Generate answers for viva questions using RAG.

    Retrieves relevant textbook chunks via ChromaDB, then sends
    to Claude for direct, point-answer formatting.
    """
    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("viva_ans", current, total, msg)
        logger.info(msg)

    # Load questions
    questions = []
    for qid in question_ids:
        q = await database.fetch_one("viva_questions", qid)
        if q and not q.get("answer_text"):  # skip already answered
            questions.append(q)

    if not questions:
        return {"answered": 0, "message": "No unanswered questions found"}

    await notify(f"Generating answers for {len(questions)} questions", 0, len(questions))

    # Pre-load key terms for auto-tagging
    chapter_terms = await get_subject_key_terms(subject)
    all_terms = _build_term_set(chapter_terms)

    answered = 0
    total_batches = (len(questions) + ANSWER_BATCH_SIZE - 1) // ANSWER_BATCH_SIZE

    for batch_start in range(0, len(questions), ANSWER_BATCH_SIZE):
        batch = questions[batch_start:batch_start + ANSWER_BATCH_SIZE]
        batch_num = batch_start // ANSWER_BATCH_SIZE + 1

        await notify(
            f"Batch {batch_num}/{total_batches}: Retrieving context...",
            batch_start, len(questions)
        )

        # Phase 1: Retrieve context for each question in the batch
        prompt_parts = []
        batch_contexts = []

        for i, q in enumerate(batch):
            chapter_id = q.get("source_chapter_id", "")

            # Retrieve relevant chunks
            # Use fewer chunks for viva (3 vs 5 for QB) — viva answers are concise
            chunks = []
            if chapter_id:
                results = embedder.search_similar(
                    subject, q["question_text"],
                    n_results=3, filter_chapter_id=chapter_id
                )
                chunks = results
            if not chunks:
                results = embedder.search_similar(subject, q["question_text"], n_results=3)
                chunks = results

            # Truncate chunks to reduce input tokens (viva answers don't need full context)
            chunk_texts = [c["text"][:600] for c in chunks]
            context = "\n---\n".join(chunk_texts) if chunk_texts else "No content available."

            # Extract source pages
            source_pages = _extract_source_pages(chunks, q.get("chapter_name", ""))

            batch_contexts.append({
                "chunks": chunks,
                "source_pages": source_pages,
                "chunk_ids": [c["id"] for c in chunks],
            })

            prompt_parts.append(
                f"QUESTION {i}:\n{q['question_text']}\n\n"
                f"TEXTBOOK SOURCE (Chapter: {q.get('chapter_name', 'Unknown')}):\n"
                f"{context}\n"
            )

        # Phase 2: Send to Claude
        full_prompt = "\n\n{'='*50}\n\n".join(prompt_parts)
        full_prompt += f"\n\nAnswer ALL {len(batch)} questions above. Be direct and to the point."

        try:
            client = get_claude_client()
            response = await client.request(
                messages=[{"role": "user", "content": full_prompt}],
                system=ANSWER_GEN_SYSTEM,
                model=settings.haiku_model,
                max_tokens=4096,  # Viva answers are concise, no need for 8K
                task_type="viva_answer_gen",
                subject=subject,
                request_id=f"viva_ans_{uuid.uuid4().hex[:8]}",
            )

            answers_list = response.get("answers", [])
        except Exception as e:
            logger.error(f"Answer generation failed: {e}")
            await notify(f"Error: {e}", batch_start, len(questions))
            continue

        # Phase 3: Store answers and auto-tag
        for i, q in enumerate(batch):
            ans = answers_list[i] if i < len(answers_list) else None
            if not ans or not ans.get("answer_text"):
                continue

            answer_text = ans["answer_text"]
            ctx = batch_contexts[i]

            # Auto-tag explained terms
            combined = f"{q['question_text']} {answer_text}"
            terms = extract_explained_terms(combined, all_terms)

            await database.update("viva_questions", q["id"], {
                "answer_text": answer_text,
                "explained_terms": terms,
                "source_pages": ctx["source_pages"],
                "source_chunks": ctx["chunk_ids"],
                "status": "generated",
            })
            answered += 1

        await notify(
            f"Batch {batch_num}/{total_batches}: {len([a for a in answers_list if a and a.get('answer_text')])} answers generated",
            min(batch_start + ANSWER_BATCH_SIZE, len(questions)), len(questions)
        )

    await notify(f"Answer generation complete: {answered}/{len(questions)}", len(questions), len(questions))

    return {
        "answered": answered,
        "total": len(questions),
        "api_calls": total_batches,
    }


def _extract_source_pages(chunks: list[dict], textbook_name: str) -> dict:
    """Extract page references from retrieved chunks."""
    all_pages = []
    for c in chunks:
        page_str = c.get("metadata", {}).get("page_numbers", "[]")
        try:
            pages = json.loads(page_str.replace("'", '"')) if isinstance(page_str, str) else page_str
            if isinstance(pages, list):
                all_pages.extend(pages)
        except (json.JSONDecodeError, TypeError):
            pass

    if not all_pages:
        return {}

    all_pages = sorted(set(int(p) + 1 for p in all_pages if str(p).isdigit()))
    if not all_pages:
        return {}

    if len(all_pages) <= 3:
        page_ref = ", ".join(str(p) for p in all_pages)
    else:
        page_ref = f"{all_pages[0]}-{all_pages[-1]}"

    return {textbook_name: f"p. {page_ref}"}


# ── Full Pipeline ─────────────────────────────────────────────────

async def run_viva_pipeline(
    subject: str,
    textbook_id: str,
    chapter_ids: list[str] = None,
    questions_per_chapter: int = 8,
    progress_callback=None,
) -> dict:
    """Run the full viva pipeline: generate questions → answers → auto-tag.

    This is the main entry point called from the API.
    """
    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("viva_pipeline", current, total, msg)
        logger.info(msg)

    await notify("Starting viva pipeline...", 0, 3)

    # Step 1: Generate questions
    await notify("Step 1/3: Generating viva questions...", 0, 3)
    gen_result = await generate_viva_questions(
        subject=subject,
        textbook_id=textbook_id,
        chapter_ids=chapter_ids,
        questions_per_chapter=questions_per_chapter,
        progress_callback=progress_callback,
    )

    if gen_result.get("error"):
        return gen_result

    question_ids = gen_result.get("question_ids", [])
    if not question_ids:
        return {"error": "No questions generated", "generated": 0}

    # Step 2: Generate answers
    await notify(f"Step 2/3: Generating answers for {len(question_ids)} questions...", 1, 3)
    ans_result = await generate_viva_answers(
        question_ids=question_ids,
        subject=subject,
        progress_callback=progress_callback,
    )

    # Step 3: Summary
    await notify("Step 3/3: Pipeline complete!", 3, 3)

    return {
        "questions_generated": gen_result.get("generated", 0),
        "answers_generated": ans_result.get("answered", 0),
        "chapters_processed": gen_result.get("chapters_processed", 0),
        "api_calls": ans_result.get("api_calls", 0),
    }
