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

from .embedding_service import (
    EmbeddingContextError,
    embedding_result_to_json,
    generate_template_embedding,
)
from .image_normalization import ImageNormalizationService
from .ocr_adapter import OcrUnavailableError, ocr_roi
from .vector_store_adapter import search_similar_templates
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
    TemplateRequestUpdate,
    TemplateTestRequest,
    TemplateUpdate,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stub_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def _normalize_extraction_method(value: Optional[str]) -> str:
    if value in {"ocr_text", "ocr_table", "extract_image"}:
        return value
    return "ocr_text"


def _normalize_data_type(value: Optional[str]) -> str:
    if value in {"text", "number", "date", "table", "image", "string", "address", "currency"}:
        return "text" if value == "string" else value
    return "text"


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
    _ensure_requested_field_metadata_columns(conn)
    _ensure_template_field_verification_columns(conn)
    _ensure_embedding_jobs_table(conn)
    _ensure_verification_anchor_embeddings_table(conn)
    return conn


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


def _ensure_template_field_verification_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(template_fields)").fetchall()
    }
    if columns and "verification_weight" not in columns:
        conn.execute("ALTER TABLE template_fields ADD COLUMN verification_weight REAL DEFAULT 1.0")
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
        "rejection_reason": item["rejection_reason"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _template_page_row_to_api(row: sqlite3.Row) -> Dict[str, Any]:
    item = _row_to_dict(row)
    return {
        "id": item["id"],
        "template_id": item["template_id"],
        "page_number": item["page_number"],
        "page_name": item["page_name"],
        "sample_image_url": item["sample_image_url"],
        "normalized_image_url": item["normalized_image_url"],
        "qdrant_point_id": item["qdrant_point_id"],
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
                (job_id, template_id, '{"source":"admin_template_test","mode":"stub"}'),
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
                ORDER BY requested_at DESC, rowid DESC
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
            conn.execute(
                """
                UPDATE embedding_jobs
                SET status = 'completed',
                    completed_at = CURRENT_TIMESTAMP,
                    error_message = NULL,
                    vector_id = ?
                WHERE id = ?
                """,
                (f"vec_{template_id}", job_id),
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
            result = generate_template_embedding(template_id)
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
                (result.vector_id, embedding_result_to_json(result), job_id),
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
        return {
            "template_id": template_id,
            "status": "embedding_generation_stubbed",
            "scope": "template",
            "pages": [],
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
                text_similarity_score = max(base_similarity, 0.90)
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
                    ocr_result = ocr_roi(image_path, field["roi"])
                    actual_text = str(ocr_result.get("text") or "")
                    ocr_confidence = float(ocr_result.get("confidence") or 0.0)
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
            field.get("error") and ("EasyOCR" in field["error"] or "OCR verification requires" in field["error"])
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


class DecisionService:
    MIN_RETRIEVAL_SCORE = 0.50
    HIGH_RETRIEVAL_SCORE = 0.95
    STRONG_VERIFICATION_SCORE = 0.75
    DEFAULT_FINAL_CONFIDENCE_THRESHOLD = 0.8

    def final_confidence_threshold(self, template: Optional[Dict[str, Any]], metadata: Dict[str, Any]) -> float:
        raw_threshold = template.get("final_confidence_threshold") if template else metadata.get("final_confidence_threshold")
        try:
            threshold = float(raw_threshold)
        except (TypeError, ValueError):
            threshold = self.DEFAULT_FINAL_CONFIDENCE_THRESHOLD
        if threshold <= 0 or threshold > 1:
            return self.DEFAULT_FINAL_CONFIDENCE_THRESHOLD
        return threshold

    def decide_candidate(
        self,
        retrieval_score: float,
        verification: Dict[str, Any],
        final_confidence_threshold: float,
    ) -> Dict[str, Any]:
        retrieval_score = round(float(retrieval_score), 4)
        verification_score = round(float(verification.get("score", 0.0) or 0.0), 4)
        text_anchor_score = round(float(verification.get("text_anchor_score", verification_score) or 0.0), 4)
        image_anchor_score = round(float(verification.get("image_anchor_score", 1.0) or 0.0), 4)
        verification_passed = bool(verification.get("passed"))
        required_passed = bool(verification.get("required_passed", verification_passed))
        verification_status = verification.get("status")
        final_score = round((retrieval_score * 0.60) + (text_anchor_score * 0.25) + (image_anchor_score * 0.15), 4)
        final_passed = False

        if verification_status == "ocr_unavailable":
            decision_path = "ocr_unavailable"
        elif not required_passed:
            decision_path = "required_verification_failed"
        elif retrieval_score >= self.HIGH_RETRIEVAL_SCORE and verification_passed:
            final_passed = True
            decision_path = "retrieval_high_pass"
        elif verification_score >= self.STRONG_VERIFICATION_SCORE and retrieval_score >= self.MIN_RETRIEVAL_SCORE:
            final_passed = True
            decision_path = "verification_strong_pass"
        elif retrieval_score < self.MIN_RETRIEVAL_SCORE:
            decision_path = "retrieval_too_low"
        elif verification_status == "no_verification_fields":
            final_passed = retrieval_score >= self.HIGH_RETRIEVAL_SCORE
            decision_path = "retrieval_high_pass" if final_passed else "weighted_confidence_failed"
        else:
            final_passed = final_score >= final_confidence_threshold
            decision_path = "weighted_confidence_passed" if final_passed else "weighted_confidence_failed"

        return {
            "retrieval_score": retrieval_score,
            "verification_score": verification_score,
            "text_anchor_score": text_anchor_score,
            "image_anchor_score": image_anchor_score,
            "verification_passed": verification_passed,
            "final_score": round(float(final_score), 4),
            "final_passed": final_passed,
            "decision_reason": decision_path,
            "decision_path": decision_path,
            "final_confidence_threshold": final_confidence_threshold,
        }


class TemplateRequestService:
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
                    payload.page_count,
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
                        id, template_request_id, page_number, sample_image_url, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
                    similarity_threshold, final_confidence_threshold, created_by,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    payload.name,
                    payload.document_type,
                    payload.category,
                    payload.page_count,
                    payload.similarity_threshold,
                    payload.final_confidence_threshold,
                    payload.created_by,
                ),
            )
            conn.commit()
        return self.get_template(template_id)

    def list_templates(self) -> Dict[str, Any]:
        with _connect() as conn:
            rows = conn.execute("SELECT * FROM templates ORDER BY created_at DESC").fetchall()
        return {"templates": [_template_row_to_api(row) for row in rows]}

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

        return {
            **_template_row_to_api(template_row),
            "pages": [_template_page_row_to_api(row) for row in page_rows],
            "fields": [_template_field_row_to_api(row) for row in field_rows],
            "ignore_regions": [_ignore_region_row_to_api(row) for row in ignore_rows],
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

    def _build_simulation_candidate(
        self,
        candidate_template: Dict[str, Any],
        global_score: float,
        query_page_paths: Dict[int, str],
        is_current_draft: bool = False,
    ) -> Dict[str, Any]:
        verification = VerificationService().verify_template(candidate_template["id"], query_page_paths)
        if is_current_draft:
            verification = self._apply_temporary_draft_image_anchor_scores(candidate_template, verification, query_page_paths)
        threshold = DecisionService().final_confidence_threshold(candidate_template, {})
        decision = DecisionService().decide_candidate(global_score, verification, threshold)
        return {
            "template_id": candidate_template["id"],
            "template_name": candidate_template.get("name"),
            "template_status": candidate_template.get("status"),
            "vector_id": f"temp_vec_{candidate_template['id']}" if is_current_draft else f"vec_{candidate_template['id']}",
            "global_score": round(float(global_score), 4),
            "text_anchor_score": decision["text_anchor_score"],
            "image_anchor_score": decision["image_anchor_score"],
            "verification_score": decision["verification_score"],
            "final_score": decision["final_score"],
            "alignment_status": "skipped",
            "decision": decision["decision_reason"],
            "final_passed": decision["final_passed"],
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
        preview_paths = [query_page_paths[key] for key in sorted(query_page_paths)]
        vision_result = encode_images(preview_paths)

        active_candidates: List[Dict[str, Any]] = []
        seen_template_ids = {template_id}
        for result in search_similar_templates(vision_result.vector, limit=10):
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

        top_score = candidates[0]["final_score"] if candidates else 0.0
        for index, candidate in enumerate(candidates, start=1):
            candidate["rank"] = index
            candidate["score_difference_from_top"] = round(top_score - candidate["final_score"], 4)

        top1 = candidates[0] if candidates else None
        top2 = candidates[1] if len(candidates) > 1 else None
        margin = round((top1["final_score"] if top1 else 0.0) - (top2["final_score"] if top2 else 0.0), 4)
        conflict_candidates = [
            candidate
            for candidate in candidates
            if not candidate.get("is_current_draft") and candidate["final_score"] >= max(0.75, (top1["final_score"] if top1 else 0.0) - 0.08)
        ]
        simulation_passed = bool(top1 and top1.get("is_current_draft") and top1.get("final_passed") and margin >= 0.05)
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
            },
            "temporary_embedding": {
                "status": "generated",
                "engine": vision_result.engine,
                "version": vision_result.version,
                "model_name": vision_result.model_name,
                "embedding_dimension": vision_result.dimension,
                "input_count": vision_result.input_count,
                "generated_at": _now(),
                "persisted": False,
                "note": "Temporary embedding was used only for this pre-publish simulation.",
            },
            "candidates": candidates,
            "verification_anchor_results": draft_candidate.get("verification_details", []),
            "separation_analysis": {
                "top1_score": top1["final_score"] if top1 else 0.0,
                "top2_score": top2["final_score"] if top2 else None,
                "score_margin": margin,
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

        query_embedding = encode_images(query_paths)
        draft_embedding = encode_images(draft_paths)
        draft_global_score = max(0.0, min(1.0, _cosine_similarity(query_embedding.vector, draft_embedding.vector)))

        candidates: List[Dict[str, Any]] = []
        seen_template_ids = {template_id}
        for result in search_similar_templates(query_embedding.vector, limit=10):
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
            candidate["source_label"] = "Published / Qdrant Embedding"
            candidates.append(candidate)
            if len(candidates) >= 4:
                break

        draft_candidate = self._build_simulation_candidate(draft, draft_global_score, query_page_paths, is_current_draft=True)
        draft_candidate["source"] = "draft"
        draft_candidate["source_label"] = "Draft / Temporary Embedding"

        candidates = sorted([draft_candidate, *candidates], key=lambda item: item["final_score"], reverse=True)[:5]
        top_score = candidates[0]["final_score"] if candidates else 0.0
        for index, candidate in enumerate(candidates, start=1):
            candidate["rank"] = index
            candidate["score_difference_from_top"] = round(top_score - candidate["final_score"], 4)

        best = candidates[0] if candidates else None
        draft_rank = next((candidate["rank"] for candidate in candidates if candidate.get("is_current_draft")), None)
        draft_result = next((candidate for candidate in candidates if candidate.get("is_current_draft")), None)
        closest_published = next((candidate for candidate in candidates if not candidate.get("is_current_draft")), None)
        closest_score = float(closest_published.get("final_score") or 0.0) if closest_published else 0.0
        draft_score = float(draft_result.get("final_score") or 0.0) if draft_result else 0.0
        score_margin = round(draft_score - closest_score, 4)
        margin_threshold = 0.05

        if draft_rank == 1 and draft_result and draft_result.get("final_passed") and score_margin >= margin_threshold:
            conflict_level = "ready"
            recommendation = "Draft template ranked first with enough separation."
            test_passed = True
        elif draft_rank == 1 and draft_result and draft_result.get("final_passed"):
            conflict_level = "warning"
            recommendation = "Draft ranked first, but score margin is small. Review similar published templates."
            test_passed = False
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
                "score_margin": score_margin,
                "conflict_level": conflict_level,
                "recommendation": recommendation,
                "separation_threshold": margin_threshold,
            },
            "debug": {
                "temporary_embedding_persisted": False,
                "query_engine": query_embedding.engine,
                "query_model_name": query_embedding.model_name,
                "query_vector_dimension": query_embedding.dimension,
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
            extraction_method = field.get("extraction_method") or "ocr_text"
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
                if extraction_method == "extract_image" or field.get("data_type") == "image":
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
                    normalized_image_url, similarity_threshold, final_confidence_threshold,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    page_id,
                    template_id,
                    payload.page_number,
                    payload.page_name,
                    payload.sample_image_url,
                    payload.normalized_image_url,
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
                VALUES (?, ?, ?, NULL, 'draft', 1, ?, 0.75, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    template_id,
                    request_row["request_title"],
                    request_row["document_type"],
                    request_row["page_count"],
                ),
            )

            if not request_pages:
                page_id = _stub_id("tpl_page")
                created_template_page_ids[1] = page_id
                conn.execute(
                    """
                    INSERT INTO template_pages (
                        id, template_id, page_number, page_name, sample_image_url,
                        normalized_image_url, similarity_threshold, final_confidence_threshold,
                        created_at, updated_at
                    )
                    VALUES (?, ?, 1, 'Page 1', ?, ?, 0.75, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (page_id, template_id, request_row["sample_file_url"], request_row["sample_file_url"]),
                )
            else:
                for page in request_pages:
                    page_id = _stub_id("tpl_page")
                    created_template_page_ids[page["page_number"]] = page_id
                    conn.execute(
                        """
                        INSERT INTO template_pages (
                            id, template_id, page_number, page_name, sample_image_url,
                            normalized_image_url, similarity_threshold, final_confidence_threshold,
                            created_at, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, 0.75, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        """,
                        (
                            page_id,
                            template_id,
                            page["page_number"],
                            f"Page {page['page_number']}",
                            page["sample_image_url"],
                            page["sample_image_url"],
                        ),
                    )

            for index, field in enumerate(requested_fields):
                template_page_id = created_template_page_ids.get(field["page_number"])
                if template_page_id is None:
                    template_page_id = _stub_id("tpl_page")
                    created_template_page_ids[field["page_number"]] = template_page_id
                    conn.execute(
                        """
                        INSERT INTO template_pages (
                            id, template_id, page_number, page_name, sample_image_url,
                            normalized_image_url, similarity_threshold, final_confidence_threshold,
                            created_at, updated_at
                        )
                        VALUES (?, ?, ?, ?, NULL, NULL, 0.75, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        """,
                        (template_page_id, template_id, field["page_number"], f"Page {field['page_number']}"),
                    )

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
                        field["page_number"],
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
                "template_fields": len(requested_fields),
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
