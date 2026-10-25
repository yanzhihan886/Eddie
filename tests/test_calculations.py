from __future__ import annotations

import hashlib
from datetime import date
from decimal import Decimal
from pathlib import Path

from profit_app.calculations import build_summary, product_analysis
from profit_app.config import REPORT_TYPES
from profit_app.database import connect
from profit_app.importer import ImportProblem, clean_rows, parse_upload, suggest_mapping
from profit_app.services import add_cost, commit_import


def test_october_manual_standard_answer(isolated):
    db = connect(isolated["database"])
    try:
        summary = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        assert summary["gross_sales_fen"] == 88_736
        assert summary["refund_fen"] == 12_800
        assert summary["net_sales_fen"] == 75_936
        assert summary["known_cost_fen"] == 30_000
        assert summary["fee_fen"] == 3_612
        assert summary["expense_fen"] == 1_950
        assert summary["known_profit_fen"] == 40_374
        assert summary["order_count"] == 9
        assert summary["item_count"] == Decimal("10")
        assert summary["cancelled_count"] == 1
        assert summary["unknown_status_count"] == 1
        assert summary["completeness"]["complete"] is False
        assert [x["sku_id"] for x in summary["completeness"]["missing_costs"]] == ["SKU-C"]
        assert "本期间未见平台费用导入批次" not in summary["completeness"]["missing"]
        assert "本期间未见广告/其他经营费用导入批次" not in summary["completeness"]["missing"]
    finally:
        db.close()


def test_cross_month_refunds_and_unconfirmed_refund(isolated):
    db = connect(isolated["database"])
    try:
        september = build_summary(db, isolated["store_id"], None, "2026-09-01", "2026-09-30")
        october = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        assert september["gross_sales_fen"] == 10_000
        assert september["refund_fen"] == 0
        assert october["refund_fen"] == 12_800  # 20 partial + 100 cross-month + 8 unmatched
        assert db.execute("SELECT SUM(refund_amount_fen) FROM refunds WHERE is_confirmed=0").fetchone()[0] == 10_000
        assert db.execute("SELECT COUNT(*) FROM issues WHERE issue_type='unconfirmed_refund'").fetchone()[0] == 1
    finally:
        db.close()


def test_cancellation_missing_cost_and_product_allocations(isolated):
    db = connect(isolated["database"])
    try:
        summary = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        products, refund_unallocated, fee_unallocated, expense_unallocated = product_analysis(db, summary, "2026-10-01", "2026-10-31")
        sku_c = next(x for x in products if x["sku_id"] == "SKU-C")
        sku_b = next(x for x in products if x["sku_id"] == "SKU-B")
        assert summary["gross_sales_fen"] == 88_736  # cancelled row is excluded
        assert sku_c["missing_cost"] is True
        assert sku_c["cost_fen"] == 0  # accompanied by missing_cost; this is not treated as known zero cost
        assert sku_b["refund_fen"] == 2_000
        assert refund_unallocated == 10_800
        assert fee_unallocated == 0
        assert expense_unallocated == 1_200
    finally:
        db.close()


def test_settlement_difference_uses_pre_settlement_events(isolated):
    db = connect(isolated["database"])
    try:
        rows = db.execute("SELECT related_record_ids,amount_difference_fen,description FROM issues WHERE issue_type='settlement_mismatch'").fetchall()
        assert len(rows) == 1
        assert rows[0]["related_record_ids"] == "O-1007"
        assert rows[0]["amount_difference_fen"] == -300
        assert "不代表平台账单结论" in rows[0]["description"]
        october = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        assert october["settlement_fen"] == 82_824
    finally:
        db.close()


def test_unmatched_fee_and_unconfirmed_settlement_are_visible(isolated, tmp_path):
    db = connect(isolated["database"])
    try:
        store = db.execute("SELECT * FROM stores WHERE id=?", (isolated["store_id"],)).fetchone()
        fee_headers = ["费用流水号", "订单号", "费用类型", "费用金额", "费用发生日期"]
        fee_rows = [["F-EXTRA", "O-NOT-FOUND", "平台服务费", "1.00", "2026-10-15"]]
        fee_path = tmp_path / "unmatched_fee.csv"
        fee_path.write_text(",".join(fee_headers) + "\n" + ",".join(fee_rows[0]) + "\n", encoding="utf-8")
        mapping = suggest_mapping("fees", fee_headers)
        result = commit_import(db, store, "fees", fee_path.name, hashlib.sha256(fee_path.read_bytes()).hexdigest(), "CSV", fee_headers, fee_rows, mapping)
        assert result["accepted_count"] == 1
        assert db.execute("SELECT COUNT(*) FROM issues WHERE issue_type='unmatched_fee' AND status='open'").fetchone()[0] == 1
        summary = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        products, _refund, unallocated_fee, _expense = product_analysis(db, summary, "2026-10-01", "2026-10-31")
        assert summary["fee_fen"] == 3_712
        assert unallocated_fee == 100

        settle_headers = ["结算流水号", "订单号", "结算金额", "结算状态", "结算日期"]
        settle_rows = [["S-PENDING", "O-1002", "97.00", "待结算", "2026-10-15"]]
        settle_path = tmp_path / "pending_settlement.csv"
        settle_path.write_text(",".join(settle_headers) + "\n" + ",".join(settle_rows[0]) + "\n", encoding="utf-8")
        settle_mapping = suggest_mapping("settlements", settle_headers)
        commit_import(db, store, "settlements", settle_path.name, hashlib.sha256(settle_path.read_bytes()).hexdigest(), "CSV", settle_headers, settle_rows, settle_mapping)
        assert db.execute("SELECT COUNT(*) FROM issues WHERE issue_type='unconfirmed_settlement' AND status='open'").fetchone()[0] == 1
        summary = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        assert summary["settlement_fen"] == 82_824
    finally:
        db.close()


def test_duplicate_file_and_record_level_deduplication(isolated, tmp_path):
    db = connect(isolated["database"])
    try:
        store = db.execute("SELECT * FROM stores WHERE id=?", (isolated["store_id"],)).fetchone()
        order_path = Path(__file__).resolve().parents[1] / "data" / "demo_reports" / "orders.csv"
        parsed = parse_upload(order_path, "orders.csv")
        mapping = suggest_mapping("orders", parsed.headers)
        digest = hashlib.sha256(order_path.read_bytes()).hexdigest()
        try:
            commit_import(db, store, "orders", "orders.csv", digest, parsed.selected_sheet, parsed.headers, parsed.rows, mapping)
            assert False, "same file should be blocked"
        except ValueError as exc:
            assert "导入" in str(exc)

        headers = parsed.headers
        row = parsed.rows[1]  # O-1002, an exact record already in the database
        extra_path = tmp_path / "same_order.csv"
        extra_path.write_text(",".join(headers) + "\n" + ",".join(str(x or "") for x in row) + "\n", encoding="utf-8")
        extra = parse_upload(extra_path, extra_path.name)
        extra_hash = hashlib.sha256(extra_path.read_bytes()).hexdigest()
        result = commit_import(db, store, "orders", extra_path.name, extra_hash, extra.selected_sheet, extra.headers, extra.rows, mapping)
        assert result["accepted_count"] == 0
        assert result["duplicate_count"] == 1
        assert db.execute("SELECT COUNT(*) FROM orders WHERE store_id=?", (isolated["store_id"],)).fetchone()[0] == 12

        changed_row = list(row)
        amount_i = headers.index("商品实付金额")
        changed_row[amount_i] = "99.00"
        conflict_path = tmp_path / "changed_order.csv"
        conflict_path.write_text(",".join(headers) + "\n" + ",".join(str(x or "") for x in changed_row) + "\n", encoding="utf-8")
        conflict = parse_upload(conflict_path, conflict_path.name)
        conflict_result = commit_import(db, store, "orders", conflict_path.name, hashlib.sha256(conflict_path.read_bytes()).hexdigest(), conflict.selected_sheet, conflict.headers, conflict.rows, mapping)
        assert conflict_result["conflict_count"] == 1
        assert db.execute("SELECT COUNT(*) FROM orders WHERE store_id=?", (isolated["store_id"],)).fetchone()[0] == 12
    finally:
        db.close()


def test_cost_versions_preserve_prior_cost_and_recalculate_issues(isolated):
    db = connect(isolated["database"])
    try:
        db.execute("SELECT 1")
        add_cost(db, isolated["store_id"], "SKU-A", "Type-C充电线", 3_500, "2026-10-15")
        old = db.execute("SELECT unit_cost_fen,effective_to FROM product_costs WHERE store_id=? AND sku_id='SKU-A' AND effective_from='2026-01-01'", (isolated["store_id"],)).fetchone()
        new = db.execute("SELECT unit_cost_fen,effective_to FROM product_costs WHERE store_id=? AND sku_id='SKU-A' AND effective_from='2026-10-15'", (isolated["store_id"],)).fetchone()
        assert old["unit_cost_fen"] == 3_000
        assert old["effective_to"] == "2026-10-14"
        assert new["unit_cost_fen"] == 3_500
        assert new["effective_to"] is None
        add_cost(db, isolated["store_id"], "SKU-C", "透明手机壳", 2_000, "2026-01-01")
        current = build_summary(db, isolated["store_id"], None, "2026-10-01", "2026-10-31")
        assert current["known_cost_fen"] == 32_000
        assert current["completeness"]["complete"] is True
        assert db.execute("SELECT COUNT(*) FROM issues WHERE issue_type='missing_cost' AND status='superseded'").fetchone()[0] == 1
    finally:
        db.close()


def test_invalid_amount_is_rejected_not_zeroed():
    headers = ["订单号", "下单时间", "订单状态", "商品编码", "数量", "商品实付金额"]
    rows = [["O-BAD", "2026-10-01", "已完成", "SKU-X", "1", "not-money"]]
    mapping = suggest_mapping("orders", headers)
    cleaned = clean_rows("orders", headers, rows, mapping)
    assert len(cleaned) == 1
    assert cleaned[0].data == {}
    assert cleaned[0].status == "rejected"
    assert "不是有效数字" in cleaned[0].errors[0]


def test_money_and_date_normalization():
    from profit_app.importer import money_fen, _date

    assert money_fen("0.10", "金额") + money_fen("0.20", "金额") == 30
    assert money_fen("(1,234.56)", "调整", allow_negative=True) == -123_456
    assert _date("2026 年 10 月 05 日", "日期") == "2026-10-05"

