# qb-organizer/backend/core/pdf_parser.py
"""PDF text extraction using PyMuPDF — handles textbook and question paper PDFs.

Extracts:
- Table of Contents (chapter structure)
- Page-by-page text with page number mapping
- Font size analysis for section heading detection
- Image presence per page
"""

import fitz  # PyMuPDF
import hashlib
import logging
import re
import unicodedata
from pathlib import Path
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class PageContent:
    page_index: int  # 0-indexed PDF page
    text: str
    char_count: int
    image_count: int
    headings: list[dict] = field(default_factory=list)  # [{text, font_size, level}]


@dataclass
class TOCEntry:
    level: int
    title: str
    page_index: int  # 0-indexed


@dataclass
class ChapterInfo:
    number: int
    title: str
    start_page: int  # 0-indexed
    end_page: int  # 0-indexed, exclusive
    page_count: int


@dataclass
class PDFInfo:
    filename: str
    file_path: str
    sha256_hash: str
    total_pages: int
    total_chars: int
    total_images: int
    file_size_mb: float
    has_toc: bool
    toc_entries: list[TOCEntry]
    chapters: list[ChapterInfo]
    pages: list[PageContent]


def compute_sha256(file_path: str) -> str:
    """Compute SHA-256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def clean_text(text: str) -> str:
    """Normalize and clean extracted text."""
    # Normalize unicode characters
    text = unicodedata.normalize("NFKD", text)
    # Replace special whitespace with regular space
    text = re.sub(r'[\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b]', ' ', text)
    # Fix common encoding artifacts
    text = text.replace('\ufffd', "'")  # replacement character → apostrophe
    text = text.replace('\u2019', "'")  # right single quote
    text = text.replace('\u2018', "'")  # left single quote
    text = text.replace('\u201c', '"')  # left double quote
    text = text.replace('\u201d', '"')  # right double quote
    text = text.replace('\u2013', '-')  # en dash
    text = text.replace('\u2014', '-')  # em dash
    text = text.replace('\u2026', '...')  # ellipsis
    # Remove null bytes
    text = text.replace('\x00', '')
    # Normalize line endings
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    # Collapse multiple blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Collapse multiple spaces
    text = re.sub(r'[ \t]{2,}', ' ', text)
    return text.strip()


def remove_watermarks(text: str) -> str:
    """Remove known watermark patterns from extracted text."""
    watermark_patterns = [
        r'tahir99\s*-?\s*UnitedVRG',
        r'Kickass\s+Torrents',
        r'@neetpgbyme',
        r'Downloaded\s+from\s+.*',
        r'www\.\w+\.com',
    ]
    for pattern in watermark_patterns:
        text = re.sub(pattern, '', text, flags=re.IGNORECASE)
    return text.strip()


def detect_headings(page: fitz.Page) -> list[dict]:
    """Detect headings by analyzing font sizes on a page."""
    headings = []
    try:
        blocks = page.get_text("dict")["blocks"]
        for block in blocks:
            if block.get("type") != 0:  # text blocks only
                continue
            for line in block.get("lines", []):
                line_text = ""
                max_size = 0
                for span in line.get("spans", []):
                    line_text += span.get("text", "")
                    max_size = max(max_size, span.get("size", 0))
                
                line_text = line_text.strip()
                if not line_text or len(line_text) < 3:
                    continue

                # Classify by font size (based on Maheswari analysis)
                if max_size >= 14:
                    headings.append({"text": line_text, "font_size": max_size, "level": 1})
                elif max_size >= 12:
                    headings.append({"text": line_text, "font_size": max_size, "level": 2})
                elif max_size >= 11:
                    headings.append({"text": line_text, "font_size": max_size, "level": 3})
    except Exception as e:
        logger.warning(f"Heading detection failed on page: {e}")
    return headings


def parse_pdf(file_path: str) -> PDFInfo:
    """Parse a PDF file and extract all content.

    Args:
        file_path: Path to the PDF file.

    Returns:
        PDFInfo with all extracted content.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"PDF not found: {file_path}")

    logger.info(f"Parsing PDF: {path.name}")

    # Compute hash for dedup detection
    sha256 = compute_sha256(file_path)
    file_size_mb = round(path.stat().st_size / (1024 * 1024), 2)

    doc = fitz.open(file_path)

    # ── Extract TOC ──────────────────────────────────────
    raw_toc = doc.get_toc()
    toc_entries = []
    for entry in raw_toc:
        level, title, page_num = entry[0], entry[1], entry[2]
        toc_entries.append(TOCEntry(
            level=level,
            title=title.strip(),
            page_index=max(0, page_num - 1),  # Convert 1-based to 0-based
        ))

    has_toc = len(toc_entries) > 0
    logger.info(f"TOC: {len(toc_entries)} entries found")

    # ── Build chapter list from TOC ──────────────────────
    chapters = []
    # Filter to top-level entries that look like chapters
    chapter_entries = [e for e in toc_entries if e.level == 1]

    for i, entry in enumerate(chapter_entries):
        # Skip non-chapter entries (Index, Prelims, etc.)
        is_chapter = (
            "chapter" in entry.title.lower() or
            "chapter" in entry.title.lower().replace("-", " ") or
            re.match(r'chapter[\s\-_]*\d+', entry.title, re.IGNORECASE)
        )
        # Also include entries that are clearly content sections
        if not is_chapter and entry.title.lower() in ("prelims", "index", "annexures", "bibliography"):
            continue

        # Determine end page
        if i < len(chapter_entries) - 1:
            end_page = chapter_entries[i + 1].page_index
        else:
            end_page = doc.page_count

        # Clean title
        title = re.sub(r'^Chapter[\s\-_]*\d+[\s\-_]*', '', entry.title, flags=re.IGNORECASE).strip()
        if not title:
            title = entry.title.strip()

        chapters.append(ChapterInfo(
            number=len(chapters) + 1,
            title=title,
            start_page=entry.page_index,
            end_page=end_page,
            page_count=end_page - entry.page_index,
        ))

    logger.info(f"Chapters: {len(chapters)} detected")

    # ── Extract page-by-page content ─────────────────────
    pages = []
    total_chars = 0
    total_images = 0

    for page_idx in range(doc.page_count):
        try:
            page = doc.load_page(page_idx)
            raw_text = page.get_text()
            cleaned = clean_text(raw_text)
            cleaned = remove_watermarks(cleaned)

            image_count = len(page.get_images())
            headings = detect_headings(page)

            pages.append(PageContent(
                page_index=page_idx,
                text=cleaned,
                char_count=len(cleaned),
                image_count=image_count,
                headings=headings,
            ))

            total_chars += len(cleaned)
            total_images += image_count

        except Exception as e:
            logger.error(f"Error extracting page {page_idx}: {e}")
            pages.append(PageContent(
                page_index=page_idx,
                text=f"[ERROR: Could not extract page {page_idx}: {e}]",
                char_count=0,
                image_count=0,
            ))

    doc.close()

    result = PDFInfo(
        filename=path.name,
        file_path=str(path.absolute()),
        sha256_hash=sha256,
        total_pages=len(pages),
        total_chars=total_chars,
        total_images=total_images,
        file_size_mb=file_size_mb,
        has_toc=has_toc,
        toc_entries=toc_entries,
        chapters=chapters,
        pages=pages,
    )

    logger.info(
        f"PDF parsed: {result.total_pages} pages, {result.total_chars} chars, "
        f"{result.total_images} images, {len(result.chapters)} chapters"
    )

    return result


def extract_chapter_text(pdf_info: PDFInfo, chapter: ChapterInfo) -> str:
    """Extract the full text for a specific chapter."""
    texts = []
    for page in pdf_info.pages:
        if chapter.start_page <= page.page_index < chapter.end_page:
            if page.text and not page.text.startswith("[ERROR"):
                texts.append(page.text)
    return "\n\n".join(texts)


def extract_chapter_pages(pdf_info: PDFInfo, chapter: ChapterInfo) -> list[PageContent]:
    """Get all pages belonging to a chapter."""
    return [
        p for p in pdf_info.pages
        if chapter.start_page <= p.page_index < chapter.end_page
    ]


def extract_page_images(
    pdf_path: str,
    page_indices: list[int],
    output_dir: str,
    textbook_id: str,
) -> list[dict]:
    """Extract images from specific PDF pages and save to output_dir.

    Returns list of dicts: {filename, page, width, height, caption}
    """
    import os
    os.makedirs(output_dir, exist_ok=True)

    doc = fitz.open(pdf_path)
    extracted = []

    for page_idx in page_indices:
        if page_idx >= doc.page_count:
            continue
        page = doc.load_page(page_idx)
        images = page.get_images(full=True)

        for img_idx, img_info in enumerate(images):
            xref = img_info[0]
            try:
                base_image = doc.extract_image(xref)
                if not base_image:
                    continue

                image_bytes = base_image["image"]
                ext = base_image.get("ext", "png")
                width = base_image.get("width", 0)
                height = base_image.get("height", 0)

                # Skip very small images (icons, bullets, etc.)
                if width < 80 or height < 80:
                    continue

                filename = f"{textbook_id}_p{page_idx + 1}_img{img_idx}.{ext}"
                filepath = Path(output_dir) / filename

                with open(filepath, "wb") as f:
                    f.write(image_bytes)

                # Try to extract nearby text as caption
                caption = _extract_figure_caption(page, page_idx)

                extracted.append({
                    "filename": filename,
                    "page": page_idx + 1,  # 1-indexed for display
                    "width": width,
                    "height": height,
                    "caption": caption,
                    "path": str(filepath),
                })
            except Exception as e:
                logger.warning(f"Failed to extract image {img_idx} from page {page_idx}: {e}")

    doc.close()
    return extracted


def _extract_figure_caption(page: fitz.Page, page_idx: int) -> str:
    """Try to extract figure/diagram caption text from the page."""
    try:
        text = page.get_text()
        captions = []
        # Match many common caption patterns in medical textbooks
        patterns = [
            r'^(Fig\.?\s*\d+)',                    # Fig 1, Fig. 1
            r'^(Figure\s*\d+)',                     # Figure 1
            r'^(Diagram\s*\d+)',                    # Diagram 1
            r'^(Illustration\s*\d+)',               # Illustration 1
            r'^(Chart\s*\d+)',                      # Chart 1
            r'^(Table\s*\d+)',                      # Table 1
            r'^(Plate\s*\d+)',                      # Plate 1
            r'^(Fig\.?\s*\d+[\.\-:]\s*\d+)',        # Fig 1.1, Fig 1-1
        ]
        for line in text.split("\n"):
            stripped = line.strip()
            if not stripped or len(stripped) < 4:
                continue
            for pattern in patterns:
                if re.match(pattern, stripped, re.IGNORECASE):
                    captions.append(stripped[:200])
                    break
        return " | ".join(captions) if captions else ""
    except Exception:
        pass
    return ""

