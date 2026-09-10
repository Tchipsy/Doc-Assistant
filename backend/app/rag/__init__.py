"""RAG 子系统：分块、嵌入、向量检索（SQLite+NumPy）、重排。"""
from app.rag.embeddings import EmbeddingClient, embed_texts  # noqa: F401
from app.rag.vectorstore import insert_chunks, delete_doc_chunks, search, count_by_kb  # noqa: F401
from app.rag.chunker import chunk_document  # noqa: F401
from app.rag.retriever import retrieve  # noqa: F401
from app.rag.rerank import rerank_chunks  # noqa: F401
