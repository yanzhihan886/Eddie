export const DB_VERSION = 1;
export const CALCULATION_RULE_VERSION = "local-profit-v1";

export const REPORTS = {
  orders: {
    label: "订单明细",
    fields: [
      { key: "platformOrderId", label: "平台订单号", required: true, type: "text", aliases: ["订单编号", "订单号", "主订单编号", "平台订单号", "order_id", "platform_order_id"] },
      { key: "orderedAt", label: "下单日期", required: true, type: "date", aliases: ["订单日期", "下单时间", "创建时间", "付款时间", "order_date", "ordered_at"] },
      { key: "orderStatus", label: "订单状态", required: true, type: "text", aliases: ["订单状态", "交易状态", "状态", "status", "order_status"] },
      { key: "skuId", label: "SKU 编号", required: true, type: "text", aliases: ["商品编码", "商品编号", "sku", "sku_id", "商家编码"] },
      { key: "productName", label: "商品名称", required: false, type: "text", aliases: ["商品名称", "商品标题", "货品名称", "product_name"] },
      { key: "quantity", label: "销售数量", required: true, type: "quantity", aliases: ["购买数量", "商品数量", "数量", "件数", "quantity", "qty"] },
      { key: "itemAmount", label: "商品实付金额", required: false, type: "money", aliases: ["商品实付金额", "商品金额", "销售金额", "订单金额", "实付金额", "item_amount", "amount"] },
      { key: "unitPrice", label: "商品单价（可替代金额）", required: false, type: "money", aliases: ["商品单价", "成交单价", "单价", "unit_price", "price"] },
      { key: "discountAmount", label: "商品优惠金额", required: false, type: "money", aliases: ["优惠金额", "商品优惠", "折扣金额", "discount_amount"] },
      { key: "platformItemId", label: "商品明细号", required: false, type: "text", aliases: ["子订单编号", "商品明细ID", "明细编号", "item_id", "platform_item_id"] },
    ],
  },
  refunds: {
    label: "退款明细",
    fields: [
      { key: "platformRefundId", label: "退款单号", required: false, type: "text", aliases: ["退款单号", "售后单号", "退款编号", "refund_id"] },
      { key: "platformOrderId", label: "平台订单号", required: true, type: "text", aliases: ["订单编号", "订单号", "主订单编号", "order_id", "platform_order_id"] },
      { key: "platformItemId", label: "商品明细号", required: false, type: "text", aliases: ["子订单编号", "商品明细ID", "明细编号", "item_id"] },
      { key: "refundStatus", label: "退款状态", required: true, type: "text", aliases: ["退款状态", "售后状态", "状态", "refund_status"] },
      { key: "refundAmount", label: "退款金额", required: true, type: "money", aliases: ["退款金额", "退款总金额", "实退金额", "refund_amount", "amount"] },
      { key: "completedAt", label: "退款完成日期", required: true, type: "date", aliases: ["退款完成时间", "退款时间", "完成时间", "退款成功时间", "refund_date"] },
    ],
  },
  fees: {
    label: "平台费用",
    fields: [
      { key: "feeId", label: "费用记录编号", required: false, type: "text", aliases: ["费用编号", "账单编号", "流水号", "fee_id"] },
      { key: "platformOrderId", label: "平台订单号（可空）", required: false, type: "text", aliases: ["订单编号", "订单号", "关联订单号", "order_id"] },
      { key: "feeType", label: "费用类型", required: true, type: "text", aliases: ["费用类型", "费用名称", "账单类型", "项目", "fee_type"] },
      { key: "feeAmount", label: "费用金额", required: true, type: "money", aliases: ["费用金额", "支出金额", "扣款金额", "手续费", "fee_amount", "amount"] },
      { key: "feeDate", label: "费用日期", required: true, type: "date", aliases: ["费用发生日期", "账单日期", "发生时间", "扣款时间", "账单时间", "date", "fee_date"] },
    ],
  },
  costs: {
    label: "商品成本",
    fields: [
      { key: "skuId", label: "SKU 编号", required: true, type: "text", aliases: ["商品编码", "商品编号", "sku", "sku_id", "商家编码"] },
      { key: "productName", label: "商品名称", required: false, type: "text", aliases: ["商品名称", "商品标题", "product_name"] },
      { key: "unitCost", label: "单位成本", required: true, type: "money", aliases: ["单位成本", "采购成本", "商品成本", "进货价", "成本", "unit_cost", "cost"] },
      { key: "effectiveFrom", label: "生效日期（可空）", required: false, type: "date", aliases: ["生效日期", "开始日期", "effective_from"] },
      { key: "effectiveTo", label: "失效日期（可空）", required: false, type: "date", aliases: ["失效日期", "结束日期", "effective_to"] },
    ],
  },
  expenses: {
    label: "其他经营费用",
    fields: [
      { key: "expenseId", label: "费用编号", required: false, type: "text", aliases: ["费用编号", "流水号", "expense_id"] },
      { key: "expenseType", label: "费用类型", required: true, type: "text", aliases: ["费用类型", "费用名称", "项目", "expense_type"] },
      { key: "expenseAmount", label: "费用金额", required: true, type: "money", aliases: ["费用金额", "支出金额", "金额", "expense_amount", "amount"] },
      { key: "expenseDate", label: "费用日期", required: true, type: "date", aliases: ["费用日期", "账单日期", "发生时间", "日期", "expense_date"] },
      { key: "allocationMethod", label: "分摊方式（可空）", required: false, type: "text", aliases: ["分摊方式", "分配方式", "allocation_method"] },
      { key: "platformOrderId", label: "关联订单号（可空）", required: false, type: "text", aliases: ["订单号", "关联订单", "order_id"] },
      { key: "skuId", label: "关联 SKU（可空）", required: false, type: "text", aliases: ["SKU编号", "商品编码", "sku", "sku_id"] },
      { key: "note", label: "备注（可空）", required: false, type: "text", aliases: ["备注", "说明", "note"] },
    ],
  },
  settlements: {
    label: "结算记录",
    fields: [
      { key: "transactionId", label: "结算流水号", required: false, type: "text", aliases: ["结算流水号", "流水号", "交易编号", "transaction_id"] },
      { key: "platformOrderId", label: "关联订单号（可空）", required: false, type: "text", aliases: ["订单编号", "订单号", "关联订单号", "order_id"] },
      { key: "settlementAmount", label: "结算金额", required: true, type: "money", aliases: ["结算金额", "实际到账", "实收金额", "到账金额", "settlement_amount", "amount"] },
      { key: "settlementStatus", label: "结算状态", required: true, type: "text", aliases: ["结算状态", "账单状态", "状态", "status"] },
      { key: "settlementDate", label: "结算日期", required: true, type: "date", aliases: ["结算日期", "到账日期", "账单日期", "结算时间", "date"] },
    ],
  },
};

export const STORE_NAMES = [
  "stores", "orders", "orderItems", "refunds", "platformFees", "productCosts",
  "otherExpenses", "settlements", "importBatches", "rawRecords", "issues", "calculationResults",
];

export function parseMoneyFen(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  let text = String(value).trim().replace(/[¥￥$,，\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (/^[+-]/.test(text)) { negative ||= text[0] === "-"; text = text.slice(1); }
  const match = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) throw new Error(`金额格式无法识别：${String(value)}`);
  const whole = BigInt(match[1]);
  const decimals = match[2] || "";
  let cents = whole * 100n + BigInt((decimals + "00").slice(0, 2));
  if (decimals.length > 2 && Number(decimals[2]) >= 5) cents += 1n;
  if (negative) cents = -cents;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("金额超出安全计算范围");
  return Number(cents);
}

export function parseQuantityMilli(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim().replace(/[,，\s]/g, "");
  const match = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) throw new Error(`数量格式无法识别：${String(value)}`);
  const fraction = match[2] || "";
  if (fraction.length > 3 && Number(fraction[3]) >= 5) {
    const base = BigInt(match[1]) * 1000n + BigInt((fraction + "000").slice(0, 3)) + 1n;
    if (base > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("数量超出安全计算范围");
    return Number(base);
  }
  const milli = BigInt(match[1]) * 1000n + BigInt((fraction + "000").slice(0, 3));
  if (milli > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("数量超出安全计算范围");
  return Number(milli);
}

export function multiplyFenByMilli(fen, quantityMilli) {
  const n = BigInt(fen) * BigInt(quantityMilli);
  const sign = n < 0n ? -1n : 1n;
  const abs = n < 0n ? -n : n;
  const rounded = (abs + 500n) / 1000n * sign;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("计算金额超出安全范围");
  return Number(rounded);
}

export function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?(?:\s.*)?$/);
  if (!match) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.valueOf())) return null;
    return parsed.toISOString().slice(0, 10);
  }
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const STATUS = {
  valid: new Set(["已支付", "付款成功", "已发货", "已完成", "交易成功", "已签收", "success", "paid", "completed", "shipped", "delivered"]),
  cancelled: new Set(["已取消", "已关闭", "交易关闭", "取消", "closed", "cancelled", "canceled"]),
};

export function classifyOrderStatus(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (STATUS.cancelled.has(text)) return "cancelled";
  if (STATUS.valid.has(text)) return "valid";
  return "unknown";
}

export function isRefundConfirmed(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return new Set(["成功", "已完成", "已退款", "退款成功", "success", "completed", "finished", "refunded", "部分退款成功", "仅退款成功"]).has(text);
}

export function isSettlementConfirmed(value) {
  return new Set(["成功", "已结算", "已到账", "已完成", "success", "settled", "completed"]).has(String(value ?? "").trim().toLowerCase());
}

export function formatFen(fen) {
  const n = Number(fen || 0) / 100;
  return `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatQuantity(milli) {
  return (Number(milli || 0) / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

export function findCost(costs, storeId, skuId, date) {
  return costs
    .filter((cost) => cost.storeId === storeId && cost.skuId === skuId && cost.effectiveFrom <= date && (!cost.effectiveTo || cost.effectiveTo >= date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
}

export function calculateSummary(data, { storeId = "all", start, end }) {
  const stores = data.stores.filter((s) => storeId === "all" || s.id === storeId);
  const allowed = new Set(stores.map((s) => s.id));
  const orders = data.orders.filter((o) => allowed.has(o.storeId));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const validOrders = orders.filter((o) => o.statusClass === "valid");
  const periodOrders = validOrders.filter((o) => o.orderedAt >= start && o.orderedAt <= end);
  const periodOrderIds = new Set(periodOrders.map((o) => o.id));
  const orderItems = data.orderItems.filter((item) => periodOrderIds.has(item.orderId));
  const grossSalesFen = orderItems.reduce((sum, row) => sum + row.amountFen, 0);
  const itemCountMilli = orderItems.reduce((sum, row) => sum + row.quantityMilli, 0);

  const refunds = data.refunds.filter((r) => allowed.has(r.storeId) && r.confirmed && r.completedAt >= start && r.completedAt <= end);
  const refundFen = refunds.reduce((sum, row) => sum + row.amountFen, 0);
  const fees = data.platformFees.filter((r) => allowed.has(r.storeId) && r.feeDate >= start && r.feeDate <= end);
  const feeFen = fees.reduce((sum, row) => sum + row.amountFen, 0);
  const expenses = data.otherExpenses.filter((r) => allowed.has(r.storeId) && r.expenseDate >= start && r.expenseDate <= end);
  const expenseFen = expenses.reduce((sum, row) => sum + row.amountFen, 0);

  let costFen = 0;
  const missingCosts = new Map();
  for (const item of orderItems) {
    const order = orderById.get(item.orderId);
    const cost = findCost(data.productCosts, item.storeId, item.skuId, order.orderedAt);
    if (!cost) {
      const existing = missingCosts.get(item.skuId) || { skuId: item.skuId, productName: item.productName || "未命名商品", quantityMilli: 0 };
      existing.quantityMilli += item.quantityMilli;
      missingCosts.set(item.skuId, existing);
    } else {
      costFen += multiplyFenByMilli(cost.unitCostFen, item.quantityMilli);
    }
  }

  const netSalesFen = grossSalesFen - refundFen;
  const knownProfitFen = netSalesFen - costFen - feeFen - expenseFen;
  const cancelledCount = orders.filter((o) => o.statusClass === "cancelled" && o.orderedAt >= start && o.orderedAt <= end).length;
  const unknownCount = orders.filter((o) => o.statusClass === "unknown" && o.orderedAt >= start && o.orderedAt <= end).length;
  const settlementFen = data.settlements.filter((r) => allowed.has(r.storeId) && r.confirmed && r.settlementDate >= start && r.settlementDate <= end).reduce((sum, r) => sum + r.amountFen, 0);
  const missingInputs = [];
  if (missingCosts.size) missingInputs.push("有已售 SKU 缺少有效成本");
  const coverage = new Set(data.importBatches.filter((b) => allowed.has(b.storeId) && b.coverageStart <= end && b.coverageEnd >= start).map((b) => b.reportType));
  if (!coverage.has("fees")) missingInputs.push("此期间没有平台费用导入批次");
  if (!coverage.has("expenses")) missingInputs.push("此期间没有其他费用导入批次");

  return {
    start, end, storeIds: [...allowed], grossSalesFen, refundFen, netSalesFen,
    costFen, feeFen, expenseFen, knownProfitFen,
    profitMargin: netSalesFen ? knownProfitFen / netSalesFen : null,
    orderCount: periodOrders.length, itemCountMilli, cancelledCount, unknownCount,
    refundCount: refunds.length, feeCount: fees.length, expenseCount: expenses.length,
    settlementFen, missingCosts: [...missingCosts.values()], missingInputs,
    complete: missingInputs.length === 0,
  };
}

export function dailyTrend(data, summary) {
  const validOrders = data.orders.filter((o) => summary.storeIds.includes(o.storeId) && o.statusClass === "valid");
  const ordersById = new Map(validOrders.map((o) => [o.id, o]));
  const days = new Map();
  const start = new Date(`${summary.start}T00:00:00Z`);
  const end = new Date(`${summary.end}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.set(d.toISOString().slice(0, 10), 0);
  }
  for (const item of data.orderItems) {
    const order = ordersById.get(item.orderId);
    if (order && days.has(order.orderedAt)) days.set(order.orderedAt, days.get(order.orderedAt) + item.amountFen);
  }
  return [...days].map(([date, grossSalesFen]) => ({ date, grossSalesFen }));
}

export function productSummary(data, summary) {
  const validOrders = data.orders.filter((o) => summary.storeIds.includes(o.storeId) && o.statusClass === "valid" && o.orderedAt >= summary.start && o.orderedAt <= summary.end);
  const ordersById = new Map(validOrders.map((o) => [o.id, o]));
  const map = new Map();
  for (const item of data.orderItems) {
    if (!ordersById.has(item.orderId)) continue;
    const key = `${item.storeId}|${item.skuId}`;
    const row = map.get(key) || { storeId: item.storeId, skuId: item.skuId, productName: item.productName || "未命名商品", quantityMilli: 0, salesFen: 0, costFen: 0, missingCost: false };
    row.quantityMilli += item.quantityMilli;
    row.salesFen += item.amountFen;
    const cost = findCost(data.productCosts, item.storeId, item.skuId, ordersById.get(item.orderId).orderedAt);
    if (cost) row.costFen += multiplyFenByMilli(cost.unitCostFen, item.quantityMilli);
    else row.missingCost = true;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.salesFen - a.salesFen);
}

export function findFeeSettlementMismatches(data, toleranceFen = 1) {
  const ordersByKey = new Map(data.orders.map((o) => [`${o.storeId}|${o.platformOrderId}`, o]));
  const grossByOrder = new Map();
  for (const item of data.orderItems) grossByOrder.set(item.orderId, (grossByOrder.get(item.orderId) || 0) + item.amountFen);
  const refundsByOrderKey = new Map();
  for (const refund of data.refunds.filter((r) => r.confirmed)) {
    const key = `${refund.storeId}|${refund.platformOrderId}`;
    refundsByOrderKey.set(key, (refundsByOrderKey.get(key) || 0) + refund.amountFen);
  }
  const feesByOrderKey = new Map();
  for (const fee of data.platformFees.filter((r) => r.platformOrderId)) {
    const key = `${fee.storeId}|${fee.platformOrderId}`;
    feesByOrderKey.set(key, (feesByOrderKey.get(key) || 0) + fee.amountFen);
  }
  const settlementsByOrderKey = new Map();
  for (const row of data.settlements.filter((r) => r.confirmed && r.platformOrderId)) {
    const key = `${row.storeId}|${row.platformOrderId}`;
    settlementsByOrderKey.set(key, (settlementsByOrderKey.get(key) || 0) + row.amountFen);
  }
  const mismatches = [];
  for (const [key, settledFen] of settlementsByOrderKey) {
    const order = ordersByKey.get(key);
    if (!order || order.statusClass !== "valid") continue;
    const gross = grossByOrder.get(order.id) || 0;
    const refund = refundsByOrderKey.get(key) || 0;
    const fee = feesByOrderKey.get(key) || 0;
    const expectedFen = gross - refund - fee;
    const differenceFen = settledFen - expectedFen;
    if (Math.abs(differenceFen) > toleranceFen) mismatches.push({ storeId: order.storeId, platformOrderId: order.platformOrderId, expectedFen, settledFen, differenceFen });
  }
  return mismatches;
}

export function reconcileFeeSettlementIssues(data, now = new Date().toISOString()) {
  const previous = new Map((data.issues || [])
    .filter((issue) => issue.issueType === "fee_settlement_mismatch")
    .map((issue) => [issue.stableKey, issue]));
  const updates = [];
  for (const mismatch of findFeeSettlementMismatches(data)) {
    const stableKey = `fee-settlement|${mismatch.storeId}|${mismatch.platformOrderId}`;
    const old = previous.get(stableKey);
    const description = `订单 ${mismatch.platformOrderId} 的简化结算与已导入销售、退款和平台费用相差 ${formatFen(mismatch.differenceFen)}；请对照平台账单复核。`;
    if (!old) {
      updates.push({ id: `derived-${encodeURIComponent(stableKey)}`, stableKey, storeId: mismatch.storeId,
        issueType: "fee_settlement_mismatch", severity: "warning", status: "open", description,
        amountDifferenceFen: mismatch.differenceFen, relatedRecordIds: [], resolutionNote: "", createdAt: now });
    } else {
      previous.delete(stableKey);
      if (old.status !== "resolved" && (old.description !== description || old.amountDifferenceFen !== mismatch.differenceFen)) {
        updates.push({ ...old, description, amountDifferenceFen: mismatch.differenceFen, updatedAt: now });
      }
    }
  }
  for (const [stableKey, old] of previous) {
    if (old.status !== "resolved") updates.push({ ...old, status: "resolved", resolutionNote: "源数据变更后，简化结算差异不再出现。", resolvedAt: now, updatedAt: now });
  }
  return updates;
}

export function reconcileMissingCostIssues(data, now = new Date().toISOString()) {
  const orderById = new Map(data.orders.map((order) => [order.id, order]));
  const costsBySku = new Map();
  for (const cost of data.productCosts) {
    const key = `${cost.storeId}|${cost.skuId}`;
    const rows = costsBySku.get(key) || [];
    rows.push(cost);
    costsBySku.set(key, rows);
  }
  const missingBySku = new Map();
  for (const item of data.orderItems) {
    const order = orderById.get(item.orderId);
    if (!order || order.statusClass !== "valid") continue;
    const orderedAt = item.orderedAt || order.orderedAt;
    const hasCost = (costsBySku.get(`${order.storeId}|${item.skuId}`) || []).some((cost) => cost.effectiveFrom <= orderedAt
      && (!cost.effectiveTo || cost.effectiveTo >= orderedAt));
    if (hasCost) continue;
    const key = `${order.storeId}|${item.skuId}`;
    const row = missingBySku.get(key) || { storeId: order.storeId, skuId: item.skuId, dates: [], quantityMilli: 0 };
    row.dates.push(orderedAt);
    row.quantityMilli += item.quantityMilli || 0;
    missingBySku.set(key, row);
  }
  const previous = new Map((data.issues || []).filter((issue) => issue.issueType === "missing_cost").map((issue) => [issue.stableKey, issue]));
  const updates = [];
  for (const missing of missingBySku.values()) {
    const stableKey = `missing-cost|${missing.storeId}|${missing.skuId}`;
    const dates = missing.dates.sort();
    const description = `SKU ${missing.skuId} 在 ${dates[0]} 至 ${dates.at(-1)} 的有效订单中没有匹配单位成本；对应 ${missing.quantityMilli / 1000} 件商品的利润估算不完整。`;
    const old = previous.get(stableKey);
    if (!old) {
      updates.push({ id: `derived-${encodeURIComponent(stableKey)}`, stableKey, storeId: missing.storeId,
        issueType: "missing_cost", severity: "warning", status: "open", description,
        amountDifferenceFen: null, relatedRecordIds: [], resolutionNote: "", createdAt: now });
    } else {
      previous.delete(stableKey);
      if (old.status !== "resolved" && old.description !== description) updates.push({ ...old, description, updatedAt: now });
    }
  }
  for (const old of previous.values()) {
    if (old.status !== "resolved") updates.push({ ...old, status: "resolved", resolutionNote: "已补充覆盖相关订单日期的 SKU 成本。", resolvedAt: now, updatedAt: now });
  }
  return updates;
}

export function stableRecordKey(kind, row) {
  const parts = {
    orders: row.platformItemId ? [row.storeId, row.platformOrderId, row.platformItemId] : [row.storeId, row.platformOrderId, row.skuId, row.orderedAt, row.quantityMilli, row.amountFen],
    refunds: row.platformRefundId ? [row.storeId, row.platformRefundId] : [row.storeId, row.platformOrderId, row.completedAt, row.amountFen],
    fees: row.feeId ? [row.storeId, row.feeId] : [row.storeId, row.platformOrderId || "store", row.feeDate, row.feeType, row.amountFen],
    costs: [row.storeId, row.skuId, row.effectiveFrom],
    expenses: row.expenseId ? [row.storeId, row.expenseId] : [row.storeId, row.expenseDate, row.expenseType, row.amountFen, row.platformOrderId || "", row.skuId || ""],
    settlements: row.transactionId ? [row.storeId, row.transactionId] : [row.storeId, row.platformOrderId || "store", row.settlementDate, row.amountFen, row.settlementStatus],
  }[kind];
  return `${kind}|${parts.map((p) => String(p ?? "").trim()).join("|")}`;
}

export function dedupeCandidates(candidates, existingRecords = []) {
  const byKey = new Map(existingRecords.map((row) => [row.recordKey, row.rowHash]));
  const accepted = [];
  const duplicates = [];
  const conflicts = [];
  for (const row of candidates) {
    if (byKey.has(row.recordKey)) {
      (byKey.get(row.recordKey) === row.rowHash ? duplicates : conflicts).push(row);
    } else {
      accepted.push(row);
      byKey.set(row.recordKey, row.rowHash);
    }
  }
  return { accepted, duplicates, conflicts };
}

export function periodKey(storeId, start, end) {
  return `${storeId}|${start}|${end}|${CALCULATION_RULE_VERSION}`;
}
