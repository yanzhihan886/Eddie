from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stores (
 id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'CNY',
 status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 platform TEXT NOT NULL, report_type TEXT NOT NULL, original_filename TEXT NOT NULL, file_hash TEXT NOT NULL,
 imported_at TEXT NOT NULL, row_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL,
 rejected_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL, conflict_count INTEGER NOT NULL,
 status TEXT NOT NULL, template_version TEXT NOT NULL, field_mapping_json TEXT NOT NULL,
 coverage_start TEXT, coverage_end TEXT,
 UNIQUE(store_id, report_type, file_hash)
);
CREATE TABLE IF NOT EXISTS raw_records (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
 source_sheet TEXT NOT NULL, source_row_number INTEGER NOT NULL, original_payload_json TEXT NOT NULL,
 row_hash TEXT NOT NULL, business_key TEXT NOT NULL, validation_status TEXT NOT NULL,
 validation_errors_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL REFERENCES import_batches(id), source_record_id TEXT NOT NULL REFERENCES raw_records(id),
 platform_order_id TEXT NOT NULL, platform_item_id TEXT, sku_id TEXT NOT NULL, product_name TEXT,
 order_status TEXT NOT NULL, status_class TEXT NOT NULL, ordered_at TEXT NOT NULL, quantity TEXT NOT NULL,
 unit_price_fen INTEGER, item_amount_fen INTEGER NOT NULL, discount_fen INTEGER NOT NULL DEFAULT 0,
 row_hash TEXT NOT NULL, record_key TEXT NOT NULL, UNIQUE(store_id, record_key)
);
CREATE TABLE IF NOT EXISTS refunds (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL REFERENCES import_batches(id), source_record_id TEXT NOT NULL REFERENCES raw_records(id),
 platform_refund_id TEXT, platform_order_id TEXT NOT NULL, platform_item_id TEXT, refund_status TEXT NOT NULL,
 is_confirmed INTEGER NOT NULL, refund_amount_fen INTEGER NOT NULL, completed_at TEXT NOT NULL, row_hash TEXT NOT NULL, record_key TEXT NOT NULL,
 UNIQUE(store_id, record_key)
);
CREATE TABLE IF NOT EXISTS fees (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL REFERENCES import_batches(id), source_record_id TEXT NOT NULL REFERENCES raw_records(id),
 fee_id TEXT, platform_order_id TEXT, fee_type TEXT NOT NULL, fee_amount_fen INTEGER NOT NULL,
 fee_date TEXT NOT NULL, row_hash TEXT NOT NULL, record_key TEXT NOT NULL, UNIQUE(store_id, record_key)
);
CREATE TABLE IF NOT EXISTS settlements (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL REFERENCES import_batches(id), source_record_id TEXT NOT NULL REFERENCES raw_records(id),
 transaction_id TEXT, platform_order_id TEXT, settlement_amount_fen INTEGER NOT NULL,
 settlement_status TEXT NOT NULL, is_confirmed INTEGER NOT NULL, settlement_date TEXT NOT NULL, row_hash TEXT NOT NULL, record_key TEXT NOT NULL,
 UNIQUE(store_id, record_key)
);
CREATE TABLE IF NOT EXISTS product_costs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 source_record_id TEXT REFERENCES raw_records(id), sku_id TEXT NOT NULL, product_name TEXT,
 unit_cost_fen INTEGER NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, cost_source TEXT NOT NULL,
 updated_at TEXT NOT NULL, row_hash TEXT NOT NULL, record_key TEXT NOT NULL, UNIQUE(store_id, record_key),
 UNIQUE(store_id, sku_id, effective_from)
);
CREATE TABLE IF NOT EXISTS expenses (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL REFERENCES import_batches(id), source_record_id TEXT NOT NULL REFERENCES raw_records(id),
 expense_id TEXT, expense_type TEXT NOT NULL, expense_amount_fen INTEGER NOT NULL,
 expense_date TEXT NOT NULL, allocation_method TEXT NOT NULL, platform_order_id TEXT, sku_id TEXT, note TEXT,
 row_hash TEXT NOT NULL, record_key TEXT NOT NULL, UNIQUE(store_id, record_key)
);
CREATE TABLE IF NOT EXISTS issues (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 issue_type TEXT NOT NULL, source_record_id TEXT, related_record_ids TEXT NOT NULL DEFAULT '',
 amount_difference_fen INTEGER, severity TEXT NOT NULL DEFAULT 'warning', status TEXT NOT NULL DEFAULT 'open',
 description TEXT NOT NULL, resolution_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 resolved_at TEXT, stable_key TEXT NOT NULL UNIQUE, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS calculation_runs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 reporting_period TEXT NOT NULL, calculation_rule_version TEXT NOT NULL, input_snapshot_id TEXT NOT NULL,
 calculation_status TEXT NOT NULL, calculated_at TEXT NOT NULL, output_summary_json TEXT NOT NULL, warnings_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_store_date ON orders(store_id, ordered_at);
CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders(store_id, sku_id);
CREATE INDEX IF NOT EXISTS idx_refunds_store_date ON refunds(store_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(store_id, platform_order_id);
CREATE INDEX IF NOT EXISTS idx_fees_store_date ON fees(store_id, fee_date);
CREATE INDEX IF NOT EXISTS idx_settlements_store_date ON settlements(store_id, settlement_date);
CREATE INDEX IF NOT EXISTS idx_costs_lookup ON product_costs(store_id, sku_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_expenses_store_date ON expenses(store_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_issues_store_status ON issues(store_id, status, issue_type);
CREATE INDEX IF NOT EXISTS idx_raw_batch ON raw_records(batch_id, validation_status);
"""


def connect(path: str | Path) -> sqlite3.Connection:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(path: str | Path) -> None:
    with connect(path) as db:
        db.executescript(SCHEMA)
        db.execute("PRAGMA user_version = 1")
