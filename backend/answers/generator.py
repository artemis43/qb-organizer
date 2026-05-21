# qb-organizer/backend/answers/generator.py
"""On-demand answer generation using RAG (Retrieval-Augmented Generation).

Flow per question:
1. Retrieve top-5 textbook chunks from the matched chapter via ChromaDB (FREE)
2. Send chunks + question to Claude for structured formatting
3. Claude outputs: { prologue, bullets[], epilogue } — sourced from textbook only
4. Store in DB with source page references

Batches up to 5 questions per Claude call for efficiency.
"""

import json
import logging
import uuid
from datetime import datetime, timezone

from config import settings
from core import embedder
from claude.client import get_claude_client
from state import db as database
from knowledge.graph_builder import get_concepts_for_question, get_related_chunk_ids

logger = logging.getLogger(__name__)

# ── Presets ────────────────────────────────────────────────────────

PRESETS = {
    "LAQ": {"min_bullets": 15, "max_bullets": 20, "style": "detailed",
            "label": "Long Answer Question"},
    "SAQ": {"min_bullets": 8, "max_bullets": 12, "style": "detailed",
            "label": "Short Answer Question"},
    "VSAQ": {"min_bullets": 7, "max_bullets": 8, "style": "precise",
             "label": "Very Short Answer Question"},
}


def resolve_preset(preset: str, custom_count: int = None, custom_style: str = None) -> tuple[int, str]:
    """Resolve preset to (bullet_count, style)."""
    if preset in PRESETS:
        p = PRESETS[preset]
        # Use midpoint of range
        count = (p["min_bullets"] + p["max_bullets"]) // 2
        return count, p["style"]
    # Custom
    return custom_count or 8, custom_style or "detailed"


# ── System Prompt ─────────────────────────────────────────────────

ANSWER_SYSTEM = """You are a senior medical professor writing textbook-quality exam answers for MBBS students.

STRICT RULES:
1. Use ONLY the provided textbook excerpts as your source material. Do NOT add information from outside knowledge.
2. Every bullet point must be substantive and factual, sourced from the provided text.
3. If the textbook excerpts do not contain enough information for the requested number of bullets, simply use as many bullets as the content genuinely supports — do NOT add any disclaimer or note about limited information.

OUTPUT FORMAT — respond with ONLY valid JSON:
{
  "answers": [
    {
      "question_index": 0,
      "prologue": "1-2 introductory sentences that set context for the topic. Should mention the clinical/anatomical relevance.",
      "bullets": ["Point 1...", "Point 2...", "..."],
      "epilogue": "1-2 concluding sentences summarizing clinical significance, recent advances, or exam importance.",
      "source_quality": "good|partial|insufficient"
    }
  ]
}

BULLET STYLE GUIDE:
- "detailed": Each bullet should be 1-3 sentences with explanation, mechanism, or clinical correlation. Use **bold** for key medical terms within bullets where helpful.
- "precise": Each bullet should be exactly 1 concise sentence — fact-dense, no elaboration."""


# ── Context Retrieval ─────────────────────────────────────────────

async def _retrieve_context(question_text: str, chapter_id: str, subject: str, n_chunks: int = 5) -> list[dict]:
    """Retrieve relevant textbook chunks with GraphRAG enhancement.

    Layer 1: Vector similarity search in the matched chapter (existing behaviour)
    Layer 2: Knowledge graph lookup — find concepts in the question, get their
             source chunks from concept_sources (graph-aware retrieval)
    Merges both layers, deduplicates, returns enriched context.
    """
    seen_ids = set()
    results = []

    # ── Layer 1: Vector search (existing) ──
    vector_results = embedder.search_similar(
        subject, question_text, n_results=n_chunks,
        filter_chapter_id=chapter_id,
    )
    if not vector_results:
        # Fallback: search without chapter filter
        vector_results = embedder.search_similar(subject, question_text, n_results=n_chunks)

    for r in vector_results:
        if r["id"] not in seen_ids:
            seen_ids.add(r["id"])
            results.append(r)

    # ── Layer 2: GraphRAG — concept-graph retrieval ──
    try:
        relevant_concepts = await get_concepts_for_question(question_text, subject, limit=6)
        if relevant_concepts:
            concept_ids = [c["id"] for c in relevant_concepts]
            graph_chunk_ids = await get_related_chunk_ids(concept_ids, subject)

            # Fetch chunks from DB that aren't already in results
            for chunk_id in graph_chunk_ids[:12]:  # limit graph chunks
                if chunk_id in seen_ids:
                    continue
                chunk_row = await database.fetch_all(
                    "chunks", "id = ?", (chunk_id,)
                )
                if chunk_row:
                    c = chunk_row[0]
                    # Build in same format as ChromaDB result
                    results.append({
                        "id": c["id"],
                        "text": c["text"],
                        "distance": 0.3,   # Treat graph-sourced as moderately relevant
                        "similarity": 0.7,
                        "metadata": {
                            "chapter_id": c.get("chapter_id", ""),
                            "textbook_id": c.get("textbook_id", ""),
                            "page_numbers": c.get("page_numbers", "[]"),
                            "section_heading": c.get("section_heading", ""),
                            "chunk_index": c.get("chunk_index", 0),
                            "source": "graph",  # Mark as graph-sourced
                        },
                    })
                    seen_ids.add(chunk_id)
    except Exception as e:
        logger.warning(f"GraphRAG retrieval failed (falling back to vector-only): {e}")

    # Sort: vector results first (higher similarity), then graph-sourced
    results.sort(key=lambda r: r.get("similarity", 0), reverse=True)

    # Return top n_chunks + a few graph-sourced for richer context
    max_results = n_chunks + 4
    return results[:max_results]


def _extract_pages(chunks: list[dict], textbook_name: str) -> dict:
    """Extract exact page references from retrieved chunks."""
    all_pages = []
    for c in chunks:
        page_str = c["metadata"].get("page_numbers", "[]")
        try:
            pages = json.loads(page_str.replace("'", '"')) if isinstance(page_str, str) else page_str
            if isinstance(pages, list):
                all_pages.extend(pages)
        except (json.JSONDecodeError, TypeError):
            pass

    if not all_pages:
        return {}

    all_pages = sorted(set(int(p) for p in all_pages if str(p).isdigit()))
    if not all_pages:
        return {}

    # Convert 0-indexed to 1-indexed for display
    display_pages = [p + 1 for p in all_pages]
    # Format as individual pages, not ranges
    if len(display_pages) <= 3:
        page_ref = ", ".join(str(p) for p in display_pages)
    else:
        page_ref = f"{display_pages[0]}, {display_pages[1]}, ...{display_pages[-1]}"
    return {textbook_name: f"p. {page_ref}"}


_STOP_WORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "which", "have",
    "been", "were", "will", "what", "when", "where", "about", "into",
    "than", "them", "they", "their", "other", "each", "also", "more",
    "most", "some", "such", "only", "then", "very", "following", "write",
    "describe", "explain", "discuss", "enumerate", "mention", "define",
    "classify", "differentiate", "compare", "contrast", "note", "short",
    "answer", "question", "briefly", "detail",
})


def _build_keyword_pool(question_text: str, chunks: list[dict]) -> set[str]:
    """Build a relevance keyword pool from question + chunk text.

    Uses question text AND the textbook chunks (which are already known to be
    topically relevant) to create a rich keyword set for matching images.
    """
    all_text = question_text.lower()
    # Add first 300 chars of each chunk — enough for topic keywords
    for c in chunks:
        all_text += " " + c.get("text", "")[:300].lower()

    words = set()
    for w in all_text.split():
        # Strip punctuation
        clean = w.strip(".,;:!?()[]{}\"'-/\\")
        if len(clean) > 3 and clean not in _STOP_WORDS and clean.isalpha():
            words.add(clean)
    return words


async def _find_relevant_images(
    question_text: str,
    chunks: list[dict],
    textbook_id: str,
    textbook_name: str,
) -> list[dict]:
    """Find relevant images from the source pages of retrieved chunks.

    Strict relevance strategy:
    1. Extract images from the same pages as retrieved chunks
    2. Score each image by caption-to-keyword overlap (keywords from
       BOTH question text AND chunk text for better coverage)
    3. Enforce a minimum relevance score — no "filler" images
    4. Default cap: 2 images. Only 3 if all score highly.
    """
    from core.pdf_parser import extract_page_images

    # Collect page indices from chunks
    page_indices = set()
    for c in chunks:
        page_str = c["metadata"].get("page_numbers", "[]")
        try:
            pages = json.loads(page_str.replace("'", '"')) if isinstance(page_str, str) else page_str
            if isinstance(pages, list):
                for p in pages:
                    if str(p).isdigit():
                        page_indices.add(int(p))
        except (json.JSONDecodeError, TypeError):
            pass

    if not page_indices:
        logger.debug("No page indices found in chunks, skipping image extraction")
        return []

    # Get textbook record and build PDF path directly
    textbook = await database.fetch_one("textbooks", textbook_id)
    if not textbook:
        logger.warning(f"Textbook {textbook_id} not found in DB")
        return []

    pdf_path = settings.textbooks_dir / textbook["filename"]
    if not pdf_path.exists():
        logger.warning(f"Textbook PDF not found at {pdf_path}")
        return []

    images_dir = str(settings.data_dir / "images" / textbook_id)
    try:
        all_images = extract_page_images(
            str(pdf_path), sorted(page_indices), images_dir, textbook_id,
        )
    except Exception as e:
        logger.warning(f"Image extraction failed: {e}")
        return []

    if not all_images:
        logger.debug(f"No images found on pages {sorted(page_indices)}")
        return []

    logger.info(f"Found {len(all_images)} candidate images on {len(page_indices)} source pages")

    # Build keyword pool from question + chunk text (much richer than question alone)
    keywords = _build_keyword_pool(question_text, chunks)

    # ── Score each image ──
    MIN_SCORE = 5       # Minimum to be considered relevant
    CAPTION_WEIGHT = 8  # Per-word caption match
    SIZE_BONUS = 2      # Bonus for large diagrams
    MAX_DEFAULT = 2     # Default cap
    MAX_WITH_GOOD_CAPTION = 3  # If all have strong captions

    scored = []
    for img in all_images:
        caption = img.get("caption", "").lower()
        score = 0

        # Score based on caption ↔ keyword overlap
        if caption:
            caption_words = set()
            for w in caption.split():
                clean = w.strip(".,;:!?()[]{}\"'-/\\")
                if len(clean) > 3 and clean not in _STOP_WORDS:
                    caption_words.add(clean)
            overlap = keywords & caption_words
            score = len(overlap) * CAPTION_WEIGHT

        # Bonus for larger images (diagrams, flowcharts — not decorative)
        w, h = img.get("width", 0), img.get("height", 0)
        if w > 300 and h > 200:
            score += SIZE_BONUS
        # Penalty for very tall/narrow or wide/flat images (likely borders/headers)
        if w > 0 and h > 0:
            aspect = max(w, h) / min(w, h)
            if aspect > 5:
                score -= 3  # Likely a decorative bar/border

        scored.append((score, img))

    # Sort by score descending
    scored.sort(key=lambda x: x[0], reverse=True)

    # Filter by minimum score — no filler images
    qualified = [(s, img) for s, img in scored if s >= MIN_SCORE]

    if not qualified:
        # If no images meet the threshold, include at most 1 if it's a large diagram
        if scored and scored[0][0] > 0:
            best_score, best_img = scored[0]
            w, h = best_img.get("width", 0), best_img.get("height", 0)
            if w > 300 and h > 200:
                logger.info(f"No high-relevance images; including 1 large diagram (score={best_score})")
                return [best_img]
        logger.info("No sufficiently relevant images found, skipping all")
        return []

    # Cap: default 2, only 3 if all three have strong caption matches
    if len(qualified) >= 3 and all(s >= MIN_SCORE + CAPTION_WEIGHT for s, _ in qualified[:3]):
        result = [img for _, img in qualified[:MAX_WITH_GOOD_CAPTION]]
    else:
        result = [img for _, img in qualified[:MAX_DEFAULT]]

    logger.info(f"Selected {len(result)} relevant images (scores: {[s for s, _ in qualified[:len(result)]]})")
    return result


# ── Batch Generation ──────────────────────────────────────────────

async def generate_answers(
    mapping_ids: list[str],
    preset: str = "custom",
    custom_bullet_count: int = None,
    custom_style: str = None,
    progress_callback=None,
) -> dict:
    """Generate answers for up to 5 matched questions.

    Args:
        mapping_ids: List of mapping IDs (max 5)
        preset: LAQ, SAQ, VSAQ, or custom
        custom_bullet_count: Number of bullets (for custom preset)
        custom_style: detailed or precise (for custom preset)
        progress_callback: Optional async callback for progress

    Returns:
        dict with generated count, errors, cost
    """
    if len(mapping_ids) > 5:
        return {"error": "Maximum 5 questions per batch"}

    bullet_count, bullet_style = resolve_preset(preset, custom_bullet_count, custom_style)

    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("answer_gen", current, total, msg)
        logger.info(msg)

    await notify(f"Generating answers for {len(mapping_ids)} questions ({preset}, {bullet_count} bullets, {bullet_style})")

    # ── Phase 1: Retrieve context for each question ──
    items = []
    for idx, mid in enumerate(mapping_ids):
        mapping = await database.fetch_one("mappings", mid)
        if not mapping:
            logger.warning(f"Mapping {mid} not found, skipping")
            continue

        q_text = mapping["question_text"]
        chapter_id = mapping.get("final_chapter_id", "")
        chapter_name = mapping.get("final_chapter_name", "")

        # Look up the textbook for this chapter
        chapter = await database.fetch_one("chapters", chapter_id) if chapter_id else None
        textbook_id = chapter["textbook_id"] if chapter else None
        textbook = await database.fetch_one("textbooks", textbook_id) if textbook_id else None
        textbook_name = textbook["name"] if textbook else "Unknown"
        subject = textbook["subject"] if textbook else "Unknown"

        # Check if answer already exists
        existing = await database.fetch_all("answers", "mapping_id = ?", (mid,))
        if existing:
            logger.info(f"Answer already exists for mapping {mid}, will overwrite")
            for ex in existing:
                await database.execute("DELETE FROM answers WHERE id = ?", (ex["id"],))

        # Retrieve textbook context
        chunks = await _retrieve_context(q_text, chapter_id, subject)
        chunk_texts = [c["text"] for c in chunks]
        chunk_ids = [c["id"] for c in chunks]
        source_pages = _extract_pages(chunks, textbook_name)

        # Find relevant images from source pages
        images = []
        if textbook_id:
            try:
                images = await _find_relevant_images(q_text, chunks, textbook_id, textbook_name)
            except Exception as e:
                logger.warning(f"Image search failed for {mid}: {e}")

        context_text = "\n\n---\n\n".join(chunk_texts) if chunk_texts else "No textbook content available."

        items.append({
            "mapping_id": mid,
            "question_text": q_text,
            "chapter_id": chapter_id,
            "chapter_name": chapter_name,
            "textbook_name": textbook_name,
            "subject": subject,
            "context": context_text,
            "chunk_ids": chunk_ids,
            "source_pages": source_pages,
            "images": images,
        })

    if not items:
        return {"error": "No valid mappings found", "generated": 0}

    await notify(f"Phase 1 done: Retrieved context for {len(items)} questions", 1, 3)

    # ── Phase 2: Build prompt and call Claude ──
    prompt_parts = []
    for i, item in enumerate(items):
        prompt_parts.append(
            f"QUESTION {i} ({preset}, {bullet_count} {bullet_style} bullets):\n"
            f"{item['question_text']}\n\n"
            f"TEXTBOOK SOURCE (Chapter: {item['chapter_name']}):\n"
            f"{item['context']}\n"
        )

    full_prompt = "\n\n{'='*60}\n\n".join(prompt_parts)
    full_prompt += (
        f"\n\nGenerate answers for ALL {len(items)} questions above. "
        f"Each answer must have exactly {bullet_count} {bullet_style} bullet points "
        f"(unless source material is insufficient). Return the JSON."
    )

    await notify("Phase 2: Sending to Claude for answer generation...", 2, 3)

    try:
        client = get_claude_client()
        response = await client.request(
            messages=[{"role": "user", "content": full_prompt}],
            system=ANSWER_SYSTEM,
            model=settings.haiku_model,
            max_tokens=8192,
            task_type="answer_generation",
            subject=items[0]["subject"],
            request_id=f"ans_{uuid.uuid4().hex[:8]}",
        )

        answers_list = response.get("answers", [])
    except Exception as e:
        logger.error(f"Answer generation failed: {e}")
        return {"error": str(e), "generated": 0}

    # ── Phase 3: Store results ──
    await notify("Phase 3: Storing generated answers...", 3, 3)
    generated = 0
    errors = 0

    for i, item in enumerate(items):
        ans = answers_list[i] if i < len(answers_list) else None
        if not ans or not ans.get("bullets"):
            logger.warning(f"No answer generated for question {i}")
            errors += 1
            continue

        answer_id = f"ans_{uuid.uuid4().hex[:12]}"
        bullets = ans.get("bullets", [])
        # Ensure we have the right number
        if len(bullets) > bullet_count + 2:
            bullets = bullets[:bullet_count]

        await database.insert("answers", {
            "id": answer_id,
            "mapping_id": item["mapping_id"],
            "question_text": item["question_text"],
            "chapter_id": item["chapter_id"],
            "chapter_name": item["chapter_name"],
            "prologue": ans.get("prologue", ""),
            "bullets": json.dumps(bullets),
            "epilogue": ans.get("epilogue", ""),
            "bullet_count": len(bullets),
            "bullet_style": bullet_style,
            "preset": preset,
            "source_chunks": json.dumps(item["chunk_ids"]),
            "source_pages": json.dumps(item["source_pages"]),
            "images": json.dumps(item.get("images", [])),
            "textbook_name": item["textbook_name"],
            "model_used": settings.haiku_model,
            "status": "generated",
        })
        generated += 1

    result = {
        "generated": generated,
        "errors": errors,
        "total": len(items),
        "preset": preset,
        "bullet_count": bullet_count,
        "bullet_style": bullet_style,
    }

    await notify(f"Done: {generated}/{len(items)} answers generated", 3, 3)
    return result


async def regenerate_answer(
    answer_id: str,
    preset: str = None,
    custom_bullet_count: int = None,
    custom_style: str = None,
) -> dict:
    """Regenerate a single answer with different parameters."""
    answer = await database.fetch_one("answers", answer_id)
    if not answer:
        return {"error": "Answer not found"}

    mapping_id = answer["mapping_id"]
    result = await generate_answers(
        [mapping_id],
        preset=preset or answer.get("preset", "custom"),
        custom_bullet_count=custom_bullet_count,
        custom_style=custom_style,
    )
    return result
