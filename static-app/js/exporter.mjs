import { formatQuantity } from "./domain.mjs";

function safeText(value) {
  const text = String(value ?? "");
  return /^[=+@\-]/.test(text) ? `'${text}` : text;
}

function money(fen) { return Number(fen || 0) / 100; }
function cleanObject(row, fields) {
  return Object.fromEntries(fields.map(([key, label, kind]) => [label, kind === "money" ? money(row[key]) : kind === "quantity" ? Number(formatQuantity(row[key])) : safeText(row[key])]));
}

function addSheet(wb, name, rows) {
  const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "说明": "暂无记录" }]);
  const keys = rows[0] ? Object.keys(rows[0]) : ["说明"];
  sheet["!cols"] = keys.map((key) => ({ wch: Math.max(14, Math.min(34, key.length * 2 + 4)) }));
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: Math.max(0, keys.length - 1) } }) };
  wb.SheetNames.push(name);
  wb.Sheets[name] = sheet;
}

export function createWorkbook(data, summary, selectedStoreName) {
  if (!globalThis.XLSX) throw new Error("Excel 导出组件未加载，请刷新页面后重试。");
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: "卖家利润助手本地经营报告", Subject: "基于本机导入数据的经营利润估算", Author: "卖家利润助手（本地生成）" };
  addSheet(wb, "经营摘要", [{
    "店铺范围": safeText(selectedStoreName), "统计开始": summary.start, "统计结束": summary.end,
    "商品销售额（元）": money(summary.grossSalesFen), "退款金额（元）": money(summary.refundFen),
    "净销售额（元）": money(summary.netSalesFen), "已匹配商品成本（元）": money(summary.costFen),
    "平台费用（元）": money(summary.feeFen), "其他费用（元）": money(summary.expenseFen),
    "已知项目利润估算（元）": money(summary.knownProfitFen), "利润率": summary.profitMargin === null ? "" : summary.profitMargin,
    "订单数": summary.orderCount, "销售件数": Number(formatQuantity(summary.itemCountMilli)),
    "数据完整性": summary.complete ? "已导入字段齐备（仍以报表范围为准）" : `部分数据估算：${summary.missingInputs.join("；")}`,
  }]);
  addSheet(wb, "订单", data.orders.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["platformOrderId", "平台订单号"], ["orderedAt", "下单日期"], ["orderStatus", "订单状态"], ["statusClass", "识别状态"], ["id", "本地记录ID"],
  ])));
  addSheet(wb, "订单商品", data.orderItems.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["platformOrderId", "平台订单号"], ["platformItemId", "商品明细号"], ["skuId", "SKU编号"], ["productName", "商品名称"],
    ["quantityMilli", "销售数量", "quantity"], ["unitPriceFen", "单价（元）", "money"], ["amountFen", "商品实付金额（元）", "money"],
    ["discountFen", "优惠金额（元）", "money"], ["orderedAt", "下单日期"], ["importBatchId", "导入批次"],
  ])));
  addSheet(wb, "退款", data.refunds.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["platformRefundId", "退款单号"], ["platformOrderId", "订单号"], ["platformItemId", "商品明细号"],
    ["refundStatus", "退款状态"], ["confirmed", "已确认"], ["completedAt", "退款完成日期"], ["amountFen", "退款金额（元）", "money"],
  ])));
  addSheet(wb, "平台费用", data.platformFees.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["feeId", "费用编号"], ["platformOrderId", "订单号"], ["feeType", "费用类型"], ["feeDate", "费用日期"], ["amountFen", "费用金额（元）", "money"],
  ])));
  addSheet(wb, "商品成本", data.productCosts.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["skuId", "SKU编号"], ["productName", "商品名称"], ["unitCostFen", "单位成本（元）", "money"], ["effectiveFrom", "生效日期"], ["effectiveTo", "失效日期"],
  ])));
  addSheet(wb, "其他费用", data.otherExpenses.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["expenseId", "费用编号"], ["expenseType", "费用类型"], ["expenseDate", "费用日期"], ["amountFen", "费用金额（元）", "money"],
    ["allocationMethod", "分摊方式"], ["platformOrderId", "关联订单"], ["skuId", "关联SKU"], ["note", "备注"],
  ])));
  addSheet(wb, "结算", data.settlements.map((r) => cleanObject(r, [
    ["storeId", "店铺ID"], ["transactionId", "流水号"], ["platformOrderId", "订单号"], ["settlementStatus", "结算状态"],
    ["settlementDate", "结算日期"], ["amountFen", "结算金额（元）", "money"], ["confirmed", "已确认"],
  ])));
  addSheet(wb, "导入批次", data.importBatches.map((r) => cleanObject(r, [
    ["originalFilename", "原文件名"], ["reportType", "报表类型"], ["importedAt", "导入时间"], ["rowCount", "文件行数"],
    ["acceptedCount", "新增记录"], ["rejectedCount", "无效行"], ["duplicateCount", "重复行"], ["conflictCount", "冲突行"], ["status", "批次状态"],
  ])));
  addSheet(wb, "异常记录", data.issues.map((r) => cleanObject(r, [
    ["issueType", "异常类型"], ["severity", "级别"], ["status", "状态"], ["description", "说明"], ["createdAt", "发现时间"], ["resolutionNote", "处理备注"],
  ])));
  return wb;
}

export function downloadWorkbook(data, summary, selectedStoreName) {
  const workbook = createWorkbook(data, summary, selectedStoreName);
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  XLSX.writeFile(workbook, `卖家利润助手_本地经营报告_${stamp}.xlsx`, { compression: true });
}
