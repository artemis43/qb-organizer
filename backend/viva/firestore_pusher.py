# qb-organizer/backend/viva/firestore_pusher.py
"""Direct Firestore push for viva content.

Pushes generated viva questions directly into the MBBS Companion app's
Firestore collections, matching the exact schema the app expects:

  vivaSubjects → vivaChapters → vivaTopics → vivaQuestions

Uses firebase-admin SDK with a service account for authentication.
"""

import json
import logging
from pathlib import Path

from config import settings
from state import db as database

logger = logging.getLogger(__name__)

# Lazy-loaded Firestore client
_firestore_client = None


def _get_firestore():
    """Initialize and return Firestore client (lazy singleton)."""
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    import firebase_admin
    from firebase_admin import credentials, firestore

    sa_path = settings.firebase_service_account_path
    if not Path(sa_path).exists():
        raise FileNotFoundError(
            f"Firebase service account not found at: {sa_path}\n"
            f"Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key\n"
            f"Place at: {sa_path}"
        )

    # Initialize only if not already done
    if not firebase_admin._apps:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)

    _firestore_client = firestore.client()
    logger.info("Firestore client initialized")
    return _firestore_client


def check_firestore_connection() -> dict:
    """Check if Firestore is reachable."""
    try:
        db = _get_firestore()
        # Try a simple read to verify connection
        db.collection("vivaSubjects").limit(1).get()
        return {"connected": True, "message": "Firestore connected successfully"}
    except FileNotFoundError as e:
        return {"connected": False, "message": str(e)}
    except Exception as e:
        return {"connected": False, "message": f"Firestore connection failed: {e}"}


async def push_to_firestore(
    question_ids: list[str],
    progress_callback=None,
) -> dict:
    """Push selected viva questions to Firestore.

    Groups questions by subject → chapter → topic and creates/updates
    the Firestore hierarchy accordingly.

    Returns:
        dict with counts of created subjects, chapters, topics, questions
    """
    async def notify(msg, current=0, total=0):
        if progress_callback:
            await progress_callback("firestore_push", current, total, msg)
        logger.info(msg)

    # Load all selected questions
    questions = []
    for qid in question_ids:
        q = await database.fetch_one("viva_questions", qid)
        if q:
            questions.append(q)

    if not questions:
        return {"error": "No questions found", "pushed": 0}

    await notify(f"Pushing {len(questions)} questions to Firestore...", 0, len(questions))

    try:
        db = _get_firestore()
    except Exception as e:
        return {"error": str(e), "pushed": 0}

    # ── Group by hierarchy ──
    # subject → chapter → topic → [questions]
    hierarchy = {}
    for q in questions:
        subj = q["subject"]
        ch = q["chapter_name"]
        topic = q["topic_name"]

        hierarchy.setdefault(subj, {})
        hierarchy[subj].setdefault(ch, {})
        hierarchy[subj][ch].setdefault(topic, [])
        hierarchy[subj][ch][topic].append(q)

    # ── Push hierarchy ──
    stats = {"subjects": 0, "chapters": 0, "topics": 0, "questions": 0, "errors": 0}
    pushed_ids = []

    for subj_name, chapters in hierarchy.items():
        # Find or create VivaSubject
        subj_id = await _find_or_create_doc(
            db, "vivaSubjects",
            {"name": subj_name},
            {"name": subj_name, "order": 0},
        )
        if not subj_id:
            stats["errors"] += 1
            continue
        stats["subjects"] += 1

        ch_order = 0
        for ch_name, topics in chapters.items():
            ch_order += 1
            # Find or create VivaChapter
            ch_id = await _find_or_create_doc(
                db, "vivaChapters",
                {"name": ch_name, "vivaSubjectId": subj_id},
                {"name": ch_name, "vivaSubjectId": subj_id, "order": ch_order},
            )
            if not ch_id:
                stats["errors"] += 1
                continue
            stats["chapters"] += 1

            topic_order = 0
            for topic_name, topic_questions in topics.items():
                topic_order += 1
                # Find or create VivaTopic
                topic_id = await _find_or_create_doc(
                    db, "vivaTopics",
                    {"name": topic_name, "vivaChapterId": ch_id},
                    {"name": topic_name, "vivaChapterId": ch_id, "order": topic_order},
                )
                if not topic_id:
                    stats["errors"] += 1
                    continue
                stats["topics"] += 1

                # Push questions
                q_order = 0
                for q in topic_questions:
                    q_order += 1

                    # Parse explained_terms
                    explained_terms = q.get("explained_terms", "[]")
                    if isinstance(explained_terms, str):
                        try:
                            explained_terms = json.loads(explained_terms)
                        except json.JSONDecodeError:
                            explained_terms = []

                    # Parse source_pages
                    source_pages = q.get("source_pages", "{}")
                    if isinstance(source_pages, str):
                        try:
                            source_pages = json.loads(source_pages)
                        except json.JSONDecodeError:
                            source_pages = {}

                    firestore_data = {
                        "vivaTopicId": topic_id,
                        "questionText": q["question_text"],
                        "answerText": q["answer_text"],
                        "explainedTerms": [t.lower() for t in explained_terms],  # app expects lowercase
                        "order": q_order,
                        "importance": q.get("importance", "standard"),
                        "sourcePages": source_pages,
                        "difficulty": q.get("difficulty", 1),
                    }

                    try:
                        # Check for duplicate
                        existing = db.collection("vivaQuestions").where(
                            "vivaTopicId", "==", topic_id
                        ).where(
                            "questionText", "==", q["question_text"]
                        ).limit(1).get()

                        if existing:
                            # Update existing
                            doc_id = existing[0].id
                            db.collection("vivaQuestions").document(doc_id).update(firestore_data)
                        else:
                            # Create new
                            doc_ref = db.collection("vivaQuestions").add(firestore_data)
                            doc_id = doc_ref[1].id

                        # Mark as pushed in local DB
                        await database.update("viva_questions", q["id"], {
                            "firestore_id": doc_id,
                            "status": "pushed",
                        })
                        pushed_ids.append(q["id"])
                        stats["questions"] += 1

                    except Exception as e:
                        logger.error(f"Failed to push question {q['id']}: {e}")
                        stats["errors"] += 1

                await notify(
                    f"Pushed {stats['questions']} questions...",
                    stats["questions"], len(questions)
                )

    await notify(
        f"Push complete: {stats['questions']} questions, {stats['topics']} topics, "
        f"{stats['chapters']} chapters, {stats['subjects']} subjects",
        len(questions), len(questions)
    )

    return stats


async def _find_or_create_doc(db, collection: str, query_fields: dict, create_data: dict) -> str:
    """Find an existing document by fields, or create a new one.

    Returns the document ID.
    """
    try:
        # Build query
        ref = db.collection(collection)
        for field, value in query_fields.items():
            ref = ref.where(field, "==", value)

        existing = ref.limit(1).get()
        if existing:
            return existing[0].id

        # Create new
        _, doc_ref = db.collection(collection).add(create_data)
        return doc_ref.id

    except Exception as e:
        logger.error(f"Firestore {collection} find/create failed: {e}")
        return None
