import io
import os
import sqlite3
import base64
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from .services import DecisionService, VerificationService
from .vector_store_adapter import search_similar_templates
from .vision_embedding_adapter import encode_images


DETECTION_THRESHOLD = 0.75
DETECTION_VERSION = "phase7.0"
PDF_RENDER_SCALE = 2.0
verification_service = VerificationService()
decision_service = DecisionService()


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
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded PDF is empty")

    try:
        import fitz
    except ImportError as error:
        raise HTTPException(
            status_code=501,
            detail="PDF detection requires PyMuPDF. Install the 'pymupdf' package on the backend.",
        ) from error

    output_dir = _storage_path() / query_id
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF") from error

    if document.page_count == 0:
        document.close()
        raise HTTPException(status_code=400, detail="Uploaded PDF has no pages")

    page_paths = []
    try:
        for index in range(document.page_count):
            page = document.load_page(index)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(PDF_RENDER_SCALE, PDF_RENDER_SCALE), alpha=False)
            output_path = output_dir / f"page_{index + 1}.png"
            pixmap.save(str(output_path))
            page_paths.append(output_path)
    finally:
        document.close()
    return page_paths


def _prepare_query_pages(query_id: str, file_bytes: bytes) -> List[Path]:
    if file_bytes.lstrip().startswith(b"%PDF"):
        return _convert_pdf_to_page_images(query_id, file_bytes)
    return [_save_query_image(query_id, file_bytes, 1)]


def _candidate_from_result(result: Dict[str, Any], page_image_paths: Dict[int, str]) -> Optional[Dict[str, Any]]:
    metadata = result.get("metadata") or {}
    vector_id = str(result.get("vector_id") or "")
    template_id = _template_id_from_metadata(metadata, vector_id)
    template = _fetch_template(template_id)
    if template_id and template is None:
        return None
    
    if template:
        template_status = template.get("status")
        template_name = template.get("name")
        page_count = template.get("page_count")
        final_confidence_threshold = decision_service.final_confidence_threshold(template, metadata)
        with _connect() as conn:
            field_count = conn.execute(
                "SELECT COUNT(*) as count FROM template_fields WHERE template_id = ?",
                (template_id,)
            ).fetchone()["count"]
    else:
        template_status = metadata.get("template_status")
        template_name = metadata.get("template_name")
        page_count = metadata.get("page_count")
        field_count = metadata.get("field_count")
        final_confidence_threshold = decision_service.final_confidence_threshold(None, metadata)

    if template_status != "active":
        return None
    verification = verification_service.verify_template(template_id, page_image_paths) if template_id else {
        "status": "failed",
        "passed": False,
        "score": 0.0,
        "required_passed": False,
        "checked_fields": [],
    }
    retrieval_score = float(result.get("score", 0.0) or 0.0)
    decision = decision_service.decide_candidate(retrieval_score, verification, final_confidence_threshold)

    return {
        "template_id": template_id,
        "vector_id": vector_id,
        "score": decision["final_score"],
        "retrieval_score": decision["retrieval_score"],
        "average_score": decision["retrieval_score"],
        "matched_pages": 1 if decision["final_passed"] else 0,
        "template_name": template_name,
        "template_status": template_status,
        "page_count": page_count,
        "field_count": field_count,
        "model_name": metadata.get("model_name"),
        "vector_store_engine": metadata.get("vector_store_engine"),
        "verification": verification,
        "verification_score": decision["verification_score"],
        "verification_passed": decision["verification_passed"],
        "final_score": decision["final_score"],
        "final_passed": decision["final_passed"],
        "decision_reason": decision["decision_reason"],
        "decision_path": decision["decision_path"],
        "final_confidence_threshold": decision["final_confidence_threshold"],
        "metadata": metadata,
    }


def _detect_page(page_index: int, saved_image_path: Path, page_image_paths: Dict[int, str]) -> Dict[str, Any]:
    embedding = encode_images([str(saved_image_path)])
    raw_results = search_similar_templates(embedding.vector, limit=5)
    candidates = [
        candidate
        for candidate in (_candidate_from_result(result, page_image_paths) for result in raw_results)
        if candidate is not None
    ]
    candidates = sorted(candidates, key=lambda item: item["final_score"], reverse=True)
    passing_candidates = [candidate for candidate in candidates if candidate["final_passed"]]
    best_candidate = passing_candidates[0] if passing_candidates else None
    matched = best_candidate is not None
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
    by_template: Dict[str, List[Dict[str, Any]]] = {}
    for page in pages:
        for candidate in page["candidates"]:
            template_id = candidate.get("template_id")
            if template_id:
                by_template.setdefault(template_id, []).append(candidate)

    aggregated = []
    for template_id, page_candidates in by_template.items():
        best_page_cand = max(page_candidates, key=lambda c: c["retrieval_score"])
        retrieval_scores = [c["retrieval_score"] for c in page_candidates]
        max_retrieval_score = max(retrieval_scores)
        avg_retrieval_score = sum(retrieval_scores) / len(retrieval_scores)
        matched_pages_count = sum(1 for candidate in page_candidates if candidate["final_passed"])
        verification = best_page_cand.get("verification") or {
            "status": "failed",
            "passed": False,
            "score": 0.0,
            "required_passed": False,
            "checked_fields": [],
        }
        decision = decision_service.decide_candidate(
            max_retrieval_score,
            verification,
            float(best_page_cand.get("final_confidence_threshold") or DecisionService.DEFAULT_FINAL_CONFIDENCE_THRESHOLD),
        )

        aggregated.append({
            "template_id": template_id,
            "vector_id": best_page_cand["vector_id"],
            "score": decision["final_score"],
            "retrieval_score": decision["retrieval_score"],
            "average_score": avg_retrieval_score,
            "matched_pages": matched_pages_count,
            "template_name": best_page_cand["template_name"],
            "template_status": best_page_cand["template_status"],
            "page_count": best_page_cand["page_count"],
            "field_count": best_page_cand["field_count"],
            "model_name": best_page_cand["model_name"],
            "vector_store_engine": best_page_cand["vector_store_engine"],
            "verification": best_page_cand.get("verification"),
            "verification_score": decision["verification_score"],
            "verification_passed": decision["verification_passed"],
            "final_score": decision["final_score"],
            "final_passed": decision["final_passed"],
            "decision_reason": decision["decision_reason"],
            "decision_path": decision["decision_path"],
            "final_confidence_threshold": decision["final_confidence_threshold"],
            "metadata": best_page_cand.get("metadata", {}),
        })

    return sorted(aggregated, key=lambda item: item["final_score"], reverse=True)


def _detection_engine(pages: List[Dict[str, Any]]) -> str:
    for page in pages:
        engine = (page.get("debug") or {}).get("query_engine")
        if engine:
            return str(engine)
    return os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower() or "stub"


def detect_template_dev(file_bytes: bytes) -> Dict[str, Any]:
    query_id = f"detq_{uuid4().hex[:12]}"
    source_type = "pdf" if file_bytes.lstrip().startswith(b"%PDF") else "image"
    page_paths = _prepare_query_pages(query_id, file_bytes)
    page_image_paths = {index + 1: str(page_path) for index, page_path in enumerate(page_paths)}
    pages = [_detect_page(index + 1, page_path, page_image_paths) for index, page_path in enumerate(page_paths)]
    candidates = _aggregate_candidates(pages)
    passing_candidates = [candidate for candidate in candidates if candidate["final_passed"]]
    best_candidate = passing_candidates[0] if passing_candidates else None
    matched = best_candidate is not None

    return {
        "query_id": query_id,
        "engine": _detection_engine(pages),
        "version": DETECTION_VERSION,
        "threshold": DETECTION_THRESHOLD,
        "matched": matched,
        "best_candidate": best_candidate,
        "candidates": candidates,
        "pages": pages,
        "message": None if matched else "No candidate passed verification and final confidence." if candidates else "No active embedded templates available.",
        "debug": {
            "vector_store_mode": os.getenv("VECTOR_STORE_MODE", "stub").strip().lower() or "stub",
            "vision_embedding_mode": os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower() or "stub",
            "source_type": source_type,
            "input_page_count": len(page_paths),
            "converted_page_count": len(page_paths) if source_type == "pdf" else 0,
            "query_page_paths": [str(path) for path in page_paths],
        },
    }
