import { productSummary } from "./domain.mjs";

const isInPeriod = (date, summary) => date >= summary.start && date <= summary.end;
const ratioOf = (amount, total) => total > 0 ? amount / total : 0;

function moneyByType(rows, dateKey, amountKey, summary, pattern) {
  return rows
    .filter((row) => summary.storeIds.includes(row.storeId) && isInPeriod(row[dateKey] || "", summary) && pattern.test(String(row.feeType || row.expenseType || "")))
    .reduce((sum, row) => sum + Math.max(0, Number(row[amountKey] || 0)), 0);
}

function suggestedUnitPriceIncreaseFen(row, totalSalesFen, sharedDeductionFen, marginTarget) {
  if (!row.quantityMilli || row.missingCost || totalSalesFen <= 0) return null;
  const sharedDeductionRate = sharedDeductionFen / totalSalesFen;
  const roomForCost = 1 - sharedDeductionRate - marginTarget;
  if (roomForCost <= 0) return null;
  const targetSalesFen = Math.ceil(row.costFen / roomForCost);
  return Math.max(0, Math.ceil((targetSalesFen - row.salesFen) * 1000 / row.quantityMilli));
}

function reasonFor(row, shares) {
  if (row.missingCost) return { reason: "没填成本，暂时算不准", recommendation: "先补上每件进货价，再判断是否亏损。", action: "补填成本", target: "costs" };
  if (row.salesFen > 0 && row.costFen / row.salesFen >= 0.75) {
    return { reason: "进货成本占销售额太高", action: "查看商品订单", target: "records" };
  }
  const causes = [
    { amount: shares.refundFen, threshold: 0.12, reason: "退款较多，吃掉了利润", recommendation: "检查退款订单，看看是否反复出现质量或描述问题。" },
    { amount: shares.shippingFen, threshold: 0.08, reason: "运费占比偏高，压低了利润", recommendation: "检查运费模板和包邮门槛，避免运费继续吃掉利润。" },
    { amount: shares.commissionFen, threshold: 0.1, reason: "平台扣费较多，吃掉了利润", recommendation: "查看平台扣费明细，确认佣金和服务费是否偏高。" },
    { amount: shares.promotionFen, threshold: 0.1, reason: "推广费偏高，压低了利润", recommendation: "先降低推广预算，再观察这件商品是否恢复盈利。" },
  ].filter((item) => row.salesFen > 0 && item.amount / row.salesFen >= item.threshold)
    .sort((a, b) => b.amount - a.amount);
  if (causes.length) return { ...causes[0], action: "查看商品订单", target: "records" };
  return { reason: "成本和分摊费用加起来超过了销售额", recommendation: "核对进货价和实际售价，再考虑调价或下架。", action: "查看商品订单", target: "records" };
}

/** Product profits use the same sales-proportional allocation as the dashboard. */
export function buildProfitInsights(data, summary, marginThresholdPercent = 10) {
  const threshold = Number.isFinite(Number(marginThresholdPercent))
    ? Math.max(0, Math.min(50, Number(marginThresholdPercent))) : 10;
  const products = productSummary(data, summary);
  const totalSalesFen = products.reduce((sum, row) => sum + row.salesFen, 0);
  const sharedDeductionFen = summary.refundFen + summary.feeFen + summary.expenseFen;
  const shippingTotalFen = moneyByType(data.platformFees, "feeDate", "amountFen", summary, /运费|物流|配送/)
    + moneyByType(data.otherExpenses, "expenseDate", "amountFen", summary, /运费|物流|配送/);
  const commissionTotalFen = moneyByType(data.platformFees, "feeDate", "amountFen", summary, /佣金|技术服务费|交易手续费|平台扣点/);
  const promotionTotalFen = moneyByType(data.otherExpenses, "expenseDate", "amountFen", summary, /推广|广告|投流/);
  const rows = products.map((product) => {
    const allocate = (amount) => totalSalesFen > 0 ? Math.round(amount * product.salesFen / totalSalesFen) : 0;
    const shares = {
      refundFen: allocate(summary.refundFen),
      shippingFen: allocate(shippingTotalFen),
      commissionFen: allocate(commissionTotalFen),
      promotionFen: allocate(promotionTotalFen),
    };
    const allocatedDeductionsFen = allocate(sharedDeductionFen);
    const estimatedProfitFen = product.salesFen - product.costFen - allocatedDeductionsFen;
    const margin = product.salesFen ? estimatedProfitFen / product.salesFen : null;
    const reason = estimatedProfitFen < 0 || product.missingCost
      ? reasonFor(product, shares) : { reason: "", action: "查看商品订单", target: "records" };
    const priceIncreaseFen = suggestedUnitPriceIncreaseFen(product, totalSalesFen, sharedDeductionFen, threshold / 100);
    const suggestion = reason.recommendation
      ? reason.recommendation
      : priceIncreaseFen === null
        ? "先核对各项费用和进货价，再考虑调价或下架。"
        : priceIncreaseFen > 0
          ? `建议每件至少提价 ${new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(priceIncreaseFen / 100)}，达到约 ${threshold}% 利润率。`
          : "当前售价可覆盖成本，继续留意费用变化。";
    return { ...product, ...shares, allocatedDeductionsFen, profitFen: estimatedProfitFen, margin, reason: reason.reason, action: reason.action, target: reason.target, suggestion };
  });
  const knownCost = rows.filter((row) => !row.missingCost);
  const lossProducts = knownCost.filter((row) => row.profitFen < 0).sort((a, b) => a.profitFen - b.profitFen);
  const thinProducts = knownCost.filter((row) => row.profitFen >= 0 && row.margin !== null && row.margin < threshold / 100)
    .sort((a, b) => a.margin - b.margin);
  const uncertainProducts = rows.filter((row) => row.missingCost).sort((a, b) => b.salesFen - a.salesFen);
  return {
    products: rows.sort((a, b) => b.salesFen - a.salesFen),
    lossProducts,
    thinProducts,
    uncertainProducts,
    totalLossFen: lossProducts.reduce((sum, row) => sum + Math.abs(row.profitFen), 0),
    lossCount: lossProducts.length,
    thresholdPercent: threshold,
  };
}
