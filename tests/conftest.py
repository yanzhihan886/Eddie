from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from profit_app.config import REPORT_TYPES
from profit_app.database import connect
from profit_app.importer import parse_upload, suggest_mapping
from profit_app.services import commit_import, create_store
from app import create_app


PROJECT = Path(__file__).resolve().parents[1]
DEMO = PROJECT / "data" / "demo_reports"
DEMO_ORDER = ["costs.csv", "orders.csv", "refunds.csv", "fees.csv", "settlements.csv", "expenses.csv"]
TYPE_BY_FILE = {"costs.csv": "costs", "orders.csv": "orders", "refunds.csv": "refunds", "fees.csv": "fees", "settlements.csv": "settlements", "expenses.csv": "expenses"}


@pytest.fixture
def isolated(tmp_path):
    data_dir = tmp_path / "data"
    app = create_app({
        "TESTING": True,
        "DATABASE": str(data_dir / "test.sqlite3"),
        "STAGING_DIR": str(data_dir / "staging"),
        "EXPORT_DIR": str(data_dir / "exports"),
    })
    db = connect(app.config["DATABASE"])
    store_id = create_store(db, "其他/演示", "自动测试模拟店")
    db.commit()
    store = db.execute("SELECT * FROM stores WHERE id=?", (store_id,)).fetchone()
    for filename in DEMO_ORDER:
        path = DEMO / filename
        report_type = TYPE_BY_FILE[filename]
        parsed = parse_upload(path, filename)
        mapping = suggest_mapping(report_type, parsed.headers)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        commit_import(db, store, report_type, filename, digest, parsed.selected_sheet, parsed.headers, parsed.rows, mapping)
    db.close()
    return {"app": app, "client": app.test_client(), "store_id": store_id, "database": app.config["DATABASE"], "tmp_path": tmp_path}
