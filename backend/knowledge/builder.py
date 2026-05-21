# qb-organizer/backend/knowledge/builder.py
"""Knowledge Base builder — orchestrates textbook ingestion end-to-end.

Pipeline:
1. Parse PDF (local)
2. Extract chapters (local)
3. Chunk text (local)
4. Generate embeddings (local)
5. Build summaries + topics (Claude Haiku Batch)
"""

import uuid
import json
import logging
import asyncio
import time
from datetime import datetime, timezone

from config import settings
from core.pdf_parser import parse_pdf, extract_chapter_text, ChapterInfo, PDFInfo
from core.chunker import chunk_text
from core import embedder
from claude.client import get_claude_client
from state import db as database
from state.checkpoint import Checkpoint

logger = logging.getLogger(__name__)


SUMMARY_SYSTEM_PROMPT = """You are a medical education expert analyzing textbook chapters.
Your task is to provide a detailed analysis of a textbook chapter.
You MUST respond with valid JSON only — no other text, no markdown.

Output this exact JSON structure:
{
  "summary": "A 300-word summary of what this chapter covers",
  "topics": ["list", "of", "every", "distinct", "topic", "covered"],
  "key_terms": ["medical", "terms", "diseases", "procedures", "mentioned"],
  "exam_likely_topics": ["top 5 most likely exam topics from this chapter"]
}"""


async def ingest_textbook(
    file_path: str,
    name: str,
    subject: str,
    progress_callback=None,
) -> dict:
    """Full textbook ingestion pipeline."""
    textbook_id = str(uuid.uuid4())[:8]
    checkpoint = Checkpoint("ingest_textbook", f"{subject}_{textbook_id}")
    pipeline_start = time.time()

    async def notify(step, current, total, msg):
        elapsed = time.time() - pipeline_start
        elapsed_str = f"{int(elapsed)}s"
        if elapsed > 60:
            elapsed_str = f"{int(elapsed // 60)}m {int(elapsed % 60)}s"

        # Estimate remaining time
        eta_str = ""
        if current > 0 and total > 0 and current < total:
            per_item = elapsed / current
            remaining = per_item * (total - current)
            if remaining > 60:
                eta_str = f" · ETA: ~{int(remaining // 60)}m {int(remaining % 60)}s"
            else:
                eta_str = f" · ETA: ~{int(remaining)}s"

        full_msg = f"[{elapsed_str}] {msg}{eta_str}"
        if progress_callback:
            await progress_callback(step, current, total, full_msg)
        logger.info(f"[{step}] {full_msg} ({current}/{total})")

    try:
        # ── Step 1: Parse PDF ────────────────────────────
        await notify("parse", 0, 1, f"Parsing PDF: {name}")
        checkpoint.set_step("parse")

        pdf_info = parse_pdf(file_path)

        # Check for duplicates
        existing = await database.fetch_all(
            "textbooks", "sha256_hash = ?", (pdf_info.sha256_hash,)
        )
        if existing:
            return {
                "error": "duplicate",
                "message": f"This textbook has already been uploaded (ID: {existing[0]['id']})",
                "existing_id": existing[0]["id"],
            }

        # Save textbook record
        await database.insert("textbooks", {
            "id": textbook_id,
            "filename": pdf_info.filename,
            "name": name,
            "subject": subject,
            "sha256_hash": pdf_info.sha256_hash,
            "total_pages": pdf_info.total_pages,
            "total_chapters": len(pdf_info.chapters),
            "total_chars": pdf_info.total_chars,
            "total_images": pdf_info.total_images,
            "file_size_mb": pdf_info.file_size_mb,
            "status": "in_progress",
        })

        await notify("parse", 1, 1, f"PDF parsed: {pdf_info.total_pages} pages, {len(pdf_info.chapters)} chapters")

        # ── Step 2: Extract & chunk chapters ─────────────
        await notify("extract", 0, len(pdf_info.chapters), "Extracting chapter text and chunking")
        checkpoint.set_step("extract")

        all_chapter_ids = []
        all_chunks_data = []

        for idx, chapter in enumerate(pdf_info.chapters):
            chapter_id = f"{textbook_id}_ch{chapter.number:02d}"
            all_chapter_ids.append(chapter_id)

            if checkpoint.is_completed(f"extract_{chapter_id}"):
                await notify("extract", idx + 1, len(pdf_info.chapters), f"Skipping (cached): {chapter.title}")
                continue

            # Extract full text with page-level char offsets
            chapter_text = extract_chapter_text(pdf_info, chapter)
            if not chapter_text.strip():
                logger.warning(f"Chapter {chapter.number} '{chapter.title}' has no text")
                checkpoint.mark_completed(f"extract_{chapter_id}")
                continue

            page_nums = list(range(chapter.start_page, chapter.end_page))

            # Build page_char_map for accurate per-chunk page tracking
            page_char_map = {}
            running_offset = 0
            for pg_idx in range(chapter.start_page, chapter.end_page):
                if pg_idx < len(pdf_info.pages):
                    pg = pdf_info.pages[pg_idx]
                    page_char_map[pg_idx] = running_offset
                    running_offset += len(pg.text) + 2  # +2 for "\n\n" join

            chunks = chunk_text(
                chapter_text,
                page_numbers=page_nums,
                chunk_size=settings.chunk_size,
                chunk_overlap=settings.chunk_overlap,
                page_char_map=page_char_map,
            )

            # Save chapter to DB
            await database.insert("chapters", {
                "id": chapter_id,
                "textbook_id": textbook_id,
                "chapter_number": chapter.number,
                "name": chapter.title,
                "start_page": chapter.start_page,
                "end_page": chapter.end_page,
                "total_chars": len(chapter_text),
                "total_chunks": len(chunks),
                "status": "pending",
            })

            # Save chunks to DB
            for chunk in chunks:
                chunk_id = f"{chapter_id}_c{chunk.index:03d}"
                chunk_data = {
                    "id": chunk_id,
                    "chapter_id": chapter_id,
                    "textbook_id": textbook_id,
                    "chunk_index": chunk.index,
                    "text": chunk.text,
                    "page_numbers": chunk.page_numbers,
                    "section_heading": chunk.section_heading,
                    "char_count": chunk.char_count,
                    "has_diagrams": chunk.has_diagrams,
                }
                await database.insert("chunks", chunk_data)
                all_chunks_data.append(chunk_data)

            checkpoint.mark_completed(f"extract_{chapter_id}")
            await notify("extract", idx + 1, len(pdf_info.chapters),
                         f"Ch {chapter.number}/{len(pdf_info.chapters)}: {chapter.title} → {len(chunks)} chunks")

        total_chunks = len(all_chunks_data)
        await notify("extract", len(pdf_info.chapters), len(pdf_info.chapters),
                      f"All chapters extracted: {total_chunks} total chunks")

        # ── Step 3: Generate embeddings ──────────────────
        if all_chunks_data and not checkpoint.is_completed("embeddings_done"):
            await notify("embed", 0, total_chunks,
                         f"Loading embedding model (first time downloads ~420MB)...")
            checkpoint.set_step("embed")

            # Pre-load the model so we can show progress
            logger.info("Loading PubMedBERT embedding model...")
            model_start = time.time()
            embedder._get_model()  # Force model load
            model_time = time.time() - model_start
            logger.info(f"Embedding model loaded in {model_time:.1f}s")

            await notify("embed", 0, total_chunks,
                         f"Model loaded ({model_time:.0f}s). Generating embeddings for {total_chunks} chunks...")

            # Process in batches of 64 with progress updates
            batch_size = 64
            all_embedding_ids = []

            for batch_start in range(0, total_chunks, batch_size):
                batch_end = min(batch_start + batch_size, total_chunks)
                batch_chunks = all_chunks_data[batch_start:batch_end]

                embedding_ids = embedder.store_chunks(
                    subject=subject,
                    chunks=batch_chunks,
                    textbook_id=textbook_id,
                )
                all_embedding_ids.extend(embedding_ids)

                # Update chunk records
                for i, chunk_data in enumerate(batch_chunks):
                    if i < len(embedding_ids):
                        await database.update("chunks", chunk_data["id"], {
                            "embedding_id": embedding_ids[i],
                        })

                await notify("embed", batch_end, total_chunks,
                             f"Embedded {batch_end}/{total_chunks} chunks")

            checkpoint.mark_completed("embeddings_done")
            await notify("embed", total_chunks, total_chunks,
                         f"All {total_chunks} embeddings stored in ChromaDB")
        else:
            await notify("embed", total_chunks, total_chunks, "Embeddings already done (cached)")

        # ── Step 4: Build KB via Claude Batch ────────────
        await notify("knowledge", 0, len(all_chapter_ids), "Preparing Claude batch for chapter summaries")
        checkpoint.set_step("knowledge")

        batch_requests = []
        for chapter_id in all_chapter_ids:
            if checkpoint.is_completed(f"kb_{chapter_id}"):
                continue

            chapter_data = await database.fetch_one("chapters", chapter_id)
            if not chapter_data:
                continue

            chapter_chunks = await database.fetch_all(
                "chunks", "chapter_id = ?", (chapter_id,), "chunk_index ASC"
            )
            chapter_text = "\n\n".join(c["text"] for c in chapter_chunks)

            if not chapter_text.strip():
                checkpoint.mark_completed(f"kb_{chapter_id}")
                continue

            max_chars = 48000
            if len(chapter_text) > max_chars:
                chapter_text = chapter_text[:max_chars] + "\n\n[Text truncated for processing]"

            batch_requests.append({
                "custom_id": chapter_id,
                "system": SUMMARY_SYSTEM_PROMPT,
                "messages": [{
                    "role": "user",
                    "content": (
                        f"Analyze this chapter from the textbook '{name}'.\n"
                        f"Chapter: {chapter_data['name']}\n\n"
                        f"--- CHAPTER TEXT ---\n{chapter_text}\n--- END ---"
                    ),
                }],
            })

        total_time = time.time() - pipeline_start
        time_str = f"{int(total_time // 60)}m {int(total_time % 60)}s"

        if batch_requests:
            client = get_claude_client()

            # ── Submit KB Summary Batch ──
            kb_batch_id = await client.request_batch(
                requests=batch_requests,
                model=settings.haiku_model,
                task_type="kb_summary",
                subject=subject,
            )
            checkpoint.set_meta("kb_batch_id", kb_batch_id)
            await notify("knowledge", len(batch_requests), len(batch_requests),
                         f"KB batch submitted: {kb_batch_id} ({len(batch_requests)} chapters)")

            # ── Step 5: Submit KG Extraction Batch (automatic) ──
            kg_batch_id = None
            try:
                from knowledge.graph_builder import _build_kg_batch_requests, CONCEPT_EXTRACTION_SYSTEM
                kg_requests = await _build_kg_batch_requests(textbook_id, name, subject, all_chapter_ids)
                if kg_requests:
                    kg_batch_id = await client.request_batch(
                        requests=kg_requests,
                        model=settings.haiku_model,
                        task_type="kg_extraction",
                        subject=subject,
                    )
                    checkpoint.set_meta("kg_batch_id", kg_batch_id)
                    await notify("knowledge", len(batch_requests), len(batch_requests),
                                 f"KG batch submitted: {kg_batch_id} ({len(kg_requests)} chapters)")
            except Exception as kg_err:
                logger.warning(f"KG batch submission failed (KB still processing): {kg_err}")

            await database.update("textbooks", textbook_id, {
                "status": "batch_pending",
                "kg_status": "kg_batch_pending" if kg_batch_id else "not_built",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

            return {
                "textbook_id": textbook_id,
                "status": "batch_pending",
                "kb_batch_id": kb_batch_id,
                "kg_batch_id": kg_batch_id,
                "chapters": len(all_chapter_ids),
                "chunks": total_chunks,
                "processing_time": time_str,
                "message": (
                    f"Local processing complete ({time_str}). "
                    f"{len(all_chapter_ids)} chapters, {total_chunks} chunks embedded. "
                    f"KB + KG batches submitted — click 'Check Batch' when ready."
                ),
            }
        else:
            await database.update("textbooks", textbook_id, {
                "status": "completed",
                "kg_status": "not_built",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

            return {
                "textbook_id": textbook_id,
                "status": "completed",
                "chapters": len(all_chapter_ids),
                "chunks": total_chunks,
                "processing_time": time_str,
                "message": f"All done in {time_str}. Knowledge base already built.",
            }

    except Exception as e:
        logger.error(f"Textbook ingestion failed: {e}", exc_info=True)
        await database.update("textbooks", textbook_id, {"status": "failed"})
        await database.log_activity("error", "ingest", f"Failed: {e}")
        raise


async def process_kb_batch_results(textbook_id: str, batch_id: str) -> dict:
    """Process the results of a KB batch job. Also processes KG batch if present."""
    client = get_claude_client()
    batch_result = await client.poll_batch(batch_id)

    if batch_result["status"] != "ended":
        return {
            "status": batch_result["status"],
            "message": f"Batch still processing. Status: {batch_result['status']}",
            "request_counts": batch_result.get("request_counts", {}),
        }

    results = batch_result.get("results", {})
    success_count = 0
    error_count = 0

    for chapter_id, result in results.items():
        if result["status"] == "success":
            data = result["data"]
            update_data = {
                "summary": data.get("summary", ""),
                "topics": data.get("topics", []),
                "key_terms": data.get("key_terms", []),
                "exam_likely_topics": data.get("exam_likely_topics", []),
                "status": "completed",
            }
            await database.update("chapters", chapter_id, update_data)
            success_count += 1
        else:
            await database.update("chapters", chapter_id, {"status": "failed"})
            error_count += 1
            logger.error(f"KB generation failed for {chapter_id}: {result.get('error')}")

    kb_status = "completed" if error_count == 0 else "needs_review"

    # ── Also process KG batch if available ──
    kg_result = None
    from state.checkpoint import Checkpoint
    checkpoint = Checkpoint("ingest_textbook", f"{textbook_id}")
    # Try the ingestion checkpoint first (new integrated flow)
    kg_batch_id = checkpoint.get_meta("kg_batch_id")

    if not kg_batch_id:
        # Fallback: try the standalone KG checkpoint (old separate flow)
        # Load by textbook subject + id pattern
        textbook = await database.fetch_one("textbooks", textbook_id)
        if textbook:
            cp2 = Checkpoint("ingest_textbook", f"{textbook['subject']}_{textbook_id}")
            kg_batch_id = cp2.get_meta("kg_batch_id")
        if not kg_batch_id:
            cp3 = Checkpoint("build_kg", textbook_id)
            kg_batch_id = cp3.get_meta("kg_batch_id")

    if kg_batch_id:
        try:
            from knowledge.graph_builder import process_kg_batch_results
            kg_result = await process_kg_batch_results(textbook_id, kg_batch_id)
            logger.info(f"KG batch processed: {kg_result.get('message', '')}")
        except Exception as e:
            logger.warning(f"KG batch processing failed (KB still OK): {e}")
            kg_result = {"status": "failed", "message": str(e)}

    final_status = kb_status
    await database.update("textbooks", textbook_id, {
        "status": final_status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })

    message = f"KB complete: {success_count} chapters succeeded, {error_count} failed."
    if kg_result:
        message += f" KG: {kg_result.get('message', 'processed')}"

    return {
        "status": final_status,
        "succeeded": success_count,
        "failed": error_count,
        "kg_result": kg_result,
        "message": message,
    }

