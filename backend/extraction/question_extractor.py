# qb-organizer/backend/extraction/question_extractor.py
"""Extract individual questions from question paper PDFs.

Pipeline:
1. Parse QP PDF locally (PyMuPDF)
2. Auto-detect metadata (university, year, month)
3. Send to Claude Haiku for structured question extraction
"""

import uuid
import re
import json
import logging
from pathlib import Path

from config import settings
from core.pdf_parser import parse_pdf, clean_text
from claude.client import get_claude_client
from state import db as database
from state.checkpoint import Checkpoint

logger = logging.getLogger(__name__)


EXTRACTION_SYSTEM_PROMPT = """You are a medical exam question extraction expert.
Extract EVERY question from this exam paper. Be thorough — do not miss any question.

You MUST respond with valid JSON only:
{
  "questions": [
    {
      "question_number": "1a",
      "question_text": "Full question text preserving medical terminology",
      "question_type": "LAQ",
      "marks": 10,
      "has_sub_parts": false,
      "sub_parts": []
    }
  ],
  "metadata": {
    "university": "full university name or null",
    "subject": "subject name or null",
    "year": 2024,
    "month": "June",
    "paper_number": "Paper I",
    "exam_schemes": ["RS-4"]
  }
}

Rules for question_type:
- "LAQ" = Long Answer Question (typically 10+ marks, essay-type)
- "SAQ" = Short Answer Question (typically 4-5 marks)  
- "VSAQ" = Very Short Answer Question (typically 2 marks)
- "MCQ" = Multiple Choice Question
- "MATCH" = Match the following
- "DIAGRAM" = Draw/label diagram
- "CLINICAL_CASE" = Clinical case scenario
- "OTHER" = Anything else

Rules:
- Extract the COMPLETE question text, even if it spans multiple lines
- Keep medical terminology EXACTLY as written
- For multi-part questions (a, b, c), extract each part separately
- If marks are visible, include them; if not, set to null
- Detect the type from section headers, marks, or question structure
- For exam_schemes: look for patterns like (RS-1), (RS-2), (RS-3), (RS-4) etc. in the paper header.
  A single paper may have multiple scheme codes. Return all found as an array like ["RS-4"] or ["RS-3", "RS-4"].
  If none found, return an empty array."""


def detect_metadata_from_filename(filename: str) -> dict:
    """Try to extract exam metadata from the filename."""
    meta = {"university": None, "year": None, "month": None, "subject": None}

    # Common patterns: "RGUHS_Anatomy_Jun2024.pdf", "anatomy-june-2024.pdf"
    year_match = re.search(r'20\d{2}', filename)
    if year_match:
        meta["year"] = int(year_match.group())

    month_patterns = {
        "jan": "January", "feb": "February", "mar": "March", "apr": "April",
        "may": "May", "jun": "June", "jul": "July", "aug": "August",
        "sep": "September", "oct": "October", "nov": "November", "dec": "December",
    }
    lower = filename.lower()
    for abbr, full in month_patterns.items():
        if abbr in lower:
            meta["month"] = full
            break

    # University detection
    uni_patterns = ["rguhs", "muhs", "aiims", "jipmer", "kmu", "kuhs"]
    for uni in uni_patterns:
        if uni in lower:
            meta["university"] = uni.upper()
            break

    return meta


def detect_exam_schemes_from_text(text: str) -> list[str]:
    """Extract exam scheme codes (e.g. RS-4, RS-1) from QP text.

    RGUHS papers encode the exam round as a bracketed code like (RS-4).
    A single paper may have multiple codes if it covers multiple sections.

    Returns a sorted, deduplicated list of scheme codes found, e.g. ['RS-4'].
    Returns an empty list if none found.
    """
    # Match (RS-N) or (RS-NN) anywhere in the text
    matches = re.findall(r'\(RS-(\d+)\)', text, re.IGNORECASE)
    if not matches:
        # Also try without parentheses: "- RS-4" or "RS-4" near subject line
        matches = re.findall(r'\bRS-(\d+)\b', text, re.IGNORECASE)
    unique = sorted(set(matches), key=lambda x: int(x))
    return [f"RS-{n}" for n in unique]


async def extract_questions_from_qp(
    file_path: str,
    subject: str,
    metadata_overrides: dict = None,
    progress_callback=None,
) -> dict:
    """Extract all questions from a single question paper.

    Args:
        file_path: Path to the QP PDF.
        subject: Subject name.
        metadata_overrides: Optional overrides for auto-detected metadata.
        progress_callback: Optional async callback.

    Returns:
        dict with qp_id and extracted questions.
    """
    qp_id = str(uuid.uuid4())[:8]

    async def notify(msg):
        if progress_callback:
            await progress_callback("extract", 0, 1, msg)
        logger.info(msg)

    try:
        # Step 1: Parse PDF locally
        await notify(f"Parsing QP: {Path(file_path).name}")
        pdf_info = parse_pdf(file_path)

        # Check duplicate
        existing = await database.fetch_all(
            "question_papers", "sha256_hash = ?", (pdf_info.sha256_hash,)
        )
        if existing:
            return {
                "error": "duplicate",
                "message": f"This QP already uploaded (ID: {existing[0]['id']})",
                "existing_id": existing[0]["id"],
            }

        # Step 2: Auto-detect metadata
        meta = detect_metadata_from_filename(pdf_info.filename)
        if metadata_overrides:
            meta.update({k: v for k, v in metadata_overrides.items() if v})

        # Get full text
        full_text = "\n\n".join(p.text for p in pdf_info.pages if p.text.strip())

        # Save QP record
        await database.insert("question_papers", {
            "id": qp_id,
            "filename": pdf_info.filename,
            "subject": subject,
            "university": meta.get("university"),
            "year": meta.get("year"),
            "month": meta.get("month"),
            "schema": meta.get("schema"),
            "total_pages": pdf_info.total_pages,
            "sha256_hash": pdf_info.sha256_hash,
            "status": "in_progress",
        })

        # Step 3: Send to Claude for extraction
        await notify("Extracting questions via Claude...")
        client = get_claude_client()

        # Truncate if very long
        max_chars = 20000
        if len(full_text) > max_chars:
            full_text = full_text[:max_chars] + "\n[Truncated]"

        response = await client.request(
            messages=[{
                "role": "user",
                "content": f"Extract all questions from this exam paper:\n\n{full_text}",
            }],
            system=EXTRACTION_SYSTEM_PROMPT,
            model=settings.haiku_model,
            task_type="qp_extraction",
            subject=subject,
            request_id=f"qp_{qp_id}",
        )

        # Step 4: Parse and save questions
        questions = response.get("questions", [])
        extracted_meta = response.get("metadata", {})

        # Update metadata with Claude's detection
        if extracted_meta.get("university") and not meta.get("university"):
            meta["university"] = extracted_meta["university"]
        if extracted_meta.get("year") and not meta.get("year"):
            meta["year"] = extracted_meta["year"]
        if extracted_meta.get("month") and not meta.get("month"):
            meta["month"] = extracted_meta["month"]

        # --- Build exam_tag (RS-X codes) and paper_name (human-readable) ---
        # 1. Try to get RS-X schemes from the PDF text (most reliable)
        scheme_codes = detect_exam_schemes_from_text(full_text)

        # 2. Also check if Claude extracted any in metadata
        claude_schemes = extracted_meta.get("exam_schemes", []) or []
        for s in claude_schemes:
            s_upper = s.upper()
            if s_upper not in scheme_codes:
                scheme_codes.append(s_upper)
        scheme_codes = sorted(set(scheme_codes), key=lambda x: int(x.split('-')[-1]) if x.split('-')[-1].isdigit() else 0)

        # 3. Build paper_name from university + month + year (descriptive)
        paper_name_parts = []
        if meta.get("university"):
            paper_name_parts.append(meta["university"])
        if meta.get("month"):
            paper_name_parts.append(meta["month"])
        if meta.get("year"):
            paper_name_parts.append(str(meta["year"]))
        paper_name = ", ".join(paper_name_parts) if paper_name_parts else pdf_info.filename

        # 4. exam_tag = RS codes (comma-sep) if found, else paper_name as fallback
        exam_tag = ", ".join(scheme_codes) if scheme_codes else paper_name

        logger.info(f"QP {qp_id}: exam_tag='{exam_tag}', paper_name='{paper_name}'")

        saved_questions = []
        for q in questions:
            q_id = f"{qp_id}_q{q.get('question_number', str(uuid.uuid4())[:4])}"
            q_data = {
                "id": q_id,
                "qp_id": qp_id,
                "question_number": q.get("question_number", ""),
                "question_text": q.get("question_text", ""),
                "question_type": q.get("question_type", "OTHER"),
                "marks": q.get("marks"),
                "has_sub_parts": q.get("has_sub_parts", False),
                "sub_parts": q.get("sub_parts", []),
                "status": "pending",
            }
            await database.insert("questions", q_data)
            q_data["exam_tag"] = exam_tag
            q_data["paper_name"] = paper_name
            saved_questions.append(q_data)

        # Update QP record
        await database.update("question_papers", qp_id, {
            "university": meta.get("university"),
            "year": meta.get("year"),
            "month": meta.get("month"),
            "schema": meta.get("schema"),
            "total_questions": len(saved_questions),
            "status": "completed",
        })

        await notify(f"Extracted {len(saved_questions)} questions from {pdf_info.filename}")

        return {
            "qp_id": qp_id,
            "filename": pdf_info.filename,
            "subject": subject,
            "exam_tag": exam_tag,
            "paper_name": paper_name,
            "metadata": meta,
            "questions": saved_questions,
            "total": len(saved_questions),
        }

    except Exception as e:
        logger.error(f"QP extraction failed: {e}", exc_info=True)
        await database.update("question_papers", qp_id, {"status": "failed"})
        raise


async def batch_extract_qps(
    file_paths: list[str],
    subject: str,
    progress_callback=None,
) -> dict:
    """Extract questions from multiple QPs using Claude Batch API.

    More efficient than processing one-by-one.
    """
    batch_requests = []
    qp_records = []

    for fp in file_paths:
        qp_id = str(uuid.uuid4())[:8]
        pdf_info = parse_pdf(fp)

        # Check duplicate
        existing = await database.fetch_all(
            "question_papers", "sha256_hash = ?", (pdf_info.sha256_hash,)
        )
        if existing:
            logger.info(f"Skipping duplicate QP: {pdf_info.filename}")
            continue

        meta = detect_metadata_from_filename(pdf_info.filename)
        full_text = "\n\n".join(p.text for p in pdf_info.pages if p.text.strip())

        if len(full_text) > 20000:
            full_text = full_text[:20000] + "\n[Truncated]"

        await database.insert("question_papers", {
            "id": qp_id,
            "filename": pdf_info.filename,
            "subject": subject,
            "university": meta.get("university"),
            "year": meta.get("year"),
            "month": meta.get("month"),
            "total_pages": pdf_info.total_pages,
            "sha256_hash": pdf_info.sha256_hash,
            "status": "batch_pending",
        })

        batch_requests.append({
            "custom_id": qp_id,
            "system": EXTRACTION_SYSTEM_PROMPT,
            "messages": [{
                "role": "user",
                "content": f"Extract all questions from this exam paper:\n\n{full_text}",
            }],
        })

        qp_records.append({"id": qp_id, "filename": pdf_info.filename, "meta": meta})

    if not batch_requests:
        return {"status": "no_new_qps", "message": "All QPs already processed."}

    client = get_claude_client()
    batch_id = await client.request_batch(
        requests=batch_requests,
        model=settings.haiku_model,
        task_type="qp_batch_extraction",
        subject=subject,
    )

    return {
        "status": "batch_submitted",
        "batch_id": batch_id,
        "qp_count": len(batch_requests),
        "qp_records": qp_records,
        "message": f"Batch submitted: {len(batch_requests)} QPs",
    }
