import base64
import io
import json
import math
import os
import re
import sqlite3
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
from .embedding_service import EmbeddingContextError
from .image_normalization import ImageNormalizationService
from .layout_analysis_service import analyze_layout
from .layout_signature_service import build_layout_signature, compare_layout_signatures, signature_to_json
from .layout_template_matcher import search_layout_candidates
from .ocr_adapter import OcrUnavailableError, ocr_roi, ocr_rois
from .vision_embedding_adapter import encode_images
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
)


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


def _connect() -> Any:
    conn = connect_db()
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_template_request_page_review_columns(conn)
    _ensure_template_layout_references_table(conn)
    _ensure_requested_field_metadata_columns(conn)
    _ensure_template_matching_weight_columns(conn)
    _ensure_template_page_layout_signature_column(conn)
    _ensure_template_field_verification_columns(conn)
    _ensure_embedding_jobs_table(conn)
    _ensure_verification_anchor_embeddings_table(conn)
    return conn


def _ensure_template_request_page_review_columns(conn: sqlite3.Connection) -> None:
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
    conn.commit()


def _ensure_template_layout_references_table(conn: sqlite3.Connection) -> None:
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


def _ensure_requested_field_metadata_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(requested_fields)").fetchall()
    }
    if columns and "data_type" not in columns:
        conn.execute("ALTER TABLE requested_fields ADD COLUMN data_type TEXT DEFAULT 'text'")
    if columns and "extraction_method" not in columns:
        conn.execute("ALTER TABLE requested_fields ADD COLUMN extraction_method TEXT DEFAULT 'ocr_text'")
    conn.commit()


def _ensure_embedding_jobs_table(conn: sqlite3.Connection) -> None:
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


def _ensure_template_matching_weight_columns(conn: sqlite3.Connection) -> None:
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


def _ensure_template_field_verification_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(template_fields)").fetchall()
    }
    if columns and "verification_weight" not in columns:
        conn.execute("ALTER TABLE template_fields ADD COLUMN verification_weight REAL DEFAULT 1.0")
    conn.commit()


def _ensure_template_page_layout_signature_column(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(template_pages)").fetchall()
    }
    if columns and "layout_signature_json" not in columns:
        conn.execute("ALTER TABLE template_pages ADD COLUMN layout_signature_json TEXT")
    conn.commit()


def _ensure_verification_anchor_embeddings_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS verification_anchor_embeddings (
            id TEXT NOT NULL PRIMARY KEY,
            template_id TEXT NOT NULL,
            anchor_id TEXT NOT NULL,
            embedding_json TEXT NOT NULL,
            model_version TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
            FOREIGN KEY (anchor_id) REFERENCES template_fields(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS verification_anchor_embeddings_anchor_idx ON verification_anchor_embeddings(anchor_id)"
    )
    conn.commit()


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return dict(row)


def _request_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
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


def _page_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_request_id": item["template_request_id"],
        "page_number": item["page_number"],
        "sample_image_url": item["sample_image_url"],
        "image_source": item.get("image_source", "user_request"),
        "review_status": item.get("review_status", "pending"),
        "is_canonical": bool(item.get("is_canonical", 0)),
        "layout_signature_json": item.get("layout_signature_json"),
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_layout_reference_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
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


def _field_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
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


def _template_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "name": item["name"],
        "document_type": item["document_type"],
        "category": item["category"],
        "status": item["status"],
        "version": item["version"],
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


def _template_page_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
    item = _row_to_dict(row)
    layout_signature_json = item.get("layout_signature_json") if "layout_signature_json" in item else None
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "page_number": item["page_number"],
        "page_name": item["page_name"],
        "sample_image_url": item["sample_image_url"],
        "normalized_image_url": item["normalized_image_url"],
        "qdrant_point_id": item["qdrant_point_id"],
        "layout_signature_json": layout_signature_json,
        "similarity_threshold": item["similarity_threshold"],
        "final_confidence_threshold": item["final_confidence_threshold"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_field_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
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
        "roi_padding": item["roi_padding"],
        "verification_weight": item.get("verification_weight", 1.0),
        "sort_order": item["sort_order"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _ignore_region_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
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


def _embedding_job_row_to_api(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
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


def _refresh_template_layout_signatures(conn: sqlite3.Connection, template_id: str) -> List[Dict[str, Any]]:
    reference_count_row = conn.execute(
        "SELECT COUNT(*) AS reference_count FROM template_layout_references WHERE template_id = ?",
        (template_id,),
    ).fetchone()
    should_bootstrap_references = bool(reference_count_row and not reference_count_row["reference_count"])
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
        if should_bootstrap_references and source:
            conn.execute(
                """
                INSERT INTO template_layout_references (
                    id, template_id, template_page_id, page_number, image_url,
                    image_source, review_status, is_canonical, layout_signature_json,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'admin_upload', 'approved', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    _stub_id("tpl_ref"),
                    template_id,
                    row["id"],
                    row["page_number"],
                    source,
                    1 if row["page_number"] == 1 else 0,
                    signature_json,
                ),
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
    return refreshed


def _refresh_template_layout_reference_signatures(conn: sqlite3.Connection, template_id: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, page_number, image_url
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
                    "page_number": row["page_number"],
                    "status": "failed",
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
                "page_number": row["page_number"],
                "status": "generated",
                "region_count": signature.get("region_count", 0),
                "model": signature.get("model"),
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


def _template_page_image_source(conn: sqlite3.Connection, template_page_id: str) -> Optional[str]:
    row = conn.execute(
        "SELECT normalized_image_url, sample_image_url FROM template_pages WHERE id = ?",
        (template_page_id,),
    ).fetchone()
    if row is None:
        return None
    return row["normalized_image_url"] or row["sample_image_url"]


def _upsert_image_anchor_embedding(conn: sqlite3.Connection, template_id: str, field_row: sqlite3.Row) -> None:
    item = _template_field_row_to_api(field_row)
    if not item["use_for_verification"] or item["data_type"] != "image":
        conn.execute("DELETE FROM verification_anchor_embeddings WHERE anchor_id = ?", (item["id"],))
        return

    source = _template_page_image_source(conn, item["template_page_id"])
    if not source:
        return
    crop_path = _storage_root() / "verification_anchor_crops" / template_id / f"{item['id']}.png"
    cropped = _crop_anchor_roi(source, item["roi"], crop_path, item.get("roi_padding") or 6)
    if not cropped:
        return
    result = encode_images([cropped])
    embedding_id = f"anchor_emb_{item['id']}"
    conn.execute(
        """
        INSERT INTO verification_anchor_embeddings (
            id, template_id, anchor_id, embedding_json, model_version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            embedding_json = excluded.embedding_json,
            model_version = excluded.model_version,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            embedding_id,
            template_id,
            item["id"],
            json.dumps(result.vector),
            result.version,
        ),
    )


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


class ImageEncoderService:
    def encode_page(self, page_id: str) -> Dict[str, Any]:
        return {"page_id": page_id, "status": "embedding_pending", "embedding": None}


class QdrantService:
    def upsert_template_page_point(self, template_id: str, page_id: str) -> Dict[str, Any]:
        return {
            "template_id": template_id,
            "template_page_id": page_id,
            "qdrant_point_id": _stub_id("qdrant_point"),
            "status": "stubbed",
        }


class EmbeddingService:
    def __init__(self) -> None:
        self.encoder = ImageEncoderService()
        self.qdrant = QdrantService()

    def _fetch_template_or_404(self, conn: sqlite3.Connection, template_id: str) -> sqlite3.Row:
        template_row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
        if template_row is None:
            raise HTTPException(status_code=404, detail="Template not found")
        return template_row

    def _job_with_template(self, conn: sqlite3.Connection, job_id: str) -> Dict[str, Any]:
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
            generated_pages = _refresh_template_layout_signatures(conn, template_id)
            if not generated_pages or any(item.get("status") != "generated" for item in generated_pages):
                failed_pages = [item for item in generated_pages if item.get("status") != "generated"]
                raise HTTPException(
                    status_code=409,
                    detail=f"Layout signature generation failed: {failed_pages or 'no template pages'}",
                )
            metadata = {
                "engine": "layout_signature",
                "version": "layout-signature-v1",
                "template_id": template_id,
                "page_count": len(generated_pages),
                "layout_signature_pages": generated_pages,
                "global_vector_store": "disabled",
                "qdrant_used_for_global_retrieval": False,
                "image_anchor_embeddings": "dinov2_optional",
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
                generated_pages = _refresh_template_layout_signatures(conn, template_id)
                if not generated_pages or any(item.get("status") != "generated" for item in generated_pages):
                    failed_pages = [item for item in generated_pages if item.get("status") != "generated"]
                    raise RuntimeError(f"Layout signature generation failed: {failed_pages or 'no template pages'}")
                conn.commit()
            metadata = {
                "engine": "layout_signature",
                "version": "layout-signature-v1",
                "template_id": template_id,
                "page_count": len(generated_pages),
                "layout_signature_pages": generated_pages,
                "global_vector_store": "disabled",
                "qdrant_used_for_global_retrieval": False,
                "image_anchor_embeddings": "dinov2_optional",
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
        return {
            **self.qdrant.upsert_template_page_point(template_id, page_id),
            "status": "embedding_generation_stubbed",
            "scope": "template_page",
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
            "ocr_confidence": round(float(ocr_confidence or 0.0), 4),
            "field_score": field_score,
            "verification_threshold": round(float(threshold), 4),
            "score": field_score,
            "passed": passed,
            "failure_reason": failure_reason,
        }

    def _load_anchor_embedding(self, anchor_id: str) -> Optional[List[float]]:
        with _connect() as conn:
            row = conn.execute(
                "SELECT embedding_json FROM verification_anchor_embeddings WHERE anchor_id = ? ORDER BY updated_at DESC LIMIT 1",
                (anchor_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            values = json.loads(row["embedding_json"])
        except (TypeError, json.JSONDecodeError):
            return None
        if not isinstance(values, list):
            return None
        return [float(value) for value in values if isinstance(value, (int, float))]

    def _score_image_anchor(self, field: Dict[str, Any], image_path: str) -> Dict[str, Any]:
        expected_vector = self._load_anchor_embedding(field["id"])
        reference_crop_path = _storage_root() / "verification_anchor_crops" / field["template_id"] / f"{field['id']}.png"
        if not expected_vector:
            return {
                "score": 0.0,
                "passed": False,
                "failure_reason": "anchor_embedding_missing",
                "embedding_id": None,
                "reference_crop_preview_data_url": _image_path_to_data_url(str(reference_crop_path)),
                "current_crop_preview_data_url": None,
            }

        crop_path = _storage_root() / "verification_query_anchor_crops" / field["template_id"] / f"{field['id']}_{uuid4().hex[:8]}.png"
        cropped = _crop_anchor_roi(image_path, field["roi"], crop_path, field.get("roi_padding") or 6)
        if not cropped:
            return {
                "score": 0.0,
                "passed": False,
                "failure_reason": "roi_crop_failed",
                "embedding_id": f"anchor_emb_{field['id']}",
                "reference_crop_preview_data_url": _image_path_to_data_url(str(reference_crop_path)),
                "current_crop_preview_data_url": None,
            }

        result = encode_images([cropped])
        score = round(float(_cosine_similarity(result.vector, expected_vector)), 4)
        return {
            "score": score,
            "passed": score >= 0.75,
            "failure_reason": "passed" if score >= 0.75 else "below_threshold",
            "embedding_id": f"anchor_emb_{field['id']}",
            "model_version": result.version,
            "dino_similarity_score": score,
            "reference_crop_preview_data_url": _image_path_to_data_url(str(reference_crop_path)),
            "current_crop_preview_data_url": _image_path_to_data_url(cropped),
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

            if anchor_type == "image" and not image_path:
                checked_fields.append(
                    {
                        "field_id": field["id"],
                        "anchor_id": field["id"],
                        "field_name": field["field_name"],
                        "display_label": field["display_label"],
                        "anchor_type": "image",
                        "verification_method": "image_feature",
                        "page_number": page_number,
                        "expected_text": None,
                        "actual_text": "",
                        "normalized_expected": "",
                        "normalized_actual": "",
                        "text_similarity_score": None,
                        "ocr_confidence": None,
                        "field_score": 0.0,
                        "verification_threshold": 0.75,
                        "match_type": "image_feature",
                        "required": bool(field["required_for_verification"]),
                        "passed": False,
                        "score": 0.0,
                        "failure_reason": "query_page_missing",
                        "roi": field["roi"],
                        "roi_padding": field.get("roi_padding") or 6,
                        "weight": float(field.get("verification_weight") or 1.0),
                        "embedding_id": f"anchor_emb_{field['id']}",
                        "reference_crop_preview_data_url": None,
                        "current_crop_preview_data_url": None,
                        "dino_similarity_score": 0.0,
                        "error": f"No query page image available for page {page_number}",
                    }
                )
                continue

            if anchor_type == "image" and image_path:
                image_match = self._score_image_anchor(field, image_path)
                checked_fields.append(
                    {
                        "field_id": field["id"],
                        "anchor_id": field["id"],
                        "field_name": field["field_name"],
                        "display_label": field["display_label"],
                        "anchor_type": "image",
                        "verification_method": "image_feature",
                        "page_number": page_number,
                        "expected_text": None,
                        "actual_text": "",
                        "normalized_expected": "",
                        "normalized_actual": "",
                        "text_similarity_score": None,
                        "ocr_confidence": None,
                        "field_score": image_match["score"],
                        "verification_threshold": 0.75,
                        "match_type": "image_feature",
                        "required": bool(field["required_for_verification"]),
                        "passed": image_match["passed"],
                        "score": image_match["score"],
                        "failure_reason": image_match["failure_reason"],
                        "roi": field["roi"],
                        "roi_padding": field.get("roi_padding") or 6,
                        "weight": float(field.get("verification_weight") or 1.0),
                        "embedding_id": image_match.get("embedding_id"),
                        "reference_crop_preview_data_url": image_match.get("reference_crop_preview_data_url"),
                        "current_crop_preview_data_url": image_match.get("current_crop_preview_data_url"),
                        "dino_similarity_score": image_match.get("dino_similarity_score", image_match["score"]),
                        "model_version": image_match.get("model_version"),
                        "error": None,
                    }
                )
                continue

            if image_path:
                try:
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
    DEFAULT_FINAL_CONFIDENCE_THRESHOLD = 0.8
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
        final_passed = final_score >= final_confidence_threshold
        decision_path = "final_threshold_passed" if final_passed else "final_threshold_failed"

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
        source_pages = payload.pages or [
            {
                "page_number": 1,
                "original_image_url": payload.sample_file_url,
                "normalized_image_url": payload.sample_file_url,
            }
        ]

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
                conn.execute(
                    """
                    INSERT INTO template_request_pages (
                        id, template_request_id, page_number, sample_image_url,
                        image_source, review_status, is_canonical, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, 'user_request', 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (_stub_id("tpl_req_page"), request_id, page_number, sample_image_url),
                )

            conn.commit()

        return self.get(request_id)

    def list(self) -> Dict[str, Any]:
        with _connect() as conn:
            request_rows = conn.execute(
                "SELECT * FROM template_requests ORDER BY created_at DESC"
            ).fetchall()

        return {"template_requests": [self.get(row["id"]) for row in request_rows]}

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
        return {"id": request_id, **payload.model_dump(exclude_unset=True), "updated_at": _now()}

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
                    image_source, review_status, is_canonical, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    image_id,
                    request_id,
                    page_number,
                    payload.sample_image_url,
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
            if row["is_canonical"]:
                raise HTTPException(status_code=409, detail="Select another canonical image before removing this one.")

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
        return {"template_count": 0, "pending_request_count": 0, "status": "stubbed"}

    def create_template(self, payload: TemplateCreate) -> Dict[str, Any]:
        template_id = _stub_id("tpl")
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO templates (
                    id, name, document_type, category, status, version, page_count,
                    similarity_threshold, final_confidence_threshold,
                    layout_weight, text_anchor_weight, image_anchor_weight, created_by,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    payload.name,
                    payload.document_type,
                    payload.category,
                    payload.page_count,
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

    def _align_query_pages_for_candidate(
        self,
        candidate_template: Dict[str, Any],
        query_page_paths: Dict[int, str],
    ) -> Dict[str, Any]:
        template_page_paths = self._template_page_image_paths(candidate_template["id"], candidate_template.get("pages") or [])
        verification_page_paths = dict(query_page_paths)
        alignments: List[Dict[str, Any]] = []

        for page_number, query_path in query_page_paths.items():
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
    ) -> Dict[str, Any]:
        alignment_context = self._align_query_pages_for_candidate(candidate_template, query_page_paths)
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
            if reference_crop and query_crop:
                reference_result = encode_images([reference_crop])
                query_result = encode_images([query_crop])
                score = round(float(_cosine_similarity(query_result.vector, reference_result.vector)), 4)
                checked_fields.append(
                    {
                        **checked,
                        "field_score": score,
                        "score": score,
                        "passed": score >= 0.75,
                        "failure_reason": "passed" if score >= 0.75 else "below_threshold",
                        "embedding_id": f"temp_anchor_emb_{field_id}",
                        "model_version": query_result.version,
                        "dino_similarity_score": score,
                        "temporary_embedding": True,
                        "reference_crop_preview_data_url": _image_path_to_data_url(reference_crop),
                        "current_crop_preview_data_url": _image_path_to_data_url(query_crop),
                        "error": None,
                    }
                )
            else:
                checked_fields.append(
                    {
                        **checked,
                        "field_score": 0.0,
                        "score": 0.0,
                        "passed": False,
                        "failure_reason": "temporary_anchor_crop_failed",
                        "embedding_id": f"temp_anchor_emb_{field_id}",
                        "temporary_embedding": True,
                        "reference_crop_preview_data_url": _image_path_to_data_url(reference_crop),
                        "current_crop_preview_data_url": _image_path_to_data_url(query_crop),
                        "dino_similarity_score": 0.0,
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

        query_page_paths = self._template_page_image_paths(template_id, pages)
        if not query_page_paths:
            raise HTTPException(status_code=409, detail="Unable to prepare template page images for verification simulation")
        query_signature = self._layout_signature_for_page_paths(query_page_paths, 1)

        active_candidates: List[Dict[str, Any]] = []
        seen_template_ids = {template_id}
        for result in search_layout_candidates(query_signature, page_number=1, limit=10, include_template_id=template_id):
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
                "input_count": len(query_page_paths),
                "generated_at": _now(),
                "persisted": False,
                "note": "Temporary layout signature was used only for this pre-publish simulation.",
            },
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
        uploaded_page_paths = _prepare_prepublish_test_pages(test_id, file_bytes)
        query_page_paths = _normalize_prepublish_test_pages(test_id, uploaded_page_paths)
        query_paths = [query_page_paths[key] for key in sorted(query_page_paths)]
        draft_paths = [draft_page_paths[key] for key in sorted(draft_page_paths)]

        query_signature = self._layout_signature_for_page_paths(query_page_paths, 1)
        draft_signature = self._layout_signature_for_page_paths(draft_page_paths, 1)
        draft_global_score = compare_layout_signatures(query_signature, draft_signature)["score"]

        candidates: List[Dict[str, Any]] = []
        seen_template_ids = {template_id}
        for result in search_layout_candidates(query_signature, page_number=1, limit=10, include_template_id=template_id):
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
            candidates.append(candidate)
            if len(candidates) >= 4:
                break

        draft_candidate = self._build_simulation_candidate(draft, draft_global_score, query_page_paths, is_current_draft=True)
        draft_candidate["source"] = "draft"
        draft_candidate["source_label"] = "Draft / Temporary Layout Signature"

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
                "query_page_paths": [str(path) for path in uploaded_page_paths],
                "normalized_query_page_paths": query_paths,
                "draft_global_score": round(draft_global_score, 4),
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
            field_rows = conn.execute("SELECT * FROM template_fields WHERE template_id = ?", (template_id,)).fetchall()
            for field_row in field_rows:
                try:
                    _upsert_image_anchor_embedding(conn, template_id, field_row)
                except Exception:
                    pass
            conn.commit()

        embedding_service = EmbeddingService()
        job_result = embedding_service.create_embedding_job(template_id)
        completed_result = embedding_service.run_job_dev(job_result["job"]["id"])
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
            result = {
                "field_id": field["id"],
                "field_name": field.get("field_name"),
                "display_label": field.get("display_label"),
                "page_number": page_number,
                "extraction_method": extraction_method,
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
                if extraction_method == "extract_image" or data_type == "image":
                    crop_path = _storage_root() / "template_extraction_test_crops" / template_id / f"{field['id']}.png"
                    cropped = _crop_anchor_roi(image_path, field["roi"], crop_path, field.get("roi_padding") or 0)
                    result.update(
                        {
                            "passed": bool(cropped),
                            "status": "passed" if cropped else "failed",
                            "ocr_text": "(image crop)",
                            "confidence": 1.0 if cropped else 0.0,
                            "crop_path": cropped,
                            "failure_reason": None if cropped else "roi_crop_failed",
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
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM template_fields
                WHERE template_id = ?
                  AND use_for_verification = 1
                  AND data_type = 'image'
                """,
                (template_id,),
            ).fetchall()
            for row in rows:
                _upsert_image_anchor_embedding(conn, template_id, row)
            conn.commit()
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
                "verification_anchor_embeddings": conn.execute(
                    "SELECT COUNT(*) AS count FROM verification_anchor_embeddings WHERE template_id = ?",
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
            conn.execute("DELETE FROM verification_anchor_embeddings WHERE template_id = ?", (template_id,))
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
            final_confidence_threshold = template_row["final_confidence_threshold"] if template_row else 0.8
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
                    required_for_verification, extraction_method,
                    anchor_text, regex_pattern, roi_padding, verification_weight, sort_order,
                    created_at, updated_at
                )
                VALUES (
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?, ?,
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
                    payload.anchor_text,
                    payload.regex_pattern,
                    payload.roi_padding if payload.roi_padding is not None else 0,
                    payload.verification_weight if payload.verification_weight is not None else 1.0,
                    payload.sort_order,
                ),
            )
            field_row = conn.execute("SELECT * FROM template_fields WHERE id = ? AND template_id = ?", (field_id, template_id)).fetchone()
            if field_row is not None:
                try:
                    _upsert_image_anchor_embedding(conn, template_id, field_row)
                except Exception:
                    pass
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
            "anchor_text": "anchor_text",
            "regex_pattern": "regex_pattern",
            "roi_padding": "roi_padding",
            "verification_weight": "verification_weight",
            "sort_order": "sort_order",
        }
        for key, column in direct_columns.items():
            if key in patch:
                value = patch[key]
                if key in {"user_selectable", "default_selected", "use_for_verification", "required_for_verification"}:
                    value = int(value)
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
                field_row = conn.execute("SELECT * FROM template_fields WHERE id = ? AND template_id = ?", (field_id, template_id)).fetchone()
                if field_row is not None:
                    try:
                        _upsert_image_anchor_embedding(conn, template_id, field_row)
                    except Exception:
                        pass
                conn.commit()
        return self.get_template(template_id)

    def delete_template_field(self, template_id: str, field_id: str) -> Dict[str, Any]:
        with _connect() as conn:
            conn.execute("DELETE FROM verification_anchor_embeddings WHERE anchor_id = ?", (field_id,))
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
            canonical_pages = [page for page in approved_pages if page["is_canonical"]]
            if len(canonical_pages) != 1:
                raise HTTPException(
                    status_code=409,
                    detail="Select exactly one approved canonical image before converting to a template.",
                )
            canonical_page = canonical_pages[0]

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
                    similarity_threshold, final_confidence_threshold,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, NULL, 'draft', 1, 1, 0.75, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    request_row["request_title"],
                    request_row["document_type"],
                ),
            )

            canonical_signature = _generate_layout_signature_for_source(canonical_page["sample_image_url"])
            canonical_signature_json = signature_to_json(canonical_signature) if canonical_signature else None
            if canonical_signature_json:
                conn.execute(
                    """
                    UPDATE template_request_pages
                    SET layout_signature_json = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (canonical_signature_json, canonical_page["id"]),
                )

            page_id = _stub_id("tpl_page")
            created_template_page_ids[1] = page_id
            conn.execute(
                """
                INSERT INTO template_pages (
                    id, template_id, page_number, page_name, sample_image_url,
                    normalized_image_url, layout_signature_json,
                    similarity_threshold, final_confidence_threshold,
                    created_at, updated_at
                )
                VALUES (?, ?, 1, 'Canonical Page', ?, ?, ?, 0.75, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    page_id,
                    template_id,
                    canonical_page["sample_image_url"],
                    canonical_page["sample_image_url"],
                    canonical_signature_json,
                ),
            )

            layout_reference_count = 0
            for reference_index, page in enumerate(approved_pages, start=1):
                signature = (
                    canonical_signature
                    if page["id"] == canonical_page["id"]
                    else _generate_layout_signature_for_source(page["sample_image_url"])
                )
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
                        page_id if page["id"] == canonical_page["id"] else None,
                        reference_index,
                        page["sample_image_url"],
                        page["image_source"],
                        1 if page["id"] == canonical_page["id"] else 0,
                        signature_json,
                    ),
                )
                layout_reference_count += 1

            canonical_requested_fields = [
                field
                for field in requested_fields
                if field["template_request_page_id"] == canonical_page["id"]
                or field["page_number"] == canonical_page["page_number"]
            ]

            for index, field in enumerate(canonical_requested_fields):
                template_page_id = created_template_page_ids[1]

                conn.execute(
                    """
                    INSERT INTO template_fields (
                        id, template_id, template_page_id, page_number,
                        field_name, display_label,
                        roi_x_ratio, roi_y_ratio, roi_width_ratio, roi_height_ratio,
                        data_type, user_selectable, default_selected,
                        use_for_verification, expected_text, match_type,
                        required_for_verification, extraction_method,
                        anchor_text, regex_pattern, roi_padding, sort_order,
                        created_at, updated_at
                    )
                    VALUES (
                        ?, ?, ?, ?,
                        ?, ?,
                        ?, ?, ?, ?,
                        ?, 1, 1,
                        0, NULL, NULL,
                        0, ?,
                        NULL, NULL, 0, ?,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    )
                    """,
                    (
                        _stub_id("tpl_field"),
                        template_id,
                        template_page_id,
                        1,
                        field["field_name"],
                        field["display_label"],
                        field["roi_x_ratio"],
                        field["roi_y_ratio"],
                        field["roi_width_ratio"],
                        field["roi_height_ratio"],
                        _normalize_data_type(field["data_type"]),
                        _normalize_extraction_method(field["extraction_method"]),
                        index + 1,
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
                "template_fields": len(canonical_requested_fields),
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
