"""
Migrate existing local SQLite data into PostgreSQL.

This script is intentionally idempotent:
- It creates the PostgreSQL schema through app.db before copying.
- It copies only columns that exist in both source and target.
- It upserts records by primary key id, so it can be run more than once.

Usage:
    $env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
    python migrate_sqlite_to_postgres.py
"""

from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

from app.db import connect as connect_target_db
from app.db import is_postgres_enabled


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SQLITE_PATH = ROOT / "project_frontend" / "prisma" / "dev.db"

TABLE_ORDER = [
    "User",
    "templates",
    "template_pages",
    "template_fields",
    "ignore_regions",
    "template_requests",
    "template_request_pages",
    "requested_fields",
    "documents",
    "document_pages",
    "extraction_results",
    "detection_logs",
    "embedding_jobs",
    "verification_anchor_embeddings",
]


def _quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _source_table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _source_columns(conn: sqlite3.Connection, table_name: str) -> List[str]:
    return [row["name"] for row in conn.execute(f"PRAGMA table_info({_quote_ident(table_name)})").fetchall()]


def _target_columns(conn: Any, table_name: str) -> List[str]:
    rows = conn.execute(
        """
        SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
        ORDER BY ordinal_position
        """,
        (table_name,),
    ).fetchall()
    return [row["name"] for row in rows]


def _rows(conn: sqlite3.Connection, table_name: str, columns: Sequence[str]) -> List[Dict[str, Any]]:
    column_sql = ", ".join(_quote_ident(column) for column in columns)
    return [dict(row) for row in conn.execute(f"SELECT {column_sql} FROM {_quote_ident(table_name)}").fetchall()]


def _upsert_rows(conn: Any, table_name: str, columns: Sequence[str], rows: Iterable[Dict[str, Any]]) -> int:
    row_list = list(rows)
    if not row_list:
        return 0

    quoted_table = _quote_ident(table_name)
    quoted_columns = ", ".join(_quote_ident(column) for column in columns)
    placeholders = ", ".join(["?"] * len(columns))
    update_columns = [column for column in columns if column != "id"]
    if update_columns:
        update_sql = ", ".join(
            f"{_quote_ident(column)} = EXCLUDED.{_quote_ident(column)}" for column in update_columns
        )
        conflict_sql = f"DO UPDATE SET {update_sql}"
    else:
        conflict_sql = "DO NOTHING"

    sql = (
        f"INSERT INTO {quoted_table} ({quoted_columns}) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT ({_quote_ident('id')}) {conflict_sql}"
    )
    for row in row_list:
        conn.execute(sql, tuple(row.get(column) for column in columns))
    return len(row_list)


def migrate(sqlite_path: Path, dry_run: bool = False) -> Dict[str, int]:
    if not sqlite_path.exists():
        raise FileNotFoundError(f"SQLite database not found: {sqlite_path}")
    if not is_postgres_enabled():
        raise RuntimeError("Set DATABASE_URL to a postgresql:// URL before running migration.")

    migrated_counts: Dict[str, int] = {}
    source = sqlite3.connect(sqlite_path)
    source.row_factory = sqlite3.Row
    target = connect_target_db()
    try:
        for table_name in TABLE_ORDER:
            if not _source_table_exists(source, table_name):
                migrated_counts[table_name] = 0
                continue

            source_columns = _source_columns(source, table_name)
            target_columns = _target_columns(target, table_name)
            columns = [column for column in source_columns if column in target_columns]
            if "id" not in columns:
                migrated_counts[table_name] = 0
                continue

            rows = _rows(source, table_name, columns)
            if dry_run:
                migrated_counts[table_name] = len(rows)
                continue

            migrated_counts[table_name] = _upsert_rows(target, table_name, columns, rows)

        if dry_run:
            target.rollback()
        else:
            target.commit()
    except Exception:
        target.rollback()
        raise
    finally:
        target.close()
        source.close()

    return migrated_counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate OCR Studio SQLite data to PostgreSQL.")
    parser.add_argument(
        "--sqlite",
        default=str(DEFAULT_SQLITE_PATH),
        help="Path to the source SQLite database. Defaults to project_frontend/prisma/dev.db.",
    )
    parser.add_argument(
        "--postgres",
        default=os.getenv("DATABASE_URL", ""),
        help="Target PostgreSQL DATABASE_URL. Defaults to current DATABASE_URL env.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Count source rows without writing to PostgreSQL.")
    args = parser.parse_args()

    if args.postgres:
        os.environ["DATABASE_URL"] = args.postgres

    counts = migrate(Path(args.sqlite), dry_run=args.dry_run)
    action = "Would migrate" if args.dry_run else "Migrated"
    for table_name, count in counts.items():
        print(f"{action} {count:>5} rows: {table_name}")


if __name__ == "__main__":
    main()
