import io
import os
import base64
import cv2
import numpy as np
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from .alignment_service import AlignmentService
from .anchor_projection_service import AnchorProjectionService
from .db import connect as connect_db
from .image_normalization import ImageNormalizationService
from .layout_analysis_service import analyze_layout
from .layout_alignment_service import LayoutAlignmentService
from .layout_signature_service import build_layout_signature
from .layout_template_matcher import search_layout_candidates
from .pipeline_core import get_pipeline_core_config
from .services import DecisionService, VerificationService


DETECTION_THRESHOLD = 0.75
PIPELINE_CONFIG = get_pipeline_core_config()
DETECTION_VERSION = PIPELINE_CONFIG.version
PDF_RENDER_SCALE = 2.0
DETECTION_RETRIEVAL_LIMIT = max(1, int(os.getenv("DETECTION_RETRIEVAL_LIMIT", "5")))
DETECTION_FULL_EVAL_LIMIT = max(1, int(os.getenv("DETECTION_FULL_EVAL_LIMIT", "2")))
DETECTION_ALIGNMENT_LIMIT = max(0, int(os.getenv("DETECTION_ALIGNMENT_LIMIT", "1")))
verification_service = VerificationService()
decision_service = DecisionService()
normalization_service = ImageNormalizationService()
alignment_service = AlignmentService()
layout_alignment_service = LayoutAlignmentService()
projection_service = AnchorProjectionService()


def _connect() -> Any:
    conn = connect_db()
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


def _fetch_template_fields(template_id: str) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM template_fields
            WHERE template_id = ?
            ORDER BY page_number ASC, sort_order ASC, created_at ASC
            """,
            (template_id,),
        ).fetchall()

    fields: List[Dict[str, Any]] = []
    for row in rows:
        fields.append(
            {
                "id": row["id"],
                "template_id": row["template_id"],
                "template_page_id": row["template_page_id"],
                "page_number": row["page_number"],
                "field_name": row["field_name"],
                "display_label": row["display_label"],
                "roi": {
                    "page_number": row["page_number"],
                    "x_ratio": row["roi_x_ratio"],
                    "y_ratio": row["roi_y_ratio"],
                    "width_ratio": row["roi_width_ratio"],
                    "height_ratio": row["roi_height_ratio"],
                },
                "data_type": row["data_type"],
                "use_for_verification": bool(row["use_for_verification"]),
                "expected_text": row["expected_text"],
                "match_type": row["match_type"],
                "required_for_verification": bool(row["required_for_verification"]),
                "extraction_method": row["extraction_method"],
                "roi_padding": row["roi_padding"],
                "verification_weight": row["verification_weight"] if "verification_weight" in row.keys() else 1.0,
            }
        )
    return fields


def _image_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _layout_signature_for_image_path(image_path: str) -> Dict[str, Any]:
    Image = _load_pillow()
    if Image is None:
        raise HTTPException(status_code=500, detail="Layout signature generation requires Pillow")
    try:
        image = Image.open(image_path).convert("RGB")
        opencv_img = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    except Exception as error:
        raise HTTPException(status_code=400, detail="Unable to read image for layout signature") from error
    return build_layout_signature(analyze_layout(opencv_img))


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
        return str(alignment_debug.get("reason") or "alignment_skipped_geometry_already_matches_template")
    if alignment_status == "aligned":
        return str(alignment_debug.get("reason") or "alignment_succeeded_and_aligned_image_used")
    if alignment_status == "fallback":
        return str(alignment_debug.get("reason") or alignment.get("error") or "alignment_attempted_but_normalized_image_used")
    return str(alignment.get("error") or alignment_debug.get("reason") or "alignment_failed_unexpectedly_normalized_image_used")


def _template_canvas_projection(
    template_id: str,
    fields: List[Dict[str, Any]],
    page_number: int,
    alignment_status: str,
    alignment_reason: str,
    extraction_image_path: str,
    extraction_image_preview_url: Optional[str],
) -> Dict[str, Any]:
    extraction_fields = [
        field
        for field in fields
        if not field.get("use_for_verification") and int(field.get("page_number") or 1) == int(page_number)
    ]
    projected_fields = []
    for field in extraction_fields:
        roi = field.get("roi") or {}
        projected_fields.append(
            {
                "field_id": field.get("id"),
                "field_name": field.get("field_name"),
                "display_label": field.get("display_label"),
                "page_number": field.get("page_number"),
                "template_roi": roi,
                "projected_polygon_before_clip": [],
                "projected_polygon": [],
                "projected_roi_before_clip": roi,
                "projected_roi": roi,
                "adaptive_roi": roi,
                "adaptive_search_region": None,
                "adaptive_word_boxes": [],
                "adaptive_word_groups": [],
                "adaptive_ranked_word_groups": [],
                "adaptive_status": "not_run",
                "adaptive_confidence": None,
                "adaptive_word_count": 0,
                "adaptive_coverage": None,
                "adaptive_ocr_confidence": None,
                "adaptive_validation_result": {
                    "passed": True,
                    "errors": [],
                    "warnings": ["adaptive_roi_pending"],
                },
                "adaptive_fallback_reason": None,
                "projection_method": "template_canvas",
                "projection_valid": True,
                "projection_validation_result": {
                    "passed": True,
                    "errors": [],
                    "warnings": [],
                    "reason": "roi_uses_template_canvas_after_alignment",
                },
                "fallback_used": False,
            }
        )

    projected_fields, adaptive_debug = projection_service.refine_projected_fields(
        projected_fields,
        extraction_fields,
        {int(page_number): extraction_image_path},
    )

    return {
        "template_id": template_id,
        "status": "success",
        "method": "template_canvas",
        "anchors_expected": 0,
        "anchors_matched": 0,
        "inliers": 0,
        "reprojection_error": None,
        "confidence": 1.0,
        "fallback_reason": None,
        "matched_anchors": [],
        "adaptive_refinement": {
            **adaptive_debug,
            "reason": adaptive_debug.get("reason") or "template_canvas_alignment_refined",
        },
        "projected_fields": projected_fields,
        "roi_coordinate_space": "template_canvas",
        "extraction_image_path": extraction_image_path,
        "extraction_image_preview_url": extraction_image_preview_url,
        "alignment_status": alignment_status,
        "alignment_reason": alignment_reason,
    }


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
        layout_alignment = layout_alignment_service.align_to_template(
            query_image_path,
            template_image_source,
            str(output_path),
        )
        layout_status = str(layout_alignment.get("alignment_status") or "")
        layout_alignment["aligned_image_preview_url"] = _detection_debug_url(layout_alignment.get("aligned_image_path"))
        layout_alignment["alignment_match_image_preview_url"] = _detection_debug_url(layout_alignment.get("alignment_match_image_path"))
        layout_debug = layout_alignment.get("alignment_debug") or {}
        layout_debug["layout_alignment_executed"] = layout_status != "skipped"
        layout_debug["orb_executed"] = False
        layout_debug["verification_source_used"] = "aligned" if layout_status == "aligned" else "normalized"
        layout_alignment["alignment_debug"] = layout_debug
        if layout_status in {"aligned", "skipped"}:
            return layout_alignment

        precheck = alignment_service.alignment_precheck(query_image_path, template_image_source, normalization_info)
        if not precheck.get("should_run_orb"):
            precheck["layout_alignment"] = layout_debug
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
        alignment_debug["layout_alignment"] = layout_debug
        alignment_debug["layout_alignment_status"] = layout_status
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
    allow_alignment: bool = True,
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

    matching_weights = decision_service.matching_weights(template, metadata)

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

    # 2) Template alignment is part of the production path.
    # The alignment service precheck skips ORB when geometry already matches.
    should_try_alignment = template_id is not None and allow_alignment

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

            # 3) Alignment is optional refinement. Never use a warped image if it
            # hurts OCR verification; fallback to the normalized image instead.
            if aligned_score >= normalized_score:
                verification = aligned_verification
                verification_source_used = "aligned"
            else:
                alignment["alignment_status"] = "fallback"
                alignment_debug = alignment.get("alignment_debug") or {}
                alignment_debug["reason"] = "aligned_verification_worse_than_normalized"
                alignment_debug["alignment_status"] = "fallback"
                alignment_debug["verification_source_used"] = "normalized"
                alignment["alignment_debug"] = alignment_debug
                verification = normalized_verification
                verification_source_used = "normalized"

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
        matching_weights,
    )
    layout_threshold = float((template or {}).get("similarity_threshold") or metadata.get("similarity_threshold") or DETECTION_THRESHOLD)
    if retrieval_score < layout_threshold:
        decision = {
            **decision,
            "final_passed": False,
            "decision_reason": "layout_score_below_threshold",
            "decision_path": "layout_score_below_threshold",
        }
    extraction_image_path = str(alignment.get("aligned_image_path") or query_image_path) if verification_source_used == "aligned" else query_image_path
    extraction_image_preview_url = _detection_debug_url(extraction_image_path)
    roi_coordinate_space = "template_canvas" if alignment_status in {"aligned", "skipped"} else "projected"

    projection = {
        "template_id": template_id,
        "status": "skipped",
        "method": "not_run",
        "anchors_expected": 0,
        "anchors_matched": 0,
        "inliers": 0,
        "reprojection_error": None,
        "confidence": 0.0,
        "fallback_reason": "candidate_did_not_pass_final_decision",
        "matched_anchors": [],
        "projected_fields": [],
        "roi_coordinate_space": roi_coordinate_space,
        "extraction_image_path": extraction_image_path,
        "extraction_image_preview_url": extraction_image_preview_url,
    }
    if template_id and decision["final_passed"]:
        template_fields = _fetch_template_fields(template_id)
        if roi_coordinate_space == "template_canvas":
            projection = _template_canvas_projection(
                template_id,
                template_fields,
                page_index,
                alignment_status,
                alignment_reason,
                extraction_image_path,
                extraction_image_preview_url,
            )
        else:
            try:
                projection_page_paths = dict(page_image_paths)
                projection_page_paths[page_index] = extraction_image_path
                projection = projection_service.project(
                    template_id,
                    template_fields,
                    projection_page_paths,
                )
                projection["roi_coordinate_space"] = roi_coordinate_space
                projection["extraction_image_path"] = extraction_image_path
                projection["extraction_image_preview_url"] = extraction_image_preview_url
            except Exception as error:
                projection = {
                    "template_id": template_id,
                    "status": "failed",
                    "method": "ratio_fallback",
                    "anchors_expected": 0,
                    "anchors_matched": 0,
                    "inliers": 0,
                    "reprojection_error": None,
                    "confidence": 0.0,
                    "fallback_reason": f"projection_runtime_error: {error}",
                    "matched_anchors": [],
                    "projected_fields": [],
                    "roi_coordinate_space": roi_coordinate_space,
                    "extraction_image_path": extraction_image_path,
                    "extraction_image_preview_url": extraction_image_preview_url,
                }

    return {
        "template_id": template_id,
        "vector_id": vector_id,
        "score": decision["final_score"],
        "retrieval_score": decision["retrieval_score"],
        "layout_score": decision["retrieval_score"],
        "layout_debug": metadata.get("layout_debug") or result.get("layout_debug"),
        "average_score": decision["retrieval_score"],
        "matched_pages": 1 if decision["final_passed"] else 0,
        "template_name": template_name,
        "template_status": template_status,
        "page_count": page_count,
        "field_count": field_count,
        "model_name": metadata.get("model_name") or metadata.get("layout_signature_version"),
        "vector_store_engine": metadata.get("vector_store_engine") or "layout-signature",
        "retrieval_engine": metadata.get("retrieval_engine") or "layout_signature",

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
        "extraction_image_path": extraction_image_path,
        "extraction_image_preview_url": extraction_image_preview_url,
        "roi_coordinate_space": roi_coordinate_space,

        "verification": verification,
        "verification_score": decision["verification_score"],
        "text_anchor_score": decision.get("text_anchor_score"),
        "image_anchor_score": decision.get("image_anchor_score"),
        "anchor_score": decision.get("anchor_score"),
        "matching_weights": decision.get("matching_weights"),
        "effective_matching_weights": decision.get("effective_matching_weights"),
        "verification_passed": decision["verification_passed"],
        "final_score": decision["final_score"],
        "final_passed": decision["final_passed"],
        "decision_reason": decision["decision_reason"],
        "decision_path": decision["decision_path"],
        "required_passed": decision.get("required_passed"),
        "required_failed_fields": decision.get("required_failed_fields", []),
        "final_confidence_threshold": decision["final_confidence_threshold"],
        "layout_similarity_threshold": layout_threshold,
        "projection": projection,
        "projected_fields": projection.get("projected_fields", []),
        "metadata": metadata,
        "evaluation_status": "full",
        "alignment_evaluated": bool(allow_alignment),
    }


def _lightweight_candidate_from_result(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    metadata = result.get("metadata") or {}
    vector_id = str(result.get("vector_id") or "")
    template_id = _template_id_from_metadata(metadata, vector_id)
    template = _fetch_template(template_id)
    if template_id and template is None:
        return None

    template_status = template.get("status") if template else metadata.get("template_status")
    if template_status != "active":
        return None

    template_name = template.get("name") if template else metadata.get("template_name")
    page_count = template.get("page_count") if template else metadata.get("page_count")
    final_confidence_threshold = decision_service.final_confidence_threshold(template, metadata)
    field_count = metadata.get("field_count")
    if template and field_count is None:
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

    retrieval_score = round(float(result.get("score", 0.0) or 0.0), 4)
    verification = {
        "template_id": template_id,
        "status": "not_evaluated_fast_path",
        "passed": False,
        "score": 0.0,
        "text_anchor_score": 0.0,
        "image_anchor_score": 0.0,
        "required_passed": False,
        "checked_fields": [],
    }
    return {
        "template_id": template_id,
        "vector_id": vector_id,
        "score": retrieval_score,
        "retrieval_score": retrieval_score,
        "layout_score": retrieval_score,
        "layout_debug": metadata.get("layout_debug") or result.get("layout_debug"),
        "average_score": retrieval_score,
        "matched_pages": 0,
        "template_name": template_name,
        "template_status": template_status,
        "page_count": page_count,
        "field_count": field_count,
        "model_name": metadata.get("model_name") or metadata.get("layout_signature_version"),
        "vector_store_engine": metadata.get("vector_store_engine") or "layout-signature",
        "retrieval_engine": metadata.get("retrieval_engine") or "layout_signature",
        "alignment_status": "not_evaluated",
        "alignment": _alignment_result("skipped", "candidate_not_fully_evaluated_fast_path"),
        "alignment_debug": {"reason": "candidate_not_fully_evaluated_fast_path"},
        "alignment_score": 0.0,
        "alignment_passed": False,
        "alignment_fallback_used": True,
        "alignment_reason": "candidate_not_fully_evaluated_fast_path",
        "normalized_verification_score": None,
        "aligned_verification_score": None,
        "verification_source_used": None,
        "before_alignment_verification": None,
        "after_alignment_verification": None,
        "verification_improvement": None,
        "alignment_match_image_path": None,
        "alignment_match_image_preview_url": None,
        "aligned_image_path": None,
        "aligned_image_preview_url": None,
        "normalized_image_path": None,
        "normalized_image_preview_url": None,
        "extraction_image_path": None,
        "extraction_image_preview_url": None,
        "roi_coordinate_space": None,
        "verification": verification,
        "verification_score": 0.0,
        "text_anchor_score": 0.0,
        "image_anchor_score": 0.0,
        "anchor_score": 0.0,
        "verification_passed": False,
        "final_score": retrieval_score,
        "final_passed": False,
        "decision_reason": "not_evaluated_fast_path",
        "decision_path": "not_evaluated_fast_path",
        "required_passed": False,
        "required_failed_fields": [],
        "final_confidence_threshold": final_confidence_threshold,
        "layout_similarity_threshold": float((template or {}).get("similarity_threshold") or metadata.get("similarity_threshold") or DETECTION_THRESHOLD),
        "projection": {
            "template_id": template_id,
            "status": "not_evaluated",
            "method": "fast_path_skipped",
            "projected_fields": [],
        },
        "projected_fields": [],
        "metadata": metadata,
        "evaluation_status": "lightweight",
        "alignment_evaluated": False,
    }


def _detect_page(page_info: Dict[str, Any], page_image_paths: Dict[int, str]) -> Dict[str, Any]:
    page_index = int(page_info["page_index"])
    normalized_image_path = str(page_info["normalized_path"])
    query_signature = _layout_signature_for_image_path(normalized_image_path)
    raw_results = search_layout_candidates(query_signature, page_number=page_index, limit=DETECTION_RETRIEVAL_LIMIT)
    candidates = []
    for index, result in enumerate(raw_results, start=1):
        if index <= DETECTION_FULL_EVAL_LIMIT:
            candidate = _candidate_from_result(
                result,
                page_image_paths,
                page_index,
                normalized_image_path,
                page_info.get("normalization"),
                allow_alignment=index <= DETECTION_ALIGNMENT_LIMIT,
            )
        else:
            candidate = _lightweight_candidate_from_result(result)
        if candidate is not None:
            candidate["retrieval_rank"] = index
            candidates.append(candidate)

    candidates = sorted(
        candidates,
        key=lambda item: (
            bool(item["final_passed"]),
            item.get("evaluation_status") == "full",
            item["final_score"],
            item["retrieval_score"],
        ),
        reverse=True,
    )
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
            "query_engine": "layout_signature",
            "query_version": query_signature.get("version"),
            "query_model_name": query_signature.get("model"),
            "query_vector_dimension": 0,
            "query_input_count": 1,
            "query_layout_signature": query_signature,
            "raw_candidate_count": len(raw_results),
            "active_candidate_count": len(candidates),
            "retrieval_limit": DETECTION_RETRIEVAL_LIMIT,
            "full_evaluation_limit": DETECTION_FULL_EVAL_LIMIT,
            "alignment_limit": DETECTION_ALIGNMENT_LIMIT,
            "fast_path_enabled": DETECTION_FULL_EVAL_LIMIT < DETECTION_RETRIEVAL_LIMIT or DETECTION_ALIGNMENT_LIMIT < DETECTION_FULL_EVAL_LIMIT,
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
            best_page_cand.get("matching_weights"),
        )

        aggregated.append({
            "template_id": template_id,
            "vector_id": best_page_cand["vector_id"],
            "score": decision["final_score"],
            "retrieval_score": decision["retrieval_score"],
            "layout_score": decision["retrieval_score"],
            "layout_debug": best_page_cand.get("layout_debug"),
            "average_score": avg_retrieval_score,
            "matched_pages": matched_pages_count,
            "template_name": best_page_cand["template_name"],
            "template_status": best_page_cand["template_status"],
            "page_count": best_page_cand["page_count"],
            "field_count": best_page_cand["field_count"],
            "model_name": best_page_cand["model_name"],
            "vector_store_engine": best_page_cand["vector_store_engine"],
            "retrieval_engine": best_page_cand.get("retrieval_engine"),
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
            "extraction_image_path": best_page_cand.get("extraction_image_path"),
            "extraction_image_preview_url": best_page_cand.get("extraction_image_preview_url"),
            "roi_coordinate_space": best_page_cand.get("roi_coordinate_space"),
            "verification": best_page_cand.get("verification"),
            "verification_score": decision["verification_score"],
            "text_anchor_score": decision.get("text_anchor_score"),
            "image_anchor_score": decision.get("image_anchor_score"),
            "anchor_score": decision.get("anchor_score"),
            "matching_weights": decision.get("matching_weights"),
            "effective_matching_weights": decision.get("effective_matching_weights"),
            "verification_passed": decision["verification_passed"],
            "final_score": decision["final_score"],
            "final_passed": decision["final_passed"],
            "decision_reason": decision["decision_reason"],
            "decision_path": decision["decision_path"],
            "required_passed": decision.get("required_passed"),
            "required_failed_fields": decision.get("required_failed_fields", []),
            "final_confidence_threshold": decision["final_confidence_threshold"],
            "layout_similarity_threshold": best_page_cand.get("layout_similarity_threshold"),
            "projection": best_page_cand.get("projection"),
            "projected_fields": best_page_cand.get("projected_fields", []),
            "metadata": best_page_cand.get("metadata", {}),
        })

    return sorted(aggregated, key=lambda item: (item["final_score"], item["retrieval_score"]), reverse=True)


def _detection_engine(pages: List[Dict[str, Any]]) -> str:
    return "layout_signature"


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
            "pipeline_core": PIPELINE_CONFIG.to_debug_dict(),
            "vector_store_mode": "not_used_for_global_retrieval",
            "vision_embedding_mode": "not_used_for_global_retrieval",
            "retrieval_engine": "layout_signature",
            "source_type": source_type,
            "input_page_count": len(page_paths),
            "converted_page_count": len(page_paths) if source_type == "pdf" else 0,
            "query_page_paths": [str(path) for path in page_paths],
            "normalized_query_page_paths": [page["normalized_path"] for page in normalized_pages],
        },
    }
