from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import uuid
from typing import Any

from .config import CALCULATION_RULE_VERSION


def fen(value: int | None) -> Decimal:
    return Decimal(value or 0) / Decimal(100)


def fmt_money(cents: int | None) -> str:
    return f"¥{fen(cents):,.2f}"


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def _round_cent(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def cost_for_sku(db, store_id: str, sku_id: str, on_date: str):
    return db.execute(
        """SELECT * FROM product_costs WHERE store_id=? AND sku_id=? AND effective_from<=?
           AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1""",
        (store_id, sku_id, on_date, on_date),
    ).fetchone()


def _filtered_stores(db, store_id: str | None, platform: str | None) -> list[str]:
    sql = "SELECT id FROM stores WHERE status='active'"
    params: list[Any] = []
    if store_id:
        sql += " AND id=?"
        params.append(store_id)
    if platform:
        sql += " AND platform=?"
        params.append(platform)
    return [r[0] for r in db.execute(sql, params).fetchall()]


def build_summary(db, store_id: str | None, platform: str | None, start: str, end: str) -> dict[str, Any]:
    ids = _filtered_stores(db, store_id, platform)
    if not ids:
        ids = []
    marks = ",".join("?" for _ in ids) or "NULL"
    params = [*ids, start, end]

    order_rows = db.execute(
        f"SELECT * FROM orders WHERE store_id IN ({marks}) AND ordered_at BETWEEN ? AND ?", params
    ).fetchall()
    valid_orders = [r for r in order_rows if r["status_class"] == "valid"]
    cancelled_orders = [r for r in order_rows if r["status_class"] == "cancelled"]
    unknown_orders = [r for r in order_rows if r["status_class"] == "unknown"]
    gross_sales_fen = sum(r["item_amount_fen"] for r in valid_orders)
    order_count = len({(r["store_id"], r["platform_order_id"]) for r in valid_orders})
    quantity = sum((_decimal(r["quantity"]) for r in valid_orders), Decimal(0))

    refund_rows = db.execute(
        f"SELECT * FROM refunds WHERE store_id IN ({marks}) AND completed_at BETWEEN ? AND ?", params
    ).fetchall()
    confirmed_refunds = [r for r in refund_rows if r["is_confirmed"]]
    refund_fen = sum(r["refund_amount_fen"] for r in confirmed_refunds)

    fee_rows = db.execute(
        f"SELECT * FROM fees WHERE store_id IN ({marks}) AND fee_date BETWEEN ? AND ?", params
    ).fetchall()
    fee_fen = sum(r["fee_amount_fen"] for r in fee_rows)

    expense_rows = db.execute(
        f"SELECT * FROM expenses WHERE store_id IN ({marks}) AND expense_date BETWEEN ? AND ?", params
    ).fetchall()
    expense_fen = sum(r["expense_amount_fen"] for r in expense_rows)

    known_cost_fen = 0
    missing_costs: dict[str, dict[str, Any]] = {}
    cost_by_line: dict[str, int | None] = {}
    for r in valid_orders:
        cost = cost_for_sku(db, r["store_id"], r["sku_id"], r["ordered_at"])
        if cost is None:
            missing_costs.setdefault(r["sku_id"], {"sku_id": r["sku_id"], "product_name": r["product_name"], "lines": 0})["lines"] += 1
            cost_by_line[r["id"]] = None
        else:
            line_cost = _round_cent(Decimal(cost["unit_cost_fen"]) * _decimal(r["quantity"]))
            known_cost_fen += line_cost
            cost_by_line[r["id"]] = line_cost

    net_sales_fen = gross_sales_fen - refund_fen
    known_profit_fen = net_sales_fen - known_cost_fen - fee_fen - expense_fen

    # Imported batch coverage is only a signal that the selected period has source data;
    # it is not proof that every platform charge was included.
    def has_report(report_type: str) -> bool:
        if not ids:
            return False
        return db.execute(
            f"""SELECT 1 FROM import_batches WHERE store_id IN ({marks}) AND report_type=?
                 AND ((coverage_start IS NULL AND coverage_end IS NULL) OR
                      (coverage_end>=? AND coverage_start<=?)) LIMIT 1""",
            [*ids, report_type, start, end],
        ).fetchone() is not None

    missing_inputs = []
    if missing_costs:
        missing_inputs.append("部分已售 SKU 缺少有效成本")
    if not has_report("fees"):
        missing_inputs.append("本期间未见平台费用导入批次")
    if not has_report("expenses"):
        missing_inputs.append("本期间未见广告/其他经营费用导入批次")
    incomplete = bool(missing_inputs)

    settlements = db.execute(
        f"SELECT COALESCE(SUM(settlement_amount_fen),0) FROM settlements WHERE store_id IN ({marks}) AND settlement_date BETWEEN ? AND ? AND is_confirmed=1",
        params,
    ).fetchone()[0] or 0
    open_issues = db.execute(
        f"SELECT COUNT(*) FROM issues WHERE store_id IN ({marks}) AND status IN ('open','review')", ids
    ).fetchone()[0] if ids else 0
    mismatch = db.execute(
        f"SELECT COALESCE(SUM(ABS(amount_difference_fen)),0) FROM issues WHERE store_id IN ({marks}) AND issue_type='settlement_mismatch' AND status!='resolved'",
        ids,
    ).fetchone()[0] if ids else 0

    profit_margin = (Decimal(known_profit_fen) / Decimal(net_sales_fen)) if net_sales_fen else None
    completeness = {
        "complete": not incomplete,
        "missing": missing_inputs,
        "missing_costs": list(missing_costs.values()),
        "label": "已导入字段齐备（仍以报表范围为准）" if not incomplete else "部分数据估算 / 数据有缺项",
    }
    return {
        "store_ids": ids, "start": start, "end": end,
        "gross_sales_fen": gross_sales_fen, "refund_fen": refund_fen, "net_sales_fen": net_sales_fen,
        "known_cost_fen": known_cost_fen, "fee_fen": fee_fen, "expense_fen": expense_fen,
        "known_profit_fen": known_profit_fen, "profit_margin": profit_margin,
        "order_count": order_count, "item_count": quantity, "cancelled_count": len(cancelled_orders),
        "unknown_status_count": len(unknown_orders), "refund_count": len(confirmed_refunds),
        "fee_record_count": len(fee_rows), "expense_record_count": len(expense_rows),
        "settlement_fen": settlements, "open_issue_count": open_issues, "mismatch_fen": mismatch,
        "completeness": completeness, "cost_by_line": cost_by_line,
    }


def daily_trend(db, summary: dict[str, Any], store_id: str | None, platform: str | None, start: str, end: str):
    ids = summary["store_ids"]
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    args = [*ids, start, end]
    daily: dict[str, dict[str, int]] = defaultdict(lambda: {"sales": 0, "refunds": 0, "fees": 0, "expenses": 0, "cost": 0})
    for r in db.execute(f"SELECT * FROM orders WHERE store_id IN ({marks}) AND ordered_at BETWEEN ? AND ?", args):
        if r["status_class"] == "valid":
            daily[r["ordered_at"]]["sales"] += r["item_amount_fen"]
            cost = cost_for_sku(db, r["store_id"], r["sku_id"], r["ordered_at"])
            if cost:
                daily[r["ordered_at"]]["cost"] += _round_cent(Decimal(cost["unit_cost_fen"]) * _decimal(r["quantity"]))
    for r in db.execute(f"SELECT * FROM refunds WHERE store_id IN ({marks}) AND completed_at BETWEEN ? AND ? AND is_confirmed=1", args):
        daily[r["completed_at"]]["refunds"] += r["refund_amount_fen"]
    for r in db.execute(f"SELECT * FROM fees WHERE store_id IN ({marks}) AND fee_date BETWEEN ? AND ?", args):
        daily[r["fee_date"]]["fees"] += r["fee_amount_fen"]
    for r in db.execute(f"SELECT * FROM expenses WHERE store_id IN ({marks}) AND expense_date BETWEEN ? AND ?", args):
        daily[r["expense_date"]]["expenses"] += r["expense_amount_fen"]

    first = date.fromisoformat(start)
    last = date.fromisoformat(end)
    if (last - first).days > 90:
        first = last - timedelta(days=90)
    result = []
    cursor = first
    while cursor <= last:
        day = cursor.isoformat()
        parts = daily[day]
        result.append({"date": day, **parts, "net": parts["sales"] - parts["refunds"], "profit": parts["sales"] - parts["refunds"] - parts["cost"] - parts["fees"] - parts["expenses"]})
        cursor += timedelta(days=1)
    return result


def product_analysis(db, summary: dict[str, Any], start: str, end: str):
    ids = summary["store_ids"]
    if not ids:
        return [], 0, 0, 0
    marks = ",".join("?" for _ in ids)
    orders = db.execute(
        f"SELECT * FROM orders WHERE store_id IN ({marks}) AND ordered_at BETWEEN ? AND ? AND status_class='valid'",
        [*ids, start, end],
    ).fetchall()
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    order_groups: dict[tuple[str, str], list[Any]] = defaultdict(list)
    for r in orders:
        key = (r["store_id"], r["sku_id"])
        item = by_key.setdefault(key, {"store_id": r["store_id"], "sku_id": r["sku_id"], "product_name": r["product_name"] or "未命名商品", "sales_fen": 0, "refund_fen": 0, "cost_fen": 0, "fee_fen": 0, "expense_fen": 0, "quantity": Decimal(0), "missing_cost": False})
        item["sales_fen"] += r["item_amount_fen"]
        item["quantity"] += _decimal(r["quantity"])
        order_groups[(r["store_id"], r["platform_order_id"])].append(r)
        cost = cost_for_sku(db, r["store_id"], r["sku_id"], r["ordered_at"])
        if cost:
            item["cost_fen"] += _round_cent(Decimal(cost["unit_cost_fen"]) * _decimal(r["quantity"]))
        else:
            item["missing_cost"] = True

    by_order: dict[tuple[str, str], list[Any]] = order_groups
    refunds = db.execute(
        f"SELECT * FROM refunds WHERE store_id IN ({marks}) AND completed_at BETWEEN ? AND ? AND is_confirmed=1",
        [*ids, start, end],
    ).fetchall()
    unallocated_refund_fen = 0
    unallocated_fee_fen = 0
    for refund in refunds:
        lines = by_order.get((refund["store_id"], refund["platform_order_id"]), [])
        if refund["platform_item_id"]:
            matches = [line for line in lines if line["platform_item_id"] == refund["platform_item_id"]]
        else:
            matches = lines
        if not matches:
            unallocated_refund_fen += refund["refund_amount_fen"]
            continue
        total = sum(x["item_amount_fen"] for x in matches)
        if len(matches) == 1 or total == 0:
            by_key[(matches[0]["store_id"], matches[0]["sku_id"])]["refund_fen"] += refund["refund_amount_fen"]
        else:
            allocated = 0
            for line in matches[:-1]:
                share = int(Decimal(refund["refund_amount_fen"] * line["item_amount_fen"]) / Decimal(total))
                by_key[(line["store_id"], line["sku_id"])]["refund_fen"] += share
                allocated += share
            last = matches[-1]
            by_key[(last["store_id"], last["sku_id"])]["refund_fen"] += refund["refund_amount_fen"] - allocated

    fees = db.execute(f"SELECT * FROM fees WHERE store_id IN ({marks}) AND fee_date BETWEEN ? AND ?", [*ids, start, end]).fetchall()
    for fee in fees:
        lines = by_order.get((fee["store_id"], fee["platform_order_id"]), [])
        total = sum(x["item_amount_fen"] for x in lines)
        if total:
            allocated = 0
            for line in lines[:-1]:
                share = int(Decimal(fee["fee_amount_fen"] * line["item_amount_fen"]) / Decimal(total))
                by_key[(line["store_id"], line["sku_id"])]["fee_fen"] += share
                allocated += share
            if lines:
                last = lines[-1]
                by_key[(last["store_id"], last["sku_id"])]["fee_fen"] += fee["fee_amount_fen"] - allocated
        else:
            unallocated_fee_fen += fee["fee_amount_fen"]

    expenses = db.execute(f"SELECT * FROM expenses WHERE store_id IN ({marks}) AND expense_date BETWEEN ? AND ?", [*ids, start, end]).fetchall()
    unallocated_expense_fen = 0
    for expense in expenses:
        if expense["allocation_method"] == "sku" and expense["sku_id"]:
            item = by_key.get((expense["store_id"], expense["sku_id"]))
            if item:
                item["expense_fen"] += expense["expense_amount_fen"]
            else:
                unallocated_expense_fen += expense["expense_amount_fen"]
        elif expense["allocation_method"] == "order" and expense["platform_order_id"]:
            lines = by_order.get((expense["store_id"], expense["platform_order_id"]), [])
            total = sum(x["item_amount_fen"] for x in lines)
            if total:
                allocated = 0
                for line in lines[:-1]:
                    share = int(Decimal(expense["expense_amount_fen"] * line["item_amount_fen"]) / Decimal(total))
                    by_key[(line["store_id"], line["sku_id"])]["expense_fen"] += share
                    allocated += share
                if lines:
                    last = lines[-1]
                    by_key[(last["store_id"], last["sku_id"])]["expense_fen"] += expense["expense_amount_fen"] - allocated
            else:
                unallocated_expense_fen += expense["expense_amount_fen"]
        else:
            unallocated_expense_fen += expense["expense_amount_fen"]

    result = []
    for item in by_key.values():
        item["net_sales_fen"] = item["sales_fen"] - item["refund_fen"]
        item["known_profit_fen"] = item["net_sales_fen"] - item["cost_fen"] - item["fee_fen"] - item["expense_fen"]
        result.append(item)
    result.sort(key=lambda x: x["known_profit_fen"], reverse=True)
    return result, unallocated_refund_fen, unallocated_fee_fen, unallocated_expense_fen


def store_analysis(db, start: str, end: str):
    stores = db.execute("SELECT id, platform, name FROM stores WHERE status='active' ORDER BY platform, name").fetchall()
    result = []
    for store in stores:
        summary = build_summary(db, store["id"], None, start, end)
        result.append({"store_id": store["id"], "platform": store["platform"], "name": store["name"], **summary})
    return result


def save_calculation_run(db, store_id: str) -> None:
    orders = db.execute("SELECT id,row_hash FROM orders WHERE store_id=? ORDER BY id", (store_id,)).fetchall()
    refunds = db.execute("SELECT id,row_hash FROM refunds WHERE store_id=? ORDER BY id", (store_id,)).fetchall()
    fees = db.execute("SELECT id,row_hash FROM fees WHERE store_id=? ORDER BY id", (store_id,)).fetchall()
    costs = db.execute("SELECT id,unit_cost_fen,effective_from,effective_to FROM product_costs WHERE store_id=? ORDER BY id", (store_id,)).fetchall()
    expenses = db.execute("SELECT id,row_hash FROM expenses WHERE store_id=? ORDER BY id", (store_id,)).fetchall()
    snapshot = [[r["id"], r[1]] for group in (orders, refunds, fees, costs, expenses) for r in group]
    snap = hashlib.sha256(json.dumps(snapshot, separators=(",", ":")).encode()).hexdigest()
    dates = []
    for table, col in (("orders", "ordered_at"), ("refunds", "completed_at"), ("fees", "fee_date"), ("expenses", "expense_date")):
        d = db.execute(f"SELECT MIN({col}) AS mn,MAX({col}) AS mx FROM {table} WHERE store_id=?", (store_id,)).fetchone()
        if d["mn"]:
            dates.extend([d["mn"], d["mx"]])
    period = f"{min(dates)}~{max(dates)}" if dates else "无日期数据"
    summary = build_summary(db, store_id, None, "0001-01-01", "9999-12-31")
    warnings = summary["completeness"]["missing"]
    status = "incomplete" if warnings else "calculated"
    db.execute(
        """INSERT INTO calculation_runs(id,store_id,reporting_period,calculation_rule_version,input_snapshot_id,
        calculation_status,calculated_at,output_summary_json,warnings_json) VALUES(?,?,?,?,?,?,?,?,?)""",
        (str(uuid.uuid4()), store_id, period, CALCULATION_RULE_VERSION, snap, status,
         __import__("datetime").datetime.now().isoformat(timespec="seconds"),
         json.dumps({k: summary[k] for k in ("gross_sales_fen", "refund_fen", "net_sales_fen", "known_cost_fen", "fee_fen", "expense_fen", "known_profit_fen")}, ensure_ascii=False),
         json.dumps(warnings, ensure_ascii=False)),
    )
