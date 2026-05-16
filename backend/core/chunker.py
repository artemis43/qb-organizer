# qb-organizer/backend/core/chunker.py
"""Section-aware text chunking for embedding generation.

Splits chapter text into overlapping chunks while respecting section boundaries.
Each chunk is ~500 tokens with ~100 token overlap.
"""

import json
import re
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Rough estimate: 1 token ≈ 4 characters for English text
CHARS_PER_TOKEN = 4


@dataclass
class Chunk:
    index: int
    text: str
    page_numbers: list[int]
    section_heading: str | None
    char_count: int
    token_estimate: int
    has_diagrams: bool


def estimate_tokens(text: str) -> int:
    """Rough token estimate."""
    return len(text) // CHARS_PER_TOKEN


def split_into_sections(text: str) -> list[dict]:
    """Split chapter text into sections based on heading patterns.
    
    Detects headings by:
    - ALL CAPS lines (common in medical textbooks)
    - Lines followed by content that look like section titles
    """
    sections = []
    current_heading = None
    current_text = []

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            current_text.append("")
            continue

        # Detect section headings:
        # 1. ALL CAPS with at least 3 chars (e.g., "OSTEOTOMY", "PHASE I - EMERGENCY CARE")
        is_heading = (
            stripped.isupper() and
            len(stripped) >= 3 and
            len(stripped) <= 100 and  # Not a full paragraph in caps
            not stripped.startswith("•") and
            not stripped.startswith("-")
        )
        # 2. Title case with short length (e.g., "Treatment of Fractures")
        if not is_heading:
            words = stripped.split()
            is_heading = (
                len(words) <= 8 and
                len(stripped) <= 80 and
                stripped[0].isupper() and
                not stripped.endswith(".") and
                not stripped.startswith("•") and
                not stripped.startswith("-") and
                sum(1 for w in words if w[0].isupper()) >= len(words) * 0.5
            )

        if is_heading and current_text:
            # Save previous section
            sections.append({
                "heading": current_heading,
                "text": "\n".join(current_text).strip(),
            })
            current_heading = stripped
            current_text = []
        elif is_heading and not current_text:
            current_heading = stripped
        else:
            current_text.append(line)

    # Don't forget the last section
    if current_text:
        sections.append({
            "heading": current_heading,
            "text": "\n".join(current_text).strip(),
        })

    return [s for s in sections if s["text"].strip()]


def _resolve_pages(text_start: int, text_end: int, page_char_map: dict[int, int] | None, fallback_pages: list[int]) -> list[int]:
    """Determine which pages a text span falls on using the char offset map."""
    if not page_char_map:
        return fallback_pages

    # Sort pages by char offset
    sorted_pages = sorted(page_char_map.items(), key=lambda x: x[1])
    pages = []
    for i, (page_idx, start_offset) in enumerate(sorted_pages):
        # Determine end of this page's content
        if i + 1 < len(sorted_pages):
            end_offset = sorted_pages[i + 1][1]
        else:
            end_offset = float("inf")

        # Check if chunk overlaps this page
        if text_start < end_offset and text_end > start_offset:
            pages.append(page_idx)

    return pages if pages else fallback_pages


def chunk_text(
    text: str,
    page_numbers: list[int],
    chunk_size: int = 500,
    chunk_overlap: int = 100,
    page_char_map: dict[int, int] | None = None,
) -> list[Chunk]:
    """Split text into overlapping chunks, respecting section boundaries.

    Args:
        text: The full chapter text.
        page_numbers: List of page numbers for this chapter.
        chunk_size: Target chunk size in tokens.
        chunk_overlap: Overlap size in tokens.
        page_char_map: Optional mapping of page# → char_offset for page tracking.

    Returns:
        List of Chunk objects.
    """
    chunk_size_chars = chunk_size * CHARS_PER_TOKEN
    overlap_chars = chunk_overlap * CHARS_PER_TOKEN

    # First, split into sections
    sections = split_into_sections(text)

    if not sections:
        # Fallback: treat entire text as one section
        sections = [{"heading": None, "text": text}]

    chunks = []
    chunk_idx = 0
    global_char_offset = 0  # Track position in full chapter text

    for section in sections:
        section_text = section["text"]
        section_heading = section["heading"]

        if not section_text.strip():
            continue

        # Find where this section starts in the full text
        section_start_in_text = text.find(section_text, global_char_offset)
        if section_start_in_text < 0:
            section_start_in_text = global_char_offset  # fallback

        # If section is small enough, make it one chunk
        if len(section_text) <= chunk_size_chars:
            chunk_pages = _resolve_pages(
                section_start_in_text,
                section_start_in_text + len(section_text),
                page_char_map, page_numbers,
            )
            # Store as JSON string for DB compatibility
            chunk_pages_json = json.dumps(chunk_pages)
            chunks.append(Chunk(
                index=chunk_idx,
                text=section_text.strip(),
                page_numbers=chunk_pages_json,
                section_heading=section_heading,
                char_count=len(section_text),
                token_estimate=estimate_tokens(section_text),
                has_diagrams=bool(re.search(r'\b(fig|figure|diagram|illustration)\b', section_text, re.IGNORECASE)),
            ))
            chunk_idx += 1
            global_char_offset = section_start_in_text + len(section_text)
            continue

        # Split large sections by paragraphs
        paragraphs = re.split(r'\n\s*\n', section_text)
        current_chunk = ""
        current_chunk_start = section_start_in_text

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            # If adding this paragraph would exceed chunk size
            if len(current_chunk) + len(para) > chunk_size_chars and current_chunk:
                # Resolve pages for this chunk
                chunk_pages = _resolve_pages(
                    current_chunk_start,
                    current_chunk_start + len(current_chunk),
                    page_char_map, page_numbers,
                )
                chunk_pages_json = json.dumps(chunk_pages)
                chunks.append(Chunk(
                    index=chunk_idx,
                    text=current_chunk.strip(),
                    page_numbers=chunk_pages_json,
                    section_heading=section_heading,
                    char_count=len(current_chunk),
                    token_estimate=estimate_tokens(current_chunk),
                    has_diagrams=bool(re.search(r'\b(fig|figure|diagram|illustration)\b', current_chunk, re.IGNORECASE)),
                ))
                chunk_idx += 1

                # Start new chunk with overlap from end of previous
                overlap_text = current_chunk[-overlap_chars:] if len(current_chunk) > overlap_chars else current_chunk
                current_chunk_start = current_chunk_start + len(current_chunk) - len(overlap_text)
                current_chunk = overlap_text + "\n\n" + para
            else:
                if current_chunk:
                    current_chunk += "\n\n" + para
                else:
                    current_chunk = para

        # Don't forget the last chunk in this section
        if current_chunk.strip():
            chunk_pages = _resolve_pages(
                current_chunk_start,
                current_chunk_start + len(current_chunk),
                page_char_map, page_numbers,
            )
            chunk_pages_json = json.dumps(chunk_pages)
            chunks.append(Chunk(
                index=chunk_idx,
                text=current_chunk.strip(),
                page_numbers=chunk_pages_json,
                section_heading=section_heading,
                char_count=len(current_chunk),
                token_estimate=estimate_tokens(current_chunk),
                has_diagrams=bool(re.search(r'\b(fig|figure|diagram|illustration)\b', current_chunk, re.IGNORECASE)),
            ))
            chunk_idx += 1

        global_char_offset = section_start_in_text + len(section_text)

    logger.debug(
        f"Chunked text into {len(chunks)} chunks "
        f"(avg {sum(c.token_estimate for c in chunks) // max(len(chunks), 1)} tokens/chunk)"
    )

    return chunks

