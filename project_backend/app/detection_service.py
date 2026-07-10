import io
import os
import sqlite3
import base64
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from .alignment_service import AlignmentService
from .image_normalization import ImageNormalizationService
from .services import DecisionService, VerificationService
from .vector_store_adapter import search_similar_templates
from .vision_embedding_adapter import encode_images


DETECTION_THRESHOLD = 0.75
DETECTION_VERSION = "phase7.0"
PDF_RENDER_SCALE = 2.0
verification_service = VerificationService()
decision_service = DecisionService()
normalization_service = ImageNormalizationService()
alignment_service = AlignmentService()


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


def _fetch_template_page_image_source(template_id: str, page_number: int) -> Optional[str]:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT normalized_image_url, sample_image_url
            FROM template_pages
            WHERE template_id = ? AND page_number = ?
            LIMIT 1
            """,
            (template_id, page_number),
        ).fetchone()
    if row is None:
        return None
    return row["normalized_image_url"] or row["sample_image_url"]


def _image_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _detection_debug_url(path_value: Optional[str]) -> Optional[str]:
    if not path_value:
        return None
    try:
        path = Path(path_value).resolve()
        root = _storage_path().resolve()
        relative = path.relative_to(root)
    except (ValueError, OSError):
        return None
    return f"/debug/detection-queries/{relative.as_posix()}"


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


def _normalize_query_pages(query_id: str, page_paths: List[Path]) -> List[Dict[str, Any]]:
    normalized_dir = _storage_path() / query_id / "normalized"
    normalized_dir.mkdir(parents=True, exist_ok=True)
    normalized_pages = []
    for index, page_path in enumerate(page_paths, start=1):
        normalized_path = normalized_dir / f"page_{index}_normalized.png"
        info = normalization_service.normalize_document(str(page_path), str(normalized_path))
        normalized_pages.append(
            {
                "page_index": index,
                "original_path": str(page_path),
                "normalized_path": info["normalized_image_path"],
                "normalization": info,
            }
        )
    return normalized_pages


def _safe_file_token(value: str) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in value)


def _alignment_result(
    status: str,
    reason: str,
    error: Optional[str] = None,
    orb_executed: bool = False,
    precheck: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    debug = {
        "method": "ORB",
        "orb_executed": orb_executed,
        "precheck": precheck or {},
        "query_keypoints": 0,
        "template_keypoints": 0,
        "raw_matches": 0,
        "good_matches": 0,
        "inliers": 0,
        "inlier_ratio": 0.0,
        "homography_found": False,
        "warp_applied": False,
        "alignment_score": 0.0,
        "reason": reason,
    }
    return {
        "alignment_status": status,
        "alignment_success": False,
        "aligned_image_path": None,
        "alignment_match_image_path": None,
        "aligned_image_preview_url": None,
        "alignment_match_image_preview_url": None,
        "alignment_debug": debug,
        "method": "ORB",
        "keypoints_query": 0,
        "keypoints_template": 0,
        "matches": 0,
        "good_matches": 0,
        "inliers": 0,
        "inlier_ratio": 0.0,
        "homography_found": False,
        "warp_applied": False,
        "alignment_score": 0.0,
        "homography": None,
        "error": error,
    }


def _alignment_reason(
    alignment_status: str,
    alignment: Dict[str, Any],
    alignment_debug: Dict[str, Any],
) -> str:
    if alignment_status == "skipped":
        return str(alignment_debug.get("reason") or "ORB skipped because normalized geometry matches template")
    if alignment_status == "aligned":
        return str(alignment_debug.get("reason") or "ORB alignment succeeded")
    if alignment_status == "fallback":
        return str(alignment_debug.get("reason") or alignment.get("error") or "normalized image used")
    return str(alignment.get("error") or alignment_debug.get("reason") or "alignment process failed")


def _align_candidate_page(
    template_id: str,
    page_number: int,
    query_image_path: str,
    normalization_info: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    template_image_source = _fetch_template_page_image_source(template_id, page_number)
    if not template_image_source:
        return _alignment_result(
            "fallback",
            f"template_page_image_unavailable_page_{page_number}",
            error=f"Template page image is unavailable for page {page_number}",
        )

    query_path = Path(query_image_path)
    output_root = query_path.parent.parent if query_path.parent.name == "normalized" else query_path.parent
    output_dir = output_root / "aligned"
    output_path = output_dir / f"{_safe_file_token(template_id)}_page_{page_number}_aligned.png"

    try:
        precheck = alignment_service.alignment_precheck(query_image_path, template_image_source, normalization_info)
        if not precheck.get("should_run_orb"):
            if precheck.get("reason") == "normalized_geometry_matches_template":
                return _alignment_result("skipped", str(precheck["reason"]), precheck=precheck)
            return _alignment_result("fallback", str(precheck.get("reason") or "alignment_precheck_unavailable"), precheck=precheck)

        alignment = alignment_service.align_to_template(query_image_path, template_image_source, str(output_path))
        service_status = str(alignment.get("alignment_status") or "")
        alignment_status = "aligned" if alignment.get("aligned_image_path") and service_status == "aligned" else "fallback"
        alignment["alignment_status"] = alignment_status
        alignment["aligned_image_preview_url"] = _detection_debug_url(alignment.get("aligned_image_path"))
        alignment["alignment_match_image_preview_url"] = _detection_debug_url(alignment.get("alignment_match_image_path"))
        alignment_debug = alignment.get("alignment_debug") or {}
        alignment_debug["orb_executed"] = True
        alignment_debug["precheck"] = precheck
        if alignment_status == "fallback" and alignment_debug.get("reason") == "aligned":
            alignment_debug["reason"] = "alignment_output_unavailable"
        alignment["alignment_debug"] = alignment_debug
        return alignment
    except Exception as error:
        return _alignment_result("failed", "alignment_runtime_error", error=f"Alignment failed: {error}")


def _candidate_from_result(
    result: Dict[str, Any],
    page_image_paths: Dict[int, str],
    page_index: int,
    query_image_path: str,
    normalization_info: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
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
                """
                SELECT COUNT(*) as count
                FROM template_fields
                WHERE template_id = ?
                  AND use_for_verification = 0
                """,
                (template_id,),
            ).fetchone()["count"]
    else:
        template_status = metadata.get("template_status")
        template_name = metadata.get("template_name")
        page_count = metadata.get("page_count")
        field_count = metadata.get("field_count")
        final_confidence_threshold = decision_service.final_confidence_threshold(None, metadata)

    if template_status != "active":
        return None

    # 1) Verify จาก normalized ก่อน
    normalized_verification = verification_service.verify_template(
        template_id,
        page_image_paths,
    ) if template_id else {
        "status": "failed",
        "passed": False,
        "score": 0.0,
        "required_passed": False,
        "checked_fields": [],
    }

    normalized_score = float(normalized_verification.get("score") or 0.0)
    verification = normalized_verification
    verification_source_used = "normalized"

    # ค่าเริ่มต้น: ยังไม่ align
    alignment = _alignment_result(
        "skipped",
        "normalized_verification_checked_first",
        precheck={"reason": "alignment_deferred_until_needed"},
    )

    aligned_verification = None
    aligned_score = None

    # 2) ถ้า normalized ยังไม่ผ่าน หรือคะแนนต่ำ ค่อยลอง alignment
    should_try_alignment = (
        template_id is not None
        and (
            not bool(normalized_verification.get("passed"))
            or normalized_score < 0.75
        )
    )

    if should_try_alignment:
        alignment = _align_candidate_page(
            template_id,
            page_index,
            query_image_path,
            normalization_info,
        )

        if alignment.get("alignment_status") == "aligned" and alignment.get("aligned_image_path"):
            aligned_page_image_paths = dict(page_image_paths)
            aligned_page_image_paths[page_index] = str(alignment["aligned_image_path"])

            aligned_verification = verification_service.verify_template(
                template_id,
                aligned_page_image_paths,
            )
            aligned_score = float(aligned_verification.get("score") or 0.0)

            # 3) ใช้ aligned เฉพาะถ้าดีกว่า normalized
            if aligned_score > normalized_score:
                verification = aligned_verification
                verification_source_used = "aligned"

    alignment_debug = alignment.get("alignment_debug") or {}
    alignment_score = float(alignment.get("alignment_score") or alignment_debug.get("alignment_score") or 0.0)
    alignment_status = str(alignment.get("alignment_status") or "fallback")

    normalized_verification_score = normalized_score
    aligned_verification_score = aligned_score
    verification_improvement = (
        round(aligned_score - normalized_score, 4)
        if aligned_score is not None
        else None
    )

    alignment_debug["before_alignment_verification"] = round(normalized_score, 4)
    alignment_debug["normalized_verification_score"] = round(normalized_score, 4)
    alignment_debug["after_alignment_verification"] = round(aligned_score, 4) if aligned_score is not None else None
    alignment_debug["aligned_verification_score"] = round(aligned_score, 4) if aligned_score is not None else None
    alignment_debug["verification_improvement"] = verification_improvement
    alignment_debug["verification_image_used"] = verification_source_used
    alignment_debug["verification_source_used"] = verification_source_used

    alignment_reason = _alignment_reason(alignment_status, alignment, alignment_debug)
    alignment_debug["alignment_status"] = alignment_status
    alignment_debug["alignment_reason"] = alignment_reason

    alignment["alignment_debug"] = alignment_debug
    alignment["alignment_status"] = alignment_status
    alignment["alignment_reason"] = alignment_reason

    retrieval_score = float(result.get("score", 0.0) or 0.0)
    decision = decision_service.decide_candidate(
        retrieval_score,
        verification,
        final_confidence_threshold,
    )

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

        "alignment_status": alignment_status,
        "alignment": alignment,
        "alignment_debug": alignment_debug,
        "alignment_score": alignment_score,
        "alignment_passed": alignment_status == "aligned",
        "alignment_fallback_used": verification_source_used == "normalized",
        "alignment_reason": alignment_reason,

        "normalized_verification_score": round(normalized_verification_score, 4),
        "aligned_verification_score": round(aligned_verification_score, 4) if aligned_verification_score is not None else None,
        "verification_source_used": verification_source_used,
        "before_alignment_verification": round(normalized_verification_score, 4),
        "after_alignment_verification": round(aligned_verification_score, 4) if aligned_verification_score is not None else None,
        "verification_improvement": verification_improvement,

        "alignment_match_image_path": alignment.get("alignment_match_image_path"),
        "alignment_match_image_preview_url": alignment.get("alignment_match_image_preview_url"),
        "aligned_image_path": alignment.get("aligned_image_path"),
        "aligned_image_preview_url": alignment.get("aligned_image_preview_url"),
        "normalized_image_path": query_image_path,
        "normalized_image_preview_url": _detection_debug_url(query_image_path),

        "verification": verification,
        "verification_score": decision["verification_score"],
        "text_anchor_score": decision.get("text_anchor_score"),
        "image_anchor_score": decision.get("image_anchor_score"),
        "verification_passed": decision["verification_passed"],
        "final_score": decision["final_score"],
        "final_passed": decision["final_passed"],
        "decision_reason": decision["decision_reason"],
        "decision_path": decision["decision_path"],
        "final_confidence_threshold": decision["final_confidence_threshold"],
        "metadata": metadata,
    }


def _detect_page(page_info: Dict[str, Any], page_image_paths: Dict[int, str]) -> Dict[str, Any]:
    page_index = int(page_info["page_index"])
    normalized_image_path = str(page_info["normalized_path"])
    embedding = encode_images([normalized_image_path])
    raw_results = search_similar_templates(embedding.vector, limit=5)
    candidates = [
        candidate
        for candidate in (
            _candidate_from_result(result, page_image_paths, page_index, normalized_image_path, page_info.get("normalization"))
            for result in raw_results
        )
        if candidate is not None
    ]
    candidates = sorted(candidates, key=lambda item: (item["final_score"], item["retrieval_score"]), reverse=True)
    passing_candidates = [candidate for candidate in candidates if candidate["final_passed"]]
    best_candidate = passing_candidates[0] if passing_candidates else None
    matched = best_candidate is not None
    return {
        "page_index": page_index,
        "matched": matched,
        "best_candidate": best_candidate,
        "candidates": candidates,
        "image_preview_data_url": _image_to_data_url(Path(normalized_image_path)),
        "original_image_preview_url": _detection_debug_url(str(page_info["original_path"])),
        "normalized_image_preview_url": _detection_debug_url(normalized_image_path),
        "original_image_path": str(page_info["original_path"]),
        "normalized_image_path": normalized_image_path,
        "normalization": page_info["normalization"],
        "debug": {
            "query_image_path": str(page_info["original_path"]),
            "normalized_query_image_path": normalized_image_path,
            "original_image_preview_url": _detection_debug_url(str(page_info["original_path"])),
            "normalized_image_preview_url": _detection_debug_url(normalized_image_path),
            "query_engine": embedding.engine,
            "query_version": embedding.version,
            "query_model_name": embedding.model_name,
            "query_vector_dimension": embedding.dimension,
            "query_input_count": embedding.input_count,
            "raw_candidate_count": len(raw_results),
            "active_candidate_count": len(candidates),
            "aligned_candidate_paths": [
                candidate["alignment"]["aligned_image_path"]
                for candidate in candidates
                if candidate.get("alignment", {}).get("aligned_image_path")
            ],
            "alignment_match_image_paths": [
                candidate["alignment"]["alignment_match_image_path"]
                for candidate in candidates
                if candidate.get("alignment", {}).get("alignment_match_image_path")
            ],
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
            "alignment_status": best_page_cand.get("alignment_status"),
            "alignment": best_page_cand.get("alignment"),
            "alignment_debug": best_page_cand.get("alignment_debug"),
            "alignment_score": best_page_cand.get("alignment_score"),
            "alignment_passed": best_page_cand.get("alignment_passed"),
            "alignment_fallback_used": best_page_cand.get("alignment_fallback_used"),
            "alignment_reason": best_page_cand.get("alignment_reason"),
            "normalized_verification_score": best_page_cand.get("normalized_verification_score"),
            "aligned_verification_score": best_page_cand.get("aligned_verification_score"),
            "verification_source_used": best_page_cand.get("verification_source_used"),
            "before_alignment_verification": best_page_cand.get("before_alignment_verification"),
            "after_alignment_verification": best_page_cand.get("after_alignment_verification"),
            "verification_improvement": best_page_cand.get("verification_improvement"),
            "alignment_match_image_path": best_page_cand.get("alignment_match_image_path"),
            "alignment_match_image_preview_url": best_page_cand.get("alignment_match_image_preview_url"),
            "aligned_image_path": best_page_cand.get("aligned_image_path"),
            "aligned_image_preview_url": best_page_cand.get("aligned_image_preview_url"),
            "normalized_image_path": best_page_cand.get("normalized_image_path"),
            "normalized_image_preview_url": best_page_cand.get("normalized_image_preview_url"),
            "verification": best_page_cand.get("verification"),
            "verification_score": decision["verification_score"],
            "text_anchor_score": decision.get("text_anchor_score"),
            "image_anchor_score": decision.get("image_anchor_score"),
            "verification_passed": decision["verification_passed"],
            "final_score": decision["final_score"],
            "final_passed": decision["final_passed"],
            "decision_reason": decision["decision_reason"],
            "decision_path": decision["decision_path"],
            "final_confidence_threshold": decision["final_confidence_threshold"],
            "metadata": best_page_cand.get("metadata", {}),
        })

    return sorted(aggregated, key=lambda item: (item["final_score"], item["retrieval_score"]), reverse=True)


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
    normalized_pages = _normalize_query_pages(query_id, page_paths)
    page_image_paths = {page["page_index"]: page["normalized_path"] for page in normalized_pages}
    pages = [_detect_page(page, page_image_paths) for page in normalized_pages]
    candidates = _aggregate_candidates(pages)
    passing_candidates = sorted(
        [candidate for candidate in candidates if candidate["final_passed"]],
        key=lambda item: (item["final_score"], item["retrieval_score"]),
        reverse=True,
    )
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
            "normalized_query_page_paths": [page["normalized_path"] for page in normalized_pages],
        },
    }
