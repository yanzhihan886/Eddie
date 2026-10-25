import test from "node:test";
import assert from "node:assert/strict";
import { calculateSummary, classifyOrderStatus, dedupeCandidates, findFeeSettlementMismatches, formatFen, isRefundConfirmed, parseMoneyFen, parseQuantityMilli, reconcileFeeSettlementIssues, reconcileMissingCostIssues, stableRecordKey } from "../js/domain.mjs";
import { parseCsv, suggestMapping } from "../js/importer.mjs";

const sample = () => ({
  stores: [{ id: "s1", name: "测试店" }],
  orders: [{ id: "o1", storeId: "s1", platformOrderId: "N-1", orderedAt: "2026-10-01", statusClass: "valid", orderStatus: "已完成" }],
  orderItems: [{ id: "i1", storeId: "s1", orderId: "o1", platformOrderId: "N-1", skuId: "SKU-1", productName: "样品", quantityMilli: 2000, amountFen: 10000, orderedAt: "2026-10-01" }],
  refunds: [],
  platformFees: [{ id: "f1", storeId: "s1", platformOrderId: "N-1", amountFen: 300, feeDate: "2026-10-01" }],
  productCosts: [{ id: "c1", storeId: "s1", skuId: "SKU-1", unitCostFen: 2000, effectiveFrom: "2026-01-01", effectiveTo: null }],
  otherExpenses: [{ id: "e1", storeId: "s1", amountFen: 100, expenseDate: "2026-10-01" }],
  settlements: [], issues: [], calculationResults: [], importBatches: [
    { id: "b1", storeId: "s1", reportType: "fees", coverageStart: "2026-10-01", coverageEnd: "2026-10-01" },
    { id: "b2", storeId: "s1", reportType: "expenses", coverageStart: "2026-10-01", coverageEnd: "2026-10-01" },
  ], rawRecords: [],
});

test("money parsing uses integer fen and half-up rounding", () => {
  assert.equal(parseMoneyFen("¥1,234.565"), 123457);
  assert.equal(parseMoneyFen("(12.30)"), -1230);
  assert.equal(formatFen(123457), "¥1,234.57");
  assert.equal(parseMoneyFen(""), null);
  assert.throws(() => parseMoneyFen("12元abc"), /格式无法识别/);
});

test("quantity is stored at milli-unit precision", () => {
  assert.equal(parseQuantityMilli("2.1254"), 2125);
  assert.equal(parseQuantityMilli("1.9999"), 2000);
  assert.throws(() => parseQuantityMilli("-1"), /数量格式无法识别/);
});

test("status rules classify completed, cancelled and unknown orders deterministically", () => {
  assert.equal(classifyOrderStatus("已发货"), "valid");
  assert.equal(classifyOrderStatus("CANCELLED"), "cancelled");
  assert.equal(classifyOrderStatus("待付款"), "unknown");
  assert.equal(isRefundConfirmed("部分退款成功"), true);
});

test("normal order profit uses exact cents and includes costs, fees and expenses", () => {
  const data = sample();
  const summary = calculateSummary(data, { storeId: "all", start: "2026-10-01", end: "2026-10-01" });
  assert.equal(summary.grossSalesFen, 10000);
  assert.equal(summary.costFen, 4000);
  assert.equal(summary.feeFen, 300);
  assert.equal(summary.expenseFen, 100);
  assert.equal(summary.knownProfitFen, 5600);
  assert.equal(summary.orderCount, 1);
  assert.equal(summary.complete, true);
});

test("cancelled orders are excluded while valid order totals remain unchanged", () => {
  const data = sample();
  data.orders.push({ id: "o2", storeId: "s1", platformOrderId: "N-2", orderedAt: "2026-10-01", statusClass: "cancelled", orderStatus: "已取消" });
  data.orderItems.push({ id: "i2", storeId: "s1", orderId: "o2", platformOrderId: "N-2", skuId: "SKU-1", quantityMilli: 1000, amountFen: 7000, orderedAt: "2026-10-01" });
  const summary = calculateSummary(data, { storeId: "all", start: "2026-10-01", end: "2026-10-01" });
  assert.equal(summary.grossSalesFen, 10000);
  assert.equal(summary.orderCount, 1);
  assert.equal(summary.cancelledCount, 1);
});

test("partial refunds reduce net sales and known profit", () => {
  const data = sample();
  data.refunds.push({ id: "r1", storeId: "s1", platformOrderId: "N-1", confirmed: true, amountFen: 2500, completedAt: "2026-10-01" });
  const summary = calculateSummary(data, { storeId: "all", start: "2026-10-01", end: "2026-10-01" });
  assert.equal(summary.netSalesFen, 7500);
  assert.equal(summary.knownProfitFen, 3100);
  assert.equal(summary.refundCount, 1);
});

test("refunds crossing month boundaries are counted by completion date, not order date", () => {
  const data = sample();
  data.orders[0].orderedAt = "2026-09-30";
  data.orderItems[0].orderedAt = "2026-09-30";
  data.platformFees[0].feeDate = "2026-09-30";
  data.otherExpenses[0].expenseDate = "2026-09-30";
  data.refunds.push({ id: "r-cross", storeId: "s1", platformOrderId: "N-1", confirmed: true, amountFen: 2500, completedAt: "2026-10-01" });
  const september = calculateSummary(data, { storeId: "all", start: "2026-09-01", end: "2026-09-30" });
  const october = calculateSummary(data, { storeId: "all", start: "2026-10-01", end: "2026-10-31" });
  assert.equal(september.grossSalesFen, 10000);
  assert.equal(september.refundFen, 0);
  assert.equal(october.grossSalesFen, 0);
  assert.equal(october.refundFen, 2500);
  assert.equal(october.netSalesFen, -2500);
});

test("missing SKU cost remains visibly incomplete and is not silently treated as known cost", () => {
  const data = sample();
  data.productCosts = [];
  const summary = calculateSummary(data, { storeId: "all", start: "2026-10-01", end: "2026-10-01" });
  assert.equal(summary.costFen, 0);
  assert.equal(summary.knownProfitFen, 9600);
  assert.equal(summary.complete, false);
  assert.equal(summary.missingCosts[0].skuId, "SKU-1");
});

test("duplicate file rows are skipped and changed content becomes a conflict", () => {
  const base = { recordKey: "fees|s1|f-1", rowHash: "same" };
  const split = dedupeCandidates([base, base, { recordKey: "fees|s1|f-1", rowHash: "changed" }]);
  assert.equal(split.accepted.length, 1);
  assert.equal(split.duplicates.length, 1);
  assert.equal(split.conflicts.length, 1);
  const existing = dedupeCandidates([{ recordKey: "fees|s1|f-1", rowHash: "same" }], [base]);
  assert.equal(existing.duplicates.length, 1);
  assert.equal(existing.accepted.length, 0);
});

test("different report rows have deterministic business keys", () => {
  const row = { storeId: "s1", platformOrderId: "N-1", platformItemId: "I-1", skuId: "SKU-1", orderedAt: "2026-10-01", quantityMilli: 1000, amountFen: 1000 };
  assert.equal(stableRecordKey("orders", row), stableRecordKey("orders", { ...row }));
  assert.notEqual(stableRecordKey("orders", row), stableRecordKey("orders", { ...row, platformItemId: "I-2" }));
});

test("fee and settlement mismatch is a review signal with a one-cent tolerance", () => {
  const data = sample();
  data.refunds.push({ id: "r1", storeId: "s1", platformOrderId: "N-1", confirmed: true, amountFen: 2000, completedAt: "2026-10-01" });
  data.settlements.push({ id: "set1", storeId: "s1", platformOrderId: "N-1", confirmed: true, amountFen: 7500, settlementDate: "2026-10-01" });
  const mismatch = findFeeSettlementMismatches(data);
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].expectedFen, 7700);
  assert.equal(mismatch[0].differenceFen, -200);
  data.settlements[0].amountFen = 7701;
  assert.equal(findFeeSettlementMismatches(data).length, 0);
});

test("fee and settlement mismatches are stored as stable issues and auto-resolved when corrected", () => {
  const data = sample();
  data.settlements.push({ id: "set1", storeId: "s1", platformOrderId: "N-1", confirmed: true, amountFen: 7000, settlementDate: "2026-10-01" });
  const created = reconcileFeeSettlementIssues(data, "2026-10-02T00:00:00.000Z");
  assert.equal(created.length, 1);
  assert.equal(created[0].issueType, "fee_settlement_mismatch");
  assert.equal(created[0].amountDifferenceFen, -2700);
  data.issues = created;
  data.settlements[0].amountFen = 9700;
  const resolved = reconcileFeeSettlementIssues(data, "2026-10-03T00:00:00.000Z");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved");
  assert.equal(resolved[0].stableKey, created[0].stableKey);
});

test("missing SKU costs become stable review issues and resolve after an effective cost is added", () => {
  const data = sample();
  data.productCosts = [];
  const created = reconcileMissingCostIssues(data, "2026-10-02T00:00:00.000Z");
  assert.equal(created.length, 1);
  assert.equal(created[0].issueType, "missing_cost");
  assert.match(created[0].description, /SKU-1/);
  data.issues = created;
  data.productCosts.push({ id: "c-new", storeId: "s1", skuId: "SKU-1", unitCostFen: 2000, effectiveFrom: "2026-10-01", effectiveTo: null });
  const resolved = reconcileMissingCostIssues(data, "2026-10-03T00:00:00.000Z");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved");
  assert.equal(resolved[0].stableKey, created[0].stableKey);
});

test("CSV parser supports quoted commas, escaped quotes, and line breaks", () => {
  const rows = parseCsv('订单号,商品名称,备注\r\nA-1,"壳, 蓝色","说""你好"""\r\nA-2,"多行\n商品",ok');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ["A-1", "壳, 蓝色", '说"你好"']);
  assert.equal(rows[2][1], "多行\n商品");
});

test("mapping suggestions match common Chinese report headers", () => {
  const mapping = suggestMapping("orders", ["订单编号", "订单日期", "订单状态", "商品编码", "购买数量", "实付金额"]);
  assert.equal(mapping.platformOrderId, "订单编号");
  assert.equal(mapping.orderedAt, "订单日期");
  assert.equal(mapping.itemAmount, "实付金额");
});
