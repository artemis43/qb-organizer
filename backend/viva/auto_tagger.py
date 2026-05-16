# qb-organizer/backend/viva/auto_tagger.py
"""Auto-tag explainedTerms for viva questions using chapter key_terms.

Works on both generated AND manually written questions.
Strategy:
1. Collect all key_terms from chapters of the same subject
2. Match terms that appear in the answer text (case-insensitive, word-boundary)
3. Filter out trivially short terms (< 4 chars)
4. Return sorted unique list
"""

import json
import logging
import re
from state import db as database

logger = logging.getLogger(__name__)


async def get_subject_key_terms(subject: str) -> dict[str, list[str]]:
    """Load all key_terms from chapters belonging to the given subject.

    Returns: {chapter_id: [term1, term2, ...]}
    """
    chapters = await database.fetch_all(
        "chapters",
        "textbook_id IN (SELECT id FROM textbooks WHERE subject = ?)",
        (subject,),
    )
    result = {}
    for ch in chapters:
        raw = ch.get("key_terms", "[]")
        if isinstance(raw, str):
            try:
                terms = json.loads(raw)
            except json.JSONDecodeError:
                terms = []
        else:
            terms = raw or []
        result[ch["id"]] = [str(t).strip() for t in terms if len(str(t).strip()) >= 4]
    return result


def _build_term_set(chapter_terms: dict[str, list[str]]) -> set[str]:
    """Flatten all chapter terms into a normalized set."""
    all_terms = set()
    for terms in chapter_terms.values():
        for t in terms:
            all_terms.add(t.strip().lower())
    return all_terms


def extract_explained_terms(answer_text: str, all_terms: set[str]) -> list[str]:
    """Match key terms that appear in the answer text.

    Uses word-boundary matching to avoid false positives.
    Returns original-cased terms for display.
    """
    if not answer_text or not all_terms:
        return []

    answer_lower = answer_text.lower()
    matched = []

    for term in sorted(all_terms, key=len, reverse=True):  # longest first
        if len(term) < 4:
            continue
        # Word-boundary match to avoid partial matches
        pattern = r'\b' + re.escape(term) + r'\b'
        if re.search(pattern, answer_lower):
            # Store in title case for clean display
            matched.append(term.title() if term.islower() else term)

    # Deduplicate preserving order
    seen = set()
    unique = []
    for t in matched:
        key = t.lower()
        if key not in seen:
            seen.add(key)
            unique.append(t)

    return unique


async def auto_tag_question(
    question_id: str,
    subject: str = None,
) -> list[str]:
    """Auto-tag a single viva question with explainedTerms.

    If subject is not provided, reads it from the question record.
    """
    question = await database.fetch_one("viva_questions", question_id)
    if not question:
        logger.warning(f"Viva question {question_id} not found")
        return []

    subject = subject or question["subject"]
    chapter_terms = await get_subject_key_terms(subject)
    all_terms = _build_term_set(chapter_terms)

    # Tag from both question and answer text
    combined_text = f"{question['question_text']} {question['answer_text']}"
    terms = extract_explained_terms(combined_text, all_terms)

    # Save back to DB
    await database.update("viva_questions", question_id, {
        "explained_terms": terms,
    })

    logger.info(f"Auto-tagged {question_id}: {len(terms)} terms")
    return terms


async def auto_tag_batch(
    question_ids: list[str],
    subject: str,
    progress_callback=None,
) -> dict:
    """Auto-tag multiple viva questions.

    Pre-loads terms once for efficiency.
    """
    chapter_terms = await get_subject_key_terms(subject)
    all_terms = _build_term_set(chapter_terms)

    if not all_terms:
        return {"error": "No key_terms found for subject. Ingest a textbook first.", "tagged": 0}

    tagged = 0
    for idx, qid in enumerate(question_ids):
        question = await database.fetch_one("viva_questions", qid)
        if not question:
            continue

        combined_text = f"{question['question_text']} {question['answer_text']}"
        terms = extract_explained_terms(combined_text, all_terms)

        await database.update("viva_questions", qid, {
            "explained_terms": terms,
        })
        tagged += 1

        if progress_callback and (idx + 1) % 10 == 0:
            await progress_callback("auto_tag", idx + 1, len(question_ids),
                                     f"Tagged {idx + 1}/{len(question_ids)} questions")

    return {"tagged": tagged, "total": len(question_ids), "term_pool_size": len(all_terms)}
