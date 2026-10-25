from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from .calculations import build_summary, save_calculation_run
from .config import CALCULATION_RULE_VERSION, FIELD_SPECS, REPORT_TYPES, TEMPLATE_VERSION
from .importer import CleanRow, classify_duplicates, clean_rows


def now_text() -> str:
    return datetime.now().isoformat(timespec="seconds")


def create_store(db, platform: str, name: str) -> str:
    store_id = str(uuid.uuid4())
    timestamp = now_text()
    db.execute("INSERT INTO stores(id,platform,name,currency,status,created_at,updated_at) VALUES(?,?,?,'CNY','active',?,?)", (store_id, platform, name.strip(), timestamp, timestamp))
    return store_id


def _existing_keys(db, store_id: str, report_type: str) -> dict[str, str]:
    table = {"orders": "orders", "refunds": "refunds", "fees": "fees", "settlements": "settlements", "costs": "product_costs", "expenses": "expenses"}[report_type]
    rows = db.execute(f"SELECT record_key,row_hash FROM {table} WHERE store_id=?", (store_id,)).fetchall()
    return {r["record_key"]: r["row_hash"] for r in rows}


def inspect_rows(db, store_id: str, report_type: str, headers: list[str], rows: list[list[Any]], mapping: dict[str, str]) -> list[CleanRow]:
    cleaned = clean_rows(report_type, headers, rows, mapping)
    classify_duplicates(cleaned, _existing_keys(db, store_id, report_type))
    return cleaned


def _date_coverage(rows: list[CleanRow], report_type: str) -> tuple[str | None, str | None]:
    field = {"orders": "ordered_at", "refunds": "completed_at", "fees": "fee_date", "settlements": "settlement_date", "costs": "effective_from", "expenses": "expense_date"}[report_type]
    dates = [r.data.get(field) for r in rows if r.status == "accepted" and r.data.get(field)]
    return (min(dates), max(dates)) if dates else (None, None)


def _issue(db, store_id: str, issue_type: str, stable_key: str, description: str,
           source_record_id: str | None = None, related_record_ids: str = "",
           amount_difference_fen: int | None = None, severity: str = "warning") -> None:
    db.execute(
        """INSERT INTO issues(id,store_id,issue_type,source_record_id,related_record_ids,amount_difference_fen,
        severity,status,description,resolution_note,created_at,resolved_at,stable_key,last_seen)
        VALUES(?,?,?,?,?,?,?,'open',?,'',?,NULL,?,?)
        ON CONFLICT(stable_key) DO UPDATE SET description=excluded.description,
          amount_difference_fen=excluded.amount_difference_fen, severity=excluded.severity,last_seen=excluded.last_seen""",
        (str(uuid.uuid4()), store_id, issue_type, source_record_id, related_record_ids, amount_difference_fen,
         severity, description, now_text(), stable_key, now_text()),
    )


def _insert_typed(db, report_type: str, store_id: str, batch_id: str, raw_id: str, row: CleanRow) -> None:
    d = row.data
    if report_type == "orders":
        db.execute(
            """INSERT INTO orders(id,store_id,batch_id,source_record_id,platform_order_id,platform_item_id,sku_id,
            product_name,order_status,status_class,ordered_at,quantity,unit_price_fen,item_amount_fen,discount_fen,row_hash,record_key)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), store_id, batch_id, raw_id, d["platform_order_id"], d.get("platform_item_id"), d["sku_id"],
             d.get("product_name"), d["order_status"], d["status_class"], d["ordered_at"], d["quantity"], d.get("unit_price_fen"),
             d["item_amount_fen"], d["discount_fen"], row.row_hash, row.business_key),
        )
    elif report_type == "refunds":
        db.execute(
            """INSERT INTO refunds(id,store_id,batch_id,source_record_id,platform_refund_id,platform_order_id,platform_item_id,
            refund_status,is_confirmed,refund_amount_fen,completed_at,row_hash,record_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), store_id, batch_id, raw_id, d.get("platform_refund_id"), d["platform_order_id"], d.get("platform_item_id"),
             d["refund_status"], int(d["confirmed"]), d["refund_amount_fen"], d["completed_at"], row.row_hash, row.business_key),
        )
    elif report_type == "fees":
        db.execute(
            """INSERT INTO fees(id,store_id,batch_id,source_record_id,fee_id,platform_order_id,fee_type,fee_amount_fen,fee_date,row_hash,record_key)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), store_id, batch_id, raw_id, d.get("fee_id"), d.get("platform_order_id"), d["fee_type"], d["fee_amount_fen"], d["fee_date"], row.row_hash, row.business_key),
        )
    elif report_type == "settlements":
        db.execute(
            """INSERT INTO settlements(id,store_id,batch_id,source_record_id,transaction_id,platform_order_id,settlement_amount_fen,
            settlement_status,is_confirmed,settlement_date,row_hash,record_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), store_id, batch_id, raw_id, d.get("transaction_id"), d.get("platform_order_id"), d["settlement_amount_fen"],
             d["settlement_status"], int(d["is_confirmed"]), d["settlement_date"], row.row_hash, row.business_key),
        )
    elif report_type == "costs":
        _save_cost(db, store_id, d["sku_id"], d.get("product_name"), d["unit_cost_fen"], d["effective_from"], d.get("effective_to"), "imported", raw_id, row.row_hash, row.business_key)
    elif report_type == "expenses":
        db.execute(
            """INSERT INTO expenses(id,store_id,batch_id,source_record_id,expense_id,expense_type,expense_amount_fen,expense_date,
            allocation_method,platform_order_id,sku_id,note,row_hash,record_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), store_id, batch_id, raw_id, d.get("expense_id"), d["expense_type"], d["expense_amount_fen"], d["expense_date"],
             d["allocation_method"], d.get("platform_order_id"), d.get("sku_id"), d.get("note"), row.row_hash, row.business_key),
        )


def _save_cost(db, store_id: str, sku_id: str, product_name: str | None, unit_cost_fen: int,
               effective_from: str, effective_to: str | None, source: str, raw_id: str | None,
               row_hash: str, record_key: str) -> None:
    existing_same = db.execute("SELECT * FROM product_costs WHERE store_id=? AND sku_id=? AND effective_from=?", (store_id, sku_id, effective_from)).fetchone()
    if existing_same:
        if existing_same["row_hash"] == row_hash:
            return
        raise ValueError(f"SKU {sku_id} 在 {effective_from} 已有不同成本记录")
    rows = db.execute("SELECT * FROM product_costs WHERE store_id=? AND sku_id=? ORDER BY effective_from", (store_id, sku_id)).fetchall()
    new_from = date.fromisoformat(effective_from)
    proposed_to = date.fromisoformat(effective_to) if effective_to else None
    for existing in rows:
        old_from = date.fromisoformat(existing["effective_from"])
        old_to = date.fromisoformat(existing["effective_to"]) if existing["effective_to"] else None
        # Close an open or overlapping prior version at the day before a later version begins.
        if old_from < new_from and (old_to is None or old_to >= new_from):
            db.execute("UPDATE product_costs SET effective_to=? WHERE id=?", ((new_from - timedelta(days=1)).isoformat(), existing["id"]))
            old_to = new_from - timedelta(days=1)
        # A new open-ended version ends before the next known version.
        if old_from > new_from and proposed_to is None:
            proposed_to = old_from - timedelta(days=1)
        elif old_from > new_from and proposed_to >= old_from:
            raise ValueError(f"SKU {sku_id} 的结束日期与后续成本版本重叠")
        if proposed_to is None:
            overlap = old_to is None or old_to >= new_from
        else:
            overlap = not (proposed_to < old_from or (old_to is not None and old_to < new_from))
        if overlap:
            raise ValueError(f"SKU {sku_id} 的成本有效期与已有版本重叠")
    db.execute(
        """INSERT INTO product_costs(id,store_id,source_record_id,sku_id,product_name,unit_cost_fen,effective_from,effective_to,
        cost_source,updated_at,row_hash,record_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (str(uuid.uuid4()), store_id, raw_id, sku_id, product_name, unit_cost_fen, effective_from,
         proposed_to.isoformat() if proposed_to else None, source, now_text(), row_hash, record_key),
    )


def commit_import(db, store, report_type: str, filename: str, file_hash: str, sheet_name: str,
                  headers: list[str], rows: list[list[Any]], mapping: dict[str, str]) -> dict[str, Any]:
    existing_batch = db.execute("SELECT id,imported_at FROM import_batches WHERE store_id=? AND report_type=? AND file_hash=?", (store["id"], report_type, file_hash)).fetchone()
    if existing_batch:
        raise ValueError(f"这个文件已于 {existing_batch['imported_at']} 导入，未重复写入。")
    cleaned = clean_rows(report_type, headers, rows, mapping)
    classify_duplicates(cleaned, _existing_keys(db, store["id"], report_type))
    accepted = [r for r in cleaned if r.status == "accepted"]
    duplicates = [r for r in cleaned if r.status == "duplicate"]
    conflicts = [r for r in cleaned if r.status == "conflict"]
    rejected = [r for r in cleaned if r.status == "rejected"]
    batch_id = str(uuid.uuid4())
    start, end = _date_coverage(cleaned, report_type)
    if accepted and report_type == "costs":
        # Check business-key conflicts before creating a batch; overlap checks still happen transactionally below.
        for row in accepted:
            same = db.execute("SELECT row_hash FROM product_costs WHERE store_id=? AND record_key=?", (store["id"], row.business_key)).fetchone()
            if same:
                raise ValueError("成本生效日期已存在，请用新的生效日期建立版本。")
    with db:
        db.execute(
            """INSERT INTO import_batches(id,store_id,platform,report_type,original_filename,file_hash,imported_at,row_count,
            accepted_count,rejected_count,duplicate_count,conflict_count,status,template_version,field_mapping_json,coverage_start,coverage_end)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (batch_id, store["id"], store["platform"], report_type, filename, file_hash, now_text(), len(cleaned), len(accepted),
             len(rejected), len(duplicates), len(conflicts), "imported_with_warnings" if rejected or duplicates or conflicts or any(r.errors for r in accepted) else "imported",
             TEMPLATE_VERSION, json.dumps(mapping, ensure_ascii=False), start, end),
        )
        for row in cleaned:
            raw_id = str(uuid.uuid4())
            status = row.status
            db.execute(
                """INSERT INTO raw_records(id,batch_id,source_sheet,source_row_number,original_payload_json,row_hash,business_key,validation_status,validation_errors_json)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (raw_id, batch_id, sheet_name, row.row_number, json.dumps(row.payload, ensure_ascii=False, default=str), row.row_hash,
                 row.business_key, status, json.dumps(row.errors, ensure_ascii=False)),
            )
            if status == "accepted":
                try:
                    _insert_typed(db, report_type, store["id"], batch_id, raw_id, row)
                except ValueError as exc:
                    # Cost range overlap is visible and kept as a rejected raw row.
                    db.execute("UPDATE raw_records SET validation_status='rejected',validation_errors_json=? WHERE id=?", (json.dumps([str(exc)], ensure_ascii=False), raw_id))
                    db.execute("UPDATE import_batches SET accepted_count=accepted_count-1,rejected_count=rejected_count+1,status='imported_with_warnings' WHERE id=?", (batch_id,))
                    row.status = "rejected"
                    row.errors.append(str(exc))
            if row.status in {"rejected", "duplicate", "conflict"}:
                text = "; ".join(row.errors) or "数据行未能导入"
                _issue(db, store["id"], f"import_{row.status}", f"batch:{batch_id}:row:{row.row_number}", f"{filename} 第 {row.row_number} 行：{text}", raw_id, raw_id, severity="error" if row.status in {"rejected", "conflict"} else "info")
        _refresh_issues(db, store["id"])
        save_calculation_run(db, store["id"])
    return {"batch_id": batch_id, "row_count": len(cleaned), "accepted_count": sum(r.status == "accepted" for r in cleaned),
            "rejected_count": sum(r.status == "rejected" for r in cleaned), "duplicate_count": len(duplicates), "conflict_count": len(conflicts)}


def _refresh_issues(db, store_id: str) -> None:
    calculated_types = ("unmatched_refund", "unmatched_fee", "unmatched_settlement", "missing_cost", "unknown_order_status", "settlement_mismatch", "unmatched_expense", "unconfirmed_refund", "unconfirmed_settlement")
    marks = ",".join("?" for _ in calculated_types)
    db.execute(f"UPDATE issues SET last_seen=NULL WHERE store_id=? AND issue_type IN ({marks})", (store_id, *calculated_types))
    now = now_text()
    orders = db.execute("SELECT * FROM orders WHERE store_id=?", (store_id,)).fetchall()
    order_ids = {r["platform_order_id"] for r in orders}
    for r in orders:
        if r["status_class"] == "unknown":
            _issue(db, store_id, "unknown_order_status", f"unknown-status:{r['id']}", f"订单 {r['platform_order_id']} 状态“{r['order_status']}”无法归类，未计入销售。", r["source_record_id"], r["id"])
        if r["status_class"] == "valid" and cost_for_order(db, r) is None:
            _issue(db, store_id, "missing_cost", f"missing-cost:{r['id']}", f"SKU {r['sku_id']} 在 {r['ordered_at']} 没有有效成本；利润估算不完整。", r["source_record_id"], r["id"])
    for r in db.execute("SELECT * FROM refunds WHERE store_id=? AND is_confirmed=0", (store_id,)):
        _issue(db, store_id, "unconfirmed_refund", f"unconfirmed-refund:{r['id']}", f"退款 {r['platform_refund_id'] or r['id']} 状态“{r['refund_status']}”未确认完成，未计入已确认退款金额。", r["source_record_id"], r["id"], severity="info")
    for r in db.execute("SELECT * FROM settlements WHERE store_id=? AND is_confirmed=0", (store_id,)):
        _issue(db, store_id, "unconfirmed_settlement", f"unconfirmed-settlement:{r['id']}", f"结算记录 {r['transaction_id'] or r['id']} 状态“{r['settlement_status']}”未确认，未计入已确认结算金额。", r["source_record_id"], r["id"], severity="info")
    for table, table_name, id_col, date_col in (("refunds", "unmatched_refund", "platform_order_id", "completed_at"), ("fees", "unmatched_fee", "platform_order_id", "fee_date"), ("settlements", "unmatched_settlement", "platform_order_id", "settlement_date")):
        rows = db.execute(f"SELECT * FROM {table} WHERE store_id=? AND {id_col} IS NOT NULL", (store_id,)).fetchall()
        for r in rows:
            if r[id_col] not in order_ids:
                _issue(db, store_id, table_name, f"{table_name}:{r['id']}", f"{table_name} 记录关联的订单 {r[id_col]} 未找到，请复核订单报表期间或订单号映射。", r["source_record_id"], r["id"])
    exps = db.execute("SELECT * FROM expenses WHERE store_id=?", (store_id,)).fetchall()
    for r in exps:
        if r["allocation_method"] == "order" and r["platform_order_id"] not in order_ids:
            _issue(db, store_id, "unmatched_expense", f"unmatched-expense:{r['id']}", f"费用 {r['expense_type']} 指向订单 {r['platform_order_id']}，但订单未找到。", r["source_record_id"], r["id"])
        if r["allocation_method"] == "sku" and not db.execute("SELECT 1 FROM orders WHERE store_id=? AND sku_id=? LIMIT 1", (store_id, r["sku_id"])).fetchone():
            _issue(db, store_id, "unmatched_expense", f"unmatched-expense:{r['id']}", f"费用 {r['expense_type']} 指向 SKU {r['sku_id']}，但订单未找到。", r["source_record_id"], r["id"])
    valid_orders = [r for r in orders if r["status_class"] == "valid"]
    order_groups: dict[str, list[Any]] = {}
    for r in valid_orders:
        order_groups.setdefault(r["platform_order_id"], []).append(r)
    for order_no, lines in order_groups.items():
        fee_rows = db.execute("SELECT * FROM fees WHERE store_id=? AND platform_order_id=?", (store_id, order_no)).fetchall()
        settlement_rows = db.execute("SELECT * FROM settlements WHERE store_id=? AND platform_order_id=? AND is_confirmed=1", (store_id, order_no)).fetchall()
        if not fee_rows or len(settlement_rows) != 1:
            continue
        settlement_cutoff = max(r["settlement_date"] for r in settlement_rows)
        sales = sum(r["item_amount_fen"] for r in lines if r["ordered_at"] <= settlement_cutoff)
        refunds = db.execute("SELECT COALESCE(SUM(refund_amount_fen),0) FROM refunds WHERE store_id=? AND platform_order_id=? AND is_confirmed=1 AND completed_at<=?", (store_id, order_no, settlement_cutoff)).fetchone()[0] or 0
        fee_total = sum(r["fee_amount_fen"] for r in fee_rows if r["fee_date"] <= settlement_cutoff)
        actual = sum(r["settlement_amount_fen"] for r in settlement_rows)
        expected = sales - refunds - fee_total
        diff = actual - expected
        if abs(diff) > 1:
            _issue(db, store_id, "settlement_mismatch", f"settlement-mismatch:{store_id}:{order_no}",
                  f"订单级简化对照：商品销售额 {sales/100:.2f} − 已确认退款 {refunds/100:.2f} − 已匹配费用 {fee_total/100:.2f} = 预期 {expected/100:.2f}；结算报表为 {actual/100:.2f}。仅作复核线索，不代表平台账单结论。",
                  None, order_no, diff, "warning")
    db.execute(
        f"""UPDATE issues SET status=CASE WHEN status='resolved' THEN status ELSE 'superseded' END,
        resolved_at=COALESCE(resolved_at,?), resolution_note=CASE WHEN resolution_note='' THEN
        '数据更新后此异常条件不再触发，已归档；历史记录保留。' ELSE resolution_note END
        WHERE store_id=? AND issue_type IN ({marks}) AND last_seen IS NULL""",
        (now, store_id, *calculated_types),
    )


def cost_for_order(db, order):
    return db.execute(
        """SELECT id FROM product_costs WHERE store_id=? AND sku_id=? AND effective_from<=?
        AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1""",
        (order["store_id"], order["sku_id"], order["ordered_at"], order["ordered_at"]),
    ).fetchone()


def add_cost(db, store_id: str, sku_id: str, product_name: str, unit_cost_fen: int, effective_from: str) -> None:
    data = {"sku_id": sku_id, "unit_cost_fen": unit_cost_fen, "effective_from": effective_from, "effective_to": None}
    row_hash = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    record_key = f"cost:{sku_id}:{effective_from}"
    with db:
        _save_cost(db, store_id, sku_id, product_name or None, unit_cost_fen, effective_from, None, "manual", None, row_hash, record_key)
        _refresh_issues(db, store_id)
        save_calculation_run(db, store_id)


def resolve_issue(db, issue_id: str, status: str, note: str) -> bool:
    if status not in {"open", "review", "resolved"}:
        return False
    timestamp = now_text()
    cursor = db.execute("UPDATE issues SET status=?,resolution_note=?,resolved_at=? WHERE id=?",
                        (status, note.strip(), timestamp if status == "resolved" else None, issue_id))
    return cursor.rowcount == 1


def query_issues(db, store_id: str | None = None, status: str | None = None):
    sql = "SELECT issues.*,stores.name AS store_name,stores.platform FROM issues JOIN stores ON stores.id=issues.store_id WHERE 1=1"
    params = []
    if store_id:
        sql += " AND issues.store_id=?"
        params.append(store_id)
    if status == "open":
        sql += " AND issues.status IN ('open','review')"
    elif status == "resolved":
        sql += " AND issues.status='resolved'"
    sql += " ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC"
    return db.execute(sql, params).fetchall()
