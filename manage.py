from __future__ import annotations

import argparse
import hashlib
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from profit_app.calculations import save_calculation_run
from profit_app.config import DATA_DIR, DATABASE_PATH, REPORT_TYPES
from profit_app.database import connect, init_db
from profit_app.importer import parse_upload, suggest_mapping
from profit_app.services import commit_import, create_store


def backup_database(path: Path, backup_dir: Path) -> Path | None:
    if not path.exists():
        return None
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"seller_profit_{datetime.now().strftime('%Y%m%d_%H%M%S')}.sqlite3"
    src = sqlite3.connect(path)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return target


def load_demo(path: Path) -> None:
    if not path.exists():
        init_db(path)
    db = connect(path)
    try:
        store = db.execute("SELECT * FROM stores WHERE platform='其他/演示' AND name='模拟配件店（虚构数据）'").fetchone()
        if store is None:
            store_id = create_store(db, "其他/演示", "模拟配件店（虚构数据）")
            db.commit()
            store = db.execute("SELECT * FROM stores WHERE id=?", (store_id,)).fetchone()
        folder = Path(__file__).parent / "data" / "demo_reports"
        order = ["costs.csv", "orders.csv", "refunds.csv", "fees.csv", "settlements.csv", "expenses.csv"]
        report_type_by_file = {"costs.csv": "costs", "orders.csv": "orders", "refunds.csv": "refunds", "fees.csv": "fees", "settlements.csv": "settlements", "expenses.csv": "expenses"}
        for filename in order:
            file_path = folder / filename
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            if db.execute("SELECT 1 FROM import_batches WHERE store_id=? AND report_type=? AND file_hash=?", (store["id"], report_type_by_file[filename], digest)).fetchone():
                continue
            parsed = parse_upload(file_path, filename)
            mapping = suggest_mapping(report_type_by_file[filename], parsed.headers)
            result = commit_import(db, store, report_type_by_file[filename], filename, digest, parsed.selected_sheet, parsed.headers, parsed.rows, mapping)
            print(f"{REPORT_TYPES[report_type_by_file[filename]]}: 接收 {result['accepted_count']}，重复 {result['duplicate_count']}，拒绝 {result['rejected_count']}，冲突 {result['conflict_count']}")
        print(f"演示数据已加载到店铺：{store['name']}（全部虚构）")
    finally:
        db.close()


def restore_database(path: Path, backup_path: Path, backup_dir: Path) -> None:
    backup_dir = backup_dir.resolve()
    backup_path = backup_path.resolve()
    if backup_dir not in backup_path.parents or not backup_path.is_file():
        raise ValueError("只能从 data/backups/ 中选择已有备份文件。")
    check = sqlite3.connect(backup_path)
    try:
        result = check.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise ValueError(f"备份完整性检查失败：{result}")
    finally:
        check.close()
    current_backup = backup_database(path, backup_dir)
    temp_path = path.with_suffix(".restore.tmp")
    src = sqlite3.connect(backup_path)
    dst = sqlite3.connect(temp_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()
    temp_path.replace(path)
    print(f"数据库已恢复：{backup_path}")
    if current_backup:
        print(f"恢复前数据库备份：{current_backup}")


def main() -> int:
    parser = argparse.ArgumentParser(description="卖家利润助手本地数据库工具")
    parser.add_argument("command", choices=["init-db", "reset-db", "backup-db", "restore-db", "load-demo"])
    parser.add_argument("--confirm", action="store_true", help="确认执行数据库重置")
    parser.add_argument("--backup", help="从 data/backups/ 中指定要恢复的数据库文件")
    args = parser.parse_args()
    path = DATABASE_PATH
    if args.command == "init-db":
        init_db(path)
        print(f"数据库已初始化：{path}")
    elif args.command == "reset-db":
        if not args.confirm:
            print("为防止误删，请同时提供 --confirm。", file=sys.stderr)
            return 2
        backup = backup_database(path, DATA_DIR / "backups")
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(path) + suffix)
            if candidate.exists():
                candidate.unlink()
        init_db(path)
        print(f"数据库已重置：{path}")
        if backup:
            print(f"重置前数据库备份：{backup}")
    elif args.command == "backup-db":
        backup = backup_database(path, DATA_DIR / "backups")
        if backup:
            print(f"数据库备份已创建：{backup}")
        else:
            print("数据库尚不存在；没有需要备份的内容。")
    elif args.command == "restore-db":
        if not args.confirm or not args.backup:
            print("恢复会替换当前数据库；请提供 --confirm 和 --backup <文件名>。", file=sys.stderr)
            return 2
        selected = (DATA_DIR / "backups" / args.backup).resolve()
        restore_database(path, selected, DATA_DIR / "backups")
    elif args.command == "load-demo":
        load_demo(path)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
