from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SELLER_MVP_DATA_DIR", BASE_DIR / "data")).resolve()
DATABASE_PATH = Path(os.environ.get("SELLER_MVP_DATABASE", DATA_DIR / "seller_profit.sqlite3")).resolve()
STAGING_DIR = DATA_DIR / "staging"
EXPORT_DIR = DATA_DIR / "exports"
MAX_UPLOAD_BYTES = int(os.environ.get("SELLER_MVP_MAX_UPLOAD_MB", "20")) * 1024 * 1024
MAX_DATA_ROWS = int(os.environ.get("SELLER_MVP_MAX_ROWS", "50000"))
TEMPLATE_VERSION = "generic-mapping-v1"
CALCULATION_RULE_VERSION = "event-period-fen-v1"

PLATFORMS = ["淘宝/天猫", "拼多多", "抖音电商", "其他/演示"]
REPORT_TYPES = {
    "orders": "订单明细",
    "refunds": "退款明细",
    "fees": "平台费用",
    "settlements": "结算明细",
    "costs": "商品成本",
    "expenses": "其他费用",
}

FIELD_SPECS = {
    "orders": [
        ("platform_order_id", "平台订单号", True, ["订单编号", "订单号", "主订单编号", "平台订单号", "order_id", "订单id"]),
        ("ordered_at", "下单日期", True, ["订单日期", "下单时间", "创建时间", "付款时间", "订单创建时间", "date", "order_date"]),
        ("order_status", "订单状态", True, ["订单状态", "交易状态", "售后状态", "状态", "status"]),
        ("sku_id", "SKU编号", True, ["商品编码", "商品编号", "sku", "sku_id", "商家编码", "规格编码"]),
        ("product_name", "商品名称", False, ["商品名称", "商品标题", "货品名称", "商品", "product_name"]),
        ("quantity", "销售数量", True, ["购买数量", "商品数量", "数量", "件数", "quantity", "qty"]),
        ("item_amount", "商品销售金额", False, ["商品实付金额", "商品金额", "商品销售额", "实付金额", "订单金额", "销售金额", "item_amount", "amount"]),
        ("unit_price", "商品单价（可替代金额）", False, ["商品单价", "成交单价", "单价", "unit_price", "price"]),
        ("discount_amount", "商品优惠金额", False, ["优惠金额", "商品优惠", "折扣金额", "discount", "discount_amount"]),
        ("platform_item_id", "平台商品明细号", False, ["子订单编号", "明细编号", "商品明细ID", "子订单号", "item_id"]),
    ],
    "refunds": [
        ("platform_refund_id", "平台退款单号", False, ["退款单号", "售后单号", "退款编号", "refund_id"]),
        ("platform_order_id", "平台订单号", True, ["订单编号", "订单号", "主订单编号", "platform_order_id", "order_id"]),
        ("platform_item_id", "平台商品明细号", False, ["子订单编号", "商品明细ID", "明细编号", "item_id"]),
        ("refund_status", "退款状态", True, ["退款状态", "售后状态", "状态", "refund_status"]),
        ("refund_amount", "退款金额", True, ["退款金额", "退款总金额", "实退金额", "refund_amount", "amount"]),
        ("completed_at", "退款完成日期", True, ["退款完成时间", "退款时间", "完成时间", "退款成功时间", "refund_date"]),
    ],
    "fees": [
        ("fee_id", "费用记录编号", False, ["费用编号", "账单编号", "流水号", "fee_id"]),
        ("platform_order_id", "平台订单号（可空）", False, ["订单编号", "订单号", "关联订单号", "order_id"]),
        ("fee_type", "费用类型", True, ["费用类型", "费用名称", "账单类型", "项目", "fee_type"]),
        ("fee_amount", "费用金额", True, ["费用金额", "支出金额", "扣款金额", "手续费", "fee_amount", "amount"]),
        ("fee_date", "费用发生日期", True, ["费用发生日期", "账单日期", "发生时间", "扣款时间", "账单时间", "date", "fee_date"]),
    ],
    "settlements": [
        ("transaction_id", "结算流水号", False, ["结算流水号", "流水号", "交易编号", "transaction_id"]),
        ("platform_order_id", "平台订单号（可空）", False, ["订单编号", "订单号", "关联订单号", "order_id"]),
        ("settlement_amount", "结算金额", True, ["结算金额", "实际到账", "实收金额", "到账金额", "settlement_amount", "amount"]),
        ("settlement_status", "结算状态", True, ["结算状态", "账单状态", "状态", "status"]),
        ("settlement_date", "结算日期", True, ["结算日期", "到账日期", "账单日期", "结算时间", "date"]),
    ],
    "costs": [
        ("sku_id", "SKU编号", True, ["商品编码", "商品编号", "sku", "sku_id", "商家编码"]),
        ("product_name", "商品名称", False, ["商品名称", "商品标题", "product_name"]),
        ("unit_cost", "单位成本", True, ["单位成本", "采购成本", "商品成本", "进货价", "成本", "unit_cost", "cost"]),
        ("effective_from", "生效日期（可空，默认最早）", False, ["生效日期", "开始日期", "effective_from"]),
        ("effective_to", "失效日期（可空）", False, ["失效日期", "结束日期", "effective_to"]),
    ],
    "expenses": [
        ("expense_id", "费用编号", False, ["费用编号", "流水号", "expense_id"]),
        ("expense_type", "经营费用类型", True, ["费用类型", "费用名称", "项目", "expense_type"]),
        ("expense_amount", "费用金额", True, ["费用金额", "支出金额", "金额", "expense_amount", "amount"]),
        ("expense_date", "费用发生日期", True, ["费用日期", "账单日期", "发生时间", "日期", "expense_date"]),
        ("allocation_method", "分摊方式（可空）", False, ["分摊方式", "分配方式", "allocation_method"]),
        ("platform_order_id", "关联订单号（可空）", False, ["订单号", "关联订单", "order_id"]),
        ("sku_id", "关联SKU（可空）", False, ["SKU编号", "商品编码", "sku", "sku_id"]),
        ("note", "备注（可空）", False, ["备注", "说明", "note"]),
    ],
}

DATE_FIELDS = {
    "orders": {"ordered_at"},
    "refunds": {"completed_at"},
    "fees": {"fee_date"},
    "settlements": {"settlement_date"},
    "costs": {"effective_from", "effective_to"},
    "expenses": {"expense_date"},
}

MONEY_FIELDS = {
    "orders": {"item_amount", "unit_price", "discount_amount"},
    "refunds": {"refund_amount"},
    "fees": {"fee_amount"},
    "settlements": {"settlement_amount"},
    "costs": {"unit_cost"},
    "expenses": {"expense_amount"},
}

ALIASES = {"orders": "订单", "refunds": "退款", "fees": "平台费用", "settlements": "结算", "costs": "成本", "expenses": "其他费用"}
