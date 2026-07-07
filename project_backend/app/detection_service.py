import io
import os
import sqlite3
import base64
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from .vector_store_adapter import search_similar_templates
from .vision_embedding_adapter import encode_images


DETECTION_THRESHOLD = 0.75
DETECTION_VERSION = "phase7.0"


def _db_path() -> Path:
    database_url = os.getenv("DATABASE_URL", "")
    if database_url.startswith("file:"):
        raw_path = database_url.replace("file:", "", 1).strip('"')
        candidate = Path(raw_path)
        if candidate.is_absolute():
            return candidate
        cwd_candidate = Path.cwd() / candidate
        if cwd_candidate.exists():
            return cwd_candidate

    return Path(__file__).resolve().parents[2] / "project_frontend" / "prisma" / "dev.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _storage_path() -> Path:
    return Path(__file__).resolve().parents[1] / "storage" / "detection_queries"


def _load_pillow():
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def _template_id_from_metadata(metadata: Dict[str, Any], vector_id: str) -> Optional[str]:
    if metadata.get("template_id"):
        return str(metadata["template_id"])
    if vector_id.startswith("vec_"):
        return vector_id.replace("vec_", "", 1)
    return None


def _fetch_template(template_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not template_id:
        return None
    with _connect() as conn:
        row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
    return dict(row) if row else None


def _image_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _save_query_image(query_id: str, image_bytes: bytes, page_index: int = 1) -> Path:
    Image = _load_pillow()
    if Image is None:
        raise HTTPException(status_code=400, detail="Image validation is unavailable because Pillow is not installed")
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image is empty")

    try:
        image = Image.open(io.BytesIO(image_bytes))
        if image.mode != "RGB":
            image = image.convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image") from error

    output_dir = _storage_path() / query_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"page_{page_index}.png"
    image.save(output_path, format="PNG")
    return output_path


def _convert_pdf_to_page_images(query_id: str, pdf_bytes: bytes) -> List[Path]:
    try:
        import fitz
    except ImportError as error:
        raise HTTPException(status_code=501, detail="PDF detection requires a PDF rendering dependency.") from error

    output_dir = _storage_path() / query_id
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF") from error

    if document.page_count == 0:
        raise HTTPException(status_code=400, detail="Uploaded PDF has no pages")

    page_paths = []
    for index in range(document.page_count):
        page = document.load_page(index)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        output_path = output_dir / f"page_{index + 1}.png"
        pixmap.save(str(output_path))
        page_paths.append(output_path)
    document.close()
    return page_paths


def _prepare_query_pages(query_id: str, file_bytes: bytes) -> List[Path]:
    if file_bytes.startswith(b"%PDF"):
        return _convert_pdf_to_page_images(query_id, file_bytes)
    return [_save_query_image(query_id, file_bytes, 1)]


def _candidate_from_result(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    metadata = result.get("metadata") or {}
    vector_id = str(result.get("vector_id") or "")
    template_id = _template_id_from_metadata(metadata, vector_id)
    template = _fetch_template(template_id)
    template_status = template["status"] if template else metadata.get("template_status")
    if template_status != "active":
        return None

    return {
        "template_id": template_id,
        "vector_id": vector_id,
        "score": float(result.get("score", 0) or 0),
        "average_score": float(result.get("score", 0) or 0),
        "matched_pages": 1 if float(result.get("score", 0) or 0) >= DETECTION_THRESHOLD else 0,
        "template_name": template["name"] if template else metadata.get("template_name"),
        "template_status": template_status,
        "page_count": template["page_count"] if template else metadata.get("page_count"),
        "field_count": metadata.get("field_count"),
        "model_name": metadata.get("model_name"),
        "vector_store_engine": metadata.get("vector_store_engine"),
        "metadata": metadata,
    }


def _detect_page(page_index: int, saved_image_path: Path) -> Dict[str, Any]:
    embedding = encode_images([str(saved_image_path)])
    raw_results = search_similar_templates(embedding.vector, limit=5)
    candidates = [
        candidate
        for candidate in (_candidate_from_result(result) for result in raw_results)
        if candidate is not None
    ]
    best_candidate = candidates[0] if candidates else None
    matched = bool(best_candidate and best_candidate["score"] >= DETECTION_THRESHOLD)
    return {
        "page_index": page_index,
        "matched": matched,
        "best_candidate": best_candidate,
        "candidates": candidates,
        "image_preview_data_url": _image_to_data_url(saved_image_path),
        "debug": {
            "query_image_path": str(saved_image_path),
            "query_engine": embedding.engine,
            "query_version": embedding.version,
            "query_model_name": embedding.model_name,
            "query_vector_dimension": embedding.dimension,
            "query_input_count": embedding.input_count,
            "raw_candidate_count": len(raw_results),
            "active_candidate_count": len(candidates),
        },
    }


def _aggregate_candidates(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_template: Dict[str, Dict[str, Any]] = {}
    for page in pages:
        for candidate in page["candidates"]:
            template_id = candidate.get("template_id") or candidate.get("vector_id") or ""
            score = float(candidate.get("score", 0) or 0)
            current = by_template.setdefault(
                template_id,
                {
                    **candidate,
                    "score": score,
                    "average_score": score,
                    "matched_pages": 0,
                    "page_index": page["page_index"],
                    "_scores": [],
                },
            )
            current["_scores"].append(score)
            if score > float(current.get("score", 0) or 0):
                current.update({**candidate, "score": score, "page_index": page["page_index"]})
            if score >= DETECTION_THRESHOLD:
                current["matched_pages"] = int(current.get("matched_pages", 0) or 0) + 1

    aggregated = []
    for candidate in by_template.values():
        scores = candidate.pop("_scores", [])
        candidate["average_score"] = sum(scores) / len(scores) if scores else 0
        aggregated.append(candidate)
    return sorted(aggregated, key=lambda item: item.get("score", 0), reverse=True)


def _detection_engine(pages: List[Dict[str, Any]]) -> str:
    for page in pages:
        engine = (page.get("debug") or {}).get("query_engine")
        if engine:
            return str(engine)
    return os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower() or "stub"


def detect_template_dev(file_bytes: bytes) -> Dict[str, Any]:
    query_id = f"detq_{uuid4().hex[:12]}"
    page_paths = _prepare_query_pages(query_id, file_bytes)
    pages = [_detect_page(index + 1, page_path) for index, page_path in enumerate(page_paths)]
    candidates = _aggregate_candidates(pages)
    best_candidate = candidates[0] if candidates else None
    matched = bool(best_candidate and best_candidate["score"] >= DETECTION_THRESHOLD)

    return {
        "query_id": query_id,
        "engine": _detection_engine(pages),
        "version": DETECTION_VERSION,
        "threshold": DETECTION_THRESHOLD,
        "matched": matched,
        "best_candidate": best_candidate,
        "candidates": candidates,
        "pages": pages,
        "message": None if candidates else "No active embedded templates available.",
        "debug": {
            "vector_store_mode": os.getenv("VECTOR_STORE_MODE", "stub").strip().lower() or "stub",
            "vision_embedding_mode": os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower() or "stub",
            "input_page_count": len(page_paths),
            "query_page_paths": [str(path) for path in page_paths],
        },
    }
