from __future__ import annotations

import hashlib
from pathlib import Path

from .config import REPORT_TYPES
from .database import connect, init_db
from .importer import parse_upload, suggest_mapping
from .services import commit_import, create_store


DEMO_IMPORT_ORDER = (
    "costs.csv",
    "orders.csv",
    "refunds.csv",
    "fees.csv",
    "settlements.csv",
    "expenses.csv",
)
DEMO_REPORT_TYPES = {
    "costs.csv": "costs",
    "orders.csv": "orders",
    "refunds.csv": "refunds",
    "fees.csv": "fees",
    "settlements.csv": "settlements",
    "expenses.csv": "expenses",
}


def seed_demo_database(database_path: str | Path, reports_dir: str | Path) -> dict:
    """Initialize a fresh, session-scoped database with fictional reports."""
    database_path = Path(database_path)
    reports_dir = Path(reports_dir)
    init_db(database_path)
    db = connect(database_path)
    imported = []
    try:
        store_id = create_store(db, "其他/演示", "模拟配件店（虚构数据）")
        db.commit()
        store = db.execute("SELECT * FROM stores WHERE id=?", (store_id,)).fetchone()
        for filename in DEMO_IMPORT_ORDER:
            path = reports_dir / filename
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            report_type = DEMO_REPORT_TYPES[filename]
            parsed = parse_upload(path, filename)
            mapping = suggest_mapping(report_type, parsed.headers)
            result = commit_import(
                db,
                store,
                report_type,
                filename,
                digest,
                parsed.selected_sheet,
                parsed.headers,
                parsed.rows,
                mapping,
            )
            imported.append({"type": REPORT_TYPES[report_type], **result})
        return {"store_name": store["name"], "imports": imported}
    finally:
        db.close()
