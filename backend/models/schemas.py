# qb-organizer/backend/models/schemas.py
"""All data models for the QB Organizer pipeline."""

from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum
from datetime import datetime


# ── Enums ──────────────────────────────────────────────────────────

class ProcessingStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    NEEDS_REVIEW = "needs_review"


class ConfidenceLevel(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class QuestionType(str, Enum):
    LAQ = "LAQ"
    SAQ = "SAQ"
    VSAQ = "VSAQ"
    MCQ = "MCQ"
    MATCH = "MATCH"
    DIAGRAM = "DIAGRAM"
    CLINICAL_CASE = "CLINICAL_CASE"
    OTHER = "OTHER"


# ── Textbook Models ───────────────────────────────────────────────

class Textbook(BaseModel):
    id: Optional[str] = None
    filename: str
    name: str  # e.g. "Maheswari's Essential Orthopaedics"
    subject: str  # e.g. "Orthopaedics"
    sha256_hash: str
    total_pages: int
    total_chapters: int
    total_chars: int
    total_images: int
    file_size_mb: float
    status: ProcessingStatus = ProcessingStatus.PENDING
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class Chapter(BaseModel):
    id: Optional[str] = None
    textbook_id: str
    chapter_number: int
    name: str  # e.g. "Orthopaedic Trauma Introduction"
    start_page: int  # 0-indexed PDF page
    end_page: int  # 0-indexed PDF page (exclusive)
    total_chars: int = 0
    total_chunks: int = 0
    status: ProcessingStatus = ProcessingStatus.PENDING
    # Knowledge Base fields (populated by Claude)
    summary: Optional[str] = None
    topics: Optional[list[str]] = None
    key_terms: Optional[list[str]] = None
    exam_likely_topics: Optional[list[str]] = None


class TextChunk(BaseModel):
    id: Optional[str] = None
    chapter_id: str
    textbook_id: str
    chunk_index: int
    text: str
    page_numbers: list[int]  # which pages this chunk spans
    section_heading: Optional[str] = None
    char_count: int = 0
    has_diagrams: bool = False
    embedding_id: Optional[str] = None  # ChromaDB reference


# ── Question Paper Models ─────────────────────────────────────────

class QuestionPaper(BaseModel):
    id: Optional[str] = None
    filename: str
    subject: str
    university: Optional[str] = None
    year: Optional[int] = None
    month: Optional[str] = None
    paper_number: Optional[str] = None
    total_pages: int = 0
    total_questions: int = 0
    sha256_hash: str = ""
    status: ProcessingStatus = ProcessingStatus.PENDING
    created_at: Optional[str] = None


class ExtractedQuestion(BaseModel):
    id: Optional[str] = None
    qp_id: str  # which question paper it came from
    question_number: str  # e.g. "1a", "Q3.ii"
    question_text: str
    question_type: QuestionType = QuestionType.OTHER
    marks: Optional[int] = None
    has_sub_parts: bool = False
    sub_parts: Optional[list[str]] = None
    raw_section: Optional[str] = None  # original section header from paper
    status: ProcessingStatus = ProcessingStatus.PENDING


# ── Matching Models ───────────────────────────────────────────────

class ChapterMatch(BaseModel):
    chapter_id: str
    chapter_name: str
    textbook_name: str
    vector_score: float = 0.0
    keyword_score: float = 0.0
    llm_score: Optional[float] = None
    combined_score: float = 0.0
    reasoning: Optional[str] = None
    page_references: Optional[dict[str, str]] = None  # {book: pages}


class QuestionMapping(BaseModel):
    id: Optional[str] = None
    question_id: str
    question_text: str
    question_type: QuestionType
    qp_id: str
    exam_tag: str  # e.g. "RGUHS Jun 2024"
    # Matching result
    matched_chapters: list[ChapterMatch] = []
    best_match: Optional[ChapterMatch] = None
    confidence: float = 0.0
    confidence_level: ConfidenceLevel = ConfidenceLevel.LOW
    is_multi_chapter: bool = False
    # Review
    is_reviewed: bool = False
    reviewer_action: Optional[str] = None  # "accepted", "reassigned", "flagged"
    final_chapter_id: Optional[str] = None
    final_chapter_name: Optional[str] = None
    # Dedup
    duplicate_group_id: Optional[str] = None
    appears_in_exams: list[str] = []  # all exam tags this question appeared in
    frequency: int = 1


# ── Export Models (Firestore-ready) ───────────────────────────────

class FirestoreQuestion(BaseModel):
    """Matches the MBBS Companion app's Firestore question model exactly."""
    questionText: str
    type: str  # LAQ, SAQ, etc.
    chapterId: str
    exams: list[str] = []
    isAnswered: bool = False
    answerId: Optional[str] = None
    pageNumbers: dict[str, str] = {}  # {bookName: pageRange}
    order: int = 0


class FirestoreChapter(BaseModel):
    """Matches the app's chapter model."""
    name: str
    subjectId: str
    order: int = 0


class FirestoreSubject(BaseModel):
    """Matches the app's subject model."""
    name: str
    order: int = 0
    universityId: str = ""


class ExportBundle(BaseModel):
    """Complete export package for one subject."""
    export_metadata: dict = {}
    subject: FirestoreSubject
    chapters: list[FirestoreChapter] = []
    questions: list[FirestoreQuestion] = []
    dedup_report: Optional[dict] = None


# ── API Response Models ───────────────────────────────────────────

class ProcessingProgress(BaseModel):
    task: str
    status: ProcessingStatus
    current: int = 0
    total: int = 0
    percentage: float = 0.0
    message: str = ""
    sub_tasks: list[dict] = []


class CostSummary(BaseModel):
    total_spent: float = 0.0
    budget_limit: float = 25.0
    budget_remaining: float = 25.0
    breakdown: dict[str, float] = {}  # by task type
    api_calls_made: int = 0


class DashboardStats(BaseModel):
    total_textbooks: int = 0
    total_chapters: int = 0
    total_chunks: int = 0
    total_qps: int = 0
    total_questions: int = 0
    total_matched: int = 0
    confidence_distribution: dict[str, int] = {"high": 0, "medium": 0, "low": 0}
    subjects: list[dict] = []
    cost: CostSummary = CostSummary()
    recent_activity: list[dict] = []
