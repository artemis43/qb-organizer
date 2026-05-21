# qb-organizer/backend/matching/matcher.py
"""High-accuracy 3-Layer chapter matching engine.

Layer 1: Vector similarity search (ChromaDB + PubMedBERT) — FREE
Layer 2: Chapter name + keyword scoring — FREE
Layer 3: Claude LLM batch classification — high accuracy, batched for efficiency

Design: Layers 1&2 generate candidate chapters per question.
Layer 3 sends questions in batches of 5 to Claude for final classification.
"""

import json
import logging
import re
import uuid
from collections import Counter, defaultdict
from rapidfuzz import fuzz

from config import settings
from core import embedder
from claude.client import get_claude_client
from state import db as database
from state.checkpoint import Checkpoint

logger = logging.getLogger(__name__)


# ── Claude Prompts ────────────────────────────────────────────────

BATCH_CLASSIFY_SYSTEM = """You are a senior medical professor with decades of experience in medical education and textbook authoring.

Your task: Given MULTIPLE exam questions, each with candidate textbook chapters, determine EXACTLY which chapter each question belongs to.

CRITICAL RULES:
1. Read each chapter's name, summary, and topic list CAREFULLY before deciding
2. Match based on the PRIMARY TOPIC of the question, not tangential mentions
3. A question about "Crush Syndrome" belongs to "Complications of Fractures" — not "Treatment of Fractures"
4. A question about "Painful Arc Syndrome" belongs to the shoulder/soft tissue chapter — not arthritis
5. A question about "Pathological Fractures" belongs to the bone tumours/metabolic chapter — not children's fractures
6. If a question genuinely spans 2+ chapters, list them all
7. Be PRECISE — medical education demands accuracy

Respond with ONLY valid JSON — an object with a "classifications" array:
{
  "classifications": [
    {
      "question_index": 0,
      "primary_chapter_id": "chapter_id",
      "primary_chapter_name": "chapter name",
      "confidence": 0.95,
      "reasoning": "1-2 sentence explanation",
      "secondary_chapters": [],
      "is_multi_chapter": false
    }
  ]
}"""


# ── Layer 1: Vector Search ────────────────────────────────────────

async def vector_match(question_text: str, subject: str, n_results: int = 20) -> dict[str, float]:
    """Search ChromaDB for similar chunks, aggregate scores by chapter."""
    results = embedder.search_similar(subject, question_text, n_results=n_results)

    chapter_scores = defaultdict(list)
    for r in results:
        ch_id = r["metadata"].get("chapter_id", "")
        if ch_id:
            chapter_scores[ch_id].append(r["similarity"])

    aggregated = {}
    for ch_id, scores in chapter_scores.items():
        scores.sort(reverse=True)
        if len(scores) == 1:
            aggregated[ch_id] = scores[0]
        else:
            top = scores[0] * 0.5
            avg_rest = sum(scores[1:]) / len(scores[1:]) * 0.3
            freq_bonus = min(len(scores) / n_results, 0.3) * 0.2
            aggregated[ch_id] = min(top + avg_rest + freq_bonus, 1.0)

    return dict(sorted(aggregated.items(), key=lambda x: x[1], reverse=True)[:8])


# ── Layer 2: Chapter Name + Keyword Matching ──────────────────────

STOP_WORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "and", "or", "but",
    "not", "no", "nor", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some", "such",
    "than", "too", "very", "just", "about", "up", "out", "this", "that",
    "these", "those", "it", "its", "what", "which", "who", "whom",
    "describe", "explain", "discuss", "write", "note", "enumerate",
    "mention", "classify", "define", "brief", "short", "detail",
    "essay", "causes", "features", "management", "treatment",
    "diagram", "draw", "label", "clinical", "significance", "importance",
}


def extract_keywords(text: str) -> set[str]:
    """Extract significant keywords from text."""
    words = re.findall(r'[a-zA-Z]{3,}', text.lower())
    return {w for w in words if w not in STOP_WORDS}


async def name_and_keyword_match(question_text: str, candidate_chapter_ids: list[str]) -> dict[str, float]:
    """Score candidates by chapter name match + keyword overlap."""
    q_keywords = extract_keywords(question_text)
    q_lower = question_text.lower()
    if not q_keywords:
        return {}

    scores = {}
    for ch_id in candidate_chapter_ids:
        chapter = await database.fetch_one("chapters", ch_id)
        if not chapter:
            continue

        ch_name = chapter.get("name", "")
        ch_name_lower = ch_name.lower()

        name_ratio = fuzz.partial_ratio(q_lower, ch_name_lower) / 100.0
        name_words = extract_keywords(ch_name)
        name_overlap = len(q_keywords & name_words) / max(len(name_words), 1)

        chapter_keywords = set()
        chapter_keywords.update(name_words)

        for field in ["topics", "key_terms"]:
            raw = chapter.get(field)
            if raw:
                if isinstance(raw, str):
                    try:
                        items = json.loads(raw)
                    except json.JSONDecodeError:
                        items = []
                else:
                    items = raw or []
                for item in items:
                    chapter_keywords.update(extract_keywords(str(item)))

        if not chapter_keywords:
            scores[ch_id] = name_ratio * 0.5
            continue

        intersection = q_keywords & chapter_keywords
        jaccard = len(intersection) / len(q_keywords) if q_keywords else 0

        fuzzy_matches = 0
        for qk in q_keywords:
            for ck in chapter_keywords:
                if fuzz.ratio(qk, ck) > 85:
                    fuzzy_matches += 1
                    break
        fuzzy_score = fuzzy_matches / len(q_keywords) if q_keywords else 0

        keyword_score = jaccard * 0.5 + fuzzy_score * 0.5
        combined = name_ratio * 0.2 + name_overlap * 0.2 + keyword_score * 0.6
        scores[ch_id] = combined

    return scores


# ── Layer 3: Batch Claude Classification ──────────────────────────

async def _build_chapter_context(chapter_id: str) -> str:
    """Build context string for a chapter."""
    ch_data = await database.fetch_one("chapters", chapter_id)
    if not ch_data:
        return ""

    summary = ch_data.get("summary", "No summary")[:300]
    topics_raw = ch_data.get("topics", "[]")
    if isinstance(topics_raw, str):
        try:
            topics_list = json.loads(topics_raw)
        except json.JSONDecodeError:
            topics_list = []
    else:
        topics_list = topics_raw or []

    topics_str = ", ".join(str(t) for t in topics_list[:20])
    return (
        f"  Chapter: {ch_data.get('name', 'Unknown')} (ID: {chapter_id})\n"
        f"  Summary: {summary}\n"
        f"  Topics: {topics_str}\n"
    )


async def claude_classify_batch(
    batch_items: list[dict],
    subject: str,
) -> list[dict]:
    """Send multiple questions to Claude in a single API call.

    Args:
        batch_items: list of dicts with 'question_text', 'question_type', 'candidates'
        subject: textbook subject

    Returns:
        list of classification dicts (one per question)
    """
    # Build the multi-question prompt
    prompt_parts = []
    for i, item in enumerate(batch_items):
        q_section = f"QUESTION {i} ({item['question_type']}):\n{item['question_text']}\n\nCandidate chapters:\n"
        for ch in item["candidates"]:
            ctx = await _build_chapter_context(ch["chapter_id"])
            q_section += f"  --- {ch['chapter_name']} (ID: {ch['chapter_id']}, score: {ch['local_score']:.3f}) ---\n{ctx}\n"
        prompt_parts.append(q_section)

    full_prompt = "\n\n═══════════════════════════════════\n\n".join(prompt_parts)
    full_prompt += f"\n\nClassify ALL {len(batch_items)} questions above. Return the classifications array."

    try:
        client = get_claude_client()
        response = await client.request(
            messages=[{"role": "user", "content": full_prompt}],
            system=BATCH_CLASSIFY_SYSTEM,
            model=settings.haiku_model,
            task_type="match_classify_batch",
            subject=subject,
            request_id=f"batch_classify_{uuid.uuid4().hex[:8]}",
        )

        classifications = response.get("classifications", [])
        if len(classifications) == len(batch_items):
            return classifications
        else:
            logger.warning(f"Batch returned {len(classifications)} results for {len(batch_items)} questions, padding")
            # Pad with None for missing
            while len(classifications) < len(batch_items):
                classifications.append(None)
            return classifications

    except Exception as e:
        logger.error(f"Batch classification failed: {e}")
        # Fall back to individual calls
        results = []
        for item in batch_items:
            try:
                single = await _classify_single(item, subject)
                results.append(single)
            except Exception as e2:
                logger.error(f"Individual fallback failed: {e2}")
                results.append(None)
        return results


async def _classify_single(item: dict, subject: str) -> dict:
    """Fallback: classify a single question."""
    prompt = f"EXAM QUESTION ({item['question_type']}):\n{item['question_text']}\n\nCandidate chapters:\n"
    for ch in item["candidates"]:
        ctx = await _build_chapter_context(ch["chapter_id"])
        prompt += f"--- {ch['chapter_name']} (ID: {ch['chapter_id']}) ---\n{ctx}\n"
    prompt += "\nWhich chapter does this question PRIMARILY belong to?"

    # Use same system prompt but for single question format
    single_system = BATCH_CLASSIFY_SYSTEM.replace(
        "MULTIPLE exam questions, each with candidate textbook chapters",
        "an exam question with candidate textbook chapters"
    ).replace(
        '"classifications" array:\n{\n  "classifications": [\n    {\n      "question_index": 0,',
        "a single object:\n{"
    ).replace(
        '    }\n  ]\n}', "}")

    client = get_claude_client()
    response = await client.request(
        messages=[{"role": "user", "content": prompt}],
        system=single_system,
        model=settings.haiku_model,
        task_type="match_classify",
        subject=subject,
        request_id=f"classify_{uuid.uuid4().hex[:8]}",
    )
    return response


# ── Score Computation ─────────────────────────────────────────────

def compute_final_confidence(local_score: float, llm_confidence: float = None) -> tuple[float, str]:
    """Compute final confidence score and level."""
    if llm_confidence is not None:
        score = local_score * 0.30 + llm_confidence * 0.70
    else:
        score = local_score

    if score >= settings.confidence_high:
        return score, "high"
    elif score >= settings.confidence_low:
        return score, "medium"
    else:
        return score, "low"


# ── Page Reference Finder ─────────────────────────────────────────

async def find_page_references(question_text: str, chapter_id: str, subject: str, textbook_name: str) -> dict:
    """Find the most relevant page numbers for a question within its chapter."""
    results = embedder.search_similar(subject, question_text, n_results=5, filter_chapter_id=chapter_id)
    if not results:
        return {}

    all_pages = []
    for r in results:
        page_str = r["metadata"].get("page_numbers", "[]")
        try:
            pages = json.loads(page_str.replace("'", '"')) if isinstance(page_str, str) else page_str
            all_pages.extend(pages)
        except (json.JSONDecodeError, TypeError):
            pass

    if not all_pages:
        return {}

    all_pages = sorted(set(int(p) for p in all_pages if str(p).isdigit()))
    if not all_pages:
        return {}

    start = all_pages[0] + 1
    end = all_pages[-1] + 1
    page_ref = str(start) if start == end else f"{start}-{end}"
    return {textbook_name: page_ref}


# ── Deduplication ─────────────────────────────────────────────────

def find_duplicate_questions(questions: list[dict], threshold: float = 0.88) -> list[list[str]]:
    """Find groups of duplicate/similar questions using fuzzy matching."""
    n = len(questions)
    visited = set()
    groups = []

    for i in range(n):
        if questions[i]["id"] in visited:
            continue
        group = [questions[i]["id"]]
        visited.add(questions[i]["id"])
        for j in range(i + 1, n):
            if questions[j]["id"] in visited:
                continue
            ratio = fuzz.ratio(questions[i]["question_text"].lower(), questions[j]["question_text"].lower())
            if ratio >= threshold * 100:
                group.append(questions[j]["id"])
                visited.add(questions[j]["id"])
        if len(group) > 1:
            groups.append(group)

    return groups


# ── Main Matching Orchestrator ────────────────────────────────────

BATCH_SIZE = 5  # Questions per Claude API call

async def match_questions_to_chapters(
    subject: str,
    textbook_id: str,
    question_ids: list[str] = None,
    progress_callback=None,
    paper_ids: list[str] = None,
) -> dict:
    """Match questions to chapters using the 3-layer system.

    Sends questions to Claude in batches of 5 for efficiency.
    15 questions = 3 API calls instead of 15.

    Args:
        paper_ids: Optional list of paper IDs to restrict matching to.
    """
    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("match", current, total, msg)
        logger.info(msg)

    # Get questions
    if question_ids:
        questions = []
        for qid in question_ids:
            q = await database.fetch_one("questions", qid)
            if q:
                questions.append(q)
    elif paper_ids:
        # Match only selected papers
        questions = []
        for pid in paper_ids:
            qs = await database.fetch_all(
                "questions",
                "status = ? AND qp_id = ?",
                ("pending", pid),
            )
            questions.extend(qs)
    else:
        questions = await database.fetch_all(
            "questions",
            "status = ? AND qp_id IN (SELECT id FROM question_papers WHERE subject = ?)",
            ("pending", subject),
        )

    if not questions:
        return {"status": "no_questions", "message": "No pending questions to match."}

    # ── Pre-load existing answered questions for answer deduplication ──
    existing_answered = await database.fetch_all(
        "answers", None, None
    )
    answered_map = {}  # mapping_id → answer row
    for ans in existing_answered:
        answered_map[ans["mapping_id"]] = ans

    existing_mappings = await database.fetch_all("mappings", "is_reviewed = 1", None)
    reviewed_questions = {m["question_text"].strip().lower(): m for m in existing_mappings}

    # Get textbook info
    textbook = await database.fetch_one("textbooks", textbook_id)
    textbook_name = textbook["name"] if textbook else subject
    textbook_subject = textbook["subject"] if textbook else subject

    if textbook_subject != subject:
        logger.info(f"Cross-subject matching: QP='{subject}' → Textbook='{textbook_subject}'")

    # Pre-load chapters
    all_chapters = await database.fetch_all("chapters", "textbook_id = ?", (textbook_id,), "chapter_number ASC")
    chapter_lookup = {ch["id"]: ch for ch in all_chapters}
    all_chapter_ids = [ch["id"] for ch in all_chapters]

    await notify(f"Matching {len(questions)} questions to {len(all_chapters)} chapters", 0, len(questions))

    results = {"high": 0, "medium": 0, "low": 0, "total": len(questions), "answer_copied": 0}

    # ── Phase 1: Local scoring for ALL questions ──
    await notify("Phase 1: Local scoring (vector + keyword)...", 0, len(questions))
    prepared = []  # Each item has question info + candidates

    for idx, q in enumerate(questions):
        q_text = q["question_text"]
        q_id = q["id"]
        q_type = q.get("question_type", "OTHER")

        qp = await database.fetch_one("question_papers", q["qp_id"])
        exam_tag = ""
        paper_name = ""
        if qp:
            # Build paper_name (human-readable: university, month, year)
            name_parts = []
            if qp.get("university"):
                name_parts.append(qp["university"])
            if qp.get("month"):
                name_parts.append(qp["month"])
            if qp.get("year"):
                name_parts.append(str(qp["year"]))
            paper_name = ", ".join(p for p in name_parts if p and p != "None")

            # Build exam_tag: try RS-X pattern from QP filename/text (will be
            # populated on future re-extractions). For existing data, fall back to paper_name.
            raw_exam_tag = qp.get("exam_tag", "")
            if raw_exam_tag:
                exam_tag = raw_exam_tag
            else:
                exam_tag = paper_name

        # Layer 1: Vector search
        vector_scores = await vector_match(q_text, textbook_subject)

        # Layer 2: Keyword match (all chapters)
        keyword_scores = await name_and_keyword_match(q_text, all_chapter_ids)

        # Merge candidates
        candidate_ids = set(vector_scores.keys())
        keyword_sorted = sorted(keyword_scores.items(), key=lambda x: x[1], reverse=True)[:5]
        for kid, _ in keyword_sorted:
            candidate_ids.add(kid)

        candidates = []
        for ch_id in candidate_ids:
            v = vector_scores.get(ch_id, 0)
            k = keyword_scores.get(ch_id, 0)
            local = v * 0.55 + k * 0.45
            ch = chapter_lookup.get(ch_id, {})
            candidates.append({
                "chapter_id": ch_id,
                "chapter_name": ch.get("name", "Unknown"),
                "vector_score": round(v, 4),
                "keyword_score": round(k, 4),
                "local_score": round(local, 4),
            })

        candidates.sort(key=lambda x: x["local_score"], reverse=True)

        prepared.append({
            "question": q,
            "q_text": q_text,
            "q_id": q_id,
            "q_type": q_type,
            "exam_tag": exam_tag,
            "candidates": candidates[:5],
            "all_candidates": candidates,
        })

        if (idx + 1) % 5 == 0:
            await notify(f"Phase 1: Scored {idx+1}/{len(questions)} questions", idx + 1, len(questions))

    # ── Phase 2: Batch Claude classification ──
    total_batches = (len(prepared) + BATCH_SIZE - 1) // BATCH_SIZE
    await notify(f"Phase 2: Sending {len(prepared)} questions to Claude in {total_batches} batch(es)...", 0, len(questions))

    for batch_start in range(0, len(prepared), BATCH_SIZE):
        batch = prepared[batch_start:batch_start + BATCH_SIZE]
        batch_num = batch_start // BATCH_SIZE + 1

        await notify(
            f"Phase 2: Claude batch {batch_num}/{total_batches} ({len(batch)} questions)...",
            batch_start, len(questions)
        )

        # Build batch items for Claude
        batch_items = [{
            "question_text": item["q_text"],
            "question_type": item["q_type"],
            "candidates": item["candidates"],
        } for item in batch]

        # Call Claude with batch
        llm_results = await claude_classify_batch(batch_items, textbook_subject)

        # ── Phase 3: Store results ──
        for i, item in enumerate(batch):
            q = item["question"]
            q_id = item["q_id"]
            q_text = item["q_text"]
            q_type = item["q_type"]
            exam_tag = item["exam_tag"]
            top_candidates = item["candidates"]

            llm_result = llm_results[i] if i < len(llm_results) else None

            if llm_result and llm_result.get("primary_chapter_id"):
                llm_chapter_id = llm_result["primary_chapter_id"]
                llm_confidence = llm_result.get("confidence", 0.5)
                reasoning = llm_result.get("reasoning", "")
                is_multi = llm_result.get("is_multi_chapter", False)

                local_score = 0
                for c in item["all_candidates"]:
                    if c["chapter_id"] == llm_chapter_id:
                        local_score = c["local_score"]
                        break

                final_score, final_level = compute_final_confidence(local_score, llm_confidence)

                for c in top_candidates:
                    if c["chapter_id"] == llm_chapter_id:
                        c["llm_confidence"] = llm_confidence
                        c["llm_reasoning"] = reasoning
                        c["combined_score"] = final_score
                    else:
                        c["combined_score"] = c["local_score"]

                final_ch = chapter_lookup.get(llm_chapter_id, {})
                page_refs = await find_page_references(q_text, llm_chapter_id, textbook_subject, textbook_name)

                await database.insert("mappings", {
                    "id": f"map_{q_id}",
                    "question_id": q_id,
                    "question_text": q_text,
                    "question_type": q_type,
                    "qp_id": q["qp_id"],
                    "exam_tag": exam_tag,
                    "paper_name": paper_name,
                    "matched_chapters": top_candidates,
                    "best_match": {
                        "chapter_id": llm_chapter_id,
                        "chapter_name": final_ch.get("name", ""),
                        "textbook_name": textbook_name,
                        "vector_score": next((c["vector_score"] for c in top_candidates if c["chapter_id"] == llm_chapter_id), 0),
                        "keyword_score": next((c["keyword_score"] for c in top_candidates if c["chapter_id"] == llm_chapter_id), 0),
                        "llm_confidence": llm_confidence,
                        "combined_score": final_score,
                        "reasoning": reasoning,
                        "page_references": page_refs,
                    },
                    "confidence": final_score,
                    "confidence_level": final_level,
                    "is_multi_chapter": is_multi,
                    "is_reviewed": final_level == "high",
                    "reviewer_action": "auto_accepted" if final_level == "high" else None,
                    "final_chapter_id": llm_chapter_id,
                    "final_chapter_name": final_ch.get("name", ""),
                    "appears_in_exams": [exam_tag] if exam_tag else [],
                    "frequency": 1,
                })
                results[final_level] += 1

            else:
                # LLM failed — local-only
                if top_candidates:
                    best = top_candidates[0]
                    local_score = best["local_score"]
                else:
                    best = {"chapter_id": "", "chapter_name": "Unknown", "local_score": 0}
                    local_score = 0

                level = "high" if local_score >= settings.confidence_high else "medium" if local_score >= settings.confidence_low else "low"
                best_ch = chapter_lookup.get(best.get("chapter_id", ""), {})

                for c in top_candidates:
                    c["combined_score"] = c["local_score"]

                await database.insert("mappings", {
                    "id": f"map_{q_id}",
                    "question_id": q_id,
                    "question_text": q_text,
                    "question_type": q_type,
                    "qp_id": q["qp_id"],
                    "exam_tag": exam_tag,
                    "paper_name": paper_name,
                    "matched_chapters": top_candidates,
                    "best_match": {
                        "chapter_id": best.get("chapter_id", ""),
                        "chapter_name": best.get("chapter_name", ""),
                        "textbook_name": textbook_name,
                        "combined_score": local_score,
                        "reasoning": "LLM unavailable — local scoring only",
                    },
                    "confidence": local_score,
                    "confidence_level": level,
                    "is_reviewed": level == "high",
                    "reviewer_action": "auto_accepted" if level == "high" else None,
                    "final_chapter_id": best.get("chapter_id", ""),
                    "final_chapter_name": best_ch.get("name", ""),
                    "appears_in_exams": [exam_tag] if exam_tag else [],
                    "frequency": 1,
                })
                results[level] += 1

            await database.update("questions", q_id, {"status": "matched"})

            # ── Answer Deduplication: copy answer from similar reviewed questions ──
            mapping_id = f"map_{q_id}"
            q_normalized = q_text.strip().lower()
            for reviewed_text, reviewed_mapping in reviewed_questions.items():
                similarity = fuzz.ratio(q_normalized, reviewed_text)
                if similarity >= 90:
                    # Found a very similar question - check if it has an answer
                    src_mapping_id = reviewed_mapping["id"]
                    if src_mapping_id in answered_map:
                        src_ans = answered_map[src_mapping_id]
                        # Copy the answer (independent copy, not a link)
                        new_ans_id = f"ans_{uuid.uuid4().hex[:12]}"
                        await database.insert("answers", {
                            "id": new_ans_id,
                            "mapping_id": mapping_id,
                            "question_text": q_text,
                            "chapter_id": src_ans.get("chapter_id", ""),
                            "chapter_name": src_ans.get("chapter_name", ""),
                            "prologue": src_ans.get("prologue", ""),
                            "bullets": src_ans.get("bullets", "[]"),
                            "epilogue": src_ans.get("epilogue", ""),
                            "bullet_count": src_ans.get("bullet_count", 0),
                            "bullet_style": src_ans.get("bullet_style", "detailed"),
                            "preset": src_ans.get("preset", "custom"),
                            "source_chunks": src_ans.get("source_chunks", "[]"),
                            "source_pages": src_ans.get("source_pages", "{}"),
                            "textbook_name": src_ans.get("textbook_name", ""),
                            "model_used": src_ans.get("model_used", ""),
                            "status": "generated",
                        })
                        results["answer_copied"] += 1
                        logger.info(f"Answer copied from mapping {src_mapping_id} to {mapping_id} (similarity: {similarity}%)")
                    break  # Only copy from the best match

            global_idx = batch_start + i
            ch_name = top_candidates[0]["chapter_name"][:40] if top_candidates else "?"
            await notify(
                f"[{global_idx+1}/{len(questions)}] Q{q.get('question_number', global_idx+1)}: → {ch_name}",
                global_idx + 1, len(questions)
            )

    copied = results.get("answer_copied", 0)
    copied_msg = f", {copied} answers copied" if copied > 0 else ""
    await notify(
        f"Matching complete: {results['high']} HIGH, {results['medium']} MEDIUM, {results['low']} LOW ({total_batches} API calls{copied_msg})",
        results["total"], results["total"]
    )

    return results
