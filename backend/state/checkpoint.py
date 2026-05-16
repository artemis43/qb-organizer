# qb-organizer/backend/state/checkpoint.py
"""Checkpoint/resume system — saves progress at every step so processing
can resume from the exact point of interruption."""

import json
import logging
from pathlib import Path
from datetime import datetime, timezone
from config import settings

logger = logging.getLogger(__name__)


class Checkpoint:
    """Persistent checkpoint manager for long-running pipeline tasks."""

    def __init__(self, task_name: str, subject: str):
        self.task_name = task_name
        self.subject = subject
        safe_name = f"{task_name}_{subject}".replace(" ", "_").lower()
        self.path = settings.checkpoints_dir / f"{safe_name}.json"
        self.data = self._load()

    def _load(self) -> dict:
        """Load existing checkpoint or create new."""
        if self.path.exists():
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                logger.info(f"Resumed checkpoint: {self.path.name}")
                return data
            except (json.JSONDecodeError, IOError):
                logger.warning(f"Corrupt checkpoint {self.path.name}, starting fresh")
        return {
            "task": self.task_name,
            "subject": self.subject,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "completed_items": [],
            "failed_items": [],
            "current_step": None,
            "metadata": {},
        }

    def _save(self):
        """Persist checkpoint to disk."""
        self.data["updated_at"] = datetime.now(timezone.utc).isoformat()
        # Write to temp file first, then rename (atomic on most OS)
        tmp_path = self.path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
        tmp_path.replace(self.path)

    def is_completed(self, item_id: str) -> bool:
        """Check if an item has already been processed."""
        return item_id in self.data["completed_items"]

    def mark_completed(self, item_id: str):
        """Mark an item as successfully processed."""
        if item_id not in self.data["completed_items"]:
            self.data["completed_items"].append(item_id)
        # Remove from failed if it was there
        if item_id in self.data["failed_items"]:
            self.data["failed_items"].remove(item_id)
        self._save()

    def mark_failed(self, item_id: str, error: str = ""):
        """Mark an item as failed."""
        if item_id not in self.data["failed_items"]:
            self.data["failed_items"].append(item_id)
        self.data.setdefault("errors", {})[item_id] = {
            "error": error,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        self._save()

    def set_step(self, step: str):
        """Set the current processing step."""
        self.data["current_step"] = step
        self._save()

    def set_meta(self, key: str, value):
        """Store arbitrary metadata."""
        self.data["metadata"][key] = value
        self._save()

    def get_meta(self, key: str, default=None):
        """Retrieve metadata."""
        return self.data["metadata"].get(key, default)

    @property
    def completed_count(self) -> int:
        return len(self.data["completed_items"])

    @property
    def failed_count(self) -> int:
        return len(self.data["failed_items"])

    @property
    def pending_items(self) -> list[str]:
        """Items that were neither completed nor failed."""
        all_items = set(self.data.get("all_items", []))
        done = set(self.data["completed_items"])
        failed = set(self.data["failed_items"])
        return list(all_items - done - failed)

    def register_items(self, item_ids: list[str]):
        """Register all items to be processed (for tracking pending)."""
        self.data["all_items"] = list(set(
            self.data.get("all_items", []) + item_ids
        ))
        self._save()

    def reset(self):
        """Reset checkpoint (start over)."""
        if self.path.exists():
            self.path.unlink()
        self.data = self._load()

    def summary(self) -> dict:
        """Return a summary of checkpoint state."""
        total = len(self.data.get("all_items", []))
        return {
            "task": self.task_name,
            "subject": self.subject,
            "current_step": self.data["current_step"],
            "total": total,
            "completed": self.completed_count,
            "failed": self.failed_count,
            "pending": total - self.completed_count - self.failed_count,
            "percentage": (self.completed_count / total * 100) if total > 0 else 0,
        }
