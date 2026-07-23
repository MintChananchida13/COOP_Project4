import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from .db import connect as connect_db
from .layout_signature_service import compare_layout_signatures, signature_from_json


def _connect() -> Any:
    conn = connect_db()
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_layout_signature_column(conn)
    _ensure_template_layout_references_table(conn)
    _ensure_template_matching_weight_columns(conn)
    return conn


def _ensure_layout_signature_column(conn: Any) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(template_pages)").fetchall()}
    if columns and "layout_signature_json" not in columns:
        conn.execute("ALTER TABLE template_pages ADD COLUMN layout_signature_json TEXT")
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
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS template_layout_references_template_id_idx ON template_layout_references(template_id)"
    )
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
        reference_rows = conn.execute(
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
                COALESCE(tlr.template_page_id, tp.id) AS template_page_id,
                tlr.id AS layout_reference_id,
                tlr.page_number AS page_number,
                tlr.image_url AS layout_reference_image_url,
                tlr.image_source AS layout_reference_source,
                tlr.is_canonical AS layout_reference_is_canonical,
                tlr.layout_signature_json AS layout_signature_json
            FROM template_layout_references tlr
            JOIN templates t ON t.id = tlr.template_id
            LEFT JOIN template_pages tp ON tp.template_id = t.id AND tp.page_number = 1
            WHERE tlr.layout_signature_json IS NOT NULL
              AND tlr.review_status = 'approved'
            ORDER BY t.updated_at DESC, tlr.is_canonical DESC, tlr.page_number ASC
            """
        ).fetchall()

        fallback_rows = conn.execute(
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
                NULL AS layout_reference_id,
                tp.page_number AS page_number,
                COALESCE(tp.normalized_image_url, tp.sample_image_url) AS layout_reference_image_url,
                'template_page' AS layout_reference_source,
                1 AS layout_reference_is_canonical,
                tp.layout_signature_json AS layout_signature_json
            FROM template_pages tp
            JOIN templates t ON t.id = tp.template_id
            WHERE tp.layout_signature_json IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM template_layout_references tlr
                  WHERE tlr.template_id = t.id
                    AND tlr.layout_signature_json IS NOT NULL
                    AND tlr.review_status = 'approved'
            )
            ORDER BY t.updated_at DESC, tp.page_number ASC
            """
        ).fetchall()

        rows = [*reference_rows, *fallback_rows]

    best_by_template: Dict[str, Dict[str, Any]] = {}
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
            "matched_layout_reference_id": row["layout_reference_id"],
            "matched_layout_reference_page_number": row["page_number"],
            "page_number": row["page_number"],
            "matched_layout_reference_image_url": row["layout_reference_image_url"],
            "matched_layout_reference_source": row["layout_reference_source"],
            "matched_layout_reference_is_canonical": bool(row["layout_reference_is_canonical"]),
            "final_confidence_threshold": row["final_confidence_threshold"],
            "layout_weight": row["layout_weight"],
            "text_anchor_weight": row["text_anchor_weight"],
            "image_anchor_weight": row["image_anchor_weight"],
            "retrieval_engine": "layout_signature",
            "vector_store_engine": "layout-signature",
            "layout_signature_version": signature.get("version"),
            "layout_debug": similarity,
        }
        candidate = {
            "vector_id": f"layout_{template_id}_{row['layout_reference_id'] or row['page_number']}",
            "score": similarity["score"],
            "metadata": metadata,
            "layout_score": similarity["score"],
            "layout_debug": similarity,
        }
        previous = best_by_template.get(template_id)
        if previous is None or candidate["score"] > previous["score"]:
            best_by_template[template_id] = candidate

    return sorted(best_by_template.values(), key=lambda item: item["score"], reverse=True)[:limit]
