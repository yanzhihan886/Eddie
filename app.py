from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from flask import Flask, abort, flash, g, jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.utils import secure_filename

from profit_app.calculations import build_summary, daily_trend, fmt_money, product_analysis, store_analysis
from profit_app.config import (ALIASES, DATA_DIR, EXPORT_DIR, FIELD_SPECS, MAX_DATA_ROWS, MAX_UPLOAD_BYTES,
                               PLATFORMS, REPORT_TYPES, STAGING_DIR)
from profit_app.database import connect, init_db
from profit_app.demo import seed_demo_database
from profit_app.exporter import create_report
from profit_app.importer import ImportProblem, clean_rows, money_fen, parse_upload, suggest_mapping
from profit_app.services import add_cost, commit_import, create_store, inspect_rows, query_issues, resolve_issue


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__)
    public_demo_from_env = _env_flag("SELLER_MVP_DEMO_MODE")
    configured_secret = os.environ.get("SELLER_MVP_SECRET")
    if public_demo_from_env and not configured_secret:
        raise RuntimeError("公开 Demo 必须通过 SELLER_MVP_SECRET 设置随机密钥。")
    app.config.update(
        SECRET_KEY=configured_secret or secrets.token_urlsafe(32),
        DATABASE=str(Path(os.environ.get("SELLER_MVP_DATABASE", DATA_DIR / "seller_profit.sqlite3")).resolve()),
        STAGING_DIR=str(STAGING_DIR.resolve()), EXPORT_DIR=str(EXPORT_DIR.resolve()),
        DEMO_MODE=public_demo_from_env,
        DEMO_DATA_DIR=str(Path(os.environ.get("SELLER_MVP_DEMO_DATA_DIR", Path(tempfile.gettempdir()) / "seller-profit-assistant-demo")).resolve()),
        DEMO_REPORTS_DIR=str((Path(__file__).parent / "data" / "demo_reports").resolve()),
        DEMO_SESSION_TTL_HOURS=float(os.environ.get("SELLER_MVP_DEMO_SESSION_TTL_HOURS", "6")),
        DEMO_MAX_SESSIONS=int(os.environ.get("SELLER_MVP_DEMO_MAX_SESSIONS", "50")),
        SESSION_COOKIE_SECURE=_env_flag("SELLER_MVP_COOKIE_SECURE"),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=float(os.environ.get("SELLER_MVP_DEMO_SESSION_TTL_HOURS", "6"))),
        MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES + 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)
    if app.config["DEMO_MODE"]:
        Path(app.config["DEMO_DATA_DIR"]).mkdir(parents=True, exist_ok=True)
    else:
        Path(app.config["STAGING_DIR"]).mkdir(parents=True, exist_ok=True)
        Path(app.config["EXPORT_DIR"]).mkdir(parents=True, exist_ok=True)
        init_db(app.config["DATABASE"])

    demo_seed_lock = threading.Lock()
    demo_cleanup_lock = threading.Lock()
    next_demo_cleanup = [0.0]

    def current_staging_dir() -> Path:
        if app.config["DEMO_MODE"]:
            return Path(g.demo_staging_dir)
        return Path(app.config["STAGING_DIR"])

    @app.before_request
    def prepare_demo_workspace():
        if not app.config["DEMO_MODE"] or request.endpoint in {"health", "static", "demo_report", "favicon_ico"}:
            return

        workspace_id = session.get("demo_workspace_id")
        if not isinstance(workspace_id, str) or not re.fullmatch(r"[a-f0-9]{32}", workspace_id):
            workspace_id = secrets.token_hex(16)
            session["demo_workspace_id"] = workspace_id
        session.permanent = True

        root = Path(app.config["DEMO_DATA_DIR"]).resolve()
        workspace = (root / workspace_id).resolve()
        if root not in workspace.parents:
            abort(400)
        if workspace.exists():
            os.utime(workspace, None)

        now = time.monotonic()
        if now >= next_demo_cleanup[0]:
            with demo_cleanup_lock:
                if now >= next_demo_cleanup[0]:
                    cutoff = time.time() - app.config["DEMO_SESSION_TTL_HOURS"] * 60 * 60
                    for old_workspace in root.iterdir():
                        if (old_workspace.name != workspace_id
                                and re.fullmatch(r"[a-f0-9]{32}", old_workspace.name)
                                and old_workspace.is_dir()
                                and not old_workspace.is_symlink()
                                and old_workspace.stat().st_mtime < cutoff):
                            shutil.rmtree(old_workspace, ignore_errors=True)
                    next_demo_cleanup[0] = now + 60

        if not workspace.exists():
            active_sessions = sum(
                1 for child in root.iterdir()
                if child.is_dir() and not child.is_symlink() and re.fullmatch(r"[a-f0-9]{32}", child.name)
            )
            if active_sessions >= app.config["DEMO_MAX_SESSIONS"]:
                return "公开 Demo 当前体验人数较多，请稍后重试。", 503
            workspace.mkdir(parents=True, exist_ok=True)
        os.utime(workspace, None)
        g.demo_workspace = workspace
        g.demo_staging_dir = str(workspace / "staging")
        g.demo_database_path = str(workspace / "seller_profit.sqlite3")
        Path(g.demo_staging_dir).mkdir(parents=True, exist_ok=True)
        (workspace / "exports").mkdir(parents=True, exist_ok=True)
        g.database_path = g.demo_database_path

        database_path = Path(g.demo_database_path)
        if not database_path.exists():
            with demo_seed_lock:
                if not database_path.exists():
                    seed_demo_database(database_path, app.config["DEMO_REPORTS_DIR"])

    def db():
        if "db" not in g:
            g.db = connect(getattr(g, "database_path", app.config["DATABASE"]))
        return g.db

    @app.teardown_appcontext
    def close_db(_error=None):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.context_processor
    def inject_navigation_issue_count():
        count = db().execute("SELECT COUNT(*) FROM issues WHERE status IN ('open','review')").fetchone()[0]
        return {"nav_issue_count": count, "demo_mode": app.config["DEMO_MODE"]}

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.errorhandler(413)
    def too_large(_error):
        upload_limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
        return render_template("error.html", title="文件超出限制", message=f"上传文件不能超过 {upload_limit_mb} MB。请拆分报表后重试。"), 413

    def stores():
        return db().execute("SELECT * FROM stores WHERE status='active' ORDER BY platform,name").fetchall()

    def period_from_request():
        today = date.today()
        latest = db().execute("""SELECT MAX(d) FROM (
          SELECT MAX(ordered_at) d FROM orders UNION ALL SELECT MAX(completed_at) FROM refunds
          UNION ALL SELECT MAX(fee_date) FROM fees UNION ALL SELECT MAX(expense_date) FROM expenses)""").fetchone()[0]
        end_default = date.fromisoformat(latest) if latest else today
        start_default = end_default - timedelta(days=29)
        try:
            start = date.fromisoformat(request.args.get("start", start_default.isoformat()))
            end = date.fromisoformat(request.args.get("end", end_default.isoformat()))
        except ValueError:
            start, end = start_default, end_default
        if end < start:
            start, end = end, start
        if (end - start).days > 366:
            start = end - timedelta(days=366)
        return start.isoformat(), end.isoformat()

    def stage_path(token: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", token):
            abort(404)
        directory = current_staging_dir().resolve()
        path = (directory / f"{token}.json").resolve()
        if directory not in path.parents or not path.exists():
            abort(404)
        return path

    def clean_expired_staging() -> None:
        directory = current_staging_dir().resolve()
        cutoff = datetime.now().timestamp() - 24 * 60 * 60
        for meta_path in directory.glob("[0-9a-f]" * 32 + ".json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if float(meta.get("created_at", 0)) >= cutoff:
                    continue
                data_path = (directory / meta["stored_file"]).resolve()
                if directory in data_path.parents:
                    data_path.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
            except (OSError, KeyError, ValueError, json.JSONDecodeError):
                meta_path.unlink(missing_ok=True)

    @app.get("/favicon.ico")
    def favicon_ico():
        return "", 204

    def read_stage(token: str):
        meta_path = stage_path(token)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        data_path = (meta_path.parent / meta["stored_file"]).resolve()
        if meta_path.parent.resolve() not in data_path.parents or not data_path.exists():
            abort(404)
        return meta, data_path

    def mapping_from_form(report_type: str) -> dict[str, str]:
        return {key: request.form.get(f"map_{key}", "").strip() for key, *_ in FIELD_SPECS[report_type]}

    def render_stage(token: str, meta: dict, data_path: Path, mapping: dict | None = None, checked: list | None = None, error: str | None = None):
        try:
            parsed = parse_upload(data_path, meta["original_filename"], meta.get("sheet_name"))
        except ImportProblem as exc:
            return render_template("error.html", title="无法预览文件", message=str(exc)), 400
        mapping = mapping or suggest_mapping(meta["report_type"], parsed.headers)
        counts = None
        sample = []
        if checked is not None:
            counts = {key: sum(row.status == key for row in checked) for key in ("accepted", "rejected", "duplicate", "conflict")}
            sample = checked[:25]
        existing = db().execute("SELECT imported_at FROM import_batches WHERE store_id=? AND report_type=? AND file_hash=?", (meta["store_id"], meta["report_type"], meta["file_hash"])).fetchone()
        return render_template("import_preview.html", token=token, meta=meta, parsed=parsed, fields=FIELD_SPECS[meta["report_type"]],
                               mapping=mapping, counts=counts, sample=sample, error=error,
                               duplicate_file=existing["imported_at"] if existing else None,
                               raw_preview=parsed.rows[:12])

    @app.get("/health")
    def health():
        if app.config["DEMO_MODE"]:
            return jsonify({"status": "ok", "mode": "public-demo"})
        db().execute("SELECT 1").fetchone()
        return jsonify({"status": "ok", "mode": "local", "database": "connected"})

    @app.get("/guide")
    def guide_page():
        has_active_store = db().execute("SELECT 1 FROM stores WHERE status='active' LIMIT 1").fetchone() is not None
        start_url = url_for("imports_page") if has_active_store else url_for("store_page")
        start_label = "导入一份经营报表" if has_active_store else "创建第一家店铺"
        return render_template("guide.html", title="快速上手", start_url=start_url, start_label=start_label)

    @app.get("/")
    def dashboard():
        start, end = period_from_request()
        store_id = request.args.get("store_id") or None
        platform = request.args.get("platform") or None
        summary = build_summary(db(), store_id, platform, start, end)
        trend = daily_trend(db(), summary, store_id, platform, start, end)
        products, refund_unallocated, fee_unallocated, expense_unallocated = product_analysis(db(), summary, start, end)
        max_sales = max([x["sales"] for x in trend] or [0])
        max_profit = max([abs(x["known_profit_fen"]) for x in products] or [1])
        for day in trend:
            day["bar"] = max(2, int(100 * day["sales"] / max_sales)) if max_sales else 0
        for item in products[:8]:
            item["bar"] = max(3, int(100 * abs(item["known_profit_fen"]) / max_profit))
        platform_rows = []
        for p in PLATFORMS:
            if platform and platform != p:
                continue
            psummary = build_summary(db(), store_id, p, start, end)
            if psummary["store_ids"]:
                platform_rows.append({"platform": p, **psummary})
        issue_rows = query_issues(db(), store_id=store_id, status="open")[:5]
        return render_template("dashboard.html", title="经营总览", stores=stores(), platforms=PLATFORMS, start=start, end=end,
                               selected_store=store_id, selected_platform=platform, summary=summary, trend=trend,
                               products=products[:8], platform_rows=platform_rows, issue_rows=issue_rows,
                               fmt_money=fmt_money, refund_unallocated=refund_unallocated, fee_unallocated=fee_unallocated,
                               expense_unallocated=expense_unallocated)

    @app.route("/stores", methods=["GET", "POST"])
    def store_page():
        if request.method == "POST":
            action = request.form.get("action")
            if action == "create":
                name = request.form.get("name", "").strip()
                platform = request.form.get("platform", "")
                if not name or platform not in PLATFORMS:
                    flash("请填写店铺名称并选择平台。", "error")
                else:
                    create_store(db(), platform, name)
                    db().commit()
                    flash("店铺已创建。", "success")
            elif action == "update":
                store_id = request.form.get("store_id", "")
                name = request.form.get("name", "").strip()
                status = request.form.get("status", "active")
                if status not in {"active", "archived"} or not name:
                    flash("店铺信息不完整。", "error")
                else:
                    db().execute("UPDATE stores SET name=?,status=?,updated_at=datetime('now') WHERE id=?", (name, status, store_id))
                    db().commit()
                    flash("店铺信息已保存。", "success")
            return redirect(url_for("store_page"))
        all_stores = db().execute("SELECT * FROM stores ORDER BY status,platform,name").fetchall()
        return render_template("stores.html", title="店铺管理", stores=all_stores, platforms=PLATFORMS)

    @app.get("/imports")
    def imports_page():
        clean_expired_staging()
        batch_rows = db().execute("""SELECT import_batches.*,stores.name AS store_name FROM import_batches
            JOIN stores ON stores.id=import_batches.store_id ORDER BY imported_at DESC LIMIT 100""").fetchall()
        demo_dir = Path(__file__).parent.joinpath("data", "demo_reports")
        demo_files = [{"name": p.name, "size": p.stat().st_size} for p in sorted(demo_dir.glob("*")) if p.is_file()]
        return render_template("imports.html", title="文件导入", stores=stores(), report_types=REPORT_TYPES, batches=batch_rows,
                               max_mb=MAX_UPLOAD_BYTES // (1024 * 1024), max_rows=MAX_DATA_ROWS, demo_files=demo_files)

    @app.get("/demo-reports/<filename>")
    def demo_report(filename: str):
        allowed = {"orders.csv", "refunds.csv", "fees.csv", "settlements.csv", "costs.csv", "expenses.csv"}
        if filename not in allowed:
            abort(404)
        path = Path(__file__).parent.joinpath("data", "demo_reports", filename)
        if not path.is_file():
            abort(404)
        return send_file(path, as_attachment=True, download_name=f"模拟_{filename}", mimetype="text/csv; charset=utf-8")

    @app.post("/imports/preview")
    def upload_preview():
        file = request.files.get("file")
        store_id = request.form.get("store_id", "")
        report_type = request.form.get("report_type", "")
        store = db().execute("SELECT * FROM stores WHERE id=? AND status='active'", (store_id,)).fetchone()
        if not store:
            flash("请先创建或选择有效店铺。", "error")
            return redirect(url_for("imports_page"))
        if report_type not in REPORT_TYPES:
            flash("请选择报表类型。", "error")
            return redirect(url_for("imports_page"))
        if not file or not file.filename:
            flash("请选择要上传的文件。", "error")
            return redirect(url_for("imports_page"))
        original = file.filename
        suffix = Path(original).suffix.lower()
        if suffix not in {".xlsx", ".csv", ".tsv"}:
            flash("只支持 xlsx、csv、tsv。旧版 xls 请另存为 xlsx。", "error")
            return redirect(url_for("imports_page"))
        filename = f"{secure_filename(Path(original).stem) or 'uploaded'}{suffix}"
        token = uuid.uuid4().hex
        staging_dir = current_staging_dir()
        stored = f"{token}{suffix}"
        path = staging_dir / stored
        file.save(path)
        if path.stat().st_size > MAX_UPLOAD_BYTES:
            path.unlink(missing_ok=True)
            flash("文件超过 20 MB 限制。", "error")
            return redirect(url_for("imports_page"))
        file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        meta = {"stored_file": stored, "original_filename": filename, "file_hash": file_hash,
                "store_id": store_id, "store_name": store["name"], "platform": store["platform"],
                "report_type": report_type, "report_label": REPORT_TYPES[report_type], "created_at": datetime.now().timestamp()}
        try:
            parsed = parse_upload(path, filename)
            meta["sheet_names"] = parsed.sheet_names
            meta["sheet_name"] = parsed.selected_sheet
            (staging_dir / f"{token}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            return redirect(url_for("import_stage", token=token))
        except ImportProblem as exc:
            path.unlink(missing_ok=True)
            (staging_dir / f"{token}.json").unlink(missing_ok=True)
            return render_template("error.html", title="无法读取文件", message=str(exc)), 400

    @app.route("/imports/<token>", methods=["GET", "POST"])
    def import_stage(token: str):
        meta, data_path = read_stage(token)
        if request.method == "GET":
            return render_stage(token, meta, data_path)
        action = request.form.get("action", "check")
        if action == "cancel":
            data_path.unlink(missing_ok=True)
            stage_path(token).unlink(missing_ok=True)
            flash("已取消本次导入，文件暂存已清理。", "info")
            return redirect(url_for("imports_page"))
        if action == "sheet":
            sheet = request.form.get("sheet_name", "")
            try:
                parsed = parse_upload(data_path, meta["original_filename"], sheet)
                meta["sheet_name"] = parsed.selected_sheet
                stage_path(token).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
                return render_stage(token, meta, data_path)
            except ImportProblem as exc:
                return render_stage(token, meta, data_path, error=str(exc)), 400
        mapping = mapping_from_form(meta["report_type"])
        try:
            parsed = parse_upload(data_path, meta["original_filename"], meta.get("sheet_name"))
            checked = inspect_rows(db(), meta["store_id"], meta["report_type"], parsed.headers, parsed.rows, mapping)
            if action == "confirm":
                store = db().execute("SELECT * FROM stores WHERE id=?", (meta["store_id"],)).fetchone()
                result = commit_import(db(), store, meta["report_type"], meta["original_filename"], meta["file_hash"], parsed.selected_sheet,
                                       parsed.headers, parsed.rows, mapping)
                data_path.unlink(missing_ok=True)
                stage_path(token).unlink(missing_ok=True)
                flash(f"导入批次完成：接收 {result['accepted_count']} 行，拒绝 {result['rejected_count']} 行，重复 {result['duplicate_count']} 行，冲突 {result['conflict_count']} 行。", "success")
                return redirect(url_for("imports_page"))
            meta["mapping"] = mapping
            stage_path(token).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            return render_stage(token, meta, data_path, mapping=mapping, checked=checked)
        except (ImportProblem, ValueError) as exc:
            return render_stage(token, meta, data_path, mapping=mapping, error=str(exc)), 400

    @app.get("/costs")
    def costs_page():
        store_id = request.args.get("store_id") or None
        all_costs = db().execute("""SELECT product_costs.*,stores.name AS store_name,stores.platform FROM product_costs
            JOIN stores ON stores.id=product_costs.store_id WHERE (? IS NULL OR product_costs.store_id=?)
            ORDER BY stores.platform,stores.name,sku_id,effective_from DESC""", (store_id, store_id)).fetchall()
        missing = db().execute("""SELECT DISTINCT o.store_id,o.sku_id,MAX(o.product_name) product_name,s.name store_name,s.platform
            FROM orders o JOIN stores s ON s.id=o.store_id LEFT JOIN product_costs c ON c.store_id=o.store_id AND c.sku_id=o.sku_id
              AND c.effective_from<=o.ordered_at AND (c.effective_to IS NULL OR c.effective_to>=o.ordered_at)
            WHERE o.status_class='valid' AND c.id IS NULL AND (? IS NULL OR o.store_id=?) GROUP BY o.store_id,o.sku_id""", (store_id, store_id)).fetchall()
        return render_template("costs.html", title="商品成本", stores=stores(), selected_store=store_id, costs=all_costs, missing=missing)

    @app.post("/costs")
    def add_cost_route():
        store_id = request.form.get("store_id", "")
        sku_id = request.form.get("sku_id", "").strip()
        name = request.form.get("product_name", "").strip()
        effective = request.form.get("effective_from", "").strip() or "1900-01-01"
        try:
            amount = money_fen(request.form.get("unit_cost"), "单位成本")
            date.fromisoformat(effective)
            if not sku_id:
                raise ValueError("SKU 编号不能为空。")
            add_cost(db(), store_id, sku_id, name, amount, effective)
            db().commit()
            flash(f"SKU {sku_id} 成本版本已保存。", "success")
        except Exception as exc:
            db().rollback()
            flash(f"保存失败：{exc}", "error")
        return redirect(url_for("costs_page", store_id=store_id))

    @app.route("/issues", methods=["GET", "POST"])
    def issues_page():
        if request.method == "POST":
            issue_id = request.form.get("issue_id", "")
            status = request.form.get("status", "open")
            note = request.form.get("resolution_note", "")
            if resolve_issue(db(), issue_id, status, note):
                db().commit()
                flash("异常处理记录已保存。", "success")
            else:
                flash("未找到异常或状态无效。", "error")
            return redirect(url_for("issues_page", store_id=request.form.get("store_id") or "", status_filter=request.form.get("status_filter") or ""))
        store_id = request.args.get("store_id") or None
        status_filter = request.args.get("status_filter") or "open"
        return render_template("issues.html", title="对账与异常", stores=stores(), issues=query_issues(db(), store_id, status_filter),
                               selected_store=store_id, status_filter=status_filter)

    @app.get("/analytics")
    def analytics_page():
        start, end = period_from_request()
        analyses = store_analysis(db(), start, end)
        selected_store = request.args.get("store_id") or None
        if selected_store:
            analyses = [x for x in analyses if x["store_id"] == selected_store]
        products = []
        if selected_store:
            summary = build_summary(db(), selected_store, None, start, end)
            products, refund_unallocated, fee_unallocated, expense_unallocated = product_analysis(db(), summary, start, end)
        else:
            refund_unallocated = fee_unallocated = expense_unallocated = 0
        return render_template("analytics.html", title="店铺与商品分析", stores=stores(), analyses=analyses, products=products,
                               selected_store=selected_store, start=start, end=end, fmt_money=fmt_money,
                               refund_unallocated=refund_unallocated, fee_unallocated=fee_unallocated, expense_unallocated=expense_unallocated)

    @app.get("/reports.xlsx")
    def report_download():
        start, end = period_from_request()
        store_id = request.args.get("store_id") or None
        platform = request.args.get("platform") or None
        file = create_report(db(), store_id, platform, start, end)
        filename = f"卖家利润助手经营报告_{start}_{end}.xlsx"
        return send_file(file, as_attachment=True, download_name=filename,
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.errorhandler(Exception)
    def handle_unexpected(error):
        if app.testing:
            raise error
        app.logger.exception("Unhandled local MVP error", exc_info=error)
        return render_template("error.html", title="操作未完成", message="本地应用遇到错误。请返回重试；若持续发生，请查看启动服务的终端输出。"), 500

    return app


app = create_app()


if __name__ == "__main__":
    host = os.environ.get("SELLER_MVP_HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    port = int(os.environ.get("PORT", os.environ.get("SELLER_MVP_PORT", "8765")))
    app.run(host=host, port=port, debug=False)
