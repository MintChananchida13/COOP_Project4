import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


_POSTGRES_READY = False


def _database_url() -> str:
    return os.getenv("DATABASE_URL", "").strip().strip('"')


def is_postgres_enabled() -> bool:
    database_url = _database_url().lower()
    return database_url.startswith("postgresql://") or database_url.startswith("postgres://")


def sqlite_db_path() -> Path:
    database_url = _database_url()
    if database_url.startswith("file:"):
        raw_path = database_url.replace("file:", "", 1).strip('"')
        candidate = Path(raw_path)
        if candidate.is_absolute():
            return candidate
        cwd_candidate = Path.cwd() / candidate
        if cwd_candidate.exists():
            return cwd_candidate

    return Path(__file__).resolve().parents[2] / "project_frontend" / "prisma" / "dev.db"


class StaticCursor:
    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None):
        self._rows = rows or []

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> List[Dict[str, Any]]:
        return self._rows


class PostgresConnection:
    def __init__(self, raw_conn: Any):
        self._raw_conn = raw_conn

    def __enter__(self) -> "PostgresConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        self.close()

    def execute(self, sql: str, params: Sequence[Any] = ()) -> Any:
        normalized = sql.strip()
        lowered = normalized.lower()
        if lowered.startswith("pragma foreign_keys"):
            return StaticCursor()
        if lowered.startswith("pragma table_info"):
            return self._table_info(normalized)

        translated_sql = _translate_sql(normalized)
        cursor = self._raw_conn.cursor()
        cursor.execute(translated_sql, tuple(params or ()))
        return cursor

    def commit(self) -> None:
        self._raw_conn.commit()

    def rollback(self) -> None:
        self._raw_conn.rollback()

    def close(self) -> None:
        self._raw_conn.close()

    def _table_info(self, sql: str) -> StaticCursor:
        match = re.search(r"pragma\s+table_info\((?:\"|')?([^\"')]+)(?:\"|')?\)", sql, re.IGNORECASE)
        table_name = match.group(1) if match else ""
        cursor = self._raw_conn.cursor()
        cursor.execute(
            """
            SELECT column_name AS name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
            ORDER BY ordinal_position
            """,
            (table_name,),
        )
        return StaticCursor([dict(row) for row in cursor.fetchall()])


def _translate_sql(sql: str) -> str:
    sql = sql.replace("DATETIME", "TIMESTAMPTZ")
    sql = sql.replace(" rowid ", " id ")
    sql = sql.replace(", rowid ", ", id ")
    return sql.replace("?", "%s")


def _connect_postgres() -> PostgresConnection:
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError as exc:
        raise RuntimeError(
            "PostgreSQL mode requires psycopg2-binary. Install backend requirements first."
        ) from exc

    conn = psycopg2.connect(_database_url(), cursor_factory=psycopg2.extras.RealDictCursor)
    wrapped = PostgresConnection(conn)
    _ensure_postgres_schema(wrapped)
    return wrapped


def connect() -> Any:
    if is_postgres_enabled():
        return _connect_postgres()

    conn = sqlite3.connect(sqlite_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_postgres_schema(conn: PostgresConnection) -> None:
    global _POSTGRES_READY
    if _POSTGRES_READY:
        return

    for statement in _POSTGRES_SCHEMA:
        conn.execute(statement)
    conn.commit()
    _POSTGRES_READY = True


_POSTGRES_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL UNIQUE,
        "passwordHash" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'USER',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS image_verification_categories (
        value TEXT NOT NULL PRIMARY KEY,
        label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        match_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.70,
        margin_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.05,
        evidence_temperature DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS templates (
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        document_type TEXT,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        page_count INTEGER NOT NULL DEFAULT 1,
        similarity_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.75,
        final_confidence_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.8,
        layout_weight DOUBLE PRECISION NOT NULL DEFAULT 0.50,
        text_anchor_weight DOUBLE PRECISION NOT NULL DEFAULT 0.35,
        image_anchor_weight DOUBLE PRECISION NOT NULL DEFAULT 0.15,
        created_by TEXT,
        approved_by TEXT,
        rejection_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS template_pages (
        id TEXT NOT NULL PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        page_name TEXT,
        sample_image_url TEXT,
        normalized_image_url TEXT,
        layout_signature_json TEXT,
        similarity_threshold DOUBLE PRECISION,
        final_confidence_threshold DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS template_fields (
        id TEXT NOT NULL PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        template_page_id TEXT NOT NULL REFERENCES template_pages(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        display_label TEXT NOT NULL,
        roi_x_ratio DOUBLE PRECISION NOT NULL,
        roi_y_ratio DOUBLE PRECISION NOT NULL,
        roi_width_ratio DOUBLE PRECISION NOT NULL,
        roi_height_ratio DOUBLE PRECISION NOT NULL,
        data_type TEXT,
        user_selectable INTEGER NOT NULL DEFAULT 1,
        default_selected INTEGER NOT NULL DEFAULT 0,
        use_for_verification INTEGER NOT NULL DEFAULT 0,
        expected_text TEXT,
        match_type TEXT,
        required_for_verification INTEGER NOT NULL DEFAULT 0,
        extraction_method TEXT NOT NULL DEFAULT 'fixed_roi',
        anchor_text TEXT,
        regex_pattern TEXT,
        roi_padding DOUBLE PRECISION,
        sort_order INTEGER NOT NULL DEFAULT 0,
        verification_weight DOUBLE PRECISION DEFAULT 1.0,
        image_category TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT template_fields_roi_ratio_check CHECK (
            roi_x_ratio >= 0 AND roi_x_ratio <= 1 AND
            roi_y_ratio >= 0 AND roi_y_ratio <= 1 AND
            roi_width_ratio > 0 AND roi_width_ratio <= 1 AND
            roi_height_ratio > 0 AND roi_height_ratio <= 1
        )
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ignore_regions (
        id TEXT NOT NULL PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        template_page_id TEXT NOT NULL REFERENCES template_pages(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        roi_x_ratio DOUBLE PRECISION NOT NULL,
        roi_y_ratio DOUBLE PRECISION NOT NULL,
        roi_width_ratio DOUBLE PRECISION NOT NULL,
        roi_height_ratio DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT ignore_regions_roi_ratio_check CHECK (
            roi_x_ratio >= 0 AND roi_x_ratio <= 1 AND
            roi_y_ratio >= 0 AND roi_y_ratio <= 1 AND
            roi_width_ratio > 0 AND roi_width_ratio <= 1 AND
            roi_height_ratio > 0 AND roi_height_ratio <= 1
        )
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS template_requests (
        id TEXT NOT NULL PRIMARY KEY,
        requested_by TEXT,
        request_title TEXT NOT NULL,
        document_type TEXT,
        sample_file_url TEXT,
        request_mode TEXT NOT NULL DEFAULT 'image_only',
        status TEXT NOT NULL DEFAULT 'draft',
        user_note TEXT,
        admin_note TEXT,
        converted_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
        page_count INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS template_request_pages (
        id TEXT NOT NULL PRIMARY KEY,
        template_request_id TEXT NOT NULL REFERENCES template_requests(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        sample_image_url TEXT,
        image_source TEXT NOT NULL DEFAULT 'user_request',
        review_status TEXT NOT NULL DEFAULT 'pending',
        is_canonical INTEGER NOT NULL DEFAULT 0,
        layout_signature_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS template_layout_references (
        id TEXT NOT NULL PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        template_page_id TEXT REFERENCES template_pages(id) ON DELETE SET NULL,
        page_number INTEGER NOT NULL DEFAULT 1,
        image_url TEXT NOT NULL,
        image_source TEXT NOT NULL DEFAULT 'user_request',
        review_status TEXT NOT NULL DEFAULT 'approved',
        is_canonical INTEGER NOT NULL DEFAULT 0,
        layout_signature_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS requested_fields (
        id TEXT NOT NULL PRIMARY KEY,
        template_request_id TEXT NOT NULL REFERENCES template_requests(id) ON DELETE CASCADE,
        template_request_page_id TEXT NOT NULL REFERENCES template_request_pages(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        display_label TEXT NOT NULL,
        roi_x_ratio DOUBLE PRECISION NOT NULL,
        roi_y_ratio DOUBLE PRECISION NOT NULL,
        roi_width_ratio DOUBLE PRECISION NOT NULL,
        roi_height_ratio DOUBLE PRECISION NOT NULL,
        data_type TEXT DEFAULT 'text',
        extraction_method TEXT NOT NULL DEFAULT 'ocr_text',
        user_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT requested_fields_roi_ratio_check CHECK (
            roi_x_ratio >= 0 AND roi_x_ratio <= 1 AND
            roi_y_ratio >= 0 AND roi_y_ratio <= 1 AND
            roi_width_ratio > 0 AND roi_width_ratio <= 1 AND
            roi_height_ratio > 0 AND roi_height_ratio <= 1
        )
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS documents (
        id TEXT NOT NULL PRIMARY KEY,
        uploaded_by TEXT,
        original_file_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploaded',
        page_count INTEGER NOT NULL DEFAULT 1,
        detected_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
        confidence_score DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS document_pages (
        id TEXT NOT NULL PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        original_image_url TEXT,
        normalized_image_url TEXT,
        status TEXT NOT NULL DEFAULT 'uploaded',
        detected_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
        detected_template_page_id TEXT REFERENCES template_pages(id) ON DELETE SET NULL,
        confidence_score DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS extraction_results (
        id TEXT NOT NULL PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        document_page_id TEXT NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        template_field_id TEXT REFERENCES template_fields(id) ON DELETE SET NULL,
        field_name TEXT NOT NULL,
        display_label TEXT NOT NULL,
        ocr_text TEXT,
        ocr_confidence DOUBLE PRECISION,
        roi_preview_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS detection_logs (
        id TEXT NOT NULL PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        document_page_id TEXT NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        candidate_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
        candidate_template_page_id TEXT REFERENCES template_pages(id) ON DELETE SET NULL,
        layout_score DOUBLE PRECISION,
        verification_score DOUBLE PRECISION,
        final_score DOUBLE PRECISION,
        decision TEXT NOT NULL,
        fail_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS embedding_jobs (
        id TEXT NOT NULL PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT,
        vector_id TEXT,
        metadata_json TEXT
    )
    """,
    'CREATE UNIQUE INDEX IF NOT EXISTS template_pages_template_id_page_number_key ON template_pages(template_id, page_number)',
    'CREATE INDEX IF NOT EXISTS template_fields_template_page_id_page_number_idx ON template_fields(template_page_id, page_number)',
    'CREATE INDEX IF NOT EXISTS ignore_regions_template_page_id_page_number_idx ON ignore_regions(template_page_id, page_number)',
    'CREATE UNIQUE INDEX IF NOT EXISTS template_request_pages_template_request_id_page_number_key ON template_request_pages(template_request_id, page_number)',
    'CREATE INDEX IF NOT EXISTS requested_fields_template_request_page_id_page_number_idx ON requested_fields(template_request_page_id, page_number)',
    'CREATE INDEX IF NOT EXISTS template_layout_references_template_id_idx ON template_layout_references(template_id)',
    'CREATE INDEX IF NOT EXISTS template_layout_references_template_status_idx ON template_layout_references(template_id, review_status, is_canonical)',
    'CREATE UNIQUE INDEX IF NOT EXISTS document_pages_document_id_page_number_key ON document_pages(document_id, page_number)',
    'CREATE INDEX IF NOT EXISTS extraction_results_document_page_id_page_number_idx ON extraction_results(document_page_id, page_number)',
    'CREATE INDEX IF NOT EXISTS detection_logs_document_page_id_page_number_idx ON detection_logs(document_page_id, page_number)',
    'CREATE INDEX IF NOT EXISTS embedding_jobs_template_id_requested_at_idx ON embedding_jobs(template_id, requested_at)',
]
