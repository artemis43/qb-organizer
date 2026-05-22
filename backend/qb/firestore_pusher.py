# qb-organizer/backend/qb/firestore_pusher.py
"""Direct Firestore push for question bank content.

Pushes generated QB questions + answers directly into the MBBS Companion
app's Firestore, matching the exact schema the app expects:

  subjects → chapters → questions + answers

Answers with images are first uploaded to ImageKit, then the CDN URLs
are stored in Firestore — exactly as the admin dashboard does it.
"""

import json
import logging
import re
from pathlib import Path

from config import settings
from state import db as database
from matching.matcher import find_duplicate_questions

logger = logging.getLogger(__name__)

# ── Answer text cleanup & formatting ─────────────────────────────

# Phrases that indicate the source had limited information.
# These should never appear in the final answer shown to students.
_LIMITED_INFO_PATTERNS = [
    r"Limited(?:\s+(?:source|textbook))?\s+(?:information|content|data|detail|material)\s+(?:is\s+)?available[^.]*\.",
    r"(?:The\s+)?(?:source|textbook|provided)\s+(?:material|text|content|excerpts?)?\s+(?:is|are|does\s+not|doesn'?t)\s+(?:insufficient|not\s+enough|limited)[^.]*\.",
    r"(?:Not|No)\s+enough\s+(?:information|content|detail)[^.]*(?:source|textbook|text)[^.]*\.",
    r"Based\s+on\s+(?:the\s+)?(?:available|limited|provided)\s+(?:source|textbook|content|text)[^.]*(?:cannot|unable\s+to|difficult\s+to)[^.]*\.",
    r"The\s+(?:source|textbook)\s+(?:does\s+not|doesn'?t)\s+(?:provide|contain|include|cover)[^.]*(?:details?|information|content)[^.]*\.",
    r"(?:Source|Textbook|Content)\s+(?:is|provides?)?\s+(?:insufficient|limited|incomplete)[^.]*\.",
    r"(?:Further|Additional|More)\s+(?:information|details?)\s+(?:not|is\s+not)\s+(?:available|provided)[^.]*\.",
    r"This\s+(?:topic|question)\s+(?:is\s+)?(?:not|poorly)\s+(?:covered|discussed|addressed)[^.]*(?:source|textbook)[^.]*\.",
]


def _clean_answer_text(text: str) -> str:
    """Strip 'limited source info' disclaimers from generated answer text."""
    if not text:
        return text
    for pattern in _LIMITED_INFO_PATTERNS:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE).strip()
    # Collapse 2+ consecutive blank lines into one
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _format_answer_markdown(prologue: str, bullets: list, epilogue: str) -> str:
    """Assemble answer sections into clean, readable markdown.

    Structure:
        {prologue paragraph}

        - **Term:** detail
        - Point

        *{epilogue}*
    """
    parts = []

    if prologue:
        cleaned_prologue = _clean_answer_text(prologue.strip())
        if cleaned_prologue:
            parts.append(cleaned_prologue)

    if bullets:
        bullet_lines = []
        for b in bullets:
            b = b.strip()
            if not b:
                continue
            b = _clean_answer_text(b)
            if not b:
                continue
            # If the bullet already starts with '-' or '*', keep it; otherwise prefix
            if b.startswith(('-', '*', '•')):
                line = b
            else:
                line = f"- {b}"
            bullet_lines.append(line)
        if bullet_lines:
            parts.append("\n".join(bullet_lines))

    if epilogue:
        cleaned_epilogue = _clean_answer_text(epilogue.strip())
        if cleaned_epilogue:
            # Wrap epilogue in italics as a summary/conclusion note
            parts.append(f"*{cleaned_epilogue}*")

    return "\n\n".join(parts)

# Lazy-loaded Firestore client (reuses viva module's init)
_firestore_client = None


def _get_firestore():
    """Initialize and return Firestore client (lazy singleton)."""
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    import firebase_admin
    from firebase_admin import credentials, firestore

    sa_path = settings.firebase_service_account_path
    if not Path(sa_path).exists():
        raise FileNotFoundError(
            f"Firebase service account not found at: {sa_path}\n"
            f"Download from: Firebase Console → Project Settings → Service Accounts"
        )

    if not firebase_admin._apps:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)

    _firestore_client = firestore.client()
    logger.info("Firestore client initialized for QB push")
    return _firestore_client


async def push_qb_to_firestore(
    subject: str,
    mapping_ids: list[str] = None,
    upload_images: bool = True,
    progress_callback=None,
    dry_run: bool = False,
) -> dict:
    """Push question bank questions + answers to Firestore.

    If mapping_ids is None, pushes all reviewed/high-confidence mappings
    for the subject. Handles deduplication, image upload, and answer linking.

    Args:
        subject: Subject name
        mapping_ids: Specific mapping IDs to push (or all if None)
        upload_images: Whether to upload images to ImageKit
        progress_callback: SSE progress callback

    Returns:
        Stats dict with counts
    """
    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("qb_push", current, total, msg)
        logger.info(msg)

    await notify("Loading question data...", 0, 4)

    # Load mappings
    if mapping_ids:
        mappings = []
        for mid in mapping_ids:
            m = await database.fetch_one("mappings", mid)
            if m:
                mappings.append(m)
    else:
        mappings = await database.fetch_all(
            "mappings",
            "qp_id IN (SELECT id FROM question_papers WHERE subject = ?) "
            "AND (is_reviewed = 1 OR confidence_level = 'high')",
            (subject,),
        )

    if not mappings:
        return {"error": "No eligible questions found", "pushed": 0}

    # Load chapters
    chapters = await database.fetch_all(
        "chapters",
        "textbook_id IN (SELECT id FROM textbooks WHERE subject = ?)",
        (subject,), "chapter_number ASC",
    )

    textbooks = await database.fetch_all("textbooks", "subject = ?", (subject,))
    textbook_name = textbooks[0]["name"] if textbooks else subject

    await notify(f"Processing {len(mappings)} questions...", 1, 4)

    # Deduplication
    all_questions = [{"id": m["id"], "question_text": m["question_text"]} for m in mappings]
    dup_groups = find_duplicate_questions(all_questions)
    dup_map = {}
    for group_idx, group in enumerate(dup_groups):
        for q_id in group:
            dup_map[q_id] = f"dup_{group_idx}"

    # Initialize Firestore
    try:
        db = _get_firestore()
    except Exception as e:
        return {"error": str(e), "pushed": 0}

    # ── Find or create subject ──
    await notify("Creating Firestore hierarchy...", 2, 4)

    subj_ref = db.collection("subjects")
    existing_subj = subj_ref.where("name", "==", subject).limit(1).get()
    if existing_subj:
        subject_doc_id = existing_subj[0].id
    else:
        # Case-insensitive fallback lookup
        all_subjects = subj_ref.get()
        matched_doc = None
        for s_doc in all_subjects:
            s_name = s_doc.to_dict().get("name", "")
            if s_name.lower().strip() == subject.lower().strip():
                matched_doc = s_doc
                break
        if matched_doc:
            subject_doc_id = matched_doc.id
        else:
            if dry_run:
                subject_doc_id = "mock_subject_id"
            else:
                _, doc_ref = subj_ref.add({"name": subject.strip(), "order": 0})
                subject_doc_id = doc_ref.id

    # ── Create/find chapters ──
    chapter_fs_map = {}  # local_chapter_id → firestore_chapter_id
    for ch in chapters:
        ch_name_normalized = ch["name"].strip()
        ch_query = db.collection("chapters").where(
            "name", "==", ch_name_normalized
        ).where(
            "subjectId", "==", subject_doc_id
        ).limit(1).get()

        if ch_query:
            chapter_fs_map[ch["id"]] = ch_query[0].id
        else:
            # Fallback 1: Name search alone (ignoring subjectId)
            ch_query_fallback = db.collection("chapters").where(
                "name", "==", ch_name_normalized
            ).limit(1).get()
            if ch_query_fallback:
                chapter_fs_map[ch["id"]] = ch_query_fallback[0].id
            else:
                # Fallback 2: Case-insensitive search over all chapters
                all_chapters = db.collection("chapters").get()
                matched_ch = None
                for c_doc in all_chapters:
                    c_dict = c_doc.to_dict()
                    if c_dict.get("name", "").lower().strip() == ch_name_normalized.lower():
                        matched_ch = c_doc
                        break
                if matched_ch:
                    chapter_fs_map[ch["id"]] = matched_ch.id
                else:
                    if dry_run:
                        chapter_fs_map[ch["id"]] = f"mock_chapter_id_{ch['id']}"
                    else:
                        _, ch_ref = db.collection("chapters").add({
                            "name": ch_name_normalized,
                            "subjectId": subject_doc_id,
                            "order": ch.get("chapter_number", 0),
                        })
                        chapter_fs_map[ch["id"]] = ch_ref.id

    # ── Push questions ──
    await notify(f"Pushing {len(mappings)} questions to Firestore...", 3, 4)

    stats = {"questions": 0, "answers": 0, "images_uploaded": 0, "duplicates_merged": 0, "errors": 0}
    seen_texts = {}  # normalized_text → firestore_question_id

    for idx, m in enumerate(mappings):
        q_text = m["question_text"].strip()
        normalized = q_text.lower().strip()

        # Get Firestore chapter ID
        final_ch_id = m.get("final_chapter_id", "")
        fs_chapter_id = chapter_fs_map.get(final_ch_id, "")

        if not fs_chapter_id:
            # Try from best_match
            best_match = m.get("best_match")
            if best_match:
                if isinstance(best_match, str):
                    try:
                        best_match = json.loads(best_match)
                    except json.JSONDecodeError:
                        best_match = {}
                ch_id = best_match.get("chapter_id", "")
                fs_chapter_id = chapter_fs_map.get(ch_id, "")

        if not fs_chapter_id:
            stats["errors"] += 1
            continue

        # Check for duplicate
        group_id = dup_map.get(m["id"])
        if group_id and normalized in seen_texts:
            # Merge exam tags into existing
            existing_q_id = seen_texts[normalized]
            raw_tag = m.get("exam_tag", "")
            merge_tags = [t.strip() for t in raw_tag.split(",") if t.strip()] if raw_tag else []
            if merge_tags:
                try:
                    from firebase_admin import firestore as fs_module
                    if not dry_run:
                        db.collection("questions").document(existing_q_id).update({
                            "exams": fs_module.ArrayUnion(merge_tags)
                        })
                except Exception:
                    pass
            stats["duplicates_merged"] += 1
            continue

        # Get page references
        page_refs = {}
        best_match = m.get("best_match")
        if best_match:
            if isinstance(best_match, str):
                try:
                    best_match = json.loads(best_match)
                except json.JSONDecodeError:
                    best_match = {}
            page_refs = best_match.get("page_references", {}) or {}

        # Parse exam tags (may be comma-separated: "RS-3, RS-4")
        raw_exam_tag = m.get("exam_tag", "")
        exam_tags = [t.strip() for t in raw_exam_tag.split(",") if t.strip()] if raw_exam_tag else []
        paper_name = m.get("paper_name", "") or raw_exam_tag
        q_type = m.get("question_type", "OTHER")

        # Check for existing answer
        answer_rows = await database.fetch_all("answers", "mapping_id = ?", (m["id"],))

        has_answer = False
        answer_doc_id = None

        if answer_rows:
            ans = answer_rows[0]
            try:
                bullets = json.loads(ans.get("bullets", "[]")) if ans.get("bullets") else []
            except json.JSONDecodeError:
                bullets = []

            # Build answer text as rich markdown
            answer_text = _format_answer_markdown(
                prologue=ans.get("prologue", ""),
                bullets=bullets,
                epilogue=ans.get("epilogue", ""),
            )

            # Handle images
            image_urls = []
            if upload_images:
                try:
                    images_raw = json.loads(ans.get("images", "[]")) if ans.get("images") else []
                except json.JSONDecodeError:
                    images_raw = []

                if images_raw:
                    if dry_run:
                        image_urls = [f"https://ik.imagekit.io/mock/{img.get('filename')}" for img in images_raw]
                        stats["images_uploaded"] += len(images_raw)
                    else:
                        from qb.imagekit_uploader import upload_answer_images
                        image_urls = await upload_answer_images(images_raw, subject)
                        image_urls = [u for u in image_urls if u]  # Filter empty
                        stats["images_uploaded"] += len(image_urls)

            # Push answer to Firestore
            answer_payload = {
                "text": answer_text,
                "imageUrls": image_urls,
                "mappingId": m["id"],  # For exact deduplication
            }

            # Check for existing answer in Firestore using mappingId
            existing_ans = db.collection("answers").where(
                "mappingId", "==", m["id"]
            ).limit(1).get()

            # Fallback to partial text matching for legacy records
            if not existing_ans:
                existing_ans = db.collection("answers").where(
                    "text", "==", answer_text[:200]
                ).limit(1).get()

            if existing_ans:
                answer_doc_id = existing_ans[0].id
                if not dry_run:
                    db.collection("answers").document(answer_doc_id).update(answer_payload)
            else:
                if dry_run:
                    answer_doc_id = f"mock_answer_id_{m['id']}"
                else:
                    _, ans_ref = db.collection("answers").add(answer_payload)
                    answer_doc_id = ans_ref.id

            has_answer = True
            stats["answers"] += 1

        # Push question to Firestore
        question_payload = {
            "questionText": q_text,
            "type": q_type,
            "chapterId": fs_chapter_id,
            "exams": exam_tags,
            "paperName": paper_name,
            "isAnswered": has_answer,
            "answerId": answer_doc_id,
            "pageNumbers": page_refs,
            "order": idx + 1,
        }

        try:
            # Check for existing question
            existing_q = db.collection("questions").where(
                "questionText", "==", q_text
            ).where(
                "chapterId", "==", fs_chapter_id
            ).limit(1).get()

            if existing_q:
                q_doc_id = existing_q[0].id
                if not dry_run:
                    db.collection("questions").document(q_doc_id).update(question_payload)
            else:
                if dry_run:
                    q_doc_id = f"mock_question_id_{idx}"
                else:
                    _, q_ref = db.collection("questions").add(question_payload)
                    q_doc_id = q_ref.id

            seen_texts[normalized] = q_doc_id
            stats["questions"] += 1

            # Mark as pushed in local DB
            if not dry_run:
                await database.update("mappings", m["id"], {"is_reviewed": 1})

        except Exception as e:
            logger.error(f"Failed to push question {m['id']}: {e}")
            stats["errors"] += 1

        if (idx + 1) % 20 == 0:
            await notify(
                f"Pushed {idx + 1}/{len(mappings)} questions...",
                3, 4
            )

    await notify(
        f"Push complete: {stats['questions']} questions, {stats['answers']} answers, "
        f"{stats['images_uploaded']} images, {stats['duplicates_merged']} duplicates merged",
        4, 4
    )

    return stats
