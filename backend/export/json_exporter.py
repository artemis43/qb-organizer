# qb-organizer/backend/export/json_exporter.py
"""Export organized questions as Firestore-ready JSON.

Outputs JSON that exactly matches the MBBS Companion app's data models.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from config import settings
from state import db as database
from matching.matcher import find_duplicate_questions

logger = logging.getLogger(__name__)


async def export_subject(subject: str, university_id: str = "") -> dict:
    """Export all organized data for a subject as Firestore-ready JSON.

    Args:
        subject: The subject name.
        university_id: Firestore university document ID.

    Returns:
        The export bundle as a dict (also saved to file).
    """
    logger.info(f"Exporting subject: {subject}")

    # Get all completed mappings for this subject
    mappings = await database.fetch_all(
        "mappings",
        "qp_id IN (SELECT id FROM question_papers WHERE subject = ?)",
        (subject,),
    )

    if not mappings:
        return {"error": "no_data", "message": f"No matched questions found for {subject}."}

    # Get all chapters for this subject
    chapters = await database.fetch_all(
        "chapters",
        "textbook_id IN (SELECT id FROM textbooks WHERE subject = ?)",
        (subject,),
        "chapter_number ASC",
    )

    # Get textbook info
    textbooks = await database.fetch_all("textbooks", "subject = ?", (subject,))
    textbook_name = textbooks[0]["name"] if textbooks else subject

    # ── Deduplication ──────────────────────────────────────
    all_questions = [{"id": m["id"], "question_text": m["question_text"]} for m in mappings]
    dup_groups = find_duplicate_questions(all_questions)

    # Build dedup map
    dup_map = {}  # mapping_id → group_id
    for group_idx, group in enumerate(dup_groups):
        group_id = f"dup_{group_idx}"
        for q_id in group:
            dup_map[q_id] = group_id

    # ── Build Firestore structures ─────────────────────────
    firestore_chapters = []
    chapter_id_map = {}  # our_id → firestore-friendly id

    for idx, ch in enumerate(chapters):
        fs_id = f"ch_{subject.lower().replace(' ', '_')}_{idx + 1:02d}"
        chapter_id_map[ch["id"]] = fs_id
        firestore_chapters.append({
            "id": fs_id,
            "name": ch["name"],
            "subjectId": "{{SUBJECT_ID}}",  # placeholder
            "order": idx + 1,
        })

    # ── Build questions with dedup merging ─────────────────
    seen_texts = {}  # normalized text → first mapping
    firestore_questions = []
    dedup_report = {"frequently_asked": [], "total_unique": 0, "total_with_duplicates": 0}

    for m in mappings:
        mapping_data = m
        q_text = mapping_data["question_text"].strip()
        final_ch_id = mapping_data.get("final_chapter_id", "")
        fs_chapter_id = chapter_id_map.get(final_ch_id, "")

        if not fs_chapter_id:
            # Try to find from best_match
            best_match = mapping_data.get("best_match")
            if best_match:
                if isinstance(best_match, str):
                    try:
                        best_match = json.loads(best_match)
                    except json.JSONDecodeError:
                        best_match = {}
                ch_id = best_match.get("chapter_id", "")
                fs_chapter_id = chapter_id_map.get(ch_id, "")

        if not fs_chapter_id:
            continue

        # Get page references
        page_refs = {}
        best_match = mapping_data.get("best_match")
        if best_match:
            if isinstance(best_match, str):
                try:
                    best_match = json.loads(best_match)
                except json.JSONDecodeError:
                    best_match = {}
            page_refs = best_match.get("page_references", {}) or {}

        exam_tag = mapping_data.get("exam_tag", "")
        q_type = mapping_data.get("question_type", "OTHER")

        # Check for duplicate
        normalized = q_text.lower().strip()
        group_id = dup_map.get(mapping_data["id"])

        if group_id and normalized in seen_texts:
            # Merge exam tag into existing question
            existing = seen_texts[normalized]
            if exam_tag and exam_tag not in existing["exams"]:
                existing["exams"].append(exam_tag)
                existing["_meta"]["frequency"] += 1
            dedup_report["total_with_duplicates"] += 1
            continue

        question_entry = {
            "questionText": q_text,
            "type": q_type,
            "chapterId": fs_chapter_id,
            "exams": [exam_tag] if exam_tag else [],
            "isAnswered": False,
            "answerId": None,
            "answer": None,
            "pageNumbers": page_refs,
            "order": len(firestore_questions) + 1,
            "_meta": {
                "confidence": mapping_data.get("confidence", 0),
                "confidence_level": mapping_data.get("confidence_level", "low"),
                "frequency": 1,
                "original_id": mapping_data["id"],
            },
        }

        # ── Attach answer if generated ──
        answer_rows = await database.fetch_all(
            "answers", "mapping_id = ?", (mapping_data["id"],)
        )
        if answer_rows:
            ans = answer_rows[0]
            try:
                bullets = json.loads(ans.get("bullets", "[]")) if ans.get("bullets") else []
            except json.JSONDecodeError:
                bullets = []
            try:
                source_pages = json.loads(ans.get("source_pages", "{}")) if ans.get("source_pages") else {}
            except json.JSONDecodeError:
                source_pages = {}

            question_entry["isAnswered"] = True
            question_entry["answerId"] = ans["id"]

            try:
                images = json.loads(ans.get("images", "[]")) if ans.get("images") else []
            except json.JSONDecodeError:
                images = []

            question_entry["answer"] = {
                "prologue": ans.get("prologue", ""),
                "bullets": bullets,
                "epilogue": ans.get("epilogue", ""),
                "bulletCount": ans.get("bullet_count", 0),
                "preset": ans.get("preset", "custom"),
                "sourcePages": source_pages,
                "images": [{"filename": img.get("filename"), "page": img.get("page"), "caption": img.get("caption", "")} for img in images],
                "textbookName": ans.get("textbook_name", ""),
            }

        seen_texts[normalized] = question_entry
        firestore_questions.append(question_entry)
        dedup_report["total_unique"] += 1
        dedup_report["total_with_duplicates"] += 1

    # Find frequently asked questions
    for q in firestore_questions:
        if q["_meta"]["frequency"] >= 3:
            dedup_report["frequently_asked"].append({
                "question": q["questionText"][:100],
                "count": q["_meta"]["frequency"],
                "exams": q["exams"],
            })

    # Sort frequently asked by count
    dedup_report["frequently_asked"].sort(key=lambda x: x["count"], reverse=True)

    # ── Build stats ────────────────────────────────────────
    confidence_stats = {"high": 0, "medium": 0, "low": 0}
    for q in firestore_questions:
        level = q["_meta"]["confidence_level"]
        confidence_stats[level] = confidence_stats.get(level, 0) + 1

    qps = await database.fetch_all("question_papers", "subject = ?", (subject,))

    # ── Build export bundle ────────────────────────────────
    export = {
        "export_metadata": {
            "tool_version": "1.0.0",
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "subject": subject,
            "textbooks_used": [t["name"] for t in textbooks],
            "question_papers_processed": len(qps),
            "total_questions": len(firestore_questions),
            "total_unique_questions": dedup_report["total_unique"],
            "total_answered": len([q for q in firestore_questions if q["isAnswered"]]),
            "confidence_stats": confidence_stats,
        },
        "subject": {
            "name": subject,
            "order": 1,
            "universityId": university_id or "{{UNIVERSITY_ID}}",
        },
        "chapters": firestore_chapters,
        "questions": firestore_questions,
        "dedup_report": dedup_report,
    }

    # Save to file
    export_path = settings.exports_dir / f"{subject.lower().replace(' ', '_')}_export.json"
    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(export, f, indent=2, ensure_ascii=False)

    logger.info(
        f"Exported: {len(firestore_questions)} questions, {len(firestore_chapters)} chapters "
        f"→ {export_path}"
    )

    return export
