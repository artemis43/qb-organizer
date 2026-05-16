# qb-organizer/backend/state/db.py
"""SQLite database management with async support and auto-migrations."""

import aiosqlite
import json
import logging
from pathlib import Path
from datetime import datetime, timezone
from config import settings

logger = logging.getLogger(__name__)

DB_PATH = str(settings.db_path)

SCHEMA_SQL = """
-- Textbooks
CREATE TABLE IF NOT EXISTS textbooks (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    sha256_hash TEXT UNIQUE NOT NULL,
    total_pages INTEGER DEFAULT 0,
    total_chapters INTEGER DEFAULT 0,
    total_chars INTEGER DEFAULT 0,
    total_images INTEGER DEFAULT 0,
    file_size_mb REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Chapters
CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    textbook_id TEXT NOT NULL,
    chapter_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    start_page INTEGER NOT NULL,
    end_page INTEGER NOT NULL,
    total_chars INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    summary TEXT,
    topics TEXT,          -- JSON array
    key_terms TEXT,       -- JSON array
    exam_likely_topics TEXT,  -- JSON array
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (textbook_id) REFERENCES textbooks(id)
);

-- Text Chunks
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    textbook_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    page_numbers TEXT NOT NULL,  -- JSON array
    section_heading TEXT,
    char_count INTEGER DEFAULT 0,
    has_diagrams INTEGER DEFAULT 0,
    embedding_id TEXT,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id),
    FOREIGN KEY (textbook_id) REFERENCES textbooks(id)
);

-- Question Papers
CREATE TABLE IF NOT EXISTS question_papers (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    subject TEXT NOT NULL,
    university TEXT,
    year INTEGER,
    month TEXT,
    paper_number TEXT,
    total_pages INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 0,
    sha256_hash TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
);

-- Extracted Questions
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    qp_id TEXT NOT NULL,
    question_number TEXT,
    question_text TEXT NOT NULL,
    question_type TEXT DEFAULT 'OTHER',
    marks INTEGER,
    has_sub_parts INTEGER DEFAULT 0,
    sub_parts TEXT,       -- JSON array
    raw_section TEXT,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (qp_id) REFERENCES question_papers(id)
);

-- Question Mappings (matching results)
CREATE TABLE IF NOT EXISTS mappings (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    question_type TEXT,
    qp_id TEXT NOT NULL,
    exam_tag TEXT,
    matched_chapters TEXT, -- JSON array of ChapterMatch
    best_match TEXT,       -- JSON object
    confidence REAL DEFAULT 0,
    confidence_level TEXT DEFAULT 'low',
    is_multi_chapter INTEGER DEFAULT 0,
    is_reviewed INTEGER DEFAULT 0,
    reviewer_action TEXT,
    final_chapter_id TEXT,
    final_chapter_name TEXT,
    duplicate_group_id TEXT,
    appears_in_exams TEXT,  -- JSON array
    frequency INTEGER DEFAULT 1,
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

-- Cost Tracking
CREATE TABLE IF NOT EXISTS api_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    model TEXT NOT NULL,
    task_type TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    request_id TEXT,
    subject TEXT
);

-- Retry Queue
CREATE TABLE IF NOT EXISTS retry_queue (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,      -- JSON
    task_type TEXT NOT NULL,
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    last_error TEXT,
    status TEXT DEFAULT 'pending',  -- pending, success, permanent_failure
    created_at TEXT DEFAULT (datetime('now')),
    last_attempt_at TEXT
);

-- Processing Logs
CREATE TABLE IF NOT EXISTS processing_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    level TEXT DEFAULT 'info',
    task TEXT,
    message TEXT,
    details TEXT   -- JSON
);

-- Generated Answers
CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY,
    mapping_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    chapter_id TEXT,
    chapter_name TEXT,
    prologue TEXT,
    bullets TEXT,          -- JSON array of strings
    epilogue TEXT,
    bullet_count INTEGER DEFAULT 5,
    bullet_style TEXT DEFAULT 'detailed',  -- detailed or precise
    preset TEXT DEFAULT 'custom',          -- LAQ, SAQ, VSAQ, custom
    source_chunks TEXT,    -- JSON array of chunk IDs used
    source_pages TEXT,     -- JSON object {textbook_name: "p. X, Y"}
    images TEXT,           -- JSON array of {filename, page, caption, path}
    textbook_name TEXT,
    generated_at TEXT DEFAULT (datetime('now')),
    model_used TEXT,
    token_cost REAL DEFAULT 0,
    status TEXT DEFAULT 'generated',  -- generated, edited, approved
    FOREIGN KEY (mapping_id) REFERENCES mappings(id)
);

-- Viva Questions (generated or manually written)
CREATE TABLE IF NOT EXISTS viva_questions (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    chapter_name TEXT NOT NULL,
    topic_name TEXT NOT NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    explained_terms TEXT,           -- JSON array of key terms in the answer
    importance TEXT DEFAULT 'standard',  -- must_know, standard, advanced
    source_chapter_id TEXT,         -- qb-organizer chapter reference
    source_pages TEXT,              -- JSON: {"Maheswari": "p. 142-145"}
    source_chunks TEXT,             -- JSON array of chunk IDs used
    difficulty INTEGER DEFAULT 1,   -- 1=easy, 2=medium, 3=hard
    is_manual INTEGER DEFAULT 0,    -- 1 if manually written by user
    firestore_id TEXT,              -- set after push to Firestore
    status TEXT DEFAULT 'generated',-- generated, reviewed, pushed
    created_at TEXT DEFAULT (datetime('now'))
);

-- Processing Logs
CREATE TABLE IF NOT EXISTS processing_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    level TEXT DEFAULT 'info',
    task TEXT,
    message TEXT,
    details TEXT   -- JSON
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chapters_textbook ON chapters(textbook_id);
CREATE INDEX IF NOT EXISTS idx_chunks_chapter ON chunks(chapter_id);
CREATE INDEX IF NOT EXISTS idx_questions_qp ON questions(qp_id);
CREATE INDEX IF NOT EXISTS idx_mappings_question ON mappings(question_id);
CREATE INDEX IF NOT EXISTS idx_mappings_confidence ON mappings(confidence_level);
CREATE INDEX IF NOT EXISTS idx_retry_status ON retry_queue(status);
CREATE INDEX IF NOT EXISTS idx_answers_mapping ON answers(mapping_id);
CREATE INDEX IF NOT EXISTS idx_viva_subject ON viva_questions(subject);
CREATE INDEX IF NOT EXISTS idx_viva_status ON viva_questions(status);
"""


async def init_db():
    """Initialize the database with the schema."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA_SQL)
        await db.commit()

        # ── Schema migrations ──
        try:
            await db.execute("SELECT images FROM answers LIMIT 1")
        except Exception:
            try:
                await db.execute("ALTER TABLE answers ADD COLUMN images TEXT")
                await db.commit()
                logger.info("Migration: added 'images' column to answers table")
            except Exception:
                pass  # Column might already exist

    logger.info(f"Database initialized at {DB_PATH}")


async def get_db():
    """Get an async database connection."""
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


# ── Generic CRUD helpers ──────────────────────────────────────────

async def insert(table: str, data: dict) -> str:
    """Insert a row and return its id."""
    cols = ", ".join(data.keys())
    placeholders = ", ".join(["?" for _ in data])
    values = []
    for v in data.values():
        if isinstance(v, (list, dict)):
            values.append(json.dumps(v))
        else:
            values.append(v)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({placeholders})", values)
        await db.commit()
    return data.get("id", "")


async def update(table: str, row_id: str, data: dict):
    """Update a row by id."""
    set_clause = ", ".join([f"{k} = ?" for k in data.keys()])
    values = []
    for v in data.values():
        if isinstance(v, (list, dict)):
            values.append(json.dumps(v))
        else:
            values.append(v)
    values.append(row_id)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE {table} SET {set_clause} WHERE id = ?", values)
        await db.commit()


async def fetch_one(table: str, row_id: str) -> dict | None:
    """Fetch a single row by id."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,))
        row = await cursor.fetchone()
        if row:
            return dict(row)
    return None


async def fetch_all(table: str, where: str = "", params: tuple = (), order_by: str = "") -> list[dict]:
    """Fetch all rows with optional filtering."""
    query = f"SELECT * FROM {table}"
    if where:
        query += f" WHERE {where}"
    if order_by:
        query += f" ORDER BY {order_by}"

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def delete(table: str, row_id: str):
    """Delete a row by id."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
        await db.commit()


async def count(table: str, where: str = "", params: tuple = ()) -> int:
    """Count rows in a table."""
    query = f"SELECT COUNT(*) FROM {table}"
    if where:
        query += f" WHERE {where}"
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(query, params)
        row = await cursor.fetchone()
        return row[0] if row else 0


async def execute(sql: str, params: tuple = ()):
    """Execute raw SQL (for DELETE, etc.)."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(sql, params)
        await db.commit()


async def fetch_scalar(sql: str, params: tuple = ()):
    """Execute SQL and return a single scalar value (e.g. COUNT(*))."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(sql, params)
        row = await cursor.fetchone()
        return row[0] if row else 0


async def log_activity(level: str, task: str, message: str, details: dict = None):
    """Log a processing activity."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO processing_logs (level, task, message, details) VALUES (?, ?, ?, ?)",
            (level, task, message, json.dumps(details) if details else None)
        )
        await db.commit()
