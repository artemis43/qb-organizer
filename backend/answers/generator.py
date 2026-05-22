# qb-organizer/backend/answers/generator.py
"""On-demand answer generation with GraphRAG Hybrid Fusion.

Supports three retrieval modes:
  - auto:       Merged vector+graph chunks in a single Claude call (original behavior)
  - graph_only: Pure knowledge-graph-guided retrieval, zero vector search
  - hybrid:     Two independent Claude calls (vector-only + graph-only),
                then a fusion pass that merges, deduplicates, and ranks

Flow per question:
1. Retrieve textbook chunks via the selected retrieval path(s)
2. Send chunks + question to Claude for structured answer generation
3. (hybrid only) Run fusion pass to merge two candidate answers
4. Store in DB with source page references and retrieval metadata
"""

import json
import logging
import uuid
from datetime import datetime, timezone

from config import settings
from core import embedder
from claude.client import get_claude_client
from state import db as database
from knowledge.graph_builder import (
    get_concepts_for_question,
    get_related_chunk_ids,
    get_extended_concepts_for_question,
)

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


# ── System Prompts ────────────────────────────────────────────────

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


ANSWER_SYSTEM_WITH_GRAPH = """You are a senior medical professor writing textbook-quality exam answers for MBBS students.

You are given textbook excerpts AND a KNOWLEDGE GRAPH CONTEXT showing structured relationships between medical concepts (e.g., "Disease --[presents_with]--> Symptom"). Use both to write a comprehensive, structurally-aware answer.

STRICT RULES:
1. Use the provided textbook excerpts as your PRIMARY source material.
2. Use the knowledge graph context to ensure your answer covers key relationships (causes, symptoms, treatments, investigations) systematically — do not miss important connections shown in the graph.
3. Every bullet point must be substantive and factual.
4. If the textbook excerpts do not contain enough information for the requested number of bullets, simply use as many bullets as the content genuinely supports — do NOT add any disclaimer.

OUTPUT FORMAT — respond with ONLY valid JSON:
{
  "answers": [
    {
      "question_index": 0,
      "prologue": "1-2 introductory sentences that set context for the topic.",
      "bullets": ["Point 1...", "Point 2...", "..."],
      "epilogue": "1-2 concluding sentences summarizing clinical significance.",
      "source_quality": "good|partial|insufficient"
    }
  ]
}

BULLET STYLE GUIDE:
- "detailed": Each bullet should be 1-3 sentences with explanation, mechanism, or clinical correlation. Use **bold** for key medical terms.
- "precise": Each bullet should be exactly 1 concise sentence — fact-dense, no elaboration."""


FUSION_SYSTEM = """You are a senior medical professor. You have received TWO candidate answers for the same exam question:

- ANSWER A: Generated from vector-similarity textbook retrieval (keyword-matched chunks).
- ANSWER B: Generated from knowledge-graph-guided retrieval (concept-relation-aware chunks).

Your task is to MERGE them into ONE superior, definitive answer.

FUSION RULES:
1. Remove duplicate or near-duplicate bullet points — keep the more specific/detailed version.
2. Remove vague, generic, or unsupported bullets (e.g., "This is clinically important" with no substance).
3. Preserve clinically accurate, fact-dense bullets from BOTH sources.
4. Order bullets logically: definition/etiology first, then pathophysiology, clinical features, investigations, management, complications.
5. The merged prologue should be the better of the two (more informative).
6. The merged epilogue should be the better of the two (more clinically relevant).
7. For each bullet in the merged answer, indicate its provenance: "V" if it came primarily from Answer A (vector), "G" if from Answer B (graph), "F" if you fused information from both.

OUTPUT FORMAT — respond with ONLY valid JSON:
{
  "prologue": "...",
  "bullets": ["Point 1...", "Point 2...", "..."],
  "bullet_provenance": ["V", "G", "F", "V", "G", ...],
  "epilogue": "...",
  "fusion_notes": "Brief explanation of what was merged, removed, or improved."
}"""


# ── Context Retrieval Functions ───────────────────────────────────

async def _retrieve_vector_context(
    question_text: str, chapter_id: str, subject: str, n_chunks: int = 5
) -> tuple[list[dict], dict]:
    """Layer 1: Pure vector similarity search (ChromaDB).

    Returns: (chunks, metadata)
    """
    results = embedder.search_similar(
        subject, question_text, n_results=n_chunks,
        filter_chapter_id=chapter_id,
    )
    if not results:
        results = embedder.search_similar(subject, question_text, n_results=n_chunks)

    metadata = {
        "source": "vector",
        "chunks_retrieved": len(results),
    }
    return results, metadata


async def _retrieve_graph_context(
    question_text: str, subject: str, n_chunks: int = 8
) -> tuple[list[dict], dict]:
    """Layer 2: Pure knowledge-graph-guided retrieval.

    Finds concepts matching the question, traverses 1-hop neighbors,
    retrieves associated chunks from concept_sources.

    Returns: (chunks, metadata_with_graph_context)
    """
    results = []
    metadata = {
        "source": "graph",
        "chunks_retrieved": 0,
        "concepts_matched": [],
        "relation_context": [],
        "direct_concepts": 0,
        "neighbor_concepts": 0,
    }

    try:
        extended = await get_extended_concepts_for_question(question_text, subject, limit=10)

        metadata["concepts_matched"] = extended["concept_names"]
        metadata["relation_context"] = extended["relation_context"]
        metadata["direct_concepts"] = extended["direct_count"]
        metadata["neighbor_concepts"] = extended["neighbor_count"]

        if extended["concept_ids"]:
            graph_chunk_ids = await get_related_chunk_ids(extended["concept_ids"], subject)

            seen_ids = set()
            for chunk_id in graph_chunk_ids[:n_chunks + 6]:
                if chunk_id in seen_ids:
                    continue
                chunk_rows = await database.fetch_all("chunks", "id = ?", (chunk_id,))
                if chunk_rows:
                    c = chunk_rows[0]
                    results.append({
                        "id": c["id"],
                        "text": c["text"],
                        "distance": 0.3,
                        "similarity": 0.7,
                        "metadata": {
                            "chapter_id": c.get("chapter_id", ""),
                            "textbook_id": c.get("textbook_id", ""),
                            "page_numbers": c.get("page_numbers", "[]"),
                            "section_heading": c.get("section_heading", ""),
                            "chunk_index": c.get("chunk_index", 0),
                            "source": "graph",
                        },
                    })
                    seen_ids.add(chunk_id)

        metadata["chunks_retrieved"] = len(results)

    except Exception as e:
        logger.warning(f"GraphRAG retrieval failed: {e}")

    return results, metadata


async def _retrieve_context(question_text: str, chapter_id: str, subject: str, n_chunks: int = 5) -> list[dict]:
    """Retrieve relevant textbook chunks with GraphRAG enhancement (auto mode).

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


# ── Helpers ───────────────────────────────────────────────────────

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


def _compute_confidence(
    vector_chunks: int, graph_chunks: int, overlap_count: int,
    concepts_matched: int, relations_count: int
) -> int:
    """Compute an answer confidence score (0-100) based on retrieval quality."""
    score = 0

    # Base: did we find ANY chunks?
    if vector_chunks > 0:
        score += 20
    if graph_chunks > 0:
        score += 20

    # Overlap bonus: if vector and graph found the same chunks, high confidence
    if overlap_count > 0:
        score += min(overlap_count * 8, 24)

    # Concepts matched
    if concepts_matched > 0:
        score += min(concepts_matched * 5, 20)

    # Relations used (structural grounding)
    if relations_count > 0:
        score += min(relations_count * 3, 16)

    return min(score, 100)


# ── Claude Call Helper ────────────────────────────────────────────

async def _call_claude_for_answer(
    items: list[dict],
    preset: str,
    bullet_count: int,
    bullet_style: str,
    system_prompt: str,
    subject: str,
    extra_context: str = "",
) -> list[dict]:
    """Build prompt from items and call Claude. Returns parsed answers list."""
    prompt_parts = []
    for i, item in enumerate(items):
        part = (
            f"QUESTION {i} ({preset}, {bullet_count} {bullet_style} bullets):\n"
            f"{item['question_text']}\n\n"
            f"TEXTBOOK SOURCE (Chapter: {item['chapter_name']}):\n"
            f"{item['context']}\n"
        )
        if extra_context and item.get("graph_context"):
            part += f"\nKNOWLEDGE GRAPH CONTEXT:\n{item['graph_context']}\n"
        prompt_parts.append(part)

    full_prompt = "\n\n{'='*60}\n\n".join(prompt_parts)
    full_prompt += (
        f"\n\nGenerate answers for ALL {len(items)} questions above. "
        f"Each answer must have exactly {bullet_count} {bullet_style} bullet points "
        f"(unless source material is insufficient). Return the JSON."
    )

    client = get_claude_client()
    response = await client.request(
        messages=[{"role": "user", "content": full_prompt}],
        system=system_prompt,
        model=settings.haiku_model,
        max_tokens=8192,
        task_type="answer_generation",
        subject=subject,
        request_id=f"ans_{uuid.uuid4().hex[:8]}",
    )

    return response.get("answers", [])


async def _fuse_answers(
    question_text: str,
    answer_a: dict,
    answer_b: dict,
    bullet_count: int,
    subject: str,
) -> dict:
    """Fusion pass: merge two candidate answers into one superior answer."""

    bullets_a = answer_a.get("bullets", [])
    bullets_b = answer_b.get("bullets", [])

    prompt = (
        f"QUESTION:\n{question_text}\n\n"
        f"ANSWER A (Vector-similarity RAG, {len(bullets_a)} bullets):\n"
        f"Prologue: {answer_a.get('prologue', '')}\n"
        f"Bullets:\n" + "\n".join(f"  {i+1}. {b}" for i, b in enumerate(bullets_a)) + "\n"
        f"Epilogue: {answer_a.get('epilogue', '')}\n\n"
        f"ANSWER B (Knowledge-Graph RAG, {len(bullets_b)} bullets):\n"
        f"Prologue: {answer_b.get('prologue', '')}\n"
        f"Bullets:\n" + "\n".join(f"  {i+1}. {b}" for i, b in enumerate(bullets_b)) + "\n"
        f"Epilogue: {answer_b.get('epilogue', '')}\n\n"
        f"Merge into ONE superior answer with approximately {bullet_count} bullets. "
        f"Follow the fusion rules. Return the JSON."
    )

    client = get_claude_client()
    response = await client.request(
        messages=[{"role": "user", "content": prompt}],
        system=FUSION_SYSTEM,
        model=settings.haiku_model,
        max_tokens=6144,
        task_type="answer_fusion",
        subject=subject,
        request_id=f"fuse_{uuid.uuid4().hex[:8]}",
    )

    return response


# ── Batch Generation (Main Entry Point) ───────────────────────────

async def generate_answers(
    mapping_ids: list[str],
    preset: str = "custom",
    custom_bullet_count: int = None,
    custom_style: str = None,
    mode: str = "auto",
    progress_callback=None,
) -> dict:
    """Generate answers for up to 5 matched questions.

    Args:
        mapping_ids: List of mapping IDs (max 5)
        preset: LAQ, SAQ, VSAQ, or custom
        custom_bullet_count: Number of bullets (for custom preset)
        custom_style: detailed or precise (for custom preset)
        mode: "auto" | "graph_only" | "hybrid"
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

    mode_label = {"auto": "Auto (merged)", "graph_only": "GraphRAG Only", "hybrid": "Hybrid Fusion"}
    await notify(f"Generating answers for {len(mapping_ids)} questions ({preset}, {bullet_count} bullets, {bullet_style}, mode={mode_label.get(mode, mode)})")

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

        # ── Retrieve context based on mode ──
        retrieval_meta = {
            "mode": mode,
            "vector_chunks_used": 0,
            "graph_chunks_used": 0,
            "overlap_count": 0,
            "concepts_matched": [],
            "relation_context": [],
            "fusion_applied": False,
            "bullet_provenance": [],
            "fusion_notes": "",
        }

        if mode == "auto":
            # Existing merged behavior
            chunks = await _retrieve_context(q_text, chapter_id, subject)
            chunk_texts = [c["text"] for c in chunks]
            chunk_ids = [c["id"] for c in chunks]
            vector_count = sum(1 for c in chunks if c.get("metadata", {}).get("source") != "graph")
            graph_count = sum(1 for c in chunks if c.get("metadata", {}).get("source") == "graph")
            retrieval_meta["vector_chunks_used"] = vector_count
            retrieval_meta["graph_chunks_used"] = graph_count

            # Get graph context for metadata
            try:
                extended = await get_extended_concepts_for_question(q_text, subject, limit=6)
                retrieval_meta["concepts_matched"] = extended.get("concept_names", [])[:10]
                retrieval_meta["relation_context"] = extended.get("relation_context", [])[:10]
            except Exception:
                pass

            source_pages = _extract_pages(chunks, textbook_name)

        elif mode == "graph_only":
            # Pure GraphRAG: zero vector search
            graph_chunks, graph_meta = await _retrieve_graph_context(q_text, subject, n_chunks=10)
            chunks = graph_chunks
            chunk_texts = [c["text"] for c in chunks]
            chunk_ids = [c["id"] for c in chunks]
            retrieval_meta["graph_chunks_used"] = graph_meta["chunks_retrieved"]
            retrieval_meta["concepts_matched"] = graph_meta.get("concepts_matched", [])[:10]
            retrieval_meta["relation_context"] = graph_meta.get("relation_context", [])[:10]
            retrieval_meta["direct_concepts"] = graph_meta.get("direct_concepts", 0)
            retrieval_meta["neighbor_concepts"] = graph_meta.get("neighbor_concepts", 0)
            source_pages = _extract_pages(chunks, textbook_name)

        elif mode == "hybrid":
            # Dual-path: retrieve both independently
            vector_chunks, vector_meta = await _retrieve_vector_context(q_text, chapter_id, subject, n_chunks=5)
            graph_chunks, graph_meta = await _retrieve_graph_context(q_text, subject, n_chunks=8)

            # Count overlap
            vector_ids = {c["id"] for c in vector_chunks}
            graph_ids = {c["id"] for c in graph_chunks}
            overlap = vector_ids & graph_ids

            chunks = vector_chunks + [c for c in graph_chunks if c["id"] not in vector_ids]
            chunk_texts = [c["text"] for c in chunks]
            chunk_ids = [c["id"] for c in chunks]

            retrieval_meta["vector_chunks_used"] = vector_meta["chunks_retrieved"]
            retrieval_meta["graph_chunks_used"] = graph_meta["chunks_retrieved"]
            retrieval_meta["overlap_count"] = len(overlap)
            retrieval_meta["concepts_matched"] = graph_meta.get("concepts_matched", [])[:10]
            retrieval_meta["relation_context"] = graph_meta.get("relation_context", [])[:10]
            retrieval_meta["fusion_applied"] = True
            source_pages = _extract_pages(chunks, textbook_name)
        else:
            # Fallback to auto
            chunks = await _retrieve_context(q_text, chapter_id, subject)
            chunk_texts = [c["text"] for c in chunks]
            chunk_ids = [c["id"] for c in chunks]
            source_pages = _extract_pages(chunks, textbook_name)

        # Find relevant images
        images = []
        if textbook_id:
            try:
                images = await _find_relevant_images(q_text, chunks, textbook_id, textbook_name)
            except Exception as e:
                logger.warning(f"Image search failed for {mid}: {e}")

        context_text = "\n\n---\n\n".join(chunk_texts) if chunk_texts else "No textbook content available."

        # Build graph context string for prompt injection
        graph_context_str = ""
        if retrieval_meta["relation_context"]:
            graph_context_str = "\n".join(f"- {rc}" for rc in retrieval_meta["relation_context"][:15])

        # Confidence score
        confidence = _compute_confidence(
            retrieval_meta["vector_chunks_used"],
            retrieval_meta["graph_chunks_used"],
            retrieval_meta.get("overlap_count", 0),
            len(retrieval_meta.get("concepts_matched", [])),
            len(retrieval_meta.get("relation_context", [])),
        )
        retrieval_meta["confidence_score"] = confidence

        items.append({
            "mapping_id": mid,
            "question_text": q_text,
            "chapter_id": chapter_id,
            "chapter_name": chapter_name,
            "textbook_name": textbook_name,
            "subject": subject,
            "context": context_text,
            "graph_context": graph_context_str,
            "chunk_ids": chunk_ids,
            "source_pages": source_pages,
            "images": images,
            "retrieval_meta": retrieval_meta,
            # For hybrid mode: keep separate chunks for dual Claude calls
            "vector_context": "\n\n---\n\n".join([c["text"] for c in vector_chunks]) if mode == "hybrid" else "",
            "graph_only_context": "\n\n---\n\n".join([c["text"] for c in graph_chunks]) if mode == "hybrid" else "",
        })

    if not items:
        return {"error": "No valid mappings found", "generated": 0}

    await notify(f"Phase 1 done: Retrieved context for {len(items)} questions (mode={mode})", 1, 4 if mode == "hybrid" else 3)

    # ── Phase 2: Generate answers ──

    if mode == "hybrid":
        # ── Hybrid: dual-path generation + fusion ──
        await notify("Phase 2a: Generating Answer A (vector-only)...", 2, 4)

        # Answer A: vector-only
        items_a = [{
            **item,
            "context": item["vector_context"] or item["context"],
            "graph_context": "",
        } for item in items]

        try:
            answers_a = await _call_claude_for_answer(
                items_a, preset, bullet_count, bullet_style,
                ANSWER_SYSTEM, items[0]["subject"],
            )
        except Exception as e:
            logger.error(f"Vector answer generation failed: {e}")
            answers_a = [None] * len(items)

        await notify("Phase 2b: Generating Answer B (graph-only)...", 3, 4)

        # Answer B: graph-only
        items_b = [{
            **item,
            "context": item["graph_only_context"] or item["context"],
        } for item in items]

        try:
            answers_b = await _call_claude_for_answer(
                items_b, preset, bullet_count, bullet_style,
                ANSWER_SYSTEM_WITH_GRAPH, items[0]["subject"],
                extra_context="graph",
            )
        except Exception as e:
            logger.error(f"Graph answer generation failed: {e}")
            answers_b = [None] * len(items)

        await notify("Phase 2c: Running fusion pass...", 3, 4)

        # Fusion pass for each question
        fused_answers = []
        for i, item in enumerate(items):
            ans_a = answers_a[i] if i < len(answers_a) else None
            ans_b = answers_b[i] if i < len(answers_b) else None

            if ans_a and ans_b and ans_a.get("bullets") and ans_b.get("bullets"):
                try:
                    fused = await _fuse_answers(
                        item["question_text"], ans_a, ans_b,
                        bullet_count, item["subject"],
                    )
                    fused_answers.append(fused)
                    # Update provenance in retrieval metadata
                    item["retrieval_meta"]["bullet_provenance"] = fused.get("bullet_provenance", [])
                    item["retrieval_meta"]["fusion_notes"] = fused.get("fusion_notes", "")
                except Exception as e:
                    logger.warning(f"Fusion failed for question {i}, falling back to Answer A: {e}")
                    fused_answers.append(ans_a)
                    item["retrieval_meta"]["fusion_applied"] = False
            elif ans_a and ans_a.get("bullets"):
                fused_answers.append(ans_a)
                item["retrieval_meta"]["fusion_applied"] = False
                item["retrieval_meta"]["fusion_notes"] = "Fusion skipped: graph answer empty"
            elif ans_b and ans_b.get("bullets"):
                fused_answers.append(ans_b)
                item["retrieval_meta"]["fusion_applied"] = False
                item["retrieval_meta"]["fusion_notes"] = "Fusion skipped: vector answer empty"
            else:
                fused_answers.append(None)

        answers_list = fused_answers

    else:
        # ── Auto or graph_only: single Claude call ──
        await notify("Phase 2: Sending to Claude for answer generation...", 2, 3)

        # Choose system prompt based on whether we have graph context
        system = ANSWER_SYSTEM_WITH_GRAPH if any(item.get("graph_context") for item in items) else ANSWER_SYSTEM
        extra = "graph" if any(item.get("graph_context") for item in items) else ""

        try:
            answers_list = await _call_claude_for_answer(
                items, preset, bullet_count, bullet_style,
                system, items[0]["subject"], extra_context=extra,
            )
        except Exception as e:
            logger.error(f"Answer generation failed: {e}")
            return {"error": str(e), "generated": 0}

    # ── Phase 3: Store results ──
    phase_num = 4 if mode == "hybrid" else 3
    await notify(f"Phase {phase_num}: Storing generated answers...", phase_num, phase_num)
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
            "retrieval_mode": mode,
            "retrieval_metadata": json.dumps(item["retrieval_meta"]),
        })
        generated += 1

    result = {
        "generated": generated,
        "errors": errors,
        "total": len(items),
        "preset": preset,
        "bullet_count": bullet_count,
        "bullet_style": bullet_style,
        "mode": mode,
    }

    await notify(f"Done: {generated}/{len(items)} answers generated (mode={mode})", phase_num, phase_num)
    return result


async def regenerate_answer(
    answer_id: str,
    preset: str = None,
    custom_bullet_count: int = None,
    custom_style: str = None,
    mode: str = None,
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
        mode=mode or answer.get("retrieval_mode", "auto"),
    )
    return result
