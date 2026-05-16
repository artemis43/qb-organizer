# qb-organizer/backend/core/embedder.py
"""Local embedding generation using PubMedBERT via sentence-transformers.

All embeddings are generated locally — no API calls, no cost.
Stores embeddings in ChromaDB for semantic search.
"""

import logging
import uuid
from pathlib import Path
from typing import Optional

import chromadb
from chromadb.config import Settings as ChromaSettings

from config import settings

logger = logging.getLogger(__name__)

# Global model cache
_model = None
_chroma_client = None


def _get_model():
    """Lazy-load the embedding model."""
    global _model
    if _model is None:
        logger.info(f"Loading embedding model: {settings.embedding_model}")
        logger.info("This may take a minute on first run (downloading model)...")
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(settings.embedding_model)
        logger.info("Embedding model loaded successfully")
    return _model


def _get_chroma():
    """Get or create the ChromaDB client."""
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(
            path=str(settings.chroma_dir),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        logger.info(f"ChromaDB initialized at {settings.chroma_dir}")
    return _chroma_client


def get_or_create_collection(subject: str) -> chromadb.Collection:
    """Get or create a ChromaDB collection for a subject."""
    client = _get_chroma()
    safe_name = subject.lower().replace(" ", "_").replace("-", "_")
    collection_name = f"kb_{safe_name}"
    return client.get_or_create_collection(
        name=collection_name,
        metadata={"subject": subject, "hnsw:space": "cosine"},
    )


def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """Generate embeddings for a list of texts using local PubMedBERT.

    Args:
        texts: List of text strings to embed.

    Returns:
        List of embedding vectors.
    """
    model = _get_model()
    embeddings = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
    return embeddings.tolist()


def store_chunks(
    subject: str,
    chunks: list[dict],
    textbook_id: str,
) -> list[str]:
    """Generate embeddings and store chunks in ChromaDB.

    Args:
        subject: The subject name (collection identifier).
        chunks: List of chunk dicts with 'id', 'text', 'chapter_id', 'page_numbers', etc.
        textbook_id: The textbook identifier.

    Returns:
        List of embedding IDs.
    """
    collection = get_or_create_collection(subject)
    model = _get_model()

    texts = [c["text"] for c in chunks]
    if not texts:
        return []

    # Generate embeddings in batches of 64
    all_embeddings = []
    batch_size = 64
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        embeddings = model.encode(batch, show_progress_bar=False, normalize_embeddings=True)
        all_embeddings.extend(embeddings.tolist())

    # Prepare ChromaDB data
    ids = []
    documents = []
    metadatas = []
    embeddings_list = []

    for idx, chunk in enumerate(chunks):
        chunk_id = chunk.get("id", str(uuid.uuid4()))
        ids.append(chunk_id)
        documents.append(chunk["text"])
        metadatas.append({
            "chapter_id": chunk.get("chapter_id", ""),
            "textbook_id": textbook_id,
            "page_numbers": str(chunk.get("page_numbers", [])),
            "section_heading": chunk.get("section_heading", "") or "",
            "chunk_index": chunk.get("chunk_index", idx),
            "has_diagrams": str(chunk.get("has_diagrams", False)),
        })
        embeddings_list.append(all_embeddings[idx])

    # Upsert to ChromaDB (handles duplicates)
    collection.upsert(
        ids=ids,
        documents=documents,
        metadatas=metadatas,
        embeddings=embeddings_list,
    )

    logger.info(f"Stored {len(ids)} chunks in ChromaDB collection '{collection.name}'")
    return ids


def search_similar(
    subject: str,
    query_text: str,
    n_results: int = 10,
    filter_chapter_id: Optional[str] = None,
) -> list[dict]:
    """Search ChromaDB for chunks similar to the query text.

    Args:
        subject: Subject collection to search.
        query_text: The query text (e.g., a question).
        n_results: Number of results to return.
        filter_chapter_id: Optional — only search within a specific chapter.

    Returns:
        List of result dicts with 'id', 'text', 'chapter_id', 'distance', 'metadata'.
    """
    collection = get_or_create_collection(subject)

    count = collection.count()
    if count == 0:
        logger.warning(f"ChromaDB collection for '{subject}' is empty")
        return []

    where_filter = None
    if filter_chapter_id:
        where_filter = {"chapter_id": filter_chapter_id}

    try:
        # Generate query embedding with the SAME model used for storage (PubMedBERT)
        model = _get_model()
        query_embedding = model.encode([query_text], normalize_embeddings=True).tolist()

        results = collection.query(
            query_embeddings=query_embedding,
            n_results=min(n_results, count),
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        logger.error(f"ChromaDB search error: {e}")
        return []

    if not results or not results["ids"] or not results["ids"][0]:
        return []

    output = []
    for i in range(len(results["ids"][0])):
        output.append({
            "id": results["ids"][0][i],
            "text": results["documents"][0][i] if results["documents"] else "",
            "distance": results["distances"][0][i] if results["distances"] else 1.0,
            "similarity": 1.0 - (results["distances"][0][i] if results["distances"] else 1.0),
            "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
        })

    return output


def get_collection_stats(subject: str) -> dict:
    """Get stats for a subject's ChromaDB collection."""
    try:
        collection = get_or_create_collection(subject)
        return {
            "collection_name": collection.name,
            "total_chunks": collection.count(),
        }
    except Exception:
        return {"collection_name": "", "total_chunks": 0}
