import base64
import io
import json
import logging
import math
import os
import re
import time
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from .alignment_service import AlignmentService
from .db import connect as connect_db
from .image_normalization import ImageNormalizationService
from .image_verification_category_service import (
    ImageVerificationCategoryService,
    categories_to_runtime_payload,
    ensure_image_verification_categories_table,
    get_image_verification_category,
    list_image_verification_categories,
)
from .layout_analysis_service import analyze_layout, detect_text_boxes
from .layout_signature_service import build_layout_signature, compare_layout_signatures, signature_from_json, signature_to_json
from .layout_template_matcher import search_layout_candidates
from .ocr_adapter import OcrUnavailableError, ocr_roi, ocr_rois
from .ocr_postprocess import normalize_ocr_text
from .siglip_image_verification_adapter import (
    verify_image_category,
)
from .schemas import (
    CustomOcrRequest,
    DocumentUploadRequest,
    ExtractionRequest,
    IgnoreRegionCreate,
    IgnoreRegionUpdate,
    RequestedFieldCreate,
    RequestedFieldUpdate,
    TemplateCreate,
    TemplateFieldCreate,
    TemplateFieldUpdate,
    TemplatePageCreate,
    TemplatePageUpdate,
    TemplateRequestCreate,
    TemplateRequestImageCreate,
    TemplateRequestImageUpdate,
    TemplateRequestUpdate,
    TemplateTestRequest,
    TemplateUpdate,
    TemplateVersionCreate,
)


logger = logging.getLogger(__name__)


class EmbeddingContextError(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stub_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def _normalize_extraction_method(value: Optional[str]) -> str:
    if value == "typhoon_ocr":
        return "paddle_thai_ocr"
    if value in {"ocr_text", "ocr_table", "paddle_thai_ocr", "table_recognition_v2", "extract_image"}:
        return value
    return "ocr_text"


def _normalize_data_type(value: Optional[str]) -> str:
    if value in {"text", "number", "date", "table", "image", "string", "address", "currency"}:
        return "text" if value == "string" else value
    return "text"


def _normalize_roi_mode(value: Optional[str]) -> str:
    return "flexible" if value == "flexible" else "fix"


def _normalize_expected_content(value: Optional[str]) -> Optional[str]:
    return "text" if value == "text" else None


def _connect() -> Any:
    conn = connect_db()
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_template_request_page_review_columns(conn)
    _ensure_template_layout_references_table(conn)
    _ensure_requested_field_metadata_columns(conn)
    _ensure_template_matching_weight_columns(conn)
    _ensure_template_version_columns(conn)
    _ensure_template_page_layout_signature_column(conn)
    _ensure_template_field_verification_columns(conn)
    ensure_image_verification_categories_table(conn)
    _ensure_embedding_jobs_table(conn)
    return conn


def _ensure_template_request_page_review_columns(conn: Any) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(template_request_pages)").fetchall()
    }
    if columns and "image_source" not in columns:
        conn.execute("ALTER TABLE template_request_pages ADD COLUMN image_source TEXT DEFAULT 'user_request'")
    if columns and "review_status" not in columns:
        conn.execute("ALTER TABLE template_request_pages ADD COLUMN review_status TEXT DEFAULT 'pending'")
    if columns and "is_canonical" not in columns:
        conn.execute("ALTER TABLE template_request_pages ADD COLUMN is_canonical INTEGER DEFAULT 0")
    if columns and "layout_signature_json" not in columns:
        conn.execute("ALTER TABLE template_request_pages ADD COLUMN layout_signature_json TEXT")
    if columns and "source_file_id" not in columns:
        conn.execute("ALTER TABLE template_request_pages ADD COLUMN source_file_id TEXT")
    if columns and "source_file_name" not in columns:
        conn.execute("ALTER TABLE template_request_pages ADD COLUMN source_file_name TEXT")
    conn.commit()


def _ensure_template_layout_references_table(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS template_layout_references (
            id TEXT NOT NULL PRIMARY KEY,
            template_id TEXT NOT NULL,
            template_page_id TEXT,
            page_number INTEGER NOT NULL DEFAULT 1,
            image_url TEXT NOT NULL,
            image_source TEXT NOT NULL DEFAULT 'user_request',
            review_status TEXT NOT NULL DEFAULT 'approved',
            is_canonical INTEGER NOT NULL DEFAULT 0,
            layout_signature_json TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
            FOREIGN KEY (template_page_id) REFERENCES template_pages(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS template_layout_references_template_id_idx ON template_layout_references(template_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS template_layout_references_template_status_idx ON template_layout_references(template_id, review_status, is_canonical)"
    )
    conn.commit()


def _ensure_requested_field_metadata_columns(conn: Any) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(requested_fields)").fetchall()
    }
    if columns and "data_type" not in columns:
        conn.execute("ALTER TABLE requested_fields ADD COLUMN data_type TEXT DEFAULT 'text'")
    if columns and "extraction_method" not in columns:
        conn.execute("ALTER TABLE requested_fields ADD COLUMN extraction_method TEXT DEFAULT 'ocr_text'")
    conn.commit()


def _ensure_embedding_jobs_table(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS embedding_jobs (
            id TEXT NOT NULL PRIMARY KEY,
            template_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME,
            completed_at DATETIME,
            error_message TEXT,
            vector_id TEXT,
            metadata_json TEXT,
            FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS embedding_jobs_template_id_requested_at_idx ON embedding_jobs(template_id, requested_at)"
    )
    conn.commit()


def _ensure_template_matching_weight_columns(conn: Any) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(templates)").fetchall()
    }
    if columns and "layout_weight" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN layout_weight REAL DEFAULT 0.50")
    if columns and "text_anchor_weight" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN text_anchor_weight REAL DEFAULT 0.35")
    if columns and "image_anchor_weight" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN image_anchor_weight REAL DEFAULT 0.15")
    conn.commit()


def _ensure_template_version_columns(conn: Any) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(templates)").fetchall()
    }
    if columns and "template_group_id" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN template_group_id TEXT")
    if columns and "version_number" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN version_number INTEGER DEFAULT 1")
    if columns and "base_template_id" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN base_template_id TEXT")
    if columns and "description" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN description TEXT")
    if columns and "shared_fields_json" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN shared_fields_json TEXT")
    if columns and "creation_type" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN creation_type TEXT DEFAULT 'new_template'")
    conn.execute("UPDATE templates SET template_group_id = id WHERE template_group_id IS NULL OR template_group_id = ''")
    conn.execute("UPDATE templates SET version_number = version WHERE version_number IS NULL")
    conn.commit()


def _ensure_template_field_verification_columns(conn: Any) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(template_fields)").fetchall()
    }
    if columns and "verification_weight" not in columns:
        conn.execute("ALTER TABLE template_fields ADD COLUMN verification_weight REAL DEFAULT 1.0")
    if columns and "image_category" not in columns:
        conn.execute("ALTER TABLE template_fields ADD COLUMN image_category TEXT")
    if columns and "roi_mode" not in columns:
        conn.execute("ALTER TABLE template_fields ADD COLUMN roi_mode TEXT DEFAULT 'fix'")
    if columns and "expected_content" not in columns:
        conn.execute("ALTER TABLE template_fields ADD COLUMN expected_content TEXT")
    conn.commit()


def _ensure_template_page_layout_signature_column(conn: Any) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(template_pages)").fetchall()
    }
    if columns and "layout_signature_json" not in columns:
        conn.execute("ALTER TABLE template_pages ADD COLUMN layout_signature_json TEXT")
    conn.commit()


def _row_to_dict(row: Any) -> Dict[str, Any]:
    return dict(row)


def _request_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "requested_by": item["requested_by"],
        "request_title": item["request_title"],
        "document_type": item["document_type"],
        "sample_file_url": item["sample_file_url"],
        "request_mode": item["request_mode"],
        "status": item["status"],
        "user_note": item["user_note"],
        "admin_note": item["admin_note"],
        "converted_template_id": item["converted_template_id"],
        "page_count": item["page_count"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _page_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_request_id": item["template_request_id"],
        "page_number": item["page_number"],
        "sample_image_url": item["sample_image_url"],
        "source_file_id": item.get("source_file_id"),
        "source_file_name": item.get("source_file_name"),
        "image_source": item.get("image_source", "user_request"),
        "review_status": item.get("review_status", "pending"),
        "is_canonical": bool(item.get("is_canonical", 0)),
        "layout_signature_json": item.get("layout_signature_json"),
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_layout_reference_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "template_page_id": item.get("template_page_id"),
        "page_number": item["page_number"],
        "image_url": item["image_url"],
        "image_source": item.get("image_source", "user_request"),
        "review_status": item.get("review_status", "approved"),
        "is_canonical": bool(item.get("is_canonical", 0)),
        "layout_signature_json": item.get("layout_signature_json"),
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _field_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_request_id": item["template_request_id"],
        "template_request_page_id": item["template_request_page_id"],
        "page_number": item["page_number"],
        "field_name": item["field_name"],
        "display_label": item["display_label"],
        "roi": {
            "page_number": item["page_number"],
            "x_ratio": item["roi_x_ratio"],
            "y_ratio": item["roi_y_ratio"],
            "width_ratio": item["roi_width_ratio"],
            "height_ratio": item["roi_height_ratio"],
        },
        "data_type": _normalize_data_type(item.get("data_type")),
        "extraction_method": _normalize_extraction_method(item.get("extraction_method")),
        "user_note": item["user_note"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    shared_fields = []
    try:
        shared_fields = json.loads(item.get("shared_fields_json") or "[]")
    except (TypeError, json.JSONDecodeError):
        shared_fields = []
    return {
        "id": item["id"],
        "name": item["name"],
        "document_type": item["document_type"],
        "category": item["category"],
        "status": item["status"],
        "version": item["version"],
        "template_group_id": item.get("template_group_id") or item["id"],
        "version_number": item.get("version_number") or item["version"],
        "base_template_id": item.get("base_template_id"),
        "description": item.get("description"),
        "shared_fields": shared_fields if isinstance(shared_fields, list) else [],
        "creation_type": item.get("creation_type") or "new_template",
        "page_count": item["page_count"],
        "similarity_threshold": item["similarity_threshold"],
        "final_confidence_threshold": item["final_confidence_threshold"],
        "layout_weight": item.get("layout_weight", 0.50),
        "text_anchor_weight": item.get("text_anchor_weight", 0.35),
        "image_anchor_weight": item.get("image_anchor_weight", 0.15),
        "rejection_reason": item["rejection_reason"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_page_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    layout_signature_json = item.get("layout_signature_json") if "layout_signature_json" in item else None
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "page_number": item["page_number"],
        "page_name": item["page_name"],
        "sample_image_url": item["sample_image_url"],
        "normalized_image_url": item["normalized_image_url"],
        "layout_signature_json": layout_signature_json,
        "similarity_threshold": item["similarity_threshold"],
        "final_confidence_threshold": item["final_confidence_threshold"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_field_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "template_page_id": item["template_page_id"],
        "page_number": item["page_number"],
        "field_name": item["field_name"],
        "display_label": item["display_label"],
        "roi": {
            "page_number": item["page_number"],
            "x_ratio": item["roi_x_ratio"],
            "y_ratio": item["roi_y_ratio"],
            "width_ratio": item["roi_width_ratio"],
            "height_ratio": item["roi_height_ratio"],
        },
        "data_type": item["data_type"],
        "user_selectable": bool(item["user_selectable"]),
        "default_selected": bool(item["default_selected"]),
        "use_for_verification": bool(item["use_for_verification"]),
        "expected_text": item["expected_text"],
        "match_type": item["match_type"],
        "required_for_verification": bool(item["required_for_verification"]),
        "extraction_method": _normalize_extraction_method(item["extraction_method"]),
        "roi_mode": item.get("roi_mode") or "fix",
        "expected_content": item.get("expected_content"),
        "roi_padding": item["roi_padding"],
        "verification_weight": item.get("verification_weight", 1.0),
        "image_category": item.get("image_category"),
        "sort_order": item["sort_order"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _ignore_region_row_to_api(row: Any) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "template_page_id": item["template_page_id"],
        "page_number": item["page_number"],
        "field_name": item["field_name"],
        "roi": {
            "page_number": item["page_number"],
            "x_ratio": item["roi_x_ratio"],
            "y_ratio": item["roi_y_ratio"],
            "width_ratio": item["roi_width_ratio"],
            "height_ratio": item["roi_height_ratio"],
        },
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _embedding_job_row_to_api(row: Optional[Any]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "status": item["status"],
        "requested_at": item["requested_at"],
        "started_at": item["started_at"],
        "completed_at": item["completed_at"],
        "error_message": item["error_message"],
        "vector_id": item["vector_id"],
        "metadata_json": item["metadata_json"],
    }


def _cosine_similarity(left: List[float], right: List[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def _storage_root() -> Path:
    return Path(__file__).resolve().parents[1] / "storage"


def _load_image_source(source: Optional[str]):
    if not source:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None

    if source.startswith("data:image"):
        try:
            encoded = source.split(",", 1)[1]
            return Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
        except Exception:
            return None

    path = Path(source)
    if not path.exists():
        return None
    try:
        return Image.open(path).convert("RGB")
    except Exception:
        return None


def _image_to_bgr_array(image: Any):
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    try:
        rgb = np.array(image.convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _generate_layout_signature_for_source(source: Optional[str]) -> Optional[Dict[str, Any]]:
    image = _load_image_source(source)
    if image is None:
        return None
    opencv_img = _image_to_bgr_array(image)
    if opencv_img is None:
        return None
    analysis = analyze_layout(opencv_img)
    return build_layout_signature(analysis)


def _ensure_template_pages_layout_references(conn: Any, template_id: str) -> None:
    rows = conn.execute(
        """
        SELECT id, page_number, normalized_image_url, sample_image_url, layout_signature_json
        FROM template_pages
        WHERE template_id = ?
        ORDER BY page_number ASC
        """,
        (template_id,),
    ).fetchall()
    for row in rows:
        source = row["normalized_image_url"] or row["sample_image_url"]
        if not source:
            continue
        existing = conn.execute(
            """
            SELECT id
            FROM template_layout_references
            WHERE template_id = ? AND template_page_id = ?
            LIMIT 1
            """,
            (template_id, row["id"]),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE template_layout_references
                SET page_number = ?,
                    image_url = ?,
                    image_source = 'template_page',
                    review_status = 'approved',
                    is_canonical = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (row["page_number"], source, existing["id"]),
            )
            continue
        conn.execute(
            """
            INSERT INTO template_layout_references (
                id, template_id, template_page_id, page_number, image_url,
                image_source, review_status, is_canonical, layout_signature_json,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'template_page', 'approved', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                _stub_id("tpl_ref"),
                template_id,
                row["id"],
                row["page_number"],
                source,
                row["layout_signature_json"],
            ),
        )


def _refresh_template_layout_signatures(conn: Any, template_id: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, page_number, normalized_image_url, sample_image_url
        FROM template_pages
        WHERE template_id = ?
        ORDER BY page_number ASC
        """,
        (template_id,),
    ).fetchall()
    refreshed: List[Dict[str, Any]] = []
    for row in rows:
        source = row["normalized_image_url"] or row["sample_image_url"]
        signature = _generate_layout_signature_for_source(source)
        if signature is None:
            refreshed.append(
                {
                    "template_page_id": row["id"],
                    "page_number": row["page_number"],
                    "status": "failed",
                    "reason": "page_image_unavailable_or_invalid",
                }
            )
            continue
        signature_json = signature_to_json(signature)
        conn.execute(
            """
            UPDATE template_pages
            SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (signature_json, row["id"]),
        )
        refreshed.append(
            {
                "template_page_id": row["id"],
                "page_number": row["page_number"],
                "status": "generated",
                "region_count": signature.get("region_count", 0),
                "model": signature.get("model"),
            }
        )
    _ensure_template_pages_layout_references(conn, template_id)
    return refreshed


def _refresh_template_layout_reference_signatures(conn: Any, template_id: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, template_page_id, page_number, image_url, image_source, is_canonical
        FROM template_layout_references
        WHERE template_id = ? AND review_status = 'approved'
        ORDER BY is_canonical DESC, page_number ASC, created_at ASC
        """,
        (template_id,),
    ).fetchall()
    refreshed: List[Dict[str, Any]] = []
    for row in rows:
        signature = _generate_layout_signature_for_source(row["image_url"])
        if signature is None:
            refreshed.append(
                {
                    "template_layout_reference_id": row["id"],
                    "template_page_id": row["template_page_id"],
                    "page_number": row["page_number"],
                    "status": "failed",
                    "image_url": row["image_url"],
                    "image_source": row["image_source"],
                    "is_canonical": bool(row["is_canonical"]),
                    "reference_role": "main" if row["is_canonical"] else "reference_only",
                    "reason": "reference_image_unavailable_or_invalid",
                }
            )
            continue
        signature_json = signature_to_json(signature)
        conn.execute(
            """
            UPDATE template_layout_references
            SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (signature_json, row["id"]),
        )
        refreshed.append(
            {
                "template_layout_reference_id": row["id"],
                "template_page_id": row["template_page_id"],
                "page_number": row["page_number"],
                "status": "generated",
                "engine": "layout_signature",
                "version": signature.get("version"),
                "model_name": signature.get("model"),
                "label_count": len(signature.get("boxes") or []),
                "region_count": signature.get("region_count", 0),
                "model": signature.get("model"),
                "image_url": row["image_url"],
                "image_source": row["image_source"],
                "is_canonical": bool(row["is_canonical"]),
                "reference_role": "main" if row["is_canonical"] else "reference_only",
                "persisted": False,
                "reason": None,
            }
        )
    return refreshed


def _crop_anchor_roi(image_path_or_source: str, roi: Dict[str, Any], output_path: Path, padding: float = 0) -> Optional[str]:
    image = _load_image_source(image_path_or_source)
    if image is None:
        return None
    width, height = image.size
    x = float(roi["x_ratio"]) * width
    y = float(roi["y_ratio"]) * height
    w = float(roi["width_ratio"]) * width
    h = float(roi["height_ratio"]) * height
    pad = max(0.0, float(padding or 0))
    left = max(0, int(round(x - pad)))
    top = max(0, int(round(y - pad)))
    right = min(width, int(round(x + w + pad)))
    bottom = min(height, int(round(y + h + pad)))
    if right <= left or bottom <= top:
        return None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.crop((left, top, right, bottom)).save(output_path, format="PNG")
    return str(output_path)


def _image_path_to_data_url(path_value: Optional[str]) -> Optional[str]:
    if not path_value:
        return None
    path = Path(path_value)
    if not path.exists() or not path.is_file():
        return None
    try:
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError:
        return None
    return f"data:image/png;base64,{encoded}"


def _layout_region_type(region: Dict[str, Any]) -> str:
    return str(region.get("type") or region.get("data_type") or "").lower()


def _layout_regions_from_analysis(analysis: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(analysis.get("regions"), list):
        return [region for region in analysis["regions"] if isinstance(region, dict)]
    data = analysis.get("data")
    if isinstance(data, dict) and isinstance(data.get("regions"), list):
        return [region for region in data["regions"] if isinstance(region, dict)]
    pages = analysis.get("pages")
    if isinstance(pages, list):
        regions: List[Dict[str, Any]] = []
        for page in pages:
            if isinstance(page, dict) and isinstance(page.get("regions"), list):
                regions.extend(region for region in page["regions"] if isinstance(region, dict))
        return regions
    return []


def _is_supported_layout_region(region: Dict[str, Any]) -> bool:
    region_type = _layout_region_type(region).replace("_", " ").replace("-", " ")
    if any(token in region_type for token in ("header", "footer", "page number")):
        return False
    return bool(region.get("roi")) or bool(region.get("bbox"))


def _resolved_layout_region_type(region: Dict[str, Any]) -> str:
    region_type = _layout_region_type(region).replace("_", " ").replace("-", " ")
    if "table" in region_type and "title" not in region_type and "caption" not in region_type:
        return "table"
    if any(token in region_type for token in ("image", "figure", "pic", "seal", "logo", "chart")):
        return "image"
    return "text"


def _extraction_method_for_resolved_type(data_type: str) -> str:
    if data_type == "table":
        return "table_recognition_v2"
    if data_type == "image":
        return "extract_image"
    return "paddle_thai_ocr"


def _expand_table_roi(roi: Dict[str, float], image_width: int, image_height: int) -> Dict[str, float]:
    pad_x = 4.0 / max(float(image_width), 1.0)
    pad_y = 4.0 / max(float(image_height), 1.0)
    x = max(0.0, float(roi.get("x_ratio") or 0.0) - pad_x)
    y = max(0.0, float(roi.get("y_ratio") or 0.0) - pad_y)
    right = min(1.0, float(roi.get("x_ratio") or 0.0) + float(roi.get("width_ratio") or 0.0) + pad_x)
    bottom = min(1.0, float(roi.get("y_ratio") or 0.0) + float(roi.get("height_ratio") or 0.0) + pad_y)
    return {
        "x_ratio": x,
        "y_ratio": y,
        "width_ratio": max(0.0, right - x),
        "height_ratio": max(0.0, bottom - y),
    }


def _region_roi_from_boundary(region: Dict[str, Any], image_width: int, image_height: int) -> Optional[Dict[str, float]]:
    roi = region.get("roi") if isinstance(region.get("roi"), dict) else None
    if roi:
        return {
            "x_ratio": float(roi.get("x_ratio") or 0.0),
            "y_ratio": float(roi.get("y_ratio") or 0.0),
            "width_ratio": float(roi.get("width_ratio") or 0.0),
            "height_ratio": float(roi.get("height_ratio") or 0.0),
        }
    bbox = region.get("bbox") if isinstance(region.get("bbox"), dict) else None
    if not bbox:
        return None
    try:
        x = max(0.0, float(bbox.get("x") or 0.0))
        y = max(0.0, float(bbox.get("y") or 0.0))
        width = max(0.0, float(bbox.get("width") or 0.0))
        height = max(0.0, float(bbox.get("height") or 0.0))
    except (TypeError, ValueError):
        return None
    right = min(float(image_width), x + width)
    bottom = min(float(image_height), y + height)
    return {
        "x_ratio": x / max(float(image_width), 1.0),
        "y_ratio": y / max(float(image_height), 1.0),
        "width_ratio": max(0.0, right - x) / max(float(image_width), 1.0),
        "height_ratio": max(0.0, bottom - y) / max(float(image_height), 1.0),
    }


def _median_float(values: List[float], fallback: float = 0.0) -> float:
    prepared = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not prepared:
        return fallback
    middle = len(prepared) // 2
    if len(prepared) % 2:
        return prepared[middle]
    return (prepared[middle - 1] + prepared[middle]) / 2.0


def _horizontal_overlap_ratio(left: Dict[str, float], right: Dict[str, float]) -> float:
    left_x = float(left.get("x_ratio") or 0.0)
    left_right = left_x + float(left.get("width_ratio") or 0.0)
    right_x = float(right.get("x_ratio") or 0.0)
    right_right = right_x + float(right.get("width_ratio") or 0.0)
    overlap = max(0.0, min(left_right, right_right) - max(left_x, right_x))
    denominator = max(1e-9, min(float(left.get("width_ratio") or 0.0), float(right.get("width_ratio") or 0.0)))
    return overlap / denominator


def _text_line_regions_from_detection(boundary_image_path: str, image_width: int, image_height: int) -> List[Dict[str, Any]]:
    try:
        detection = detect_text_boxes(boundary_image_path)
    except Exception:
        return []
    regions: List[Dict[str, Any]] = []
    for index, region in enumerate(_layout_regions_from_analysis(detection), start=1):
        roi = _region_roi_from_boundary(region, image_width, image_height)
        if not roi or _roi_area(roi) <= 0:
            continue
        regions.append(
            {
                "type": "text",
                "data_type": "text",
                "layout_type": "text_line",
                "source": "paddle_text_detection_line",
                "confidence": region.get("confidence", 0.0),
                "roi": roi,
                "_line_index": index,
            }
        )
    return regions


def _paragraph_regions_from_text_lines(lines: List[Dict[str, Any]], debug_scope: str = "flexible") -> List[Dict[str, Any]]:
    prepared = [
        line
        for line in lines
        if isinstance(line.get("roi"), dict) and _roi_area(line["roi"]) > 0
    ]
    if not prepared:
        return []
    prepared.sort(
        key=lambda line: (
            float(line["roi"].get("y_ratio") or 0.0) + float(line["roi"].get("height_ratio") or 0.0) / 2.0,
            float(line["roi"].get("x_ratio") or 0.0),
        )
    )
    heights = [float(line["roi"].get("height_ratio") or 0.0) for line in prepared]
    widths = [float(line["roi"].get("width_ratio") or 0.0) for line in prepared]
    gaps = [
        max(
            0.0,
            float(prepared[index]["roi"].get("y_ratio") or 0.0)
            - (
                float(prepared[index - 1]["roi"].get("y_ratio") or 0.0)
                + float(prepared[index - 1]["roi"].get("height_ratio") or 0.0)
            ),
        )
        for index in range(1, len(prepared))
    ]
    median_height = _median_float(heights, 1.0)
    median_width = _median_float(widths, 1.0)
    median_gap = _median_float(gaps, median_height * 0.35)
    normal_left_edge = _median_float([float(line["roi"].get("x_ratio") or 0.0) for line in prepared], 0.0)

    groups: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    for line_index, line in enumerate(prepared):
        if not current:
            current = [line]
            continue
        prev = current[-1]
        prev_roi = prev["roi"]
        roi = line["roi"]
        gap = float(roi.get("y_ratio") or 0.0) - (
            float(prev_roi.get("y_ratio") or 0.0) + float(prev_roi.get("height_ratio") or 0.0)
        )
        current_x = float(roi.get("x_ratio") or 0.0)
        prev_x = float(prev_roi.get("x_ratio") or 0.0)
        indent_delta = abs(current_x - prev_x)
        first_line_indent = current_x - normal_left_edge
        prev_width = float(prev_roi.get("width_ratio") or 0.0)
        previous_width_ratio = prev_width / max(median_width, 1e-9)
        overlap = _horizontal_overlap_ratio(prev_roi, roi)
        gap_ratio = gap / max(median_gap, median_height * 0.25, 1e-9)
        indent_ratio = indent_delta / max(median_width, median_height, 1e-9)
        first_line_indent_ratio = first_line_indent / max(median_width, median_height, 1e-9)
        gap_evidence = gap_ratio >= 1.65 and gap >= median_height * 0.65
        indent_evidence = indent_ratio >= 0.09
        first_line_evidence = first_line_indent_ratio >= 0.12 and current_x > prev_x
        short_previous_evidence = previous_width_ratio <= 0.68
        alignment_break_evidence = overlap <= 0.42
        alignment_merge_evidence = overlap >= 0.68 and indent_ratio < 0.12
        primary_signal_count = sum(1 for value in (gap_evidence, indent_evidence, first_line_evidence, alignment_break_evidence) if value)
        supporting_signal_count = primary_signal_count + (1 if short_previous_evidence and gap_ratio >= 1.1 else 0)
        break_score = 0.0
        if gap_evidence:
            break_score += 0.35
        if indent_evidence:
            break_score += 0.35
        if first_line_evidence:
            break_score += 0.45
        if short_previous_evidence and gap_ratio >= 1.1:
            break_score += 0.2
        if alignment_break_evidence:
            break_score += 0.15
        should_break = (
            supporting_signal_count >= 2
            and primary_signal_count >= 1
            and break_score >= 0.75
            and not (alignment_merge_evidence and not gap_evidence)
        )
        logger.debug(
            "Flexible paragraph pair scope=%s pair=%s gap=%.5f gap_ratio=%.3f indent=%.5f "
            "indent_ratio=%.3f first_line_indent=%.5f width_ratio=%.3f overlap=%.3f "
            "signals=%s break_score=%.3f break=%s",
            debug_scope,
            line_index,
            gap,
            gap_ratio,
            indent_delta,
            indent_ratio,
            first_line_indent,
            previous_width_ratio,
            overlap,
            supporting_signal_count,
            break_score,
            should_break,
        )
        if should_break:
            groups.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        groups.append(current)

    paragraph_regions: List[Dict[str, Any]] = []
    for index, group in enumerate(groups, start=1):
        left = min(float(line["roi"].get("x_ratio") or 0.0) for line in group)
        top = min(float(line["roi"].get("y_ratio") or 0.0) for line in group)
        right = max(float(line["roi"].get("x_ratio") or 0.0) + float(line["roi"].get("width_ratio") or 0.0) for line in group)
        bottom = max(float(line["roi"].get("y_ratio") or 0.0) + float(line["roi"].get("height_ratio") or 0.0) for line in group)
        paragraph_regions.append(
            {
                "type": "text",
                "data_type": "text",
                "layout_type": "paragraph",
                "source": "flexible_paragraph_geometry",
                "confidence": min(1.0, sum(float(line.get("confidence") or 0.0) for line in group) / max(len(group), 1)),
                "roi": {
                    "x_ratio": max(0.0, left),
                    "y_ratio": max(0.0, top),
                    "width_ratio": max(0.0, min(1.0, right) - max(0.0, left)),
                    "height_ratio": max(0.0, min(1.0, bottom) - max(0.0, top)),
                },
                "line_count": len(group),
                "paragraph_index": index,
            }
        )
    return paragraph_regions


def _roi_overlap_ratio(target: Dict[str, float], container: Dict[str, float]) -> float:
    return _roi_intersection_area(target, container) / max(_roi_area(target), 1e-9)


def _roi_area(roi: Dict[str, float]) -> float:
    return max(0.0, float(roi.get("width_ratio") or 0.0)) * max(0.0, float(roi.get("height_ratio") or 0.0))


def _roi_intersection_area(left: Dict[str, float], right: Dict[str, float]) -> float:
    left_x = float(left.get("x_ratio") or 0.0)
    left_y = float(left.get("y_ratio") or 0.0)
    left_right = left_x + float(left.get("width_ratio") or 0.0)
    left_bottom = left_y + float(left.get("height_ratio") or 0.0)
    right_x = float(right.get("x_ratio") or 0.0)
    right_y = float(right.get("y_ratio") or 0.0)
    right_right = right_x + float(right.get("width_ratio") or 0.0)
    right_bottom = right_y + float(right.get("height_ratio") or 0.0)
    width = max(0.0, min(left_right, right_right) - max(left_x, right_x))
    height = max(0.0, min(left_bottom, right_bottom) - max(left_y, right_y))
    return width * height


def _filter_nested_flexible_regions(regions: List[Dict[str, Any]], image_width: int, image_height: int) -> List[Dict[str, Any]]:
    prepared: List[Dict[str, Any]] = []
    for region in regions:
        roi = _region_roi_from_boundary(region, image_width, image_height)
        if not roi:
            continue
        data_type = _resolved_layout_region_type(region)
        prepared.append({"region": region, "roi": roi, "data_type": data_type, "area": _roi_area(roi)})

    kept: List[Dict[str, Any]] = []
    for item in sorted(prepared, key=lambda value: value["area"], reverse=True):
        if item["area"] <= 0:
            continue
        nested_in_existing = False
        for existing in kept:
            if existing["data_type"] != item["data_type"]:
                continue
            overlap = _roi_intersection_area(item["roi"], existing["roi"])
            item_overlap = overlap / max(item["area"], 1e-9)
            existing_overlap = overlap / max(existing["area"], 1e-9)
            if item["data_type"] in {"table", "image"}:
                if item_overlap >= 0.72 or existing_overlap >= 0.72:
                    nested_in_existing = True
                    break
                continue
            if item_overlap >= 0.88:
                nested_in_existing = True
                break
        if not nested_in_existing:
            kept.append(item)

    kept_regions = [item["region"] for item in kept]
    kept_regions.sort(key=lambda region: (
        float((_region_roi_from_boundary(region, image_width, image_height) or {}).get("y_ratio") or 0.0),
        float((_region_roi_from_boundary(region, image_width, image_height) or {}).get("x_ratio") or 0.0),
    ))
    return kept_regions


def _build_flexible_paragraph_regions(boundary_image_path: str, opencv_img: Any, analysis: Dict[str, Any]) -> List[Dict[str, Any]]:
    image_height, image_width = opencv_img.shape[:2]
    layout_regions = [
        region
        for region in _layout_regions_from_analysis(analysis)
        if _is_supported_layout_region(region)
    ]
    non_text_regions = [region for region in layout_regions if _resolved_layout_region_type(region) != "text"]
    text_regions = [region for region in layout_regions if _resolved_layout_region_type(region) == "text"]
    blockers = [
        _region_roi_from_boundary(region, image_width, image_height)
        for region in non_text_regions
        if _resolved_layout_region_type(region) in {"table", "image"}
    ]
    blockers = [roi for roi in blockers if roi]
    line_regions = []
    for line in _text_line_regions_from_detection(boundary_image_path, image_width, image_height):
        line_roi = _region_roi_from_boundary(line, image_width, image_height)
        if not line_roi:
            continue
        line_area = _roi_area(line_roi)
        if any(_roi_intersection_area(line_roi, blocker) / max(line_area, 1e-9) >= 0.55 for blocker in blockers):
            continue
        line_regions.append(line)
    paragraph_regions: List[Dict[str, Any]] = []
    used_line_ids: set[int] = set()
    for text_region_index, text_region in enumerate(text_regions, start=1):
        text_roi = _region_roi_from_boundary(text_region, image_width, image_height)
        if not text_roi:
            continue
        region_lines = []
        for line in line_regions:
            line_roi = _region_roi_from_boundary(line, image_width, image_height)
            if not line_roi:
                continue
            if _roi_overlap_ratio(line_roi, text_roi) >= 0.55:
                region_lines.append(line)
                used_line_ids.add(id(line))
        paragraph_regions.extend(
            _paragraph_regions_from_text_lines(region_lines, debug_scope=f"text_region_{text_region_index}")
        )
    remaining_lines = [line for line in line_regions if id(line) not in used_line_ids]
    paragraph_regions.extend(_paragraph_regions_from_text_lines(remaining_lines, debug_scope="unscoped_text_region"))
    regions = paragraph_regions + non_text_regions if paragraph_regions else layout_regions
    if not regions:
        regions = [
            {
                "type": "text",
                "roi": {"x_ratio": 0.0, "y_ratio": 0.0, "width_ratio": 1.0, "height_ratio": 1.0},
                "source": "pp_doclayout_v3_search_boundary",
                "data_type": "text",
                "extraction_method": "paddle_thai_ocr",
            }
        ]
    return _filter_nested_flexible_regions(regions, image_width, image_height)


def _ocr_flexible_regions(boundary_image_path: str, regions: List[Dict[str, Any]], source: str) -> Dict[str, Any]:
    image = _load_image_source(boundary_image_path)
    image_width, image_height = image.size if image is not None else (1, 1)
    overlay_preview_data_url = None
    if image is not None:
        overlay = image.copy()
        try:
            from PIL import ImageDraw, ImageFont

            draw = ImageDraw.Draw(overlay)
            font = ImageFont.load_default()
            for index, region in enumerate(regions, start=1):
                roi = _region_roi_from_boundary(region, image_width, image_height)
                if not roi:
                    continue
                left = max(0, int(round(float(roi.get("x_ratio") or 0.0) * image_width)))
                top = max(0, int(round(float(roi.get("y_ratio") or 0.0) * image_height)))
                right = min(image_width, int(round((float(roi.get("x_ratio") or 0.0) + float(roi.get("width_ratio") or 0.0)) * image_width)))
                bottom = min(image_height, int(round((float(roi.get("y_ratio") or 0.0) + float(roi.get("height_ratio") or 0.0)) * image_height)))
                if right <= left or bottom <= top:
                    continue
                draw.rectangle((left, top, right, bottom), outline=(2, 132, 199), width=3)
                label = f"ROI {index}"
                label_bbox = draw.textbbox((left, top), label, font=font)
                label_width = label_bbox[2] - label_bbox[0] + 8
                label_height = label_bbox[3] - label_bbox[1] + 6
                draw.rectangle((left, max(0, top - label_height), left + label_width, top), fill=(2, 132, 199))
                draw.text((left + 4, max(0, top - label_height + 3)), label, fill=(255, 255, 255), font=font)
            buffer = io.BytesIO()
            overlay.save(buffer, format="PNG")
            overlay_preview_data_url = f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"
        except Exception:
            overlay_preview_data_url = None
    texts: List[str] = []
    confidences: List[float] = []
    segments: List[Dict[str, Any]] = []
    for index, region in enumerate(regions):
        roi = _region_roi_from_boundary(region, image_width, image_height)
        if not roi:
            continue
        data_type = _resolved_layout_region_type(region)
        if data_type == "table":
            roi = _expand_table_roi(roi, image_width, image_height)
        extraction_method = _extraction_method_for_resolved_type(data_type)
        block_roi = {
            "page_number": 1,
            "x_ratio": float(roi.get("x_ratio") or 0.0),
            "y_ratio": float(roi.get("y_ratio") or 0.0),
            "width_ratio": float(roi.get("width_ratio") or 0.0),
            "height_ratio": float(roi.get("height_ratio") or 0.0),
        }
        if block_roi["width_ratio"] <= 0 or block_roi["height_ratio"] <= 0:
            continue
        crop_preview_data_url = None
        if image is not None:
            left = max(0, int(round(block_roi["x_ratio"] * image_width)))
            top = max(0, int(round(block_roi["y_ratio"] * image_height)))
            right = min(image_width, int(round((block_roi["x_ratio"] + block_roi["width_ratio"]) * image_width)))
            bottom = min(image_height, int(round((block_roi["y_ratio"] + block_roi["height_ratio"]) * image_height)))
            if right > left and bottom > top:
                buffer = io.BytesIO()
                image.crop((left, top, right, bottom)).save(buffer, format="PNG")
                crop_preview_data_url = f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"
        table_rows = None
        table_structured = None
        table_html = None
        try:
            if data_type == "image":
                text = "(image crop)"
                confidence = 1.0
            elif data_type == "table":
                ocr_result = ocr_rois(
                    boundary_image_path,
                    [
                        {
                            "id": f"flexible_block_{index}",
                            "roi": block_roi,
                            "data_type": "table",
                            "extraction_method": "table_recognition_v2",
                        }
                    ],
                ).get(f"flexible_block_{index}", {})
                text = normalize_ocr_text(ocr_result.get("text"))
                confidence = float(ocr_result.get("confidence") or 0.0)
                table_rows = ocr_result.get("table_rows")
                table_structured = ocr_result.get("table_structured")
                table_html = ocr_result.get("table_html")
            else:
                ocr_result = ocr_roi(boundary_image_path, block_roi)
                text = normalize_ocr_text(ocr_result.get("text"))
                confidence = float(ocr_result.get("confidence") or 0.0)
            error_message = None
        except Exception as error:
            text = ""
            confidence = 0.0
            error_message = str(error)
        if text:
            texts.append(text)
            confidences.append(confidence)
        segments.append(
            {
                "index": index,
                "text": text,
                "confidence": confidence,
                "roi": block_roi,
                "type": data_type,
                "data_type": data_type,
                "extraction_method": extraction_method,
                "layout_type": _layout_region_type(region) or data_type,
                "source": source,
                "crop_preview_data_url": crop_preview_data_url,
                "table_rows": table_rows,
                "table_structured": table_structured,
                "table_html": table_html,
                "ocr_error": error_message,
            }
        )
    return {
        "text": "\n".join(texts),
        "confidence": sum(confidences) / len(confidences) if confidences else 0.0,
        "segments": segments,
        "overlay_preview_data_url": overlay_preview_data_url,
    }


def _flexible_text_ocr_from_boundary(boundary_image_path: Optional[str]) -> Dict[str, Any]:
    if not boundary_image_path:
        return {"text": "", "confidence": 0.0, "segments": [], "failure_reason": "boundary_crop_failed"}
    image = _load_image_source(boundary_image_path)
    opencv_img = _image_to_bgr_array(image) if image is not None else None
    if opencv_img is None:
        return {"text": "", "confidence": 0.0, "segments": [], "failure_reason": "boundary_image_unreadable"}

    analysis = analyze_layout(opencv_img, expand_text_rois=True, auto_roi_mode="text_line")
    regions = _build_flexible_paragraph_regions(boundary_image_path, opencv_img, analysis)

    result = _ocr_flexible_regions(boundary_image_path, regions, "flexible_paragraph_layout_blocks")
    attempts = [{"step": "flexible_roi_paragraph_blocks", "block_count": len(regions), "recognized_count": len(result["segments"])}]

    return {
        "text": result.get("text") or "",
        "confidence": float(result.get("confidence") or 0.0),
        "segments": result.get("segments") or [],
        "resolved_blocks": result.get("segments") or [],
        "flexible_overlay_preview_data_url": result.get("overlay_preview_data_url"),
        "attempts": attempts,
        "engine": "flexible_roi_text",
        "preprocessing": "flexible_roi_search_boundary_paragraph_blocks",
    }


def _save_prepublish_test_image(test_id: str, file_bytes: bytes, page_index: int = 1) -> Path:
    try:
        from PIL import Image
    except ImportError as error:
        raise HTTPException(status_code=400, detail="Image validation requires Pillow") from error
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        image = Image.open(io.BytesIO(file_bytes))
        if image.mode != "RGB":
            image = image.convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image or PDF") from error

    output_dir = _storage_root() / "prepublish_detection_tests" / test_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"page_{page_index}.png"
    image.save(output_path, format="PNG")
    return output_path


def _convert_prepublish_test_pdf(test_id: str, pdf_bytes: bytes) -> List[Path]:
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded PDF is empty")
    try:
        import fitz
    except ImportError as error:
        raise HTTPException(status_code=501, detail="PDF testing requires PyMuPDF") from error

    output_dir = _storage_root() / "prepublish_detection_tests" / test_id
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF") from error
    if document.page_count == 0:
        document.close()
        raise HTTPException(status_code=400, detail="Uploaded PDF has no pages")

    paths: List[Path] = []
    try:
        for index in range(document.page_count):
            page = document.load_page(index)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
            output_path = output_dir / f"page_{index + 1}.png"
            pixmap.save(str(output_path))
            paths.append(output_path)
    finally:
        document.close()
    return paths


def _prepare_prepublish_test_pages(test_id: str, file_bytes: bytes) -> List[Path]:
    if file_bytes.lstrip().startswith(b"%PDF"):
        return _convert_prepublish_test_pdf(test_id, file_bytes)
    return [_save_prepublish_test_image(test_id, file_bytes, 1)]


def _normalize_prepublish_test_pages(test_id: str, page_paths: List[Path]) -> Dict[int, str]:
    output_dir = _storage_root() / "prepublish_detection_tests" / test_id / "normalized"
    output_dir.mkdir(parents=True, exist_ok=True)
    normalizer = ImageNormalizationService()
    normalized: Dict[int, str] = {}
    for index, page_path in enumerate(page_paths, start=1):
        output_path = output_dir / f"page_{index}_normalized.png"
        info = normalizer.normalize_document(str(page_path), str(output_path))
        normalized[index] = str(info.get("normalized_image_path") or output_path)
    return normalized


def _template_page_image_source(conn: Any, template_page_id: str) -> Optional[str]:
    row = conn.execute(
        "SELECT normalized_image_url, sample_image_url FROM template_pages WHERE id = ?",
        (template_page_id,),
    ).fetchone()
    if row is None:
        return None
    return row["normalized_image_url"] or row["sample_image_url"]


class PageSplitService:
    def create_document_pages(self, document_id: str, payload: DocumentUploadRequest) -> List[Dict[str, Any]]:
        source_pages = payload.pages or [
            {
                "page_number": 1,
                "original_image_url": payload.original_file_url,
                "normalized_image_url": None,
            }
        ]
        return [
            {
                "id": _stub_id("doc_page"),
                "document_id": document_id,
                "page_number": page.page_number if hasattr(page, "page_number") else page["page_number"],
                "original_image_url": page.original_image_url if hasattr(page, "original_image_url") else page["original_image_url"],
                "normalized_image_url": page.normalized_image_url if hasattr(page, "normalized_image_url") else page["normalized_image_url"],
                "status": "uploaded",
            }
            for page in source_pages
        ]


class ImageProcessingService:
    def normalize_pages(self, pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [{**page, "status": "preprocessing_pending"} for page in pages]


class EmbeddingService:
    def _fetch_template_or_404(self, conn: Any, template_id: str) -> Any:
        template_row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
        if template_row is None:
            raise HTTPException(status_code=404, detail="Template not found")
        return template_row

    def _job_with_template(self, conn: Any, job_id: str) -> Dict[str, Any]:
        job_row = conn.execute("SELECT * FROM embedding_jobs WHERE id = ?", (job_id,)).fetchone()
        if job_row is None:
            raise HTTPException(status_code=404, detail="Embedding job not found")

        template_row = self._fetch_template_or_404(conn, job_row["template_id"])
        return {
            "job": _embedding_job_row_to_api(job_row),
            "template": _template_row_to_api(template_row),
        }

    def create_embedding_job(self, template_id: str) -> Dict[str, Any]:
        job_id = _stub_id("emb_job")
        with _connect() as conn:
            template_row = self._fetch_template_or_404(conn, template_id)
            if template_row["status"] != "validated":
                raise HTTPException(
                    status_code=409,
                    detail="Template must be validated before creating an embedding job",
                )

            conn.execute(
                """
                INSERT INTO embedding_jobs (
                    id, template_id, status, requested_at, metadata_json
                )
                VALUES (?, ?, 'queued', CURRENT_TIMESTAMP, ?)
                """,
                (job_id, template_id, '{"source":"admin_template_test","mode":"layout_signature"}'),
            )
            conn.execute(
                """
                UPDATE templates
                SET status = 'embedding_pending', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (template_id,),
            )
            conn.commit()
            return self._job_with_template(conn, job_id)

    def latest_embedding_job(self, template_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            self._fetch_template_or_404(conn, template_id)
            job_row = conn.execute(
                """
                SELECT * FROM embedding_jobs
                WHERE template_id = ?
                ORDER BY requested_at DESC, id DESC
                LIMIT 1
                """,
                (template_id,),
            ).fetchone()
        return {"template_id": template_id, "job": _embedding_job_row_to_api(job_row)}

    def complete_job_dev(self, job_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            job_row = conn.execute("SELECT * FROM embedding_jobs WHERE id = ?", (job_id,)).fetchone()
            if job_row is None:
                raise HTTPException(status_code=404, detail="Embedding job not found")

            template_id = job_row["template_id"]
            self._fetch_template_or_404(conn, template_id)
            _refresh_template_layout_signatures(conn, template_id)
            generated_references = _refresh_template_layout_reference_signatures(conn, template_id)
            if not generated_references or any(item.get("status") != "generated" for item in generated_references):
                failed_pages = [item for item in generated_references if item.get("status") != "generated"]
                raise HTTPException(
                    status_code=409,
                    detail=f"Layout reference signature generation failed: {failed_pages or 'no layout references'}",
                )
            metadata = {
                "engine": "layout_signature",
                "version": "layout-signature-v1",
                "template_id": template_id,
                "page_count": len(generated_references),
                "layout_signature_pages": generated_references,
                "global_vector_store": "disabled",
                "image_anchor_verification": "siglip_image_category",
                "completed_by": "complete-dev",
            }
            conn.execute(
                """
                UPDATE embedding_jobs
                SET status = 'completed',
                    completed_at = CURRENT_TIMESTAMP,
                    error_message = NULL,
                    vector_id = ?,
                    metadata_json = ?
                WHERE id = ?
                """,
                (f"layout_{template_id}", json.dumps(metadata, ensure_ascii=False, sort_keys=True), job_id),
            )
            conn.execute(
                """
                UPDATE templates
                SET status = 'active', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (template_id,),
            )
            conn.commit()
            return self._job_with_template(conn, job_id)

    def run_job_dev(self, job_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            job_row = conn.execute("SELECT * FROM embedding_jobs WHERE id = ?", (job_id,)).fetchone()
            if job_row is None:
                raise HTTPException(status_code=404, detail="Embedding job not found")
            if job_row["status"] != "queued":
                raise HTTPException(status_code=409, detail="Embedding job must be queued before it can run")

            template_id = job_row["template_id"]
            template_row = self._fetch_template_or_404(conn, template_id)
            conn.execute(
                """
                UPDATE embedding_jobs
                SET status = 'running',
                    started_at = CURRENT_TIMESTAMP,
                    error_message = NULL
                WHERE id = ?
                """,
                (job_id,),
            )
            conn.commit()

        time.sleep(1)

        try:
            with _connect() as conn:
                _refresh_template_layout_signatures(conn, template_id)
                generated_references = _refresh_template_layout_reference_signatures(conn, template_id)
                if not generated_references or any(item.get("status") != "generated" for item in generated_references):
                    failed_pages = [item for item in generated_references if item.get("status") != "generated"]
                    raise RuntimeError(f"Layout reference signature generation failed: {failed_pages or 'no layout references'}")
                conn.commit()
            metadata = {
                "engine": "layout_signature",
                "version": "layout-signature-v1",
                "template_id": template_id,
                "page_count": len(generated_references),
                "layout_signature_pages": generated_references,
                "global_vector_store": "disabled",
                "image_anchor_verification": "siglip_image_category",
            }
            vector_id = f"layout_{template_id}"
        except (EmbeddingContextError, ValueError, RuntimeError) as error:
            error_message = str(error)
            with _connect() as conn:
                conn.execute(
                    """
                    UPDATE embedding_jobs
                    SET status = 'failed',
                        completed_at = CURRENT_TIMESTAMP,
                        error_message = ?
                    WHERE id = ?
                    """,
                    (error_message, job_id),
                )
                conn.execute(
                    """
                    UPDATE templates
                    SET status = 'validated', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (template_id,),
                )
                conn.commit()
                return self._job_with_template(conn, job_id)

        with _connect() as conn:
            conn.execute(
                """
                UPDATE embedding_jobs
                SET status = 'completed',
                    completed_at = CURRENT_TIMESTAMP,
                    error_message = NULL,
                    vector_id = ?,
                    metadata_json = ?
                WHERE id = ?
                """,
                (vector_id, json.dumps(metadata, ensure_ascii=False, sort_keys=True), job_id),
            )
            conn.execute(
                """
                UPDATE templates
                SET status = 'active', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (template_id,),
            )
            conn.commit()
            return self._job_with_template(conn, job_id)

    def fail_job_dev(self, job_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            job_row = conn.execute("SELECT * FROM embedding_jobs WHERE id = ?", (job_id,)).fetchone()
            if job_row is None:
                raise HTTPException(status_code=404, detail="Embedding job not found")
            if job_row["status"] not in {"queued", "running"}:
                raise HTTPException(status_code=409, detail="Only queued or running embedding jobs can fail in dev mode")

            template_id = job_row["template_id"]
            self._fetch_template_or_404(conn, template_id)
            conn.execute(
                """
                UPDATE embedding_jobs
                SET status = 'failed',
                    completed_at = CURRENT_TIMESTAMP,
                    error_message = ?
                WHERE id = ?
                """,
                ("Embedding job failed in dev mode.", job_id),
            )
            conn.execute(
                """
                UPDATE templates
                SET status = 'validated', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (template_id,),
            )
            conn.commit()
            return self._job_with_template(conn, job_id)

    def generate_for_template(self, template_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            self._fetch_template_or_404(conn, template_id)
            pages = _refresh_template_layout_signatures(conn, template_id)
            conn.commit()
        return {
            "template_id": template_id,
            "status": "layout_signature_generated",
            "scope": "template",
            "pages": pages,
        }

    def generate_for_template_page(self, template_id: str, page_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            self._fetch_template_or_404(conn, template_id)
            page_row = conn.execute(
                "SELECT * FROM template_pages WHERE id = ? AND template_id = ?",
                (page_id, template_id),
            ).fetchone()
            if page_row is None:
                raise HTTPException(status_code=404, detail="Template page not found")
            image_url = page_row["normalized_image_url"] or page_row["sample_image_url"]
            if not image_url:
                raise HTTPException(status_code=409, detail="Template page image is unavailable")
            signature = build_layout_signature(image_url)
            conn.execute(
                """
                UPDATE template_pages
                SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND template_id = ?
                """,
                (signature_to_json(signature), page_id, template_id),
            )
            conn.commit()
        return {
            "template_id": template_id,
            "template_page_id": page_id,
            "status": "layout_signature_generated",
            "scope": "template_page",
            "layout_signature": signature,
        }


class OCRService:
    def ocr_custom_fields(self, document_id: str, payload: CustomOcrRequest) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "document_page_id": payload.document_page_id,
            "status": "custom_ocr_stubbed",
            "results": [
                {
                    "page_number": field.roi.page_number,
                    "field_name": field.field_name,
                    "display_label": field.display_label,
                    "ocr_text": None,
                    "ocr_confidence": None,
                    "roi": field.roi.model_dump(),
                }
                for field in payload.fields
            ],
        }


def _siglip_image_threshold(category: Optional[str] = None, default: float = 0.70) -> float:
    config = get_image_verification_category(category)
    return round(float(config.match_threshold), 4) if config else default


def _active_image_category_payloads() -> List[Dict[str, Any]]:
    return categories_to_runtime_payload(list_image_verification_categories(enabled_only=True))


def _image_category_api(value: Optional[str]) -> Dict[str, Any]:
    raw_value = str(value or "").strip()
    category = get_image_verification_category(raw_value)
    if category is None:
        return {
            "value": raw_value,
            "label": raw_value,
            "prompt": "",
            "match_threshold": 0.0,
            "margin_threshold": 0.0,
            "enabled": False,
            "error": "category_not_found" if raw_value else "category_missing",
        }
    item = category.to_api()
    if not category.enabled:
        item["error"] = "category_disabled"
    return item


def _image_category_values(value: Optional[str]) -> List[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(item or "").strip() for item in parsed if str(item or "").strip()]
        except Exception:
            return [raw]
    return [raw]


def _image_category_display(values: List[str]) -> str:
    labels = []
    for value in values:
        info = _image_category_api(value)
        labels.append(str(info.get("label") or value))
    return ", ".join(labels)


class VerificationService:
    FUZZY_THRESHOLD = 0.85
    DEFAULT_VERIFICATION_THRESHOLD = 0.70
    LOW_TEXT_SIMILARITY_GUARD = 0.25
    ZERO_WIDTH_CHARS = {
        "\u200b",
        "\u200c",
        "\u200d",
        "\ufeff",
    }

    def load_verification_fields(self, template_id: str) -> List[Dict[str, Any]]:
        with _connect() as conn:
            template_row = conn.execute("SELECT id FROM templates WHERE id = ?", (template_id,)).fetchone()
            if template_row is None:
                raise HTTPException(status_code=404, detail="Template not found")

            rows = conn.execute(
                """
                SELECT *
                FROM template_fields
                WHERE template_id = ?
                  AND use_for_verification = 1
                ORDER BY page_number ASC, sort_order ASC, created_at ASC
                """,
                (template_id,),
            ).fetchall()

        return [_template_field_row_to_api(row) for row in rows]

    def _normalize_text(self, value: Optional[str]) -> str:
        normalized = unicodedata.normalize("NFKC", value or "")
        for char in self.ZERO_WIDTH_CHARS:
            normalized = normalized.replace(char, "")  
        normalized = "".join(normalized.lower().split())
        return normalized

    def _normalize_for_similarity(self, value: Optional[str]) -> str:
        normalized = self._normalize_text(value)
        normalized = re.sub(r"[^\w]", "", normalized, flags=re.UNICODE)
        return normalized

    def _similarity(self, left: str, right: str) -> float:
        if not left and not right:
            return 1.0
        if not left or not right:
            return 0.0
        return SequenceMatcher(None, left, right).ratio()

    def _score_match(
        self,
        expected_text: Optional[str],
        actual_text: Optional[str],
        match_type: Optional[str],
        ocr_confidence: float,
        verification_threshold: Optional[float] = None,
    ) -> Dict[str, Any]:
        expected = self._normalize_text(expected_text)
        actual = self._normalize_text(actual_text)
        expected_for_similarity = self._normalize_for_similarity(expected_text)
        actual_for_similarity = self._normalize_for_similarity(actual_text)
        base_similarity = self._similarity(expected_for_similarity, actual_for_similarity)
        normalized_match_type = (match_type or "contains").strip().lower()
        threshold = verification_threshold or self.DEFAULT_VERIFICATION_THRESHOLD

        if not expected:
            text_similarity_score = 0.0
        elif not actual:
            text_similarity_score = 0.0
        elif normalized_match_type == "exact":
            threshold = max(threshold, 0.95)
            text_similarity_score = 1.0 if actual == expected else base_similarity
        elif normalized_match_type == "regex":
            try:
                text_similarity_score = 1.0 if re.search(expected, actual, flags=re.IGNORECASE) else 0.0
            except re.error:
                text_similarity_score = 0.0
        elif normalized_match_type == "fuzzy":
            text_similarity_score = base_similarity
        else:
            normalized_match_type = "contains"
            if expected in actual:
                text_similarity_score = 1.0
            elif actual in expected:
                length_ratio = len(actual_for_similarity) / max(len(expected_for_similarity), 1)
                if length_ratio >= 0.75:
                    text_similarity_score = max(base_similarity, 0.90)
                elif length_ratio >= 0.50:
                    text_similarity_score = max(base_similarity, 0.70)
                else:
                    text_similarity_score = base_similarity
            elif base_similarity >= 0.70:
                text_similarity_score = max(base_similarity, 0.75)
            else:
                text_similarity_score = base_similarity

        text_similarity_score = round(float(text_similarity_score), 4)
        if text_similarity_score < self.LOW_TEXT_SIMILARITY_GUARD:
            field_score = 0.0
            failure_reason = "low_text_similarity"
        else:
            field_score = round(text_similarity_score, 4)

        passed = field_score >= threshold
        if passed:
            failure_reason = "passed"
        elif text_similarity_score >= self.LOW_TEXT_SIMILARITY_GUARD:
            failure_reason = "below_threshold"

        return {
            "match_type": normalized_match_type,
            "normalized_expected": expected,
            "normalized_actual": actual,
            "text_similarity_score": text_similarity_score,
            "text_match_score": field_score,
            "ocr_confidence": round(float(ocr_confidence or 0.0), 4),
            "field_score": field_score,
            "verification_threshold": round(float(threshold), 4),
            "score": field_score,
            "passed": passed,
            "failure_reason": failure_reason,
        }

    def _score_image_anchor(self, field: Dict[str, Any], image_path: str) -> Dict[str, Any]:
        crop_path = _storage_root() / "verification_query_anchor_crops" / field["template_id"] / f"{field['id']}_{uuid4().hex[:8]}.png"
        cropped = _crop_anchor_roi(image_path, field["roi"], crop_path, field.get("roi_padding") or 6)
        category_values = _image_category_values(field.get("image_category"))
        category_value = category_values[0] if category_values else ""
        active_categories = _active_image_category_payloads()
        category_infos = [_image_category_api(value) for value in category_values]
        valid_category_values = [
            value for value, info in zip(category_values, category_infos) if not info.get("error")
        ]
        category_info = category_infos[0] if category_infos else _image_category_api(category_value)
        category_error = category_info.get("error") if not valid_category_values else None
        if category_error:
            return {
                "score": 0.0,
                "field_score": 0.0,
                "evidence_score": 0.0,
                "passed": False,
                "status": "error",
                "failure_reason": category_error,
                "verification_threshold": category_info.get("match_threshold", 0.0),
                "margin_threshold": category_info.get("margin_threshold", 0.0),
                "image_category": ", ".join(category_values) or category_value,
                "image_category_label": _image_category_display(category_values) or category_info.get("label") or category_value,
                "image_category_prompt": " | ".join(str(info.get("prompt") or "") for info in category_infos if info.get("prompt")),
                "predicted_image_category": "",
                "predicted_image_category_label": "",
                "predicted_image_category_prompt": "",
                "reference_crop_preview_data_url": None,
                "current_crop_preview_data_url": _image_path_to_data_url(cropped) if cropped else None,
                "siglip_similarity_score": 0.0,
                "image_category_score": 0.0,
                "raw_logit": 0.0,
                "raw_pair_score": 0.0,
                "relative_percentage": 0.0,
                "siglip_target_rank": 0,
                "siglip_score_margin": 0.0,
                "siglip_labels": [],
                "siglip_ui_percentages": [],
            }
        if not cropped:
            return {
                "score": 0.0,
                "field_score": 0.0,
                "evidence_score": 0.0,
                "passed": False,
                "status": "error",
                "failure_reason": "roi_crop_failed",
                "image_category": ", ".join(category_values) or category_value,
                "image_category_label": _image_category_display(category_values) or category_info.get("label") or category_value,
                "image_category_prompt": " | ".join(str(info.get("prompt") or "") for info in category_infos if info.get("prompt")),
                "reference_crop_preview_data_url": None,
                "current_crop_preview_data_url": None,
            }

        results = [verify_image_category(cropped, value, active_categories) for value in (valid_category_values or category_values)]
        result = next((item for item in results if item.passed), None) or (max(results, key=lambda item: float(item.evidence_score)) if results else verify_image_category(cropped, category_value, active_categories))
        score = round(float(result.evidence_score), 4)
        threshold = result.verification_threshold
        return {
            "score": score,
            "field_score": score,
            "evidence_score": score,
            "passed": result.passed,
            "status": result.status,
            "failure_reason": result.failure_reason,
            "verification_threshold": round(float(threshold), 4),
            "margin_threshold": round(float(result.margin_threshold), 4),
            "model_version": result.model_version,
            "scoring_version": result.scoring_version,
            "siglip_similarity_score": score,
            "image_category_score": score,
            "raw_logit": result.raw_logit,
            "raw_pair_score": result.raw_pair_score,
            "relative_percentage": result.relative_percentage,
            "image_category": result.image_category,
            "image_category_label": result.image_category_label,
            "image_category_prompt": result.prompt,
            "predicted_image_category": result.predicted_category,
            "predicted_image_category_label": result.predicted_label,
            "predicted_image_category_prompt": result.predicted_prompt,
            "siglip_target_rank": result.target_rank,
            "siglip_score_margin": result.score_margin,
            "siglip_labels": result.labels,
            "siglip_ui_percentages": result.ui_percentages,
            "reference_crop_preview_data_url": None,
            "current_crop_preview_data_url": _image_path_to_data_url(cropped),
            "model_name": result.model_name,
            "device": result.device,
        }

    def verify_template(self, template_id: str, page_image_paths: Optional[Dict[int, str]] = None) -> Dict[str, Any]:
        fields = self.load_verification_fields(template_id)
        if not fields:
            return {
                "template_id": template_id,
                "status": "no_verification_fields",
                "passed": True,
                "score": 1.0,
                "required_passed": True,
                "checked_fields": [],
            }

        text_ocr_cache: Dict[str, Dict[str, Any]] = {}
        text_ocr_errors: Dict[str, str] = {}
        text_fields_by_page: Dict[int, List[Dict[str, Any]]] = {}
        for field in fields:
            if field.get("data_type") == "image":
                continue
            page_number = int(field["page_number"])
            image_path = (page_image_paths or {}).get(page_number)
            if image_path:
                text_fields_by_page.setdefault(page_number, []).append(field)

        for page_number, page_fields in text_fields_by_page.items():
            image_path = (page_image_paths or {}).get(page_number)
            if not image_path:
                continue
            try:
                page_results = ocr_rois(
                    image_path,
                    [{"id": field["id"], "roi": field["roi"]} for field in page_fields],
                )
                text_ocr_cache.update(page_results)
            except OcrUnavailableError as error:
                for field in page_fields:
                    text_ocr_errors[field["id"]] = str(error)
            except Exception as error:
                for field in page_fields:
                    text_ocr_errors[field["id"]] = f"ROI OCR failed: {error}"

        checked_fields = []
        for field in fields:
            expected_text = field.get("expected_text")
            page_number = int(field["page_number"])
            image_path = (page_image_paths or {}).get(page_number)
            anchor_type = "image" if field.get("data_type") == "image" else "text"
            actual_text = ""
            ocr_confidence = 0.0
            field_error = None
            current_crop_preview_data_url = None

            if anchor_type == "image" and not image_path:
                category_info = _image_category_api(field.get("image_category"))
                checked_fields.append(
                    {
                        "field_id": field["id"],
                        "anchor_id": field["id"],
                        "field_name": field["field_name"],
                        "display_label": field["display_label"],
                        "anchor_type": "image",
                        "verification_method": "image_feature",
                        "page_number": page_number,
                        "expected_text": category_info.get("label") or field.get("image_category"),
                        "actual_text": "",
                        "normalized_expected": "",
                        "normalized_actual": "",
                        "text_similarity_score": None,
                        "ocr_confidence": None,
                        "field_score": 0.0,
                        "verification_threshold": category_info.get("match_threshold", 0.0),
                        "margin_threshold": category_info.get("margin_threshold", 0.0),
                        "match_type": "image_feature",
                        "required": bool(field["required_for_verification"]),
                        "passed": False,
                        "score": 0.0,
                        "failure_reason": "query_page_missing",
                        "roi": field["roi"],
                        "roi_padding": field.get("roi_padding") or 6,
                        "weight": float(field.get("verification_weight") or 1.0),
                        "image_category": field.get("image_category"),
                        "image_category_label": category_info.get("label") or field.get("image_category"),
                        "image_category_prompt": category_info.get("prompt") or "",
                        "reference_crop_preview_data_url": None,
                        "current_crop_preview_data_url": None,
                        "siglip_similarity_score": 0.0,
                        "image_category_score": 0.0,
                        "evidence_score": 0.0,
                        "raw_logit": 0.0,
                        "raw_pair_score": 0.0,
                        "relative_percentage": 0.0,
                        "siglip_target_rank": 0,
                        "siglip_score_margin": 0.0,
                        "siglip_labels": [],
                        "siglip_ui_percentages": [],
                        "error": f"No query page image available for page {page_number}",
                    }
                )
                continue

            if anchor_type == "image" and image_path:
                try:
                    image_match = self._score_image_anchor(field, image_path)
                except Exception as error:
                    category_values = _image_category_values(field.get("image_category"))
                    category_value = category_values[0] if category_values else ""
                    try:
                        category_info = _image_category_api(category_value)
                        category_label = _image_category_display(category_values)
                    except Exception:
                        category_info = {"label": category_value, "prompt": "", "match_threshold": 0.0, "margin_threshold": 0.0}
                        category_label = ", ".join(category_values)
                    fallback_crop_path = _storage_root() / "verification_query_anchor_crops" / field["template_id"] / f"{field['id']}_failed_{uuid4().hex[:8]}.png"
                    fallback_crop = _crop_anchor_roi(image_path, field["roi"], fallback_crop_path, field.get("roi_padding") or 6)
                    image_match = {
                        "score": 0.0,
                        "field_score": 0.0,
                        "evidence_score": 0.0,
                        "passed": False,
                        "status": "error",
                        "failure_reason": f"image_verification_error: {error}",
                        "verification_threshold": category_info.get("match_threshold", 0.0),
                        "margin_threshold": category_info.get("margin_threshold", 0.0),
                        "reference_crop_preview_data_url": None,
                        "current_crop_preview_data_url": _image_path_to_data_url(fallback_crop),
                        "siglip_similarity_score": 0.0,
                        "image_category_score": 0.0,
                        "raw_logit": 0.0,
                        "raw_pair_score": 0.0,
                        "relative_percentage": 0.0,
                        "image_category": ", ".join(category_values) or field.get("image_category"),
                        "image_category_label": category_label or category_info.get("label") or field.get("image_category"),
                        "image_category_prompt": category_info.get("prompt") or "",
                        "predicted_image_category": "",
                        "predicted_image_category_label": "",
                        "predicted_image_category_prompt": "",
                        "siglip_target_rank": 0,
                        "siglip_score_margin": 0.0,
                        "siglip_labels": [],
                        "siglip_ui_percentages": [],
                        "error": str(error),
                    }
                image_verification_threshold = image_match.get("verification_threshold")
                if image_verification_threshold is None:
                    try:
                        image_verification_threshold = _siglip_image_threshold(image_match.get("image_category"))
                    except Exception:
                        image_verification_threshold = 0.0
                checked_fields.append(
                    {
                        "field_id": field["id"],
                        "anchor_id": field["id"],
                        "field_name": field["field_name"],
                        "display_label": field["display_label"],
                        "anchor_type": "image",
                        "verification_method": "image_feature",
                        "page_number": page_number,
                        "expected_text": image_match.get("image_category_label"),
                        "actual_text": image_match.get("predicted_image_category_label", ""),
                        "normalized_expected": image_match.get("image_category_prompt", ""),
                        "normalized_actual": image_match.get("predicted_image_category_prompt", ""),
                        "text_similarity_score": None,
                        "ocr_confidence": None,
                        "field_score": image_match["score"],
                        "verification_threshold": image_verification_threshold,
                        "margin_threshold": image_match.get("margin_threshold"),
                        "match_type": "image_feature",
                        "required": bool(field["required_for_verification"]),
                        "passed": image_match["passed"],
                        "score": image_match["score"],
                        "failure_reason": image_match["failure_reason"],
                        "roi": field["roi"],
                        "roi_padding": field.get("roi_padding") or 6,
                        "weight": float(field.get("verification_weight") or 1.0),
                        "reference_crop_preview_data_url": image_match.get("reference_crop_preview_data_url"),
                        "current_crop_preview_data_url": image_match.get("current_crop_preview_data_url"),
                        "siglip_similarity_score": image_match.get("siglip_similarity_score", image_match["score"]),
                        "image_category_score": image_match.get("image_category_score", image_match["score"]),
                        "evidence_score": image_match.get("evidence_score", image_match["score"]),
                        "raw_logit": image_match.get("raw_logit"),
                        "raw_pair_score": image_match.get("raw_pair_score"),
                        "relative_percentage": image_match.get("relative_percentage"),
                        "status": image_match.get("status"),
                        "image_category": image_match.get("image_category"),
                        "image_category_label": image_match.get("image_category_label"),
                        "image_category_prompt": image_match.get("image_category_prompt"),
                        "predicted_image_category": image_match.get("predicted_image_category"),
                        "predicted_image_category_label": image_match.get("predicted_image_category_label"),
                        "predicted_image_category_prompt": image_match.get("predicted_image_category_prompt"),
                        "siglip_target_rank": image_match.get("siglip_target_rank"),
                        "siglip_score_margin": image_match.get("siglip_score_margin"),
                        "siglip_labels": image_match.get("siglip_labels"),
                        "siglip_ui_percentages": image_match.get("siglip_ui_percentages"),
                        "model_name": image_match.get("model_name"),
                        "device": image_match.get("device"),
                        "model_version": image_match.get("model_version"),
                        "scoring_version": image_match.get("scoring_version"),
                        "error": image_match.get("error"),
                    }
                )
                continue

            if image_path:
                try:
                    crop_path = _storage_root() / "template_verification_test_crops" / template_id / f"{field['id']}.png"
                    cropped = _crop_anchor_roi(image_path, field["roi"], crop_path, field.get("roi_padding") or 0)
                    current_crop_preview_data_url = _image_path_to_data_url(cropped)
                    if field["id"] in text_ocr_errors:
                        raise OcrUnavailableError(text_ocr_errors[field["id"]])
                    ocr_result = text_ocr_cache.get(field["id"])
                    if ocr_result is None:
                        ocr_result = ocr_roi(image_path, field["roi"])
                    actual_text = str(ocr_result.get("text") or "")
                    ocr_confidence = float(ocr_result.get("confidence") or 0.0)
                    if ocr_result.get("error"):
                        field_error = str(ocr_result.get("error"))
                except OcrUnavailableError as error:
                    field_error = str(error)
                except Exception as error:
                    field_error = f"ROI OCR failed: {error}"
            else:
                field_error = f"No query page image available for page {page_number}"

            verification_threshold = self.DEFAULT_VERIFICATION_THRESHOLD
            match = self._score_match(
                expected_text,
                actual_text,
                field.get("match_type"),
                ocr_confidence,
                verification_threshold,
            ) if not field_error else {
                "match_type": (field.get("match_type") or "contains").strip().lower(),
                "normalized_expected": self._normalize_text(expected_text),
                "normalized_actual": self._normalize_text(actual_text),
                "text_similarity_score": 0.0,
                "text_match_score": 0.0,
                "ocr_confidence": round(float(ocr_confidence or 0.0), 4),
                "field_score": 0.0,
                "verification_threshold": verification_threshold,
                "score": 0.0,
                "passed": False,
                "failure_reason": "ocr_error",
            }
            checked_fields.append(
                {
                    "field_id": field["id"],
                    "anchor_id": field["id"],
                    "field_name": field["field_name"],
                    "display_label": field["display_label"],
                    "anchor_type": "text",
                    "verification_method": "ocr_text",
                    "page_number": page_number,
                    "expected_text": expected_text,
                    "actual_text": actual_text,
                    "normalized_expected": match["normalized_expected"],
                    "normalized_actual": match["normalized_actual"],
                    "text_similarity_score": match["text_similarity_score"],
                    "text_match_score": match.get("text_match_score", match["field_score"]),
                    "ocr_confidence": match["ocr_confidence"],
                    "field_score": match["field_score"],
                    "verification_threshold": match["verification_threshold"],
                    "match_type": match["match_type"],
                    "required": bool(field["required_for_verification"]),
                    "passed": match["passed"],
                    "score": match["field_score"],
                    "failure_reason": match["failure_reason"],
                    "roi": field["roi"],
                    "roi_padding": field.get("roi_padding") or 0,
                    "weight": float(field.get("verification_weight") or 1.0),
                    "reference_crop_preview_data_url": None,
                    "current_crop_preview_data_url": current_crop_preview_data_url,
                    "error": field_error,
                }
            )

        required_fields = [field for field in checked_fields if field["required"]]
        required_passed = all(field["passed"] for field in required_fields)
        score_weight = sum(max(0.0, float(field.get("weight") or 1.0)) for field in checked_fields) or 1.0
        score = sum(field["score"] * max(0.0, float(field.get("weight") or 1.0)) for field in checked_fields) / score_weight
        text_fields = [field for field in checked_fields if field.get("anchor_type") == "text"]
        image_fields = [field for field in checked_fields if field.get("anchor_type") == "image"]
        text_weight = sum(max(0.0, float(field.get("weight") or 1.0)) for field in text_fields) or 1.0
        image_weight = sum(max(0.0, float(field.get("weight") or 1.0)) for field in image_fields) or 1.0
        text_score = sum(field["score"] * max(0.0, float(field.get("weight") or 1.0)) for field in text_fields) / text_weight if text_fields else 1.0
        image_score = sum(field["score"] * max(0.0, float(field.get("weight") or 1.0)) for field in image_fields) / image_weight if image_fields else 1.0
        passed = required_passed
        ocr_unavailable = any(
            field.get("error")
            and (
                "OCR verification requires" in field["error"]
                or "Paddle" in field["error"]
                or "paddleocr" in field["error"].lower()
            )
            for field in checked_fields
        )
        return {
            "template_id": template_id,
            "status": "ocr_unavailable" if ocr_unavailable else "verified" if passed else "failed",
            "passed": passed,
            "score": round(float(score), 4),
            "text_anchor_score": round(float(text_score), 4),
            "image_anchor_score": round(float(image_score), 4),
            "required_passed": required_passed,
            "checked_fields": checked_fields,
            "verification_details": checked_fields,
        }

    def verify_candidate(
        self,
        document_page_id: Optional[str] = None,
        template_page_id: Optional[str] = None,
        template_id: Optional[str] = None,
        page_image_paths: Optional[Dict[int, str]] = None,
    ) -> Dict[str, Any]:
        if template_id:
            return {
                **self.verify_template(template_id, page_image_paths),
                "document_page_id": document_page_id,
                "template_page_id": template_page_id,
            }
        return {
            "document_page_id": document_page_id,
            "template_page_id": template_page_id,
            "verification_score": None,
            "status": "template_id_required",
            "passed": False,
        }


class ConfidenceService:
    def calculate_page_confidence(self, page_number: int) -> Dict[str, Any]:
        return {
            "page_number": page_number,
            "layout_score": None,
            "verification_score": None,
            "final_score": None,
            "status": "confidence_stubbed",
        }


class TemplateDetectionService:
    def __init__(self) -> None:
        self.confidence = ConfidenceService()

    def detect_document(self, document_id: str) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "status": "detection_stubbed",
            "pages": [],
            "logs": [],
        }

    def get_detection(self, document_id: str) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "status": "detection_not_run",
            "pages": [],
        }


class ExtractionService:
    def get_selectable_fields(self, document_id: str, page_id: Optional[str] = None) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "document_page_id": page_id,
            "fields": [],
            "grouped_by_page": True,
        }

    def extract_selected_fields(self, document_id: str, payload: ExtractionRequest) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "status": "extraction_stubbed",
            "results": [
                {
                    "page_number": field.page_number,
                    "template_field_id": field.template_field_id,
                    "ocr_text": None,
                    "ocr_confidence": None,
                }
                for field in payload.fields
            ],
        }

    def get_results(self, document_id: str) -> Dict[str, Any]:
        return {"document_id": document_id, "results": [], "grouped_by_page": True}


class DocumentService:
    def __init__(self) -> None:
        self.page_split = PageSplitService()
        self.image_processing = ImageProcessingService()

    def upload(self, payload: DocumentUploadRequest) -> Dict[str, Any]:
        document_id = _stub_id("doc")
        pages = self.page_split.create_document_pages(document_id, payload)
        return {
            "id": document_id,
            "uploaded_by": payload.uploaded_by,
            "original_file_url": payload.original_file_url,
            "status": "uploaded",
            "page_count": len(pages),
            "pages": self.image_processing.normalize_pages(pages),
            "created_at": _now(),
        }

    def get_document(self, document_id: str) -> Dict[str, Any]:
        return {"id": document_id, "status": "stubbed", "pages": []}

    def get_pages(self, document_id: str) -> Dict[str, Any]:
        return {"document_id": document_id, "pages": []}

    def get_page(self, document_id: str, page_id: str) -> Dict[str, Any]:
        return {"document_id": document_id, "id": page_id, "page_number": None, "status": "stubbed"}


class StorageMaintenanceService:
    GENERATED_DIRS = [
        Path(__file__).resolve().parents[1] / "cropped_rois",
        Path(__file__).resolve().parents[1] / "storage" / "detection_queries",
        _storage_root() / "prepublish_detection_tests",
        _storage_root() / "template_extraction_test_crops",
        _storage_root() / "verification_query_anchor_crops",
        _storage_root() / "prepublish_anchor_crops",
    ]

    def cleanup_generated_files(self, max_age_hours: int = 24, dry_run: bool = True) -> Dict[str, Any]:
        max_age_hours = max(1, int(max_age_hours or 24))
        cutoff = time.time() - (max_age_hours * 3600)
        candidates: List[Dict[str, Any]] = []
        deleted_count = 0
        deleted_bytes = 0

        for directory in self.GENERATED_DIRS:
            if not directory.exists() or not directory.is_dir():
                continue
            for path in directory.rglob("*"):
                if not path.is_file():
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if stat.st_mtime > cutoff:
                    continue

                item = {
                    "path": str(path),
                    "size_bytes": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                }
                candidates.append(item)
                if dry_run:
                    continue
                try:
                    path.unlink()
                    deleted_count += 1
                    deleted_bytes += stat.st_size
                except OSError as error:
                    item["error"] = str(error)

        return {
            "dry_run": dry_run,
            "max_age_hours": max_age_hours,
            "candidate_count": len(candidates),
            "candidate_bytes": sum(int(item["size_bytes"]) for item in candidates),
            "deleted_count": deleted_count,
            "deleted_bytes": deleted_bytes,
            "scanned_directories": [str(path) for path in self.GENERATED_DIRS],
            "candidates": candidates[:200],
            "truncated": len(candidates) > 200,
        }


class DecisionService:
    MIN_RETRIEVAL_SCORE = 0.50
    HIGH_RETRIEVAL_SCORE = 0.95
    STRONG_VERIFICATION_SCORE = 0.75
    DEFAULT_FINAL_CONFIDENCE_THRESHOLD = 0.75
    DEFAULT_LAYOUT_WEIGHT = 0.50
    DEFAULT_TEXT_ANCHOR_WEIGHT = 0.35
    DEFAULT_IMAGE_ANCHOR_WEIGHT = 0.15

    def _truthy(self, value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "pass", "passed"}
        return bool(value)

    def _required_passed_from_fields(self, verification: Dict[str, Any], fallback: bool) -> bool:
        checked_fields = verification.get("checked_fields") or verification.get("verification_details") or []
        if not isinstance(checked_fields, list):
            return fallback
        required_fields = [
            field
            for field in checked_fields
            if isinstance(field, dict) and self._truthy(field.get("required"))
        ]
        if not required_fields:
            return True
        return all(self._truthy(field.get("passed")) for field in required_fields)

    def _required_failed_fields(self, verification: Dict[str, Any]) -> List[Dict[str, Any]]:
        checked_fields = verification.get("checked_fields") or verification.get("verification_details") or []
        if not isinstance(checked_fields, list):
            return []
        failed_fields: List[Dict[str, Any]] = []
        for field in checked_fields:
            if not isinstance(field, dict):
                continue
            if not self._truthy(field.get("required")):
                continue
            if self._truthy(field.get("passed")):
                continue
            failed_fields.append(
                {
                    "field_id": field.get("field_id") or field.get("anchor_id"),
                    "field_name": field.get("field_name") or field.get("anchor_name") or field.get("display_label"),
                    "display_label": field.get("display_label"),
                    "anchor_type": field.get("anchor_type"),
                    "page_number": field.get("page_number"),
                    "score": field.get("score") if field.get("score") is not None else field.get("field_score"),
                    "expected_text": field.get("expected_text"),
                    "actual_text": field.get("actual_text"),
                    "failure_reason": field.get("failure_reason") or field.get("error"),
                }
            )
        return failed_fields

    def final_confidence_threshold(self, template: Optional[Dict[str, Any]], metadata: Dict[str, Any]) -> float:
        raw_threshold = template.get("final_confidence_threshold") if template else metadata.get("final_confidence_threshold")
        try:
            threshold = float(raw_threshold)
        except (TypeError, ValueError):
            threshold = self.DEFAULT_FINAL_CONFIDENCE_THRESHOLD
        if threshold <= 0 or threshold > 1:
            return self.DEFAULT_FINAL_CONFIDENCE_THRESHOLD
        return threshold

    def matching_weights(self, template: Optional[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, float]:
        metadata = metadata or {}

        def read_weight(key: str, fallback: float) -> float:
            raw_value = template.get(key) if template and template.get(key) is not None else metadata.get(key)
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                value = fallback
            return max(0.0, min(1.0, value))

        weights = {
            "layout": read_weight("layout_weight", self.DEFAULT_LAYOUT_WEIGHT),
            "text_anchor": read_weight("text_anchor_weight", self.DEFAULT_TEXT_ANCHOR_WEIGHT),
            "image_anchor": read_weight("image_anchor_weight", self.DEFAULT_IMAGE_ANCHOR_WEIGHT),
        }
        total = sum(weights.values())
        if total <= 0:
            return {
                "layout": self.DEFAULT_LAYOUT_WEIGHT,
                "text_anchor": self.DEFAULT_TEXT_ANCHOR_WEIGHT,
                "image_anchor": self.DEFAULT_IMAGE_ANCHOR_WEIGHT,
            }
        return {key: round(value / total, 4) for key, value in weights.items()}

    def _effective_matching_weights(self, configured_weights: Dict[str, float], verification: Dict[str, Any]) -> Dict[str, float]:
        checked_fields = verification.get("checked_fields") or verification.get("verification_details") or []
        has_text_anchor = any(isinstance(field, dict) and field.get("anchor_type") == "text" for field in checked_fields)
        has_image_anchor = any(isinstance(field, dict) and field.get("anchor_type") == "image" for field in checked_fields)
        weights = dict(configured_weights)
        if not has_text_anchor:
            weights["text_anchor"] = 0.0
        if not has_image_anchor:
            weights["image_anchor"] = 0.0
        total = sum(weights.values())
        if total <= 0:
            return {"layout": 1.0, "text_anchor": 0.0, "image_anchor": 0.0}
        return {key: round(value / total, 4) for key, value in weights.items()}

    def decide_candidate(
        self,
        retrieval_score: float,
        verification: Dict[str, Any],
        final_confidence_threshold: float,
        matching_weights: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        retrieval_score = round(float(retrieval_score), 4)
        verification_score = round(float(verification.get("score", 0.0) or 0.0), 4)
        text_anchor_score = round(float(verification.get("text_anchor_score", verification_score) or 0.0), 4)
        image_anchor_score = round(float(verification.get("image_anchor_score", 1.0) or 0.0), 4)
        verification_passed = self._truthy(verification.get("passed"))
        raw_required_passed = self._truthy(verification.get("required_passed", verification_passed))
        required_passed = self._required_passed_from_fields(verification, raw_required_passed)
        required_failed_fields = self._required_failed_fields(verification)
        verification_status = verification.get("status")
        configured_weights = matching_weights or self.matching_weights(None, {})
        effective_weights = self._effective_matching_weights(configured_weights, verification)
        anchor_weight = effective_weights["text_anchor"] + effective_weights["image_anchor"]
        anchor_score = round(
            (
                (text_anchor_score * effective_weights["text_anchor"]) +
                (image_anchor_score * effective_weights["image_anchor"])
            ) / anchor_weight,
            4,
        ) if anchor_weight > 0 else 0.0
        final_score = round(
            (retrieval_score * effective_weights["layout"]) +
            (text_anchor_score * effective_weights["text_anchor"]) +
            (image_anchor_score * effective_weights["image_anchor"]),
            4,
        )
        final_threshold_passed = final_score >= final_confidence_threshold
        layout_passed = retrieval_score >= self.MIN_RETRIEVAL_SCORE
        final_passed = final_threshold_passed and required_passed and layout_passed
        if not required_passed:
            decision_path = "required_verification_failed"
        elif not layout_passed:
            decision_path = "layout_score_below_threshold"
        elif not final_threshold_passed:
            decision_path = "final_threshold_failed"
        else:
            decision_path = "final_threshold_passed"

        return {
            "retrieval_score": retrieval_score,
            "verification_score": verification_score,
            "text_anchor_score": text_anchor_score,
            "image_anchor_score": image_anchor_score,
            "anchor_score": anchor_score,
            "matching_weights": configured_weights,
            "effective_matching_weights": effective_weights,
            "verification_passed": verification_passed,
            "final_score": round(float(final_score), 4),
            "final_passed": final_passed,
            "decision_reason": decision_path,
            "decision_path": decision_path,
            "final_confidence_threshold": final_confidence_threshold,
            "final_threshold_passed": final_threshold_passed,
            "layout_passed": layout_passed,
            "required_passed": required_passed,
            "required_failed_fields": required_failed_fields,
        }


class TemplateRequestService:
    def _normalize_image_source(self, value: Optional[str]) -> str:
        return value if value in {"user_request", "admin_upload"} else "admin_upload"

    def _normalize_review_status(self, value: Optional[str]) -> str:
        return value if value in {"pending", "approved", "rejected"} else "pending"

    def create(self, payload: TemplateRequestCreate) -> Dict[str, Any]:
        request_id = _stub_id("tpl_req")
        source_pages = payload.pages or (
            [
                {
                    "page_number": 1,
                    "original_image_url": payload.sample_file_url,
                    "normalized_image_url": payload.sample_file_url,
                    "source_file_id": f"{request_id}_source_1",
                    "source_file_name": payload.request_title,
                }
            ]
            if payload.sample_file_url
            else []
        )
        default_source_file_id = f"{request_id}_source_1"
        default_source_file_name = payload.request_title

        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO template_requests (
                    id, requested_by, request_title, document_type, sample_file_url,
                    request_mode, status, user_note, page_count, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    request_id,
                    payload.requested_by,
                    payload.request_title,
                    payload.document_type,
                    payload.sample_file_url,
                    payload.request_mode,
                    payload.user_note,
                    max(payload.page_count, len(source_pages)),
                ),
            )

            for page in source_pages:
                page_number = page.page_number if hasattr(page, "page_number") else page["page_number"]
                sample_image_url = (
                    page.normalized_image_url or page.original_image_url
                    if hasattr(page, "normalized_image_url")
                    else page.get("normalized_image_url") or page.get("original_image_url")
                )
                source_file_id = (
                    page.source_file_id if hasattr(page, "source_file_id") else page.get("source_file_id")
                ) or default_source_file_id
                source_file_name = (
                    page.source_file_name if hasattr(page, "source_file_name") else page.get("source_file_name")
                ) or default_source_file_name
                conn.execute(
                    """
                    INSERT INTO template_request_pages (
                        id, template_request_id, page_number, sample_image_url,
                        source_file_id, source_file_name,
                        image_source, review_status, is_canonical, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 'user_request', 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (_stub_id("tpl_req_page"), request_id, page_number, sample_image_url, source_file_id, source_file_name),
                )

            conn.commit()

        return self.get(request_id)

    def list(self) -> Dict[str, Any]:
        with _connect() as conn:
            request_rows = conn.execute(
                "SELECT * FROM template_requests ORDER BY created_at DESC"
            ).fetchall()
            page_rows = conn.execute(
                """
                SELECT * FROM template_request_pages
                ORDER BY template_request_id ASC, page_number ASC
                """
            ).fetchall()
            field_rows = conn.execute(
                """
                SELECT * FROM requested_fields
                ORDER BY template_request_id ASC, page_number ASC, created_at ASC
                """
            ).fetchall()

        pages_by_request: Dict[str, List[Dict[str, Any]]] = {}
        for page_row in page_rows:
            page = _page_row_to_api(page_row)
            pages_by_request.setdefault(page["template_request_id"], []).append(page)

        fields_by_request: Dict[str, List[Dict[str, Any]]] = {}
        for field_row in field_rows:
            field = _field_row_to_api(field_row)
            fields_by_request.setdefault(field["template_request_id"], []).append(field)

        requests = []
        for row in request_rows:
            request = _request_row_to_api(row)
            request["pages"] = pages_by_request.get(request["id"], [])
            request["requested_fields"] = fields_by_request.get(request["id"], [])
            requests.append(request)

        return {"template_requests": requests}

    def get(self, request_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            request_row = conn.execute(
                "SELECT * FROM template_requests WHERE id = ?", (request_id,)
            ).fetchone()
            if request_row is None:
                return {"id": request_id, "status": "not_found", "pages": [], "requested_fields": []}

            page_rows = conn.execute(
                """
                SELECT * FROM template_request_pages
                WHERE template_request_id = ?
                ORDER BY page_number ASC
                """,
                (request_id,),
            ).fetchall()
            field_rows = conn.execute(
                """
                SELECT * FROM requested_fields
                WHERE template_request_id = ?
                ORDER BY page_number ASC, created_at ASC
                """,
                (request_id,),
            ).fetchall()

        return {
            **_request_row_to_api(request_row),
            "pages": [_page_row_to_api(row) for row in page_rows],
            "requested_fields": [_field_row_to_api(row) for row in field_rows],
        }

    def update(self, request_id: str, payload: TemplateRequestUpdate) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        if not patch:
            return self.get(request_id)

        allowed_columns = {
            "request_title",
            "document_type",
            "sample_file_url",
            "request_mode",
            "status",
            "user_note",
            "admin_note",
            "page_count",
        }
        column_values = {key: value for key, value in patch.items() if key in allowed_columns}
        if not column_values:
            return self.get(request_id)

        assignments = ", ".join(f"{column} = ?" for column in column_values)
        values = list(column_values.values())

        with _connect() as conn:
            current = conn.execute("SELECT id FROM template_requests WHERE id = ?", (request_id,)).fetchone()
            if current is None:
                raise HTTPException(status_code=404, detail="Template request not found.")

            conn.execute(
                f"""
                UPDATE template_requests
                SET {assignments}, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (*values, request_id),
            )
            conn.commit()

        return self.get(request_id)

    def delete(self, request_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            request_row = conn.execute(
                "SELECT * FROM template_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
            if request_row is None:
                raise HTTPException(status_code=404, detail="Template request not found.")

            try:
                conn.execute("BEGIN")
                deleted_fields = conn.execute(
                    "DELETE FROM requested_fields WHERE template_request_id = ?",
                    (request_id,),
                ).rowcount
                deleted_pages = conn.execute(
                    "DELETE FROM template_request_pages WHERE template_request_id = ?",
                    (request_id,),
                ).rowcount
                deleted_requests = conn.execute(
                    "DELETE FROM template_requests WHERE id = ?",
                    (request_id,),
                ).rowcount
                conn.commit()
            except Exception:
                conn.rollback()
                raise

        return {
            "id": request_id,
            "deleted": True,
            "converted_template_id": request_row["converted_template_id"],
            "deleted_records": {
                "template_requests": deleted_requests,
                "template_request_pages": deleted_pages,
                "requested_fields": deleted_fields,
            },
        }

    def submit(self, request_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            conn.execute(
                """
                UPDATE template_requests
                SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (request_id,),
            )
            conn.commit()
        return self.get(request_id)

    def pages(self, request_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM template_request_pages
                WHERE template_request_id = ?
                ORDER BY page_number ASC
                """,
                (request_id,),
            ).fetchall()
        return {"template_request_id": request_id, "pages": [_page_row_to_api(row) for row in rows]}

    def add_image(self, request_id: str, payload: TemplateRequestImageCreate) -> Dict[str, Any]:
        image_id = _stub_id("tpl_req_page")
        image_source = self._normalize_image_source(payload.image_source)
        review_status = self._normalize_review_status(payload.review_status)

        with _connect() as conn:
            request_row = conn.execute("SELECT * FROM template_requests WHERE id = ?", (request_id,)).fetchone()
            if request_row is None:
                raise HTTPException(status_code=404, detail="Template request not found.")

            max_page = conn.execute(
                "SELECT MAX(page_number) AS max_page_number FROM template_request_pages WHERE template_request_id = ?",
                (request_id,),
            ).fetchone()
            page_number = int(max_page["max_page_number"] if max_page and max_page["max_page_number"] else 0) + 1

            if payload.is_canonical:
                conn.execute(
                    "UPDATE template_request_pages SET is_canonical = 0, updated_at = CURRENT_TIMESTAMP WHERE template_request_id = ?",
                    (request_id,),
                )

            conn.execute(
                """
                INSERT INTO template_request_pages (
                    id, template_request_id, page_number, sample_image_url,
                    source_file_id, source_file_name,
                    image_source, review_status, is_canonical, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    image_id,
                    request_id,
                    page_number,
                    payload.sample_image_url,
                    payload.source_file_id or image_id,
                    payload.source_file_name or f"Uploaded image {page_number}",
                    image_source,
                    review_status,
                    1 if payload.is_canonical else 0,
                ),
            )
            conn.execute(
                """
                UPDATE template_requests
                SET page_count = (
                    SELECT COUNT(*) FROM template_request_pages WHERE template_request_id = ?
                ), updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (request_id, request_id),
            )
            conn.commit()

            row = conn.execute("SELECT * FROM template_request_pages WHERE id = ?", (image_id,)).fetchone()

        return _page_row_to_api(row)

    def update_image(self, request_id: str, image_id: str, payload: TemplateRequestImageUpdate) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        if not patch:
            return self.get(request_id)

        column_values: Dict[str, Any] = {}
        if "sample_image_url" in patch:
            column_values["sample_image_url"] = patch["sample_image_url"]
            column_values["layout_signature_json"] = None
        if "image_source" in patch:
            column_values["image_source"] = self._normalize_image_source(patch["image_source"])
        if "review_status" in patch:
            column_values["review_status"] = self._normalize_review_status(patch["review_status"])
        if "is_canonical" in patch:
            column_values["is_canonical"] = 1 if patch["is_canonical"] else 0
        if "source_file_id" in patch:
            column_values["source_file_id"] = patch["source_file_id"]
        if "source_file_name" in patch:
            column_values["source_file_name"] = patch["source_file_name"]

        with _connect() as conn:
            row = conn.execute(
                "SELECT * FROM template_request_pages WHERE id = ? AND template_request_id = ?",
                (image_id, request_id),
            ).fetchone()
            if row is None:
                request_exists = conn.execute(
                    "SELECT id FROM template_requests WHERE id = ?",
                    (request_id,),
                ).fetchone()
                image_row = conn.execute(
                    "SELECT id, template_request_id FROM template_request_pages WHERE id = ?",
                    (image_id,),
                ).fetchone()
                if request_exists is None:
                    raise HTTPException(status_code=404, detail="Template request not found.")
                if image_row is None:
                    raise HTTPException(status_code=404, detail="Template request image not found. Reload the request before trying again.")
                raise HTTPException(
                    status_code=409,
                    detail="Template request image belongs to a different request. Reload the request before trying again.",
                )

            if column_values.get("review_status") == "rejected" and column_values.get("is_canonical", row["is_canonical"]) == 1:
                raise HTTPException(status_code=409, detail="Rejected images cannot be canonical references.")
            if column_values.get("is_canonical") == 1:
                effective_status = column_values.get("review_status", row["review_status"])
                if effective_status == "rejected":
                    raise HTTPException(status_code=409, detail="Rejected images cannot be canonical references.")
                conn.execute(
                    "UPDATE template_request_pages SET is_canonical = 0, updated_at = CURRENT_TIMESTAMP WHERE template_request_id = ?",
                    (request_id,),
                )

            assignments = ", ".join(f"{column} = ?" for column in column_values.keys())
            conn.execute(
                f"""
                UPDATE template_request_pages
                SET {assignments}, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND template_request_id = ?
                """,
                [*column_values.values(), image_id, request_id],
            )
            conn.commit()
            updated = conn.execute("SELECT * FROM template_request_pages WHERE id = ?", (image_id,)).fetchone()
            if updated and updated["review_status"] == "approved" and not updated["layout_signature_json"]:
                signature = _generate_layout_signature_for_source(updated["sample_image_url"])
                if signature:
                    signature_json = signature_to_json(signature)
                    conn.execute(
                        """
                        UPDATE template_request_pages
                        SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (signature_json, image_id),
                    )
                    conn.commit()
                    updated = conn.execute("SELECT * FROM template_request_pages WHERE id = ?", (image_id,)).fetchone()

        return _page_row_to_api(updated)

    def delete_image(self, request_id: str, image_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            row = conn.execute(
                "SELECT * FROM template_request_pages WHERE id = ? AND template_request_id = ?",
                (image_id, request_id),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Template request image not found.")

            conn.execute("DELETE FROM requested_fields WHERE template_request_page_id = ?", (image_id,))
            conn.execute("DELETE FROM template_request_pages WHERE id = ? AND template_request_id = ?", (image_id, request_id))
            remaining = conn.execute(
                """
                SELECT id FROM template_request_pages
                WHERE template_request_id = ?
                ORDER BY page_number ASC
                """,
                (request_id,),
            ).fetchall()
            for index, page in enumerate(remaining, start=1):
                conn.execute(
                    "UPDATE template_request_pages SET page_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (index, page["id"]),
                )
            conn.execute(
                "UPDATE template_requests SET page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (len(remaining), request_id),
            )
            conn.commit()

        return {"id": image_id, "template_request_id": request_id, "deleted": True}

    def add_requested_field(self, request_id: str, payload: RequestedFieldCreate) -> Dict[str, Any]:
        field_id = _stub_id("req_field")
        with _connect() as conn:
            page_row = conn.execute(
                """
                SELECT id FROM template_request_pages
                WHERE template_request_id = ? AND (id = ? OR page_number = ?)
                ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
                LIMIT 1
                """,
                (
                    request_id,
                    payload.template_request_page_id,
                    payload.page_number,
                    payload.template_request_page_id,
                ),
            ).fetchone()
            if page_row is None:
                page_id = _stub_id("tpl_req_page")
                conn.execute(
                    """
                    INSERT INTO template_request_pages (
                        id, template_request_id, page_number, sample_image_url, created_at, updated_at
                    )
                    VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (page_id, request_id, payload.page_number),
                )
            else:
                page_id = page_row["id"]

            conn.execute(
                """
                INSERT INTO requested_fields (
                    id, template_request_id, template_request_page_id, page_number,
                    field_name, display_label,
                    roi_x_ratio, roi_y_ratio, roi_width_ratio, roi_height_ratio,
                    data_type, extraction_method, user_note, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    field_id,
                    request_id,
                    page_id,
                    payload.page_number,
                    payload.field_name,
                    payload.display_label,
                    payload.roi.x_ratio,
                    payload.roi.y_ratio,
                    payload.roi.width_ratio,
                    payload.roi.height_ratio,
                    _normalize_data_type(payload.data_type),
                    _normalize_extraction_method(payload.extraction_method),
                    payload.user_note,
                ),
            )
            conn.commit()

            row = conn.execute("SELECT * FROM requested_fields WHERE id = ?", (field_id,)).fetchone()
            print(
                "requested_field_saved",
                {
                    "id": field_id,
                    "request_id": request_id,
                    "data_type": _normalize_data_type(payload.data_type),
                    "extraction_method": _normalize_extraction_method(payload.extraction_method),
                },
                flush=True,
            )

        return _field_row_to_api(row)

    def update_requested_field(
        self, request_id: str, field_id: str, payload: RequestedFieldUpdate
    ) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        column_values: Dict[str, Any] = {}
        direct_columns = {
            "field_name": "field_name",
            "display_label": "display_label",
            "data_type": "data_type",
            "extraction_method": "extraction_method",
            "user_note": "user_note",
        }
        for key, column in direct_columns.items():
            if key in patch:
                value = patch[key]
                if key == "data_type":
                    value = _normalize_data_type(value)
                if key == "extraction_method":
                    value = _normalize_extraction_method(value)
                column_values[column] = value

        if payload.roi is not None:
            column_values.update(
                {
                    "page_number": payload.roi.page_number,
                    "roi_x_ratio": payload.roi.x_ratio,
                    "roi_y_ratio": payload.roi.y_ratio,
                    "roi_width_ratio": payload.roi.width_ratio,
                    "roi_height_ratio": payload.roi.height_ratio,
                }
            )

        with _connect() as conn:
            if column_values:
                set_clause = ", ".join(f"{column} = ?" for column in column_values.keys())
                conn.execute(
                    f"""
                    UPDATE requested_fields
                    SET {set_clause}, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND template_request_id = ?
                    """,
                    [*column_values.values(), field_id, request_id],
                )
                conn.commit()
            row = conn.execute(
                "SELECT * FROM requested_fields WHERE id = ? AND template_request_id = ?",
                (field_id, request_id),
            ).fetchone()

        if row is None:
            return {"id": field_id, "template_request_id": request_id, "status": "not_found"}
        return _field_row_to_api(row)

    def delete_requested_field(self, request_id: str, field_id: str) -> Dict[str, Any]:
        return {"id": field_id, "template_request_id": request_id, "deleted": True}

    def reject(self, request_id: str, reason: Optional[str]) -> Dict[str, Any]:
        with _connect() as conn:
            conn.execute(
                """
                UPDATE template_requests
                SET status = 'rejected', admin_note = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (reason, request_id),
            )
            conn.commit()
        return self.get(request_id)


class AdminTemplateService:
    def dashboard(self) -> Dict[str, Any]:
        with _connect() as conn:
            template_status_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM templates
                GROUP BY status
                """
            ).fetchall()
            request_status_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM template_requests
                GROUP BY status
                """
            ).fetchall()
            latest_request_rows = conn.execute(
                """
                SELECT *
                FROM template_requests
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 4
                """
            ).fetchall()
            latest_template_rows = conn.execute(
                """
                SELECT *
                FROM templates
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 4
                """
            ).fetchall()

        template_counts = {row["status"]: row["count"] for row in template_status_rows}
        request_counts = {row["status"]: row["count"] for row in request_status_rows}
        pending_request_count = sum(request_counts.get(status, 0) for status in ("submitted", "in_review"))
        rejected_request_count = request_counts.get("rejected", 0)
        return {
            "template_count": sum(template_counts.values()),
            "pending_request_count": pending_request_count,
            "draft_template_count": template_counts.get("draft", 0),
            "active_template_count": template_counts.get("active", 0),
            "rejected_request_count": rejected_request_count,
            "template_status_counts": template_counts,
            "request_status_counts": request_counts,
            "latest_requests": [_request_row_to_api(row) for row in latest_request_rows],
            "latest_templates": [_template_row_to_api(row) for row in latest_template_rows],
            "status": "live",
        }

    def create_template(self, payload: TemplateCreate) -> Dict[str, Any]:
        template_id = _stub_id("tpl")
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO templates (
                    id, name, document_type, category, status, version, page_count,
                    template_group_id, version_number, base_template_id, description, shared_fields_json, creation_type,
                    similarity_threshold, final_confidence_threshold,
                    layout_weight, text_anchor_weight, image_anchor_weight, created_by,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, 1, NULL, ?, ?, 'new_template', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    payload.name,
                    payload.document_type,
                    payload.category,
                    payload.page_count,
                    template_id,
                    payload.description,
                    json.dumps(payload.shared_fields or [], ensure_ascii=False),
                    payload.similarity_threshold,
                    payload.final_confidence_threshold,
                    payload.layout_weight,
                    payload.text_anchor_weight,
                    payload.image_anchor_weight,
                    payload.created_by,
                ),
            )
            conn.commit()
        return self.get_template(template_id)

    def list_templates(self) -> Dict[str, Any]:
        with _connect() as conn:
            rows = conn.execute("SELECT * FROM templates ORDER BY created_at DESC").fetchall()
            page_rows = conn.execute(
                """
                SELECT * FROM template_pages
                ORDER BY template_id ASC, page_number ASC
                """
            ).fetchall()

        pages_by_template: Dict[str, List[Dict[str, Any]]] = {}
        for page_row in page_rows:
            page = _template_page_row_to_api(page_row)
            pages_by_template.setdefault(page["template_id"], []).append(page)

        templates = []
        for row in rows:
            template = _template_row_to_api(row)
            template["pages"] = pages_by_template.get(template["id"], [])
            templates.append(template)

        return {"templates": templates}

    def get_template(self, template_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            template_row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
            if template_row is None:
                return {
                    "id": template_id,
                    "status": "not_found",
                    "pages": [],
                    "fields": [],
                    "ignore_regions": [],
                }

            page_rows = conn.execute(
                """
                SELECT * FROM template_pages
                WHERE template_id = ?
                ORDER BY page_number ASC
                """,
                (template_id,),
            ).fetchall()
            field_rows = conn.execute(
                """
                SELECT * FROM template_fields
                WHERE template_id = ?
                ORDER BY page_number ASC, sort_order ASC, created_at ASC
                """,
                (template_id,),
            ).fetchall()
            ignore_rows = conn.execute(
                """
                SELECT * FROM ignore_regions
                WHERE template_id = ?
                ORDER BY page_number ASC, created_at ASC
                """,
                (template_id,),
            ).fetchall()
            reference_rows = conn.execute(
                """
                SELECT * FROM template_layout_references
                WHERE template_id = ?
                ORDER BY is_canonical DESC, page_number ASC, created_at ASC
                """,
                (template_id,),
            ).fetchall()

        return {
            **_template_row_to_api(template_row),
            "pages": [_template_page_row_to_api(row) for row in page_rows],
            "fields": [_template_field_row_to_api(row) for row in field_rows],
            "ignore_regions": [_ignore_region_row_to_api(row) for row in ignore_rows],
            "layout_references": [_template_layout_reference_row_to_api(row) for row in reference_rows],
        }

    def _template_page_image_paths(self, template_id: str, pages: List[Dict[str, Any]]) -> Dict[int, str]:
        output_dir = _storage_root() / "prepublish_template_pages" / template_id
        output_dir.mkdir(parents=True, exist_ok=True)
        paths: Dict[int, str] = {}
        for page in pages:
            source = page.get("normalized_image_url") or page.get("sample_image_url")
            image = _load_image_source(source)
            if image is None:
                continue
            page_number = int(page.get("page_number") or 1)
            output_path = output_dir / f"page_{page_number}.png"
            image.save(output_path, format="PNG")
            paths[page_number] = str(output_path)
        return paths

    def _template_id_from_vector_candidate(self, candidate: Dict[str, Any]) -> Optional[str]:
        metadata = candidate.get("metadata") or {}
        template_id = metadata.get("template_id") or metadata.get("id")
        if template_id:
            return str(template_id)
        vector_id = candidate.get("vector_id")
        if isinstance(vector_id, str) and vector_id.startswith("vec_"):
            return vector_id[4:]
        return None

    def _layout_signature_for_page_paths(self, page_paths: Dict[int, str], page_number: int = 1) -> Dict[str, Any]:
        image_path = page_paths.get(page_number) or next(iter(page_paths.values()), None)
        signature = _generate_layout_signature_for_source(image_path)
        if signature is None:
            raise HTTPException(status_code=409, detail="Unable to generate layout signature for template matching")
        return signature

    def _layout_signature_for_template_pages(self, template: Dict[str, Any], page_number: int = 1) -> Dict[str, Any]:
        page_paths = self._template_page_image_paths(template["id"], template.get("pages") or [])
        return self._layout_signature_for_page_paths(page_paths, page_number)

    def _layout_signatures_for_page_paths(self, page_paths: Dict[int, str]) -> Dict[int, Dict[str, Any]]:
        signatures: Dict[int, Dict[str, Any]] = {}
        for page_number in sorted(page_paths):
            signatures[int(page_number)] = self._layout_signature_for_page_paths(page_paths, int(page_number))
        if not signatures:
            raise HTTPException(status_code=409, detail="Unable to generate layout signatures for template matching")
        return signatures

    def _draft_layout_reference_match(
        self,
        template_id: str,
        query_signature: Dict[str, Any],
    ) -> Dict[str, Any]:
        with _connect() as conn:
            _ensure_template_pages_layout_references(conn, template_id)
            refreshed = _refresh_template_layout_reference_signatures(conn, template_id)
            if not refreshed or any(item.get("status") != "generated" for item in refreshed):
                failed_refs = [item for item in refreshed if item.get("status") != "generated"]
                raise HTTPException(
                    status_code=409,
                    detail=f"Layout reference signature generation failed: {failed_refs or 'no layout references'}",
                )
            rows = conn.execute(
                """
                SELECT id, template_page_id, page_number, image_url, image_source,
                       is_canonical, layout_signature_json
                FROM template_layout_references
                WHERE template_id = ?
                  AND review_status = 'approved'
                  AND layout_signature_json IS NOT NULL
                ORDER BY is_canonical DESC, page_number ASC, created_at ASC
                """,
                (template_id,),
            ).fetchall()

        best_score = 0.0
        best_reference: Optional[Dict[str, Any]] = None
        compared_references: List[Dict[str, Any]] = []
        for row in rows:
            signature = signature_from_json(row["layout_signature_json"])
            if not signature:
                continue
            comparison = compare_layout_signatures(query_signature, signature)
            score = float(comparison.get("score") or 0.0)
            reference = {
                "template_layout_reference_id": row["id"],
                "template_page_id": row["template_page_id"],
                "page_number": row["page_number"],
                "image_url": row["image_url"],
                "image_source": row["image_source"],
                "is_canonical": bool(row["is_canonical"]),
                "reference_role": "main" if row["is_canonical"] else "reference_only",
                "score": round(score, 4),
            }
            compared_references.append(reference)
            if best_reference is None or score > best_score:
                best_score = score
                best_reference = {**reference, "layout_debug": comparison}

        if best_reference is None:
            raise HTTPException(status_code=409, detail="Unable to compare draft layout references")
        return {
            "score": best_score,
            "best_reference": best_reference,
            "reference_count": len(compared_references),
            "references": compared_references,
        }

    def _draft_layout_reference_matches_for_pages(
        self,
        template_id: str,
        query_signatures_by_page: Dict[int, Dict[str, Any]],
    ) -> Dict[str, Any]:
        page_matches = []
        for page_number, query_signature in sorted(query_signatures_by_page.items()):
            match = self._draft_layout_reference_match(template_id, query_signature)
            same_page_refs = [
                reference
                for reference in match.get("references", [])
                if int(reference.get("page_number") or 0) == int(page_number)
            ]
            best_same_page = max(same_page_refs, key=lambda item: float(item.get("score") or 0.0), default=None)
            best_reference = best_same_page or match["best_reference"]
            score = float(best_reference.get("score") or 0.0)
            page_matches.append(
                {
                    "query_page_number": page_number,
                    "template_page_number": best_reference.get("page_number"),
                    "score": round(score, 4),
                    "best_reference": best_reference,
                    "reference_count": match.get("reference_count", 0),
                    "same_page_reference_count": len(same_page_refs),
                    "fallback_cross_page": best_same_page is None,
                }
            )
        scores = [float(item.get("score") or 0.0) for item in page_matches]
        best_page_match = max(page_matches, key=lambda item: float(item.get("score") or 0.0)) if page_matches else None
        return {
            "score": sum(scores) / len(scores) if scores else 0.0,
            "best_reference": best_page_match.get("best_reference") if best_page_match else None,
            "reference_count": sum(int(item.get("reference_count") or 0) for item in page_matches),
            "page_matches": page_matches,
        }

    def _search_layout_candidates_for_pages(
        self,
        query_signatures_by_page: Dict[int, Dict[str, Any]],
        template_id: str,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        by_template: Dict[str, Dict[str, Any]] = {}
        for page_number, query_signature in sorted(query_signatures_by_page.items()):
            for result in search_layout_candidates(query_signature, page_number=page_number, limit=limit, include_template_id=template_id):
                candidate_template_id = self._template_id_from_vector_candidate(result)
                if not candidate_template_id:
                    continue
                score = float(result.get("score") or result.get("layout_score") or 0.0)
                entry = by_template.setdefault(
                    candidate_template_id,
                    {
                        "template_id": candidate_template_id,
                        "scores": [],
                        "best_result": result,
                        "best_score": score,
                        "page_matches": [],
                    },
                )
                entry["scores"].append(score)
                entry["page_matches"].append(
                    {
                        "query_page_number": page_number,
                        "template_page_number": (result.get("metadata") or {}).get("matched_layout_reference_page_number") or page_number,
                        "score": round(score, 4),
                        "vector_id": result.get("vector_id"),
                    }
                )
                if score > float(entry["best_score"]):
                    entry["best_score"] = score
                    entry["best_result"] = result

        candidates = []
        for entry in by_template.values():
            scores = [float(score) for score in entry["scores"]]
            average_score = sum(scores) / len(scores) if scores else 0.0
            best_result = dict(entry["best_result"])
            best_result["score"] = average_score
            best_result["layout_score"] = average_score
            best_result["page_match_details"] = entry["page_matches"]
            best_result["matched_pages"] = len(scores)
            candidates.append(best_result)
        return sorted(candidates, key=lambda item: float(item.get("score") or 0.0), reverse=True)

    def _align_query_pages_for_candidate(
        self,
        candidate_template: Dict[str, Any],
        query_page_paths: Dict[int, str],
        allow_alignment: bool = True,
    ) -> Dict[str, Any]:
        template_page_paths = self._template_page_image_paths(candidate_template["id"], candidate_template.get("pages") or [])
        verification_page_paths = dict(query_page_paths)
        alignments: List[Dict[str, Any]] = []

        for page_number, query_path in query_page_paths.items():
            if not allow_alignment:
                alignments.append(
                    {
                        "page_number": page_number,
                        "alignment_status": "skipped",
                        "verification_source_used": "original",
                        "alignment_reason": "alignment_disabled_for_current_draft_pdf_test",
                        "alignment": {"orb_executed": False},
                    }
                )
                continue

            template_path = template_page_paths.get(page_number)
            if not template_path:
                alignments.append(
                    {
                        "page_number": page_number,
                        "alignment_status": "fallback",
                        "verification_source_used": "normalized",
                        "alignment_reason": "template_page_image_missing",
                    }
                )
                continue

            try:
                precheck = AlignmentService().alignment_precheck(query_path, template_path)
                if not precheck.get("should_run_orb"):
                    alignments.append(
                        {
                            "page_number": page_number,
                            "alignment_status": "skipped",
                            "verification_source_used": "normalized",
                            "alignment_reason": precheck.get("reason") or "geometry_matches_template",
                            "alignment": {"precheck": precheck, "orb_executed": False},
                        }
                    )
                    continue

                aligned_path = _storage_root() / "prepublish_detection_tests" / "aligned" / candidate_template["id"] / f"page_{page_number}_{uuid4().hex[:8]}.png"
                result = AlignmentService().align_to_template(query_path, template_path, str(aligned_path))
                status = str(result.get("alignment_status") or result.get("status") or "failed")
                if status == "aligned" and result.get("aligned_image_path"):
                    verification_page_paths[page_number] = str(result["aligned_image_path"])
                    verification_source = "aligned"
                else:
                    status = "fallback" if status != "failed" else "failed"
                    verification_source = "normalized"
                alignments.append(
                    {
                        "page_number": page_number,
                        "alignment_status": status,
                        "verification_source_used": verification_source,
                        "alignment_reason": result.get("alignment_reason") or result.get("reason") or status,
                        "alignment": result,
                    }
                )
            except Exception as error:
                alignments.append(
                    {
                        "page_number": page_number,
                        "alignment_status": "failed",
                        "verification_source_used": "normalized",
                        "alignment_reason": str(error),
                        "alignment": {"error": str(error), "orb_executed": False},
                    }
                )

        primary_alignment = alignments[0] if alignments else {
            "alignment_status": "skipped",
            "verification_source_used": "normalized",
            "alignment_reason": "no_query_pages",
        }
        return {
            "page_paths": verification_page_paths,
            "alignments": alignments,
            "alignment_status": primary_alignment.get("alignment_status", "skipped"),
            "verification_source_used": primary_alignment.get("verification_source_used", "normalized"),
            "alignment_reason": primary_alignment.get("alignment_reason"),
        }

    def _build_simulation_candidate(
        self,
        candidate_template: Dict[str, Any],
        global_score: float,
        query_page_paths: Dict[int, str],
        is_current_draft: bool = False,
        allow_alignment: bool = True,
    ) -> Dict[str, Any]:
        alignment_context = self._align_query_pages_for_candidate(candidate_template, query_page_paths, allow_alignment=allow_alignment)
        verification = VerificationService().verify_template(candidate_template["id"], alignment_context["page_paths"])
        if is_current_draft:
            verification = self._apply_temporary_draft_image_anchor_scores(candidate_template, verification, alignment_context["page_paths"])
        decision_service = DecisionService()
        threshold = decision_service.final_confidence_threshold(candidate_template, {})
        weights = decision_service.matching_weights(candidate_template, {})
        decision = decision_service.decide_candidate(global_score, verification, threshold, weights)
        return {
            "template_id": candidate_template["id"],
            "template_name": candidate_template.get("name"),
            "template_status": candidate_template.get("status"),
            "vector_id": f"temp_vec_{candidate_template['id']}" if is_current_draft else f"vec_{candidate_template['id']}",
            "global_score": round(float(global_score), 4),
            "layout_score": round(float(global_score), 4),
            "retrieval_engine": "layout_signature",
            "text_anchor_score": decision["text_anchor_score"],
            "image_anchor_score": decision["image_anchor_score"],
            "anchor_score": decision.get("anchor_score"),
            "matching_weights": decision.get("matching_weights"),
            "effective_matching_weights": decision.get("effective_matching_weights"),
            "verification_score": decision["verification_score"],
            "final_score": decision["final_score"],
            "alignment_status": alignment_context["alignment_status"],
            "alignment_reason": alignment_context.get("alignment_reason"),
            "alignment_details": alignment_context["alignments"],
            "verification_source_used": alignment_context["verification_source_used"],
            "decision": decision["decision_reason"],
            "final_passed": decision["final_passed"],
            "required_passed": decision.get("required_passed"),
            "required_failed_fields": decision.get("required_failed_fields", []),
            "is_current_draft": is_current_draft,
            "page_count": candidate_template.get("page_count"),
            "field_count": len(candidate_template.get("fields") or []),
            "verification": verification,
            "verification_details": verification.get("checked_fields", []),
        }

    def _apply_temporary_draft_image_anchor_scores(
        self,
        draft_template: Dict[str, Any],
        verification: Dict[str, Any],
        query_page_paths: Dict[int, str],
    ) -> Dict[str, Any]:
        image_anchors = {
            field["id"]: field
            for field in draft_template.get("fields", [])
            if field.get("use_for_verification") and field.get("data_type") == "image"
        }
        if not image_anchors:
            return verification
        reference_page_paths = self._template_page_image_paths(draft_template["id"], draft_template.get("pages") or [])

        checked_fields = []
        for checked in verification.get("checked_fields", []):
            field_id = checked.get("field_id") or checked.get("anchor_id")
            field = image_anchors.get(field_id)
            if not field:
                checked_fields.append(checked)
                continue

            page_number = int(field.get("page_number") or 1)
            query_source = query_page_paths.get(page_number)
            reference_source = reference_page_paths.get(page_number)
            crop_root = _storage_root() / "prepublish_anchor_crops" / draft_template["id"]
            reference_crop_path = crop_root / "reference" / f"{field_id}.png"
            query_crop_path = crop_root / "query" / f"{field_id}_{uuid4().hex[:8]}.png"
            reference_crop = _crop_anchor_roi(reference_source, field["roi"], reference_crop_path, field.get("roi_padding") or 6) if reference_source else None
            query_crop = _crop_anchor_roi(query_source, field["roi"], query_crop_path, field.get("roi_padding") or 6) if query_source else None
            categories = _image_category_values(field.get("image_category"))
            active_categories = _active_image_category_payloads()
            if query_crop:
                category_infos = [_image_category_api(value) for value in categories]
                valid_categories = [
                    value for value, info in zip(categories, category_infos) if not info.get("error")
                ]
                siglip_results = [verify_image_category(query_crop, value, active_categories) for value in (valid_categories or categories or [""])]
                siglip_result = next((item for item in siglip_results if item.passed), None) or max(siglip_results, key=lambda item: float(item.evidence_score))
                score = round(float(siglip_result.evidence_score), 4)
                siglip_threshold = siglip_result.verification_threshold
                checked_fields.append(
                    {
                        **checked,
                        "expected_text": siglip_result.image_category_label,
                        "actual_text": siglip_result.predicted_label,
                        "normalized_expected": siglip_result.prompt,
                        "normalized_actual": siglip_result.predicted_prompt,
                        "field_score": score,
                        "score": score,
                        "verification_threshold": siglip_threshold,
                        "margin_threshold": siglip_result.margin_threshold,
                        "passed": siglip_result.passed,
                        "status": siglip_result.status,
                        "failure_reason": siglip_result.failure_reason,
                        "model_version": siglip_result.model_version,
                        "scoring_version": siglip_result.scoring_version,
                        "siglip_similarity_score": score,
                        "image_category_score": score,
                        "evidence_score": score,
                        "raw_logit": siglip_result.raw_logit,
                        "raw_pair_score": siglip_result.raw_pair_score,
                        "relative_percentage": siglip_result.relative_percentage,
                        "image_category": siglip_result.image_category,
                        "image_category_label": siglip_result.image_category_label,
                        "image_category_prompt": siglip_result.prompt,
                        "predicted_image_category": siglip_result.predicted_category,
                        "predicted_image_category_label": siglip_result.predicted_label,
                        "predicted_image_category_prompt": siglip_result.predicted_prompt,
                        "siglip_target_rank": siglip_result.target_rank,
                        "siglip_score_margin": siglip_result.score_margin,
                        "siglip_labels": siglip_result.labels,
                        "siglip_ui_percentages": siglip_result.ui_percentages,
                        "model_name": siglip_result.model_name,
                        "device": siglip_result.device,
                        "temporary_siglip_check": True,
                        "reference_crop_preview_data_url": _image_path_to_data_url(reference_crop),
                        "current_crop_preview_data_url": _image_path_to_data_url(query_crop),
                        "error": None,
                    }
                )
            else:
                category_value = categories[0] if categories else ""
                checked_fields.append(
                    {
                        **checked,
                        "field_score": 0.0,
                        "score": 0.0,
                        "passed": False,
                        "failure_reason": "temporary_anchor_crop_failed",
                        "temporary_siglip_check": True,
                        "reference_crop_preview_data_url": _image_path_to_data_url(reference_crop),
                        "current_crop_preview_data_url": _image_path_to_data_url(query_crop),
                        "siglip_similarity_score": 0.0,
                        "image_category_score": 0.0,
                        "image_category": category_value,
                        "image_category_label": _image_category_api(category_value).get("label") or category_value,
                        "image_category_prompt": _image_category_api(category_value).get("prompt") or "",
                    }
                )

        required_fields = [field for field in checked_fields if field.get("required")]
        required_passed = all(field.get("passed") for field in required_fields)
        total_weight = sum(max(0.0, float(field.get("weight") or 1.0)) for field in checked_fields) or 1.0
        score = sum(float(field.get("score") or 0.0) * max(0.0, float(field.get("weight") or 1.0)) for field in checked_fields) / total_weight
        text_fields = [field for field in checked_fields if field.get("anchor_type") == "text"]
        image_fields = [field for field in checked_fields if field.get("anchor_type") == "image"]
        text_weight = sum(max(0.0, float(field.get("weight") or 1.0)) for field in text_fields) or 1.0
        image_weight = sum(max(0.0, float(field.get("weight") or 1.0)) for field in image_fields) or 1.0
        text_score = sum(float(field.get("score") or 0.0) * max(0.0, float(field.get("weight") or 1.0)) for field in text_fields) / text_weight if text_fields else 1.0
        image_score = sum(float(field.get("score") or 0.0) * max(0.0, float(field.get("weight") or 1.0)) for field in image_fields) / image_weight if image_fields else 1.0
        return {
            **verification,
            "status": "verified" if required_passed else "failed",
            "passed": required_passed,
            "score": round(float(score), 4),
            "text_anchor_score": round(float(text_score), 4),
            "image_anchor_score": round(float(image_score), 4),
            "required_passed": required_passed,
            "checked_fields": checked_fields,
            "verification_details": checked_fields,
        }

    def run_prepublish_simulation(self, template_id: str) -> Dict[str, Any]:
        draft = self.get_template(template_id)
        if draft.get("status") == "not_found":
            raise HTTPException(status_code=404, detail="Template not found")

        pages = draft.get("pages") or []
        fields = draft.get("fields") or []
        extraction_fields = [field for field in fields if not field.get("use_for_verification")]
        anchors = [field for field in fields if field.get("use_for_verification")]
        text_anchors = [field for field in anchors if field.get("data_type") != "image"]
        image_anchors = [field for field in anchors if field.get("data_type") == "image"]

        if not pages:
            raise HTTPException(status_code=409, detail="Template must have at least one page before simulation")
        if not fields:
            raise HTTPException(status_code=409, detail="Template must have fields before simulation")

        with _connect() as conn:
            _ensure_template_pages_layout_references(conn, template_id)
            reference_signature_pages = _refresh_template_layout_reference_signatures(conn, template_id)

        query_page_paths = self._template_page_image_paths(template_id, pages)
        if not query_page_paths:
            raise HTTPException(status_code=409, detail="Unable to prepare template page images for verification simulation")
        query_signatures_by_page = self._layout_signatures_for_page_paths(query_page_paths)
        query_signature = query_signatures_by_page[min(query_signatures_by_page.keys())]
        page_layout_signature_pages: List[Dict[str, Any]] = []
        pages_by_number = {int(page.get("page_number") or index + 1): page for index, page in enumerate(pages)}
        for page_number in sorted(query_page_paths):
            page = pages_by_number.get(int(page_number), {})
            signature = query_signatures_by_page.get(int(page_number))
            page_status = "generated" if signature else "failed"
            page_layout_signature_pages.append(
                {
                    "template_page_id": page.get("id"),
                    "template_layout_reference_id": None,
                    "page_number": int(page_number),
                    "status": page_status,
                    "engine": "layout_signature",
                    "version": signature.get("version") if signature else None,
                    "model_name": signature.get("model") if signature else None,
                    "label_count": len(signature.get("boxes") or []) if signature else 0,
                    "image_url": page.get("normalized_image_url") or page.get("sample_image_url"),
                    "image_source": "template_page",
                    "is_canonical": True,
                    "reference_role": "main",
                    "persisted": False,
                    "reason": None if signature else "layout_signature_unavailable",
                }
            )
        layout_signature_pages = reference_signature_pages if reference_signature_pages else page_layout_signature_pages

        active_candidates: List[Dict[str, Any]] = []
        seen_template_ids = {template_id}
        for result in self._search_layout_candidates_for_pages(query_signatures_by_page, template_id, limit=10):
            candidate_template_id = self._template_id_from_vector_candidate(result)
            if not candidate_template_id or candidate_template_id in seen_template_ids:
                continue
            candidate_template = self.get_template(candidate_template_id)
            if candidate_template.get("status") != "active":
                continue
            seen_template_ids.add(candidate_template_id)
            active_candidates.append(
                self._build_simulation_candidate(
                    candidate_template,
                    float(result.get("score") or 0.0),
                    query_page_paths,
                    is_current_draft=False,
                )
            )
            active_candidates[-1]["page_match_details"] = result.get("page_match_details", [])
            if len(active_candidates) >= 4:
                break

        draft_candidate = self._build_simulation_candidate(draft, 1.0, query_page_paths, is_current_draft=True)
        candidates = sorted([draft_candidate, *active_candidates], key=lambda item: item["final_score"], reverse=True)
        if draft_candidate not in candidates[:5]:
            candidates = [*candidates[:4], draft_candidate]
            candidates = sorted(candidates, key=lambda item: item["final_score"], reverse=True)
        candidates = candidates[:5]

        for index, candidate in enumerate(candidates, start=1):
            candidate["rank"] = index

        top1 = candidates[0] if candidates else None
        conflict_candidates = [
            candidate
            for candidate in candidates
            if not candidate.get("is_current_draft") and candidate["final_score"] >= max(0.75, (top1["final_score"] if top1 else 0.0) - 0.08)
        ]
        simulation_passed = bool(top1 and top1.get("is_current_draft") and top1.get("final_passed"))
        if simulation_passed:
            separation_status = "ready_to_publish"
        elif conflict_candidates:
            separation_status = "conflict_detected"
        elif top1 and top1.get("is_current_draft"):
            separation_status = "needs_review"
        else:
            separation_status = "not_ready"

        return {
            "template": draft,
            "draft_summary": {
                "template_name": draft.get("name"),
                "template_id": draft.get("id"),
                "status": draft.get("status"),
                "page_count": len(pages),
                "extraction_field_count": len(extraction_fields),
                "text_anchor_count": len(text_anchors),
                "image_anchor_count": len(image_anchors),
                "similarity_threshold": draft.get("similarity_threshold"),
                "final_confidence_threshold": draft.get("final_confidence_threshold"),
                "layout_weight": draft.get("layout_weight"),
                "text_anchor_weight": draft.get("text_anchor_weight"),
                "image_anchor_weight": draft.get("image_anchor_weight"),
            },
            "temporary_embedding": {
                "status": "generated",
                "engine": "layout_signature",
                "version": query_signature.get("version"),
                "model_name": query_signature.get("model"),
                "embedding_dimension": 0,
                "input_count": len(layout_signature_pages),
                "generated_at": _now(),
                "persisted": False,
                "note": "Temporary layout signature was used only for this pre-publish simulation.",
                "layout_signature_pages": layout_signature_pages,
            },
            "layout_signature_pages": layout_signature_pages,
            "candidates": candidates,
            "verification_anchor_results": draft_candidate.get("verification_details", []),
            "separation_analysis": {
                "top1_score": top1["final_score"] if top1 else 0.0,
                "status": separation_status,
                "simulation_passed": simulation_passed,
                "conflict_templates": conflict_candidates,
                "message": "Draft template is separated from active templates." if simulation_passed else "Review candidate scores before publishing.",
            },
        }

    def run_prepublish_detection_test(self, template_id: str, file_bytes: bytes) -> Dict[str, Any]:
        draft = self.get_template(template_id)
        if draft.get("status") == "not_found":
            raise HTTPException(status_code=404, detail="Template not found")

        pages = draft.get("pages") or []
        fields = draft.get("fields") or []
        if not pages:
            raise HTTPException(status_code=409, detail="Template must have at least one page before testing")
        if not fields:
            raise HTTPException(status_code=409, detail="Template must have fields before testing")

        draft_page_paths = self._template_page_image_paths(template_id, pages)
        if not draft_page_paths:
            raise HTTPException(status_code=409, detail="Unable to prepare draft template images")

        test_id = f"prepubdet_{uuid4().hex[:12]}"
        uploaded_is_pdf = file_bytes.lstrip().startswith(b"%PDF")
        uploaded_page_paths = _prepare_prepublish_test_pages(test_id, file_bytes)
        query_page_paths = (
            {index: str(path) for index, path in enumerate(uploaded_page_paths, start=1)}
            if uploaded_is_pdf
            else _normalize_prepublish_test_pages(test_id, uploaded_page_paths)
        )
        query_paths = [query_page_paths[key] for key in sorted(query_page_paths)]
        draft_paths = [draft_page_paths[key] for key in sorted(draft_page_paths)]

        query_signatures_by_page = self._layout_signatures_for_page_paths(query_page_paths)
        query_signature = query_signatures_by_page[min(query_signatures_by_page.keys())]
        draft_reference_match = self._draft_layout_reference_matches_for_pages(template_id, query_signatures_by_page)
        draft_global_score = float(draft_reference_match["score"])

        candidates: List[Dict[str, Any]] = []
        seen_template_ids = {template_id}
        for result in self._search_layout_candidates_for_pages(query_signatures_by_page, template_id, limit=10):
            candidate_template_id = self._template_id_from_vector_candidate(result)
            if not candidate_template_id or candidate_template_id in seen_template_ids:
                continue
            candidate_template = self.get_template(candidate_template_id)
            if candidate_template.get("status") != "active":
                continue
            seen_template_ids.add(candidate_template_id)
            candidate = self._build_simulation_candidate(
                candidate_template,
                float(result.get("score") or 0.0),
                query_page_paths,
                is_current_draft=False,
            )
            candidate["source"] = "published"
            candidate["source_label"] = "Published / Layout Signature"
            candidate["page_match_details"] = result.get("page_match_details", [])
            candidates.append(candidate)
            if len(candidates) >= 4:
                break

        draft_candidate = self._build_simulation_candidate(
            draft,
            draft_global_score,
            query_page_paths,
            is_current_draft=True,
            allow_alignment=not uploaded_is_pdf,
        )
        draft_candidate["source"] = "draft"
        draft_candidate["source_label"] = "Draft / Layout References"
        draft_candidate["matched_layout_reference"] = draft_reference_match["best_reference"]
        draft_candidate["layout_reference_count"] = draft_reference_match["reference_count"]
        draft_candidate["page_match_details"] = draft_reference_match.get("page_matches", [])

        candidates = sorted([draft_candidate, *candidates], key=lambda item: item["final_score"], reverse=True)[:5]
        for index, candidate in enumerate(candidates, start=1):
            candidate["rank"] = index

        best = candidates[0] if candidates else None
        draft_rank = next((candidate["rank"] for candidate in candidates if candidate.get("is_current_draft")), None)
        draft_result = next((candidate for candidate in candidates if candidate.get("is_current_draft")), None)
        closest_published = next((candidate for candidate in candidates if not candidate.get("is_current_draft")), None)
        closest_score = float(closest_published.get("final_score") or 0.0) if closest_published else 0.0
        draft_score = float(draft_result.get("final_score") or 0.0) if draft_result else 0.0

        if draft_rank == 1 and draft_result and draft_result.get("final_passed"):
            conflict_level = "ready"
            recommendation = "Draft template ranked first and passed the detection test."
            test_passed = True
        elif best:
            conflict_level = "conflict_detected"
            recommendation = "Another template ranked above this draft. Review anchors or template separation before publishing."
            test_passed = False
        else:
            conflict_level = "not_ready"
            recommendation = "No candidate passed the detection test."
            test_passed = False

        return {
            "test_id": test_id,
            "template_id": template_id,
            "matched": bool(best and best.get("final_passed")),
            "selected_template": best,
            "selected_template_type": "Draft Temporary" if best and best.get("is_current_draft") else "Published",
            "final_confidence": best.get("final_score") if best else 0.0,
            "decision_reason": best.get("decision") if best else "no_candidates",
            "draft_template_rank": draft_rank,
            "passed": test_passed,
            "warning": bool(draft_rank == 1 and not test_passed),
            "candidates": candidates,
            "separation_result": {
                "draft_template_rank": draft_rank,
                "draft_final_score": draft_score,
                "closest_published_template": closest_published.get("template_name") if closest_published else None,
                "closest_published_score": closest_score if closest_published else None,
                "conflict_level": conflict_level,
                "recommendation": recommendation,
            },
            "debug": {
                "temporary_embedding_persisted": False,
                "query_engine": query_signature.get("engine"),
                "query_model_name": query_signature.get("model"),
                "query_vector_dimension": 0,
                "retrieval_engine": "layout_signature",
                "input_page_count": len(uploaded_page_paths),
                "source_type": "pdf" if uploaded_is_pdf else "image",
                "normalization_skipped_for_pdf": uploaded_is_pdf,
                "query_page_paths": [str(path) for path in uploaded_page_paths],
                "normalized_query_page_paths": query_paths,
                "query_page_numbers": sorted(query_signatures_by_page.keys()),
                "draft_global_score": round(draft_global_score, 4),
                "draft_layout_reference_match": draft_reference_match,
            },
        }

    def confirm_publish_template(self, template_id: str) -> Dict[str, Any]:
        template = self.get_template(template_id)
        if template.get("status") == "not_found":
            raise HTTPException(status_code=404, detail="Template not found")
        if template.get("status") == "active":
            return {"template": template, "job": None, "status": "already_active"}
        if template.get("status") not in {"draft", "validated", "nonactive"}:
            raise HTTPException(status_code=409, detail="Template must be draft or validated before publish")

        with _connect() as conn:
            conn.execute(
                "UPDATE templates SET status = 'validated', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (template_id,),
            )
            conn.commit()

        layout_job_service = EmbeddingService()
        job_result = layout_job_service.create_embedding_job(template_id)
        completed_result = layout_job_service.run_job_dev(job_result["job"]["id"])
        return {
            "status": "published",
            "template": completed_result["template"],
            "job": completed_result["job"],
        }

    def test_extraction_fields(self, template_id: str) -> Dict[str, Any]:
        template = self.get_template(template_id)
        if template.get("status") == "not_found":
            raise HTTPException(status_code=404, detail="Template not found")

        page_paths = self._template_page_image_paths(template_id, template.get("pages") or [])
        results = []
        for field in [item for item in template.get("fields", []) if not item.get("use_for_verification")]:
            page_number = int(field.get("page_number") or 1)
            image_path = page_paths.get(page_number)
            data_type = field.get("data_type") or "text"
            extraction_method = field.get("extraction_method") or ("table_recognition_v2" if data_type == "table" else "ocr_text")
            roi_mode = field.get("roi_mode") or "fix"
            expected_content = field.get("expected_content")
            result = {
                "field_id": field["id"],
                "field_name": field.get("field_name"),
                "display_label": field.get("display_label"),
                "page_number": page_number,
                "extraction_method": extraction_method,
                "roi_mode": roi_mode,
                "expected_content": expected_content,
                "passed": False,
                "status": "failed",
                "ocr_text": "",
                "confidence": 0.0,
                "failure_reason": None,
            }
            if not image_path:
                result["failure_reason"] = "page_image_missing"
                results.append(result)
                continue
            try:
                crop_path = _storage_root() / "template_extraction_test_crops" / template_id / f"{field['id']}.png"
                cropped = _crop_anchor_roi(image_path, field["roi"], crop_path, field.get("roi_padding") or 0)
                result.update(
                    {
                        "crop_path": cropped,
                        "current_crop_preview_data_url": _image_path_to_data_url(cropped),
                        "current_crop_preview_url": None,
                    }
                )
                if extraction_method == "extract_image" or data_type == "image":
                    result.update(
                        {
                            "passed": bool(cropped),
                            "status": "passed" if cropped else "failed",
                            "ocr_text": "(image crop)",
                            "confidence": 1.0 if cropped else 0.0,
                            "failure_reason": None if cropped else "roi_crop_failed",
                        }
                    )
                elif roi_mode == "flexible" and expected_content == "text":
                    ocr_result = _flexible_text_ocr_from_boundary(cropped)
                    text = str(ocr_result.get("text") or "")
                    confidence = float(ocr_result.get("confidence") or 0.0)
                    result.update(
                        {
                            "passed": bool(text.strip()),
                            "status": "passed" if text.strip() else "failed",
                            "ocr_text": text,
                            "confidence": round(confidence, 4),
                            "raw_segments": ocr_result.get("segments", []),
                            "resolved_blocks": ocr_result.get("resolved_blocks", []),
                            "flexible_overlay_preview_data_url": ocr_result.get("flexible_overlay_preview_data_url"),
                            "ocr_attempts": ocr_result.get("attempts", []),
                            "ocr_preprocessing": ocr_result.get("preprocessing"),
                            "failure_reason": None if text.strip() else str(ocr_result.get("failure_reason") or "flexible_text_empty"),
                        }
                    )
                elif data_type == "table" or extraction_method in {"table_recognition_v2", "ocr_table"}:
                    ocr_result = ocr_rois(
                        image_path,
                        [
                            {
                                "id": field["id"],
                                "roi": field["roi"],
                                "data_type": data_type,
                                "extraction_method": extraction_method,
                            }
                        ],
                    ).get(field["id"], {})
                    text = str(ocr_result.get("text") or "")
                    confidence = float(ocr_result.get("confidence") or 0.0)
                    result.update(
                        {
                            "passed": bool(text.strip()),
                            "status": "passed" if text.strip() else "failed",
                            "ocr_text": text,
                            "confidence": round(confidence, 4),
                            "table_rows": ocr_result.get("table_rows"),
                            "table_structured": ocr_result.get("table_structured"),
                            "table_html": ocr_result.get("table_html"),
                            "table_debug": ocr_result.get("table_debug"),
                            "failure_reason": None if text.strip() else str(ocr_result.get("error") or "table_empty"),
                        }
                    )
                else:
                    ocr_result = ocr_roi(image_path, field["roi"])
                    text = str(ocr_result.get("text") or "")
                    confidence = float(ocr_result.get("confidence") or 0.0)
                    result.update(
                        {
                            "passed": bool(text.strip()),
                            "status": "passed" if text.strip() else "failed",
                            "ocr_text": text,
                            "confidence": round(confidence, 4),
                            "failure_reason": None if text.strip() else "ocr_empty",
                        }
                    )
            except OcrUnavailableError as error:
                result.update({"status": "failed", "failure_reason": "ocr_unavailable", "error": str(error)})
            except Exception as error:
                result.update({"status": "failed", "failure_reason": "ocr_error", "error": str(error)})
            results.append(result)

        return {
            "template_id": template_id,
            "status": "completed",
            "tested_count": len(results),
            "passed_count": sum(1 for item in results if item["passed"]),
            "failed_count": sum(1 for item in results if not item["passed"]),
            "fields": results,
        }

    def test_verification_anchors(self, template_id: str) -> Dict[str, Any]:
        template = self.get_template(template_id)
        if template.get("status") == "not_found":
            raise HTTPException(status_code=404, detail="Template not found")
        page_paths = self._template_page_image_paths(template_id, template.get("pages") or [])
        verification = VerificationService().verify_template(template_id, page_paths)
        checked_fields = verification.get("checked_fields", [])
        return {
            "template_id": template_id,
            "status": verification.get("status"),
            "passed": verification.get("passed"),
            "score": verification.get("score"),
            "tested_count": len(checked_fields),
            "passed_count": sum(1 for item in checked_fields if item.get("passed")),
            "failed_count": sum(1 for item in checked_fields if not item.get("passed")),
            "anchors": checked_fields,
        }

    def update_template(self, template_id: str, payload: TemplateUpdate) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        column_map = {
            "name": "name",
            "document_type": "document_type",
            "category": "category",
            "description": "description",
            "status": "status",
            "page_count": "page_count",
            "similarity_threshold": "similarity_threshold",
            "final_confidence_threshold": "final_confidence_threshold",
            "layout_weight": "layout_weight",
            "text_anchor_weight": "text_anchor_weight",
            "image_anchor_weight": "image_anchor_weight",
            "rejection_reason": "rejection_reason",
        }
        updates = [(column_map[key], value) for key, value in patch.items() if key in column_map]
        if "shared_fields" in patch:
            updates.append(("shared_fields_json", json.dumps(patch["shared_fields"] or [], ensure_ascii=False)))
        if updates:
            set_clause = ", ".join(f"{column} = ?" for column, _ in updates)
            values = [value for _, value in updates]
            with _connect() as conn:
                conn.execute(
                    f"UPDATE templates SET {set_clause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [*values, template_id],
                )
                conn.commit()
        return self.get_template(template_id)

    def delete_template(self, template_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            template_row = conn.execute("SELECT id FROM templates WHERE id = ?", (template_id,)).fetchone()
            if template_row is None:
                raise HTTPException(status_code=404, detail="Template not found")

            counts = {
                "embedding_jobs": conn.execute(
                    "SELECT COUNT(*) AS count FROM embedding_jobs WHERE template_id = ?",
                    (template_id,),
                ).fetchone()["count"],
                "ignore_regions": conn.execute(
                    "SELECT COUNT(*) AS count FROM ignore_regions WHERE template_id = ?",
                    (template_id,),
                ).fetchone()["count"],
                "template_fields": conn.execute(
                    "SELECT COUNT(*) AS count FROM template_fields WHERE template_id = ?",
                    (template_id,),
                ).fetchone()["count"],
                "template_pages": conn.execute(
                    "SELECT COUNT(*) AS count FROM template_pages WHERE template_id = ?",
                    (template_id,),
                ).fetchone()["count"],
                "templates": 1,
            }
            conn.execute(
                """
                UPDATE template_requests
                SET converted_template_id = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE converted_template_id = ?
                """,
                (template_id,),
            )
            conn.execute("DELETE FROM embedding_jobs WHERE template_id = ?", (template_id,))
            conn.execute("DELETE FROM ignore_regions WHERE template_id = ?", (template_id,))
            conn.execute("DELETE FROM template_fields WHERE template_id = ?", (template_id,))
            conn.execute("DELETE FROM template_pages WHERE template_id = ?", (template_id,))
            conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))
            conn.commit()
        return {"id": template_id, "deleted": True, "deleted_records": counts}

    def list_template_pages(self, template_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM template_pages
                WHERE template_id = ?
                ORDER BY page_number ASC
                """,
                (template_id,),
            ).fetchall()
        return {"template_id": template_id, "pages": [_template_page_row_to_api(row) for row in rows]}

    def create_template_page(self, template_id: str, payload: TemplatePageCreate) -> Dict[str, Any]:
        page_id = _stub_id("tpl_page")
        with _connect() as conn:
            template_row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
            similarity_threshold = template_row["similarity_threshold"] if template_row else 0.75
            final_confidence_threshold = template_row["final_confidence_threshold"] if template_row else 0.75
            conn.execute(
                """
                INSERT INTO template_pages (
                    id, template_id, page_number, page_name, sample_image_url,
                    normalized_image_url, layout_signature_json, similarity_threshold, final_confidence_threshold,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    page_id,
                    template_id,
                    payload.page_number,
                    payload.page_name,
                    payload.sample_image_url,
                    payload.normalized_image_url,
                    payload.layout_signature_json,
                    similarity_threshold,
                    final_confidence_threshold,
                ),
            )
            page_count = conn.execute(
                "SELECT COUNT(*) AS count FROM template_pages WHERE template_id = ?",
                (template_id,),
            ).fetchone()["count"]
            conn.execute(
                "UPDATE templates SET page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (page_count, template_id),
            )
            conn.commit()
        return self.get_template(template_id)

    def update_template_page(
        self, template_id: str, page_id: str, payload: TemplatePageUpdate
    ) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        column_map = {
            "page_number": "page_number",
            "page_name": "page_name",
            "sample_image_url": "sample_image_url",
            "normalized_image_url": "normalized_image_url",
            "layout_signature_json": "layout_signature_json",
            "similarity_threshold": "similarity_threshold",
            "final_confidence_threshold": "final_confidence_threshold",
        }
        updates = [(column_map[key], value) for key, value in patch.items() if key in column_map]
        if updates:
            set_clause = ", ".join(f"{column} = ?" for column, _ in updates)
            values = [value for _, value in updates]
            with _connect() as conn:
                conn.execute(
                    f"""
                    UPDATE template_pages
                    SET {set_clause}, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND template_id = ?
                    """,
                    [*values, page_id, template_id],
                )
                if "page_number" in patch:
                    conn.execute(
                        "UPDATE template_fields SET page_number = ?, updated_at = CURRENT_TIMESTAMP WHERE template_page_id = ?",
                        (patch["page_number"], page_id),
                    )
                    conn.execute(
                        "UPDATE ignore_regions SET page_number = ?, updated_at = CURRENT_TIMESTAMP WHERE template_page_id = ?",
                        (patch["page_number"], page_id),
                    )
                conn.commit()
        return self.get_template(template_id)

    def delete_template_page(self, template_id: str, page_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            conn.execute("DELETE FROM template_pages WHERE id = ? AND template_id = ?", (page_id, template_id))
            page_count = conn.execute(
                "SELECT COUNT(*) AS count FROM template_pages WHERE template_id = ?",
                (template_id,),
            ).fetchone()["count"]
            conn.execute(
                "UPDATE templates SET page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (page_count, template_id),
            )
            conn.commit()
        return self.get_template(template_id)

    def create_template_field(self, template_id: str, payload: TemplateFieldCreate) -> Dict[str, Any]:
        field_id = _stub_id("tpl_field")
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO template_fields (
                    id, template_id, template_page_id, page_number,
                    field_name, display_label,
                    roi_x_ratio, roi_y_ratio, roi_width_ratio, roi_height_ratio,
                    data_type, user_selectable, default_selected,
                    use_for_verification, expected_text, match_type,
                    required_for_verification, extraction_method, roi_mode, expected_content,
                    anchor_text, regex_pattern, roi_padding, verification_weight, image_category, sort_order,
                    created_at, updated_at
                )
                VALUES (
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """,
                (
                    field_id,
                    template_id,
                    payload.template_page_id,
                    payload.page_number,
                    payload.field_name,
                    payload.display_label,
                    payload.roi.x_ratio,
                    payload.roi.y_ratio,
                    payload.roi.width_ratio,
                    payload.roi.height_ratio,
                    payload.data_type or "text",
                    int(payload.user_selectable),
                    int(payload.default_selected),
                    int(payload.use_for_verification),
                    payload.expected_text,
                    payload.match_type,
                    int(payload.required_for_verification),
                    _normalize_extraction_method(payload.extraction_method),
                    _normalize_roi_mode(payload.roi_mode),
                    _normalize_expected_content(payload.expected_content),
                    payload.anchor_text,
                    payload.regex_pattern,
                    payload.roi_padding if payload.roi_padding is not None else 0,
                    payload.verification_weight if payload.verification_weight is not None else 1.0,
                    (payload.image_category or None),
                    payload.sort_order,
                ),
            )
            conn.commit()
        return self.get_template(template_id)

    def update_template_field(
        self, template_id: str, field_id: str, payload: TemplateFieldUpdate
    ) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        column_values: Dict[str, Any] = {}
        direct_columns = {
            "template_page_id": "template_page_id",
            "page_number": "page_number",
            "field_name": "field_name",
            "display_label": "display_label",
            "data_type": "data_type",
            "user_selectable": "user_selectable",
            "default_selected": "default_selected",
            "use_for_verification": "use_for_verification",
            "expected_text": "expected_text",
            "match_type": "match_type",
            "required_for_verification": "required_for_verification",
            "extraction_method": "extraction_method",
            "roi_mode": "roi_mode",
            "expected_content": "expected_content",
            "anchor_text": "anchor_text",
            "regex_pattern": "regex_pattern",
            "roi_padding": "roi_padding",
            "verification_weight": "verification_weight",
            "image_category": "image_category",
            "sort_order": "sort_order",
        }
        for key, column in direct_columns.items():
            if key in patch:
                value = patch[key]
                if key in {"user_selectable", "default_selected", "use_for_verification", "required_for_verification"}:
                    value = int(value)
                if key == "extraction_method":
                    value = _normalize_extraction_method(value)
                if key == "roi_mode":
                    value = _normalize_roi_mode(value)
                if key == "expected_content":
                    value = _normalize_expected_content(value)
                column_values[column] = value
        if payload.roi is not None:
            column_values.update(
                {
                    "page_number": payload.roi.page_number,
                    "roi_x_ratio": payload.roi.x_ratio,
                    "roi_y_ratio": payload.roi.y_ratio,
                    "roi_width_ratio": payload.roi.width_ratio,
                    "roi_height_ratio": payload.roi.height_ratio,
                }
            )
        if column_values:
            set_clause = ", ".join(f"{column} = ?" for column in column_values.keys())
            with _connect() as conn:
                conn.execute(
                    f"""
                    UPDATE template_fields
                    SET {set_clause}, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND template_id = ?
                    """,
                    [*column_values.values(), field_id, template_id],
                )
                conn.commit()
        return self.get_template(template_id)

    def delete_template_field(self, template_id: str, field_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            conn.execute("DELETE FROM template_fields WHERE id = ? AND template_id = ?", (field_id, template_id))
            conn.commit()
        return self.get_template(template_id)

    def create_ignore_region(self, template_id: str, payload: IgnoreRegionCreate) -> Dict[str, Any]:
        region_id = _stub_id("ignore_region")
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO ignore_regions (
                    id, template_id, template_page_id, page_number, field_name,
                    roi_x_ratio, roi_y_ratio, roi_width_ratio, roi_height_ratio,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    region_id,
                    template_id,
                    payload.template_page_id,
                    payload.page_number,
                    payload.field_name,
                    payload.roi.x_ratio,
                    payload.roi.y_ratio,
                    payload.roi.width_ratio,
                    payload.roi.height_ratio,
                ),
            )
            conn.commit()
        return self.get_template(template_id)

    def update_ignore_region(
        self, template_id: str, region_id: str, payload: IgnoreRegionUpdate
    ) -> Dict[str, Any]:
        patch = payload.model_dump(exclude_unset=True)
        column_values: Dict[str, Any] = {}
        direct_columns = {
            "template_page_id": "template_page_id",
            "page_number": "page_number",
            "field_name": "field_name",
        }
        for key, column in direct_columns.items():
            if key in patch:
                column_values[column] = patch[key]
        if payload.roi is not None:
            column_values.update(
                {
                    "page_number": payload.roi.page_number,
                    "roi_x_ratio": payload.roi.x_ratio,
                    "roi_y_ratio": payload.roi.y_ratio,
                    "roi_width_ratio": payload.roi.width_ratio,
                    "roi_height_ratio": payload.roi.height_ratio,
                }
            )
        if column_values:
            set_clause = ", ".join(f"{column} = ?" for column in column_values.keys())
            with _connect() as conn:
                conn.execute(
                    f"""
                    UPDATE ignore_regions
                    SET {set_clause}, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND template_id = ?
                    """,
                    [*column_values.values(), region_id, template_id],
                )
                conn.commit()
        return self.get_template(template_id)

    def delete_ignore_region(self, template_id: str, region_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            conn.execute("DELETE FROM ignore_regions WHERE id = ? AND template_id = ?", (region_id, template_id))
            conn.commit()
        return self.get_template(template_id)

    def start_review(self, request_id: str) -> Dict[str, Any]:
        return {"id": request_id, "status": "in_review", "updated_at": _now()}

    def suggest_base_version_for_request(
        self,
        request_id: str,
        template_id: str,
        similarity_threshold: float = 0.72,
    ) -> Dict[str, Any]:
        with _connect() as conn:
            selected_template = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
            if selected_template is None:
                raise HTTPException(status_code=404, detail="Template not found")
            selected_template = _row_to_dict(selected_template)
            group_id = selected_template.get("template_group_id") or selected_template["id"]
            version_rows = [
                _row_to_dict(row)
                for row in conn.execute(
                """
                SELECT * FROM templates
                WHERE template_group_id = ? OR id = ?
                ORDER BY version_number DESC, version DESC, created_at DESC
                """,
                (group_id, group_id),
                ).fetchall()
            ]
            request_pages = [
                _row_to_dict(row)
                for row in conn.execute(
                """
                SELECT * FROM template_request_pages
                WHERE template_request_id = ?
                  AND review_status IN ('approved', 'pending')
                  AND sample_image_url IS NOT NULL
                ORDER BY page_number ASC
                """,
                (request_id,),
                ).fetchall()
            ]
            reference_rows = [
                _row_to_dict(row)
                for row in conn.execute(
                """
                SELECT * FROM template_layout_references
                WHERE template_id IN (
                    SELECT id FROM templates WHERE template_group_id = ? OR id = ?
                )
                  AND layout_signature_json IS NOT NULL
                ORDER BY template_id ASC, is_canonical DESC, page_number ASC
                """,
                (group_id, group_id),
                ).fetchall()
            ]

        query_signatures = []
        for page in request_pages:
            signature = _generate_layout_signature_for_source(page["sample_image_url"])
            if signature:
                query_signatures.append({"page": page, "signature": signature})

        best: Optional[Dict[str, Any]] = None
        for query in query_signatures:
            for reference in reference_rows:
                reference_signature = signature_from_json(reference["layout_signature_json"])
                if not reference_signature:
                    continue
                comparison = compare_layout_signatures(query["signature"], reference_signature)
                score = float(comparison.get("score") or comparison.get("similarity") or 0.0)
                candidate = {
                    "template_id": reference["template_id"],
                    "template_page_id": reference.get("template_page_id"),
                    "page_number": reference["page_number"],
                    "request_page_id": query["page"]["id"],
                    "request_page_number": query["page"]["page_number"],
                    "similarity_score": round(score, 4),
                    "comparison": comparison,
                }
                if best is None or candidate["similarity_score"] > best["similarity_score"]:
                    best = candidate

        versions = [_template_row_to_api(row) for row in version_rows]
        suggested = best if best and best["similarity_score"] >= similarity_threshold else None
        return {
            "request_id": request_id,
            "template_group_id": group_id,
            "versions": versions,
            "suggested_base_version": suggested,
            "reuse_roi": bool(suggested),
            "similarity_threshold": similarity_threshold,
            "message": "Suggested base version found." if suggested else "No suitable Version found.",
        }

    def create_version_from_request(self, request_id: str, payload: TemplateVersionCreate) -> Dict[str, Any]:
        if not payload.base_template_id:
            raise HTTPException(status_code=400, detail="base_template_id is required for a new Template Version.")

        with _connect() as conn:
            base_template_row = conn.execute("SELECT * FROM templates WHERE id = ?", (payload.base_template_id,)).fetchone()
            if base_template_row is None:
                raise HTTPException(status_code=404, detail="Base template version not found")
            base_template_row = _row_to_dict(base_template_row)
            request_row = conn.execute("SELECT * FROM template_requests WHERE id = ?", (request_id,)).fetchone()
            if request_row is None:
                raise HTTPException(status_code=404, detail="Template request not found")
            request_row = _row_to_dict(request_row)
            request_pages = [
                _row_to_dict(row)
                for row in conn.execute(
                """
                SELECT * FROM template_request_pages
                WHERE template_request_id = ?
                ORDER BY page_number ASC
                """,
                (request_id,),
                ).fetchall()
            ]
            approved_pages = [page for page in request_pages if page["review_status"] == "approved"]
            if not approved_pages:
                approved_pages = [page for page in request_pages if page["sample_image_url"]]
            if not approved_pages:
                raise HTTPException(status_code=409, detail="Upload at least one reference image before creating a version.")

            group_id = base_template_row.get("template_group_id") or base_template_row["id"]
            max_version_row = conn.execute(
                """
                SELECT MAX(COALESCE(version_number, version, 1)) AS max_version
                FROM templates
                WHERE template_group_id = ? OR id = ?
                """,
                (group_id, group_id),
            ).fetchone()
            next_version = int(max_version_row["max_version"] or 1) + 1
            template_id = _stub_id("tpl")
            shared_fields = payload.shared_fields
            if not shared_fields:
                try:
                    shared_fields = json.loads(base_template_row.get("shared_fields_json") or "[]")
                except (TypeError, json.JSONDecodeError):
                    shared_fields = []
            base_template_name = str(base_template_row["document_type"] or base_template_row["name"] or "").strip()
            requested_template_name = str(payload.template_name or "").strip()
            version_template_name = (
                requested_template_name
                if requested_template_name.startswith(f"{base_template_name} - ") and requested_template_name != f"{base_template_name} -"
                else base_template_name
            )

            conn.execute(
                """
                INSERT INTO templates (
                    id, name, document_type, category, status, version, page_count,
                    template_group_id, version_number, base_template_id, description, shared_fields_json, creation_type,
                    similarity_threshold, final_confidence_threshold,
                    layout_weight, text_anchor_weight, image_anchor_weight, created_by,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 'new_version', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    version_template_name,
                    base_template_row["document_type"] or payload.document_type or request_row["document_type"],
                    base_template_row["category"],
                    next_version,
                    len(approved_pages),
                    group_id,
                    next_version,
                    payload.base_template_id,
                    payload.description if payload.description is not None else base_template_row.get("description"),
                    json.dumps(shared_fields or [], ensure_ascii=False),
                    base_template_row["similarity_threshold"],
                    base_template_row["final_confidence_threshold"],
                    base_template_row.get("layout_weight", 0.50),
                    base_template_row.get("text_anchor_weight", 0.35),
                    base_template_row.get("image_anchor_weight", 0.15),
                    request_row["requested_by"],
                ),
            )

            base_pages = [
                _row_to_dict(row)
                for row in conn.execute(
                "SELECT * FROM template_pages WHERE template_id = ? ORDER BY page_number ASC",
                (payload.base_template_id,),
                ).fetchall()
            ]
            base_fields = [
                _row_to_dict(row)
                for row in conn.execute(
                "SELECT * FROM template_fields WHERE template_id = ? ORDER BY page_number ASC, sort_order ASC, created_at ASC",
                (payload.base_template_id,),
                ).fetchall()
            ]
            page_id_by_base_page: Dict[str, str] = {}
            page_id_by_number: Dict[int, str] = {}

            for page_index, source_page in enumerate(approved_pages, start=1):
                base_page = next((page for page in base_pages if int(page["page_number"]) == page_index), None)
                page_id = _stub_id("tpl_page")
                signature = _generate_layout_signature_for_source(source_page["sample_image_url"])
                signature_json = signature_to_json(signature) if signature else None
                conn.execute(
                    """
                    INSERT INTO template_pages (
                        id, template_id, page_number, page_name, sample_image_url,
                        normalized_image_url, layout_signature_json,
                        similarity_threshold, final_confidence_threshold,
                        created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (
                        page_id,
                        template_id,
                        page_index,
                        f"Page {page_index}",
                        source_page["sample_image_url"],
                        source_page["sample_image_url"],
                        signature_json,
                        base_page["similarity_threshold"] if base_page else base_template_row["similarity_threshold"],
                        base_page["final_confidence_threshold"] if base_page else base_template_row["final_confidence_threshold"],
                    ),
                )
                if base_page:
                    page_id_by_base_page[base_page["id"]] = page_id
                page_id_by_number[page_index] = page_id
                conn.execute(
                    """
                    INSERT INTO template_layout_references (
                        id, template_id, template_page_id, page_number, image_url,
                        image_source, review_status, is_canonical, layout_signature_json,
                        created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (
                        _stub_id("tpl_ref"),
                        template_id,
                        page_id,
                        page_index,
                        source_page["sample_image_url"],
                        source_page.get("image_source", "admin_upload"),
                        1 if page_index == 1 else 0,
                        signature_json,
                    ),
                )

            cloned_field_count = 0
            for field in (base_fields if payload.reuse_roi else []):
                target_page_id = page_id_by_base_page.get(field["template_page_id"]) or page_id_by_number.get(int(field["page_number"]))
                if not target_page_id:
                    continue
                conn.execute(
                    """
                    INSERT INTO template_fields (
                        id, template_id, template_page_id, page_number,
                        field_name, display_label,
                        roi_x_ratio, roi_y_ratio, roi_width_ratio, roi_height_ratio,
                        data_type, user_selectable, default_selected,
                        use_for_verification, expected_text, match_type,
                        required_for_verification, extraction_method, roi_mode, expected_content,
                        anchor_text, regex_pattern, roi_padding, sort_order,
                        verification_weight, image_category,
                        created_at, updated_at
                    )
                    VALUES (
                        ?, ?, ?, ?,
                        ?, ?,
                        ?, ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?, ?,
                        ?, ?, ?, ?,
                        ?, ?,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    )
                    """,
                    (
                        _stub_id("tpl_field"),
                        template_id,
                        target_page_id,
                        field["page_number"],
                        field["field_name"],
                        field["display_label"],
                        field["roi_x_ratio"],
                        field["roi_y_ratio"],
                        field["roi_width_ratio"],
                        field["roi_height_ratio"],
                        _normalize_data_type(field.get("data_type")),
                        field["user_selectable"],
                        field["default_selected"],
                        field["use_for_verification"],
                        field["expected_text"],
                        field["match_type"],
                        field["required_for_verification"],
                        _normalize_extraction_method(field.get("extraction_method")),
                        _normalize_roi_mode(field.get("roi_mode")),
                        _normalize_expected_content(field.get("expected_content")),
                        field["anchor_text"],
                        field["regex_pattern"],
                        field["roi_padding"],
                        field["sort_order"],
                        field.get("verification_weight", 1.0),
                        field.get("image_category"),
                    ),
                )
                cloned_field_count += 1

            conn.execute(
                """
                UPDATE template_requests
                SET status = 'converted_to_template',
                    converted_template_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (template_id, request_id),
            )
            conn.commit()

        return {
            "template_request_id": request_id,
            "converted_template_id": template_id,
            "template_id": template_id,
            "base_template_id": payload.base_template_id,
            "template_group_id": group_id,
            "version_number": next_version,
            "reuse_roi": cloned_field_count > 0,
            "status": "version_created",
            "created_records": {
                "templates": 1,
                "template_pages": len(approved_pages),
                "template_fields": cloned_field_count,
                "template_layout_references": len(approved_pages),
            },
        }

    def convert_request_to_template(self, request_id: str) -> Dict[str, Any]:
        template_id = _stub_id("tpl")
        created_template_page_ids: Dict[int, str] = {}

        with _connect() as conn:
            request_row = conn.execute(
                "SELECT * FROM template_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
            if request_row is None:
                return {
                    "template_request_id": request_id,
                    "converted_template_id": None,
                    "status": "not_found",
                }

            if request_row["converted_template_id"]:
                return {
                    "template_request_id": request_id,
                    "converted_template_id": request_row["converted_template_id"],
                    "template_id": request_row["converted_template_id"],
                    "status": "already_converted",
                }

            request_pages = conn.execute(
                """
                SELECT * FROM template_request_pages
                WHERE template_request_id = ?
                ORDER BY page_number ASC
                """,
                (request_id,),
            ).fetchall()
            approved_pages = [page for page in request_pages if page["review_status"] == "approved"]
            pending_pages = [page for page in request_pages if page["review_status"] == "pending"]
            if pending_pages:
                raise HTTPException(
                    status_code=409,
                    detail="Review every page before converting this request to a template.",
                )
            if not approved_pages:
                raise HTTPException(
                    status_code=409,
                    detail="Approve at least one document page before converting to a template.",
                )
            if any(not page["sample_image_url"] for page in approved_pages):
                raise HTTPException(
                    status_code=409,
                    detail="Approved document pages must include an image before converting to a template.",
                )
            explicit_canonical_pages = [page for page in approved_pages if page["is_canonical"]]
            main_source_file_ids = {
                (page["source_file_id"] or page["id"])
                for page in (explicit_canonical_pages or [approved_pages[0]])
            }
            template_pages_source = [
                page for page in approved_pages if (page["source_file_id"] or page["id"]) in main_source_file_ids
            ]
            if not template_pages_source:
                template_pages_source = [approved_pages[0]]

            requested_fields = conn.execute(
                """
                SELECT * FROM requested_fields
                WHERE template_request_id = ?
                ORDER BY page_number ASC, created_at ASC
                """,
                (request_id,),
            ).fetchall()

            conn.execute(
                """
                INSERT INTO templates (
                    id, name, document_type, category, status, version, page_count,
                    template_group_id, version_number, base_template_id, description, shared_fields_json, creation_type,
                    similarity_threshold, final_confidence_threshold,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, NULL, 'draft', 1, ?, ?, 1, NULL, ?, ?, 'new_template', 0.75, 0.75, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    request_row["request_title"],
                    request_row["document_type"],
                    len(template_pages_source),
                    template_id,
                    _row_to_dict(request_row).get("admin_note"),
                    json.dumps([], ensure_ascii=False),
                ),
            )

            layout_reference_count = 0
            request_page_to_template_page: Dict[str, Dict[str, Any]] = {}
            request_page_number_to_template_page: Dict[int, Dict[str, Any]] = {}
            template_page_id_by_request_page_id: Dict[str, str] = {}
            template_page_number_by_request_page_id: Dict[str, int] = {}

            for page_index, page in enumerate(template_pages_source, start=1):
                signature = _generate_layout_signature_for_source(page["sample_image_url"])
                signature_json = signature_to_json(signature) if signature else None
                if signature_json:
                    conn.execute(
                        """
                        UPDATE template_request_pages
                        SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (signature_json, page["id"]),
                    )

                page_id = _stub_id("tpl_page")
                created_template_page_ids[page_index] = page_id
                conn.execute(
                    """
                    INSERT INTO template_pages (
                        id, template_id, page_number, page_name, sample_image_url,
                        normalized_image_url, layout_signature_json,
                        similarity_threshold, final_confidence_threshold,
                        created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0.75, 0.75, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (
                        page_id,
                        template_id,
                        page_index,
                        f"Page {page_index}",
                        page["sample_image_url"],
                        page["sample_image_url"],
                        signature_json,
                    ),
                )
                page_mapping = {
                    "template_page_id": page_id,
                    "template_page_number": page_index,
                    "request_page_id": page["id"],
                    "request_page_number": page["page_number"],
                }
                request_page_to_template_page[page["id"]] = page_mapping
                request_page_number_to_template_page[int(page["page_number"])] = page_mapping
                template_page_id_by_request_page_id[page["id"]] = page_id
                template_page_number_by_request_page_id[page["id"]] = page_index

            for page in approved_pages:
                signature = _generate_layout_signature_for_source(page["sample_image_url"])
                signature_json = signature_to_json(signature) if signature else None
                if signature_json:
                    conn.execute(
                        """
                        UPDATE template_request_pages
                        SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (signature_json, page["id"]),
                    )

                page_is_canonical = (page["source_file_id"] or page["id"]) in main_source_file_ids
                template_page_id = template_page_id_by_request_page_id.get(page["id"])
                reference_page_number = template_page_number_by_request_page_id.get(page["id"], int(page["page_number"]))

                conn.execute(
                    """
                    INSERT INTO template_layout_references (
                        id, template_id, template_page_id, page_number, image_url,
                        image_source, review_status, is_canonical, layout_signature_json,
                        created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (
                        _stub_id("tpl_ref"),
                        template_id,
                        template_page_id,
                        reference_page_number,
                        page["sample_image_url"],
                        page["image_source"],
                        1 if page_is_canonical else 0,
                        signature_json,
                    ),
                )
                layout_reference_count += 1

            converted_requested_fields = [
                field
                for field in requested_fields
                if field["template_request_page_id"] in request_page_to_template_page
                or int(field["page_number"]) in request_page_number_to_template_page
            ]
            sort_order_by_page: Dict[int, int] = {}

            for field in converted_requested_fields:
                page_mapping = request_page_to_template_page.get(field["template_request_page_id"]) or request_page_number_to_template_page[int(field["page_number"])]
                template_page_id = page_mapping["template_page_id"]
                template_page_number = int(page_mapping["template_page_number"])
                sort_order_by_page[template_page_number] = sort_order_by_page.get(template_page_number, 0) + 1

                conn.execute(
                    """
                    INSERT INTO template_fields (
                        id, template_id, template_page_id, page_number,
                        field_name, display_label,
                        roi_x_ratio, roi_y_ratio, roi_width_ratio, roi_height_ratio,
                        data_type, user_selectable, default_selected,
                        use_for_verification, expected_text, match_type,
                        required_for_verification, extraction_method, roi_mode, expected_content,
                        anchor_text, regex_pattern, roi_padding, sort_order,
                        created_at, updated_at
                    )
                    VALUES (
                        ?, ?, ?, ?,
                        ?, ?,
                        ?, ?, ?, ?,
                        ?, 1, 1,
                        0, NULL, NULL,
                        0, ?, 'fix', NULL,
                        NULL, NULL, 0, ?,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    )
                    """,
                    (
                        _stub_id("tpl_field"),
                        template_id,
                        template_page_id,
                        template_page_number,
                        field["field_name"],
                        field["display_label"],
                        field["roi_x_ratio"],
                        field["roi_y_ratio"],
                        field["roi_width_ratio"],
                        field["roi_height_ratio"],
                        _normalize_data_type(field["data_type"]),
                        _normalize_extraction_method(field["extraction_method"]),
                        sort_order_by_page[template_page_number],
                    ),
                )

            conn.execute(
                """
                UPDATE template_requests
                SET status = 'converted_to_template',
                    converted_template_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (template_id, request_id),
            )
            conn.commit()

        return {
            "template_request_id": request_id,
            "converted_template_id": template_id,
            "template_id": template_id,
            "status": "converted_to_template",
            "created_records": {
                "templates": 1,
                "template_pages": len(created_template_page_ids),
                "template_fields": len(converted_requested_fields),
                "template_layout_references": layout_reference_count,
            },
        }

    def reject_request(self, request_id: str, reason: Optional[str]) -> Dict[str, Any]:
        return {"id": request_id, "status": "rejected", "rejection_reason": reason}

    def approve_template(self, template_id: str) -> Dict[str, Any]:
        return {"id": template_id, "status": "approved", "approved_at": _now()}

    def reject_template(self, template_id: str, reason: Optional[str]) -> Dict[str, Any]:
        return {"id": template_id, "status": "rejected", "rejection_reason": reason}

    def test_template(self, template_id: str, payload: TemplateTestRequest) -> Dict[str, Any]:
        return {
            "template_id": template_id,
            "status": "test_mode_stubbed",
            "pages": [
                {
                    "page_number": page.page_number,
                    "layout_preview": None,
                    "layout_overlay_preview": None,
                    "top_k_candidates": [],
                    "verification": None,
                    "confidence": None,
                }
                for page in payload.pages
            ],
        }

