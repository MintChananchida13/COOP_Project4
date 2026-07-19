import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from .layout_signature_service import compare_layout_signatures, signature_from_json


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
    _ensure_layout_signature_column(conn)
    return conn


def _ensure_layout_signature_column(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(template_pages)").fetchall()}
    if columns and "layout_signature_json" not in columns:
        conn.execute("ALTER TABLE template_pages ADD COLUMN layout_signature_json TEXT")
        conn.commit()


def search_layout_candidates(
    query_signature: Dict[str, Any],
    page_number: int = 1,
    limit: int = 5,
    include_template_id: Optional[str] = None,
    active_only: bool = True,
) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT
                t.id AS template_id,
                t.name AS template_name,
                t.status AS template_status,
                t.page_count AS page_count,
                t.final_confidence_threshold AS final_confidence_threshold,
                tp.id AS template_page_id,
                tp.page_number AS page_number,
                tp.layout_signature_json AS layout_signature_json
            FROM template_pages tp
            JOIN templates t ON t.id = tp.template_id
            WHERE tp.layout_signature_json IS NOT NULL
              AND tp.page_number = ?
            ORDER BY t.updated_at DESC, tp.page_number ASC
            """,
            (page_number,),
        ).fetchall()

    candidates: List[Dict[str, Any]] = []
    for row in rows:
        template_id = row["template_id"]
        if active_only and row["template_status"] != "active" and template_id != include_template_id:
            continue
        signature = signature_from_json(row["layout_signature_json"])
        if not signature:
            continue
        similarity = compare_layout_signatures(query_signature, signature)
        metadata = {
            "template_id": template_id,
            "template_name": row["template_name"],
            "template_status": row["template_status"],
            "page_count": row["page_count"],
            "template_page_id": row["template_page_id"],
            "page_number": row["page_number"],
            "final_confidence_threshold": row["final_confidence_threshold"],
            "retrieval_engine": "layout_signature",
            "vector_store_engine": "layout-signature",
            "layout_signature_version": signature.get("version"),
            "layout_debug": similarity,
        }
        candidates.append(
            {
                "vector_id": f"layout_{template_id}_p{row['page_number']}",
                "score": similarity["score"],
                "metadata": metadata,
                "layout_score": similarity["score"],
                "layout_debug": similarity,
            }
        )

    return sorted(candidates, key=lambda item: item["score"], reverse=True)[:limit]
