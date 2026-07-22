"""
Development cleanup for removed Admin Template Management.

This script deletes old template data and local template artifacts used by
removed development implementations.
"""

import shutil
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DB = ROOT / "project_frontend" / "prisma" / "dev.db"
BACKEND_CROPS_DIR = ROOT / "project_backend" / "cropped_rois"
FRONTEND_CROPS_DIR = ROOT / "project_frontend" / "cropped_rois"
POSTGRES_CLEANUP_SQL = ROOT / "project_backend" / "cleanup_template_management.sql"
POSTGRES_DSN = "dbname=project4_db user=postgres password=1234 host=localhost port=5432"

TABLES = [
    "RoiField",
    "Request",
    "templates",
    "verification_fields",
    "extraction_fields",
    "keywords",
    "roi_definitions",
    "template_embeddings",
    "template_requests",
    "template_reviews",
    "template_configurations",
]


def drop_sqlite_tables(db_path: Path) -> None:
    if not db_path.exists():
        print(f"SQLite database not found: {db_path}")
        return

    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        has_sequence = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
        ).fetchone()
        for table in TABLES:
            conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            if has_sequence:
                conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))
        conn.execute("PRAGMA foreign_keys = ON")
        conn.commit()
    print(f"Removed old template tables from {db_path}")


def remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
        print(f"Removed directory: {path}")
    elif path.exists():
        path.unlink()
        print(f"Removed file: {path}")


def run_postgres_cleanup() -> None:
    if not POSTGRES_CLEANUP_SQL.exists():
        return

    try:
        import psycopg2
    except ImportError:
        print("psycopg2 is not available; skipped PostgreSQL cleanup.")
        return

    try:
        with psycopg2.connect(POSTGRES_DSN) as conn:
            with conn.cursor() as cur:
                cur.execute(POSTGRES_CLEANUP_SQL.read_text(encoding="utf-8"))
            conn.commit()
        print("Removed old template tables from PostgreSQL project4_db")
    except Exception as err:
        print(f"Skipped PostgreSQL cleanup: {err}")


def main() -> None:
    drop_sqlite_tables(FRONTEND_DB)
    remove_path(BACKEND_CROPS_DIR)
    remove_path(FRONTEND_CROPS_DIR)
    run_postgres_cleanup()


if __name__ == "__main__":
    main()
