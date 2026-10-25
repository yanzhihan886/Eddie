import { classifyOrderStatus, isRefundConfirmed, isSettlementConfirmed, stableRecordKey } from "./domain.mjs";
import { readAll, writeRecords } from "./db.mjs";

function dayOffset(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export async function loadDemoData(db) {
  const demoStoreId = "demo-store-local-v1";
  const batches = await readAll(db, "importBatches");
  if (batches.some((batch) => batch.id === "demo-batch-orders-v1")) return { loaded: false };

  const store = { id: demoStoreId, platform: "其他/演示", name: "模拟配件店（虚构数据）", currency: "CNY", createdAt: new Date().toISOString(), demo: true };
  const catalog = [
    { skuId: "CASE-A", productName: "轻薄防摔手机壳", unitCostFen: 1200, priceFen: 3990 },
    { skuId: "CABLE-C", productName: "Type-C 快充线", unitCostFen: 650, priceFen: 1990 },
    { skuId: "STAND-B", productName: "折叠手机支架", unitCostFen: 1800, priceFen: 4990 },
    { skuId: "CLEAN-D", productName: "屏幕清洁套装", unitCostFen: 720, priceFen: 1590 },
  ];
  const rawOrders = [
    ["D-1001", -12, "已完成", "CASE-A", 1, 3990],
    ["D-1002", -11, "已发货", "CABLE-C", 2, 3980],
    ["D-1003", -10, "已完成", "STAND-B", 1, 4990],
    ["D-1004", -9, "已支付", "CASE-A", 1, 3790],
    ["D-1005", -8, "已取消", "CABLE-C", 1, 1990],
    ["D-1006", -7, "已完成", "CLEAN-D", 2, 3180],
    ["D-1007", -6, "待付款", "STAND-B", 1, 4990],
    ["D-1008", -5, "已完成", "CABLE-C", 1, 1990],
    ["D-1009", -4, "已完成", "CASE-A", 2, 7580],
    ["D-1010", -3, "已发货", "STAND-B", 1, 4990],
    ["D-1011", -2, "已完成", "CLEAN-D", 1, 1590],
    ["D-1012", -1, "已完成", "CABLE-C", 3, 5970],
  ];
  const batchTypes = ["orders", "costs", "refunds", "fees", "expenses", "settlements"];
  const createdAt = new Date().toISOString();
  const batchByType = new Map(batchTypes.map((type) => [type, {
    id: `demo-batch-${type}-v1`, storeId: demoStoreId, reportType: type, originalFilename: `虚构演示数据_${type}.csv`,
    fileHash: `demo-fixture-v1-${type}`, importedAt: createdAt, rowCount: 0, acceptedCount: 0, rejectedCount: 0,
    duplicateCount: 0, conflictCount: 0, status: "imported", fieldMapping: {},
    coverageStart: dayOffset(-12), coverageEnd: dayOffset(0), appSchemaVersion: 1, demo: true,
  }]));

  const orders = [];
  const orderItems = [];
  rawOrders.forEach(([platformOrderId, offset, orderStatus, skuId, quantity, amountFen], index) => {
    const catalogItem = catalog.find((item) => item.skuId === skuId);
    const orderedAt = dayOffset(offset);
    const orderId = `demo-order-${index + 1}`;
    orders.push({ id: orderId, storeId: demoStoreId, platformOrderId, orderedAt, orderStatus, statusClass: classifyOrderStatus(orderStatus),
      createdAt, importBatchId: batchByType.get("orders").id, demo: true });
    const item = { storeId: demoStoreId, orderId, platformOrderId, platformItemId: `ITEM-${index + 1}`, skuId,
      productName: catalogItem.productName, quantityMilli: quantity * 1000, unitPriceFen: catalogItem.priceFen,
      amountFen, discountFen: 0, orderedAt };
    item.recordKey = stableRecordKey("orders", item);
    item.rowHash = JSON.stringify(item);
    item.id = `demo-item-${index + 1}`;
    item.importBatchId = batchByType.get("orders").id;
    orderItems.push(item);
  });
  batchByType.get("orders").rowCount = rawOrders.length;
  batchByType.get("orders").acceptedCount = rawOrders.length;

  const productCosts = catalog.map((item, index) => {
    const row = { id: `demo-cost-${index + 1}`, storeId: demoStoreId, skuId: item.skuId, productName: item.productName,
      unitCostFen: item.unitCostFen, effectiveFrom: "1970-01-01", effectiveTo: null, costSource: "演示样例",
      importBatchId: batchByType.get("costs").id };
    row.recordKey = stableRecordKey("costs", row);
    row.rowHash = JSON.stringify(row);
    return row;
  });
  batchByType.get("costs").rowCount = productCosts.length;
  batchByType.get("costs").acceptedCount = productCosts.length;

  const refund = { id: "demo-refund-1", storeId: demoStoreId, platformRefundId: "RF-D-1003", platformOrderId: "D-1003", platformItemId: "ITEM-3",
    refundStatus: "部分退款成功", confirmed: isRefundConfirmed("成功"), amountFen: 1000, completedAt: dayOffset(-2), importBatchId: batchByType.get("refunds").id };
  refund.recordKey = stableRecordKey("refunds", refund); refund.rowHash = JSON.stringify(refund);
  batchByType.get("refunds").rowCount = 1; batchByType.get("refunds").acceptedCount = 1;

  const platformFees = rawOrders.filter((row) => !["已取消", "待付款"].includes(row[2])).map((row, index) => {
    const fee = { id: `demo-fee-${index + 1}`, storeId: demoStoreId, feeId: `FEE-${row[0]}`, platformOrderId: row[0], feeType: "平台服务费",
      amountFen: Math.round(row[5] * 0.045), feeDate: dayOffset(row[1]), importBatchId: batchByType.get("fees").id };
    fee.recordKey = stableRecordKey("fees", fee); fee.rowHash = JSON.stringify(fee); return fee;
  });
  batchByType.get("fees").rowCount = platformFees.length; batchByType.get("fees").acceptedCount = platformFees.length;

  const otherExpenses = [
    { id: "demo-expense-1", storeId: demoStoreId, expenseId: "EXP-001", expenseType: "推广费用", amountFen: 1200, expenseDate: dayOffset(-6), allocationMethod: "店铺级", platformOrderId: "", skuId: "", note: "虚构样例", importBatchId: batchByType.get("expenses").id },
    { id: "demo-expense-2", storeId: demoStoreId, expenseId: "EXP-002", expenseType: "包装耗材", amountFen: 480, expenseDate: dayOffset(-1), allocationMethod: "店铺级", platformOrderId: "", skuId: "", note: "虚构样例", importBatchId: batchByType.get("expenses").id },
  ].map((row) => ({ ...row, recordKey: stableRecordKey("expenses", row), rowHash: JSON.stringify(row) }));
  batchByType.get("expenses").rowCount = otherExpenses.length; batchByType.get("expenses").acceptedCount = otherExpenses.length;

  const settlements = rawOrders.filter((row) => !["已取消", "待付款"].includes(row[2])).map((row, index) => {
    const feeFen = Math.round(row[5] * 0.045);
    const refundFen = row[0] === "D-1003" ? 1000 : 0;
    const settlement = { id: `demo-settlement-${index + 1}`, storeId: demoStoreId, transactionId: `SET-${row[0]}`, platformOrderId: row[0],
      amountFen: row[5] - refundFen - feeFen, settlementStatus: "已结算", confirmed: isSettlementConfirmed("已结算"), settlementDate: dayOffset(row[1]),
      importBatchId: batchByType.get("settlements").id };
    settlement.recordKey = stableRecordKey("settlements", settlement); settlement.rowHash = JSON.stringify(settlement); return settlement;
  });
  batchByType.get("settlements").rowCount = settlements.length; batchByType.get("settlements").acceptedCount = settlements.length;

  const unknownOrder = orders.find((order) => order.statusClass === "unknown");
  const issues = unknownOrder ? [{ id: "demo-issue-unknown-status", storeId: demoStoreId, issueType: "unknown_order_status", severity: "warning", status: "open",
    description: `订单 ${unknownOrder.platformOrderId} 的状态“${unknownOrder.orderStatus}”未识别，未计入销售。`, sourceRecordId: "", relatedRecordIds: [unknownOrder.id], amountDifferenceFen: null,
    resolutionNote: "", createdAt, stableKey: "demo-issue-unknown-status-v1", demo: true }] : [];

  await writeRecords(db, {
    stores: [store], orders, orderItems, refunds: [refund], platformFees, productCosts, otherExpenses, settlements,
    importBatches: [...batchByType.values()], issues,
  }, "add");
  return { loaded: true, orderCount: orders.length, itemCount: orderItems.length };
}
