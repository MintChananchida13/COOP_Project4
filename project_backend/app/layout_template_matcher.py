import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from .db import connect as connect_db
from .layout_signature_service import compare_layout_signatures, signature_from_json


def _connect() -> Any:
    conn = connect_db()
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_layout_signature_column(conn)
    _ensure_template_matching_weight_columns(conn)
    return conn


def _ensure_layout_signature_column(conn: Any) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(template_pages)").fetchall()}
    if columns and "layout_signature_json" not in columns:
        conn.execute("ALTER TABLE template_pages ADD COLUMN layout_signature_json TEXT")
        conn.commit()


def _ensure_template_matching_weight_columns(conn: Any) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(templates)").fetchall()}
    if columns and "layout_weight" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN layout_weight REAL DEFAULT 0.50")
    if columns and "text_anchor_weight" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN text_anchor_weight REAL DEFAULT 0.35")
    if columns and "image_anchor_weight" not in columns:
        conn.execute("ALTER TABLE templates ADD COLUMN image_anchor_weight REAL DEFAULT 0.15")
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
                t.layout_weight AS layout_weight,
                t.text_anchor_weight AS text_anchor_weight,
                t.image_anchor_weight AS image_anchor_weight,
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
            "layout_weight": row["layout_weight"],
            "text_anchor_weight": row["text_anchor_weight"],
            "image_anchor_weight": row["image_anchor_weight"],
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
