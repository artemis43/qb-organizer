# qb-organizer/backend/qb/imagekit_uploader.py
"""Upload local images to ImageKit CDN.

Uses the same auth service as the admin dashboard:
  1. Get auth params from the auth service (signature, token, expire)
  2. Upload image file to ImageKit upload API
  3. Return the CDN URL
"""

import logging
import mimetypes
from pathlib import Path

import httpx

from config import settings

logger = logging.getLogger(__name__)

IMAGEKIT_UPLOAD_URL = "https://upload.imagekit.io/api/v2/files/upload"


async def _get_auth_params() -> dict:
    """Get authentication parameters from the auth service."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(settings.imagekit_auth_url)
        resp.raise_for_status()
        return resp.json()


async def upload_image(
    file_path: str,
    filename: str = None,
    folder: str = None,
    tags: list[str] = None,
) -> str | None:
    """Upload a local image file to ImageKit.

    Returns the ImageKit CDN URL, or None on failure.
    """
    path = Path(file_path)
    if not path.exists():
        logger.warning(f"Image file not found: {file_path}")
        return None

    filename = filename or path.name
    folder = folder or settings.imagekit_upload_folder
    tags = tags or ["answer_image", "qb_organizer"]

    try:
        auth = await _get_auth_params()
        mime_type = mimetypes.guess_type(str(path))[0] or "image/png"

        async with httpx.AsyncClient(timeout=30.0) as client:
            with open(path, "rb") as f:
                files = {"file": (filename, f, mime_type)}
                data = {
                    "fileName": filename,
                    "useUniqueFileName": "true",
                    "folder": folder,
                    "publicKey": settings.imagekit_public_key,
                    "signature": auth["signature"],
                    "expire": str(auth["expire"]),
                    "token": auth["token"],
                    "tags": ",".join(tags),
                }
                resp = await client.post(IMAGEKIT_UPLOAD_URL, data=data, files=files)
                resp.raise_for_status()
                result = resp.json()

        url = result.get("url")
        if url:
            logger.info(f"Uploaded {filename} → {url}")
            return url
        else:
            logger.error(f"ImageKit upload returned no URL: {result}")
            return None

    except httpx.HTTPStatusError as e:
        logger.error(f"ImageKit upload failed ({e.response.status_code}): {e.response.text}")
        return None
    except Exception as e:
        logger.error(f"ImageKit upload error for {filename}: {e}")
        return None


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
    folder = f"{settings.imagekit_upload_folder}/{subject}" if subject else settings.imagekit_upload_folder

    for img in images:
        file_path = img.get("path", "")
        if not file_path:
            # Reconstruct path from filename pattern: {textbook_id}_p{page}_img{idx}.{ext}
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
            tags=["answer_image", subject] if subject else None,
        )
        urls.append(url or "")

    uploaded_count = len([u for u in urls if u])
    logger.info(f"Uploaded {uploaded_count}/{len(images)} images to ImageKit")
    return urls
