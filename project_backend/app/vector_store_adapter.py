import json
import math
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


@dataclass
class VectorStoreResult:
    vector_id: str
    status: str
    engine: str
    collection: str
    dimension: int
    metadata: Dict[str, Any]


def _store_path() -> Path:
    return Path(__file__).resolve().parents[1] / "storage" / "vector_store_stub" / "templates.json"


def _vector_store_mode() -> str:
    mode = os.getenv("VECTOR_STORE_MODE", "stub").strip().lower()
    if mode not in {"stub", "qdrant"}:
        raise ValueError("VECTOR_STORE_MODE must be 'stub' or 'qdrant'")
    return mode


def _qdrant_collection() -> str:
    return os.getenv("QDRANT_COLLECTION", "templates").strip() or "templates"


def _stable_point_id(vector_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"ocr-template-vector:{vector_id}"))


def _load_qdrant():
    try:
        from qdrant_client import QdrantClient
        from qdrant_client.http import models
    except ImportError as error:
        raise RuntimeError("Qdrant mode requires qdrant-client.") from error

    client = QdrantClient(
        url=os.getenv("QDRANT_URL", "http://localhost:6333"),
        api_key=os.getenv("QDRANT_API_KEY") or None,
    )
    return client, models


def _qdrant_vector_size(collection_info: Any) -> int:
    vectors_config = collection_info.config.params.vectors
    if hasattr(vectors_config, "size"):
        return int(vectors_config.size)
    if isinstance(vectors_config, dict):
        first_config = next(iter(vectors_config.values()))
        return int(first_config.size)
    raise RuntimeError("Unable to determine Qdrant collection vector size")


def _ensure_qdrant_collection(client: Any, models: Any, collection: str, dimension: int) -> None:
    try:
        collection_info = client.get_collection(collection)
    except Exception:
        try:
            client.create_collection(
                collection_name=collection,
                vectors_config=models.VectorParams(size=dimension, distance=models.Distance.COSINE),
            )
            return
        except Exception as error:
            raise RuntimeError(f"Qdrant collection setup failed: {error}") from error

    existing_size = _qdrant_vector_size(collection_info)
    if existing_size != dimension:
        raise RuntimeError(
            f"Qdrant collection '{collection}' has vector size {existing_size}, expected {dimension}."
        )


def _load_store() -> Dict[str, Any]:
    path = _store_path()
    if not path.exists():
        return {"collection": "templates", "vectors": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"collection": "templates", "vectors": {}}


def _save_store(store: Dict[str, Any]) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2, sort_keys=True), encoding="utf-8")


def _validate_vector(vector: List[float]) -> None:
    if not vector:
        raise ValueError("Vector store upsert requires a non-empty vector")
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in vector):
        raise ValueError("Vector store upsert received invalid vector values")


def _cosine_similarity(left: List[float], right: List[float]) -> float:
    if len(left) != len(right):
        raise ValueError("Vector dimensions do not match")
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def _upsert_template_vector_stub(vector_id: str, vector: List[float], metadata: Dict[str, Any]) -> VectorStoreResult:
    _validate_vector(vector)
    store = _load_store()
    vectors = store.setdefault("vectors", {})
    vectors[vector_id] = {
        "vector_id": vector_id,
        "vector": vector,
        "dimension": len(vector),
        "metadata": metadata,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    store["collection"] = "templates"
    _save_store(store)
    return VectorStoreResult(
        vector_id=vector_id,
        status="upserted",
        engine="local-vector-store-stub",
        collection="templates",
        dimension=len(vector),
        metadata=metadata,
    )


def _upsert_template_vector_qdrant(vector_id: str, vector: List[float], metadata: Dict[str, Any]) -> VectorStoreResult:
    _validate_vector(vector)
    client, models = _load_qdrant()
    collection = _qdrant_collection()
    dimension = len(vector)
    _ensure_qdrant_collection(client, models, collection, dimension)
    updated_at = datetime.now(timezone.utc).isoformat()
    payload = {
        **metadata,
        "vector_id": vector_id,
        "updated_at": updated_at,
    }
    try:
        client.upsert(
            collection_name=collection,
            points=[
                models.PointStruct(
                    id=_stable_point_id(vector_id),
                    vector=vector,
                    payload=payload,
                )
            ],
        )
    except Exception as error:
        raise RuntimeError(f"Qdrant upsert failed: {error}") from error

    return VectorStoreResult(
        vector_id=vector_id,
        status="upserted",
        engine="qdrant",
        collection=collection,
        dimension=dimension,
        metadata=payload,
    )


def upsert_template_vector(vector_id: str, vector: List[float], metadata: Dict[str, Any]) -> VectorStoreResult:
    if _vector_store_mode() == "qdrant":
        return _upsert_template_vector_qdrant(vector_id, vector, metadata)
    return _upsert_template_vector_stub(vector_id, vector, metadata)


def _search_similar_templates_stub(vector: List[float], limit: int = 5) -> List[Dict[str, Any]]:
    _validate_vector(vector)
    store = _load_store()
    results = []
    for item in store.get("vectors", {}).values():
        stored_vector = item.get("vector") or []
        if len(stored_vector) != len(vector):
            continue
        results.append(
            {
                "vector_id": item.get("vector_id"),
                "score": _cosine_similarity(vector, stored_vector),
                "metadata": item.get("metadata") or {},
            }
        )
    return sorted(results, key=lambda item: item["score"], reverse=True)[:limit]


def _search_similar_templates_qdrant(vector: List[float], limit: int = 5) -> List[Dict[str, Any]]:
    _validate_vector(vector)
    client, _ = _load_qdrant()
    collection = _qdrant_collection()
    try:
        client.get_collection(collection)
    except Exception as error:
        message = str(error).lower()
        if "not found" in message or "doesn't exist" in message or "does not exist" in message:
            return []
        raise RuntimeError(f"Qdrant search failed: {error}") from error

    try:
        if hasattr(client, "search"):
            hits = client.search(collection_name=collection, query_vector=vector, limit=limit, with_payload=True)
        else:
            query_result = client.query_points(collection_name=collection, query=vector, limit=limit, with_payload=True)
            hits = query_result.points
    except Exception as error:
        raise RuntimeError(f"Qdrant search failed: {error}") from error

    results = []
    for hit in hits:
        payload = hit.payload or {}
        results.append(
            {
                "vector_id": payload.get("vector_id") or str(hit.id),
                "score": float(hit.score),
                "metadata": payload,
            }
        )
    return results


def search_similar_templates(vector: List[float], limit: int = 5) -> List[Dict[str, Any]]:
    if _vector_store_mode() == "qdrant":
        return _search_similar_templates_qdrant(vector, limit)
    return _search_similar_templates_stub(vector, limit)
