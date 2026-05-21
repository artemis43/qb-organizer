# qb-organizer/backend/qb/imagekit_uploader.py
"""Upload local images to ImageKit CDN directly via Server SDK.

Bypasses the client-side auth service for faster, rate-limit-free 
server-to-server uploads. Compatible with imagekitio v5+.
"""

import logging
import asyncio
from pathlib import Path
from imagekitio import ImageKit

from config import settings

logger = logging.getLogger(__name__)

# Initialize ImageKit lazily
_imagekit_client = None

def get_imagekit_client():
    global _imagekit_client
    if _imagekit_client is None:
        # ImageKit SDK v5+ only requires the private_key for server-side operations
        priv_key = settings.imagekit_private_key
        
        if not priv_key:
            logger.error("ImageKit credentials missing in config.py / .env")
            return None
            
        _imagekit_client = ImageKit(private_key=priv_key)
    return _imagekit_client

def _upload_sync(file_path: str, filename: str, folder: str, tags: list[str]) -> str:
    """Synchronous SDK upload function to be run in a thread."""
    client = get_imagekit_client()
    if not client:
        return None

    try:
        # In ImageKit Python SDK v5.x, upload is handled via client.files.upload
        result = client.files.upload(
            file=Path(file_path),
            file_name=filename,
            folder=folder,
            tags=tags
        )
        return result.url
    except Exception as e:
        logger.error(f"ImageKit SDK upload failed for {filename}: {e}")
        return None

async def upload_image(
    file_path: str,
    filename: str = None,
    folder: str = None,
    tags: list[str] = None,
) -> str | None:
    """Upload a local image file to ImageKit using asyncio threads."""
    path = Path(file_path)
    if not path.exists():
        logger.warning(f"Image file not found: {file_path}")
        return None

    filename = filename or path.name
    folder = folder or getattr(settings, "imagekit_upload_folder", "/qb_organizer")
    tags = tags or ["answer_image", "qb_organizer"]

    # Run the synchronous SDK call in a background thread to prevent blocking FastAPI
    url = await asyncio.to_thread(_upload_sync, str(path), filename, folder, tags)
    
    if url:
        logger.info(f"Uploaded {filename} → {url}")
    return url

async def upload_answer_images(images: list[dict], subject: str = "") -> list[str]:
    """Upload multiple answer images and return CDN URLs.

    Args:
        images: List of image dicts from the answers table
                Each has: filename, page, caption, path
        subject: Subject name for folder organization

    Returns:
        List of ImageKit CDN URLs (empty strings for failed uploads)
    """
    urls = []
    base_folder = getattr(settings, "imagekit_upload_folder", "/qb_organizer")
    
    # Sanitize subject name for folder path
    clean_subject = subject.replace(" ", "_").lower() if subject else "general"
    folder = f"{base_folder}/{clean_subject}"

    for img in images:
        file_path = img.get("path", "")
        if not file_path:
            # Reconstruct path from filename pattern if path is missing
            filename = img.get("filename", "")
            if filename:
                parts = filename.split("_p")
                if parts:
                    tb_id = parts[0]
                    file_path = str(settings.data_dir / "images" / tb_id / filename)

        if not file_path or not Path(file_path).exists():
            logger.warning(f"Image file not found, skipping: {img.get('filename', 'unknown')}")
            urls.append("")
            continue

        url = await upload_image(
            file_path,
            filename=img.get("filename"),
            folder=folder,
            tags=["answer_image", clean_subject],
        )
        urls.append(url or "")

    uploaded_count = len([u for u in urls if u])
    logger.info(f"Uploaded {uploaded_count}/{len(images)} images to ImageKit")
    return urls