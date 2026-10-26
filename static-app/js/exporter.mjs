import { findCost, formatQuantity, multiplyFenByMilli, productSummary } from "./domain.mjs";

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00';
const INTEGER_FORMAT = '#,##0';
const QUANTITY_FORMAT = '#,##0.###';
const PERCENT_FORMAT = '0.0%';

function safeText(value) {
  const text = String(value ?? "");
  return /^[=+@\-]/.test(text) ? `'${text}` : text;
}

function yuan(fen) { return Number(fen || 0) / 100; }
function quantity(milli) { return Number(formatQuantity(milli)); }
function clean(value) { return value === null || value === undefined ? "" : safeText(value); }
function inRange(value, start, end) { return value >= start && value <= end; }
function issueLabel(value) {
  return ({ unknown_order_status: "订单状态无法识别", missing_cost: "商品缺少成本", fee_settlement_mismatch: "到账金额与估算不一致", duplicate_record: "发现重复记录" })[value] || value || "其他问题";
}
function reportLabel(value) {
  return ({ orders: "订单表", refunds: "退款表", fees: "平台扣费表", costs: "商品成本表", expenses: "其他支出表", settlements: "实际到账表" })[value] || value || "其他表格";
}
function statusLabel(value) {
  return ({ open: "待处理", review: "待复核", resolved: "已处理", imported: "已导入", partial: "部分导入", failed: "未完成", warning: "提醒", error: "错误" })[value] || value || "";
}

function addTableSheet(wb, name, title, note, headers, rows, widths, numberColumns = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([
    [safeText(title)],
    [safeText(note)],
    [],
    headers,
    ...(rows.length ? rows : [["当前范围没有记录"]]),
  ]);
  const lastColumn = Math.max(0, headers.length - 1);
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } }, { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } }];
  sheet["!cols"] = headers.map((_, index) => ({ wch: widths?.[index] || 18 }));
  sheet["!rows"] = [{ hpt: 25 }, { hpt: 34 }, { hpt: 8 }, { hpt: 22 }];
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: Math.max(3, rows.length + 3), c: lastColumn } }) };
  sheet["!freeze"] = { xSplit: 0, ySplit: 4, topLeftCell: "A5", activePane: "bottomLeft", state: "frozen" };
  sheet["!views"] = [{ showGridLines: false }];
  for (const [column, format] of Object.entries(numberColumns)) {
    const col = Number(column);
    for (let row = 4; row < 4 + rows.length; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell && typeof cell.v === "number") cell.z = format;
    }
  }
  XLSX.utils.book_append_sheet(wb, sheet, name);
}

function createOverviewSheet(wb, summary, selectedStoreName) {
  const amountRows = [
    ["商品销售额", yuan(summary.grossSalesFen), "本期已成交订单的商品金额。"],
    ["减：已确认退款", yuan(summary.refundFen), "按退款完成日期统计。"],
    ["净销售额", yuan(summary.netSalesFen), "商品销售额减去已确认退款。"],
    ["减：已匹配商品成本", yuan(summary.costFen), "只扣除已填写且在下单日期有效的商品成本。"],
    ["减：平台扣费", yuan(summary.feeFen), "按费用发生日期统计。"],
    ["减：其他经营支出", yuan(summary.expenseFen), "例如推广费、包装费等已录入支出。"],
    ["预计利润", yuan(summary.knownProfitFen), "净销售额减去以上成本和费用；资料不全时可能偏高。"],
    ["预计利润率", summary.profitMargin === null ? "—" : summary.profitMargin, "预计利润除以净销售额。"],
  ];
  const noteRows = [
    ["店铺范围", safeText(selectedStoreName)],
    ["统计日期", `${summary.start} 至 ${summary.end}`],
    ["订单处理", `${summary.orderCount} 笔已识别成交；${summary.cancelledCount} 笔已取消未计入；${summary.unknownCount} 笔状态未识别未计入。`],
    ["售出数量", `${quantity(summary.itemCountMilli)} 件`],
    ["实际到账", `${yuan(summary.settlementFen).toFixed(2)} 元（单独列示，只用于核对，不重复计入预计利润）`],
    ["数据提醒", summary.missingInputs.length ? summary.missingInputs.join("；") : "当前导入范围未发现明显缺项；这不代表平台账单完整。"],
    ["成本提醒", summary.missingCosts.length ? `${summary.missingCosts.length} 个商品未填写成本，预计利润可能偏高。` : "本期商品均已匹配成本。"],
    ["报告说明", "根据当前浏览器里已导入的数据生成；补充或修改数据后，请重新下载。此报告是经营参考，不是会计或税务结论。"],
  ];
  const aoa = [
    ["本期经营结果"],
    [`${safeText(selectedStoreName)}  ·  ${summary.start} 至 ${summary.end}`],
    [],
    ["商品销售额"],
    [yuan(summary.grossSalesFen)],
    [],
    ["预计利润"],
    [yuan(summary.knownProfitFen)],
    [],
    ["预计利润率"],
    [summary.profitMargin === null ? "—" : summary.profitMargin],
    [],
    ["计入统计的订单"],
    [summary.orderCount],
    [],
    ["利润是怎么算出来的"],
    ["项目", "金额（元）", "简单说明"],
    ...amountRows,
    [],
    ["这份报告怎么看"],
    ...noteRows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: 2 } }, { s: { r: 3, c: 3 }, e: { r: 3, c: 5 } },
    { s: { r: 4, c: 0 }, e: { r: 4, c: 2 } }, { s: { r: 4, c: 3 }, e: { r: 4, c: 5 } },
    { s: { r: 6, c: 0 }, e: { r: 6, c: 2 } }, { s: { r: 6, c: 3 }, e: { r: 6, c: 5 } },
    { s: { r: 7, c: 0 }, e: { r: 7, c: 2 } }, { s: { r: 7, c: 3 }, e: { r: 7, c: 5 } },
    { s: { r: 9, c: 0 }, e: { r: 9, c: 2 } }, { s: { r: 9, c: 3 }, e: { r: 9, c: 5 } },
    { s: { r: 10, c: 0 }, e: { r: 10, c: 2 } }, { s: { r: 10, c: 3 }, e: { r: 10, c: 5 } },
    { s: { r: 12, c: 0 }, e: { r: 12, c: 2 } }, { s: { r: 12, c: 3 }, e: { r: 12, c: 5 } },
    { s: { r: 13, c: 0 }, e: { r: 13, c: 2 } }, { s: { r: 13, c: 3 }, e: { r: 13, c: 5 } },
    { s: { r: 15, c: 0 }, e: { r: 15, c: 5 } },
    { s: { r: 16, c: 2 }, e: { r: 16, c: 5 } },
    { s: { r: 26, c: 0 }, e: { r: 26, c: 5 } },
    ...noteRows.map((_, index) => ({ s: { r: 27 + index, c: 1 }, e: { r: 27 + index, c: 5 } })),
    ...amountRows.map((_, index) => ({ s: { r: 17 + index, c: 2 }, e: { r: 17 + index, c: 5 } })),
  ];
  sheet["!cols"] = [{ wch: 25 }, { wch: 17 }, { wch: 23 }, { wch: 17 }, { wch: 17 }, { wch: 17 }];
  sheet["!rows"] = [{ hpt: 28 }, { hpt: 23 }, { hpt: 9 }, { hpt: 22 }, { hpt: 32 }, { hpt: 10 }, { hpt: 22 }, { hpt: 32 }, { hpt: 10 }, { hpt: 22 }, { hpt: 30 }, { hpt: 10 }, { hpt: 22 }, { hpt: 28 }, { hpt: 10 }, { hpt: 25 }, { hpt: 22 }, ...Array.from({ length: amountRows.length }, () => ({ hpt: 24 }))];
  sheet["!rows"][26] = { hpt: 25 };
  for (let row = 27; row < 27 + noteRows.length; row += 1) sheet["!rows"][row] = { hpt: 30 };
  sheet["!views"] = [{ showGridLines: false }];
  for (const row of [4, 7]) for (const cell of [`A${row + 1}`, `D${row + 1}`]) if (sheet[cell]) sheet[cell].z = MONEY_FORMAT;
  if (sheet.A11 && typeof sheet.A11.v === "number") sheet.A11.z = PERCENT_FORMAT;
  if (sheet.A14 && typeof sheet.A14.v === "number") sheet.A14.z = INTEGER_FORMAT;
  for (let row = 17; row < 17 + amountRows.length; row += 1) {
    const cell = sheet[`B${row + 1}`];
    if (cell && typeof cell.v === "number") cell.z = row === 24 ? PERCENT_FORMAT : MONEY_FORMAT;
  }
  XLSX.utils.book_append_sheet(wb, sheet, "先看这里");
}

function dailyRows(data, summary) {
  const days = new Map();
  const cursor = new Date(`${summary.start}T00:00:00Z`);
  const end = new Date(`${summary.end}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    days.set(day, { date: day, orderIds: new Set(), quantityMilli: 0, salesFen: 0, refundFen: 0, costFen: 0, feeFen: 0, expenseFen: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const orders = data.orders.filter((row) => summary.storeIds.includes(row.storeId) && row.statusClass === "valid" && inRange(row.orderedAt, summary.start, summary.end));
  const orderById = new Map(orders.map((row) => [row.id, row]));
  for (const item of data.orderItems) {
    const order = orderById.get(item.orderId);
    if (!order) continue;
    const day = days.get(order.orderedAt);
    if (!day) continue;
    day.orderIds.add(order.id);
    day.quantityMilli += item.quantityMilli || 0;
    day.salesFen += item.amountFen || 0;
    const cost = findCost(data.productCosts, item.storeId, item.skuId, order.orderedAt);
    if (cost) day.costFen += multiplyFenByMilli(cost.unitCostFen, item.quantityMilli);
  }
  for (const refund of data.refunds) if (refund.confirmed && summary.storeIds.includes(refund.storeId) && days.has(refund.completedAt)) days.get(refund.completedAt).refundFen += refund.amountFen || 0;
  for (const fee of data.platformFees) if (summary.storeIds.includes(fee.storeId) && days.has(fee.feeDate)) days.get(fee.feeDate).feeFen += fee.amountFen || 0;
  for (const expense of data.otherExpenses) if (summary.storeIds.includes(expense.storeId) && days.has(expense.expenseDate)) days.get(expense.expenseDate).expenseFen += expense.amountFen || 0;
  const rows = [...days.values()].map((row) => {
    const profitFen = row.salesFen - row.refundFen - row.costFen - row.feeFen - row.expenseFen;
    return [row.date, row.orderIds.size, quantity(row.quantityMilli), yuan(row.salesFen), yuan(row.refundFen), yuan(row.costFen), yuan(row.feeFen), yuan(row.expenseFen), yuan(profitFen), row.salesFen - row.refundFen ? profitFen / (row.salesFen - row.refundFen) : "—"];
  });
  rows.push(["本期合计", summary.orderCount, quantity(summary.itemCountMilli), yuan(summary.grossSalesFen), yuan(summary.refundFen), yuan(summary.costFen), yuan(summary.feeFen), yuan(summary.expenseFen), yuan(summary.knownProfitFen), summary.profitMargin === null ? "—" : summary.profitMargin]);
  return rows;
}

function productRows(data, summary) {
  const products = productSummary(data, summary);
  const totalSales = products.reduce((sum, row) => sum + row.salesFen, 0);
  const sharedCosts = summary.refundFen + summary.feeFen + summary.expenseFen;
  return products.map((row) => {
    const allocated = totalSales ? Math.round(sharedCosts * row.salesFen / totalSales) : 0;
    const profit = row.salesFen - row.costFen - allocated;
    return [clean(row.productName), clean(row.skuId), quantity(row.quantityMilli), yuan(row.salesFen), row.missingCost ? "未填写" : yuan(row.costFen), yuan(allocated), yuan(profit), row.salesFen ? profit / row.salesFen : "—", row.missingCost ? "缺少成本，利润可能偏高" : "已匹配成本"];
  });
}

function orderRows(data, summary) {
  const stores = new Map(data.stores.map((row) => [row.id, row]));
  const orders = data.orders.filter((row) => summary.storeIds.includes(row.storeId) && inRange(row.orderedAt, summary.start, summary.end));
  const itemsByOrder = new Map();
  for (const item of data.orderItems) {
    const list = itemsByOrder.get(item.orderId) || [];
    list.push(item);
    itemsByOrder.set(item.orderId, list);
  }
  const rows = [];
  for (const order of orders) {
    const items = itemsByOrder.get(order.id) || [null];
    for (const item of items) rows.push([
      order.orderedAt, clean(stores.get(order.storeId)?.name), clean(order.platformOrderId), clean(order.orderStatus), order.statusClass === "valid" ? "计入" : "未计入",
      clean(item?.productName), clean(item?.skuId), item ? quantity(item.quantityMilli) : "", item ? yuan(item.amountFen) : "",
    ]);
  }
  return rows;
}

function moneyRecordRows(data, summary) {
  const storeName = new Map(data.stores.map((row) => [row.id, row.name]));
  const rows = [];
  for (const row of data.refunds) if (summary.storeIds.includes(row.storeId) && inRange(row.completedAt, summary.start, summary.end)) rows.push([row.completedAt, clean(storeName.get(row.storeId)), "退款", clean(row.platformRefundId || "退款记录"), clean(row.platformOrderId), yuan(row.amountFen), row.confirmed ? "已确认，计入利润估算" : "未确认，不计入利润估算"]);
  for (const row of data.platformFees) if (summary.storeIds.includes(row.storeId) && inRange(row.feeDate, summary.start, summary.end)) rows.push([row.feeDate, clean(storeName.get(row.storeId)), "平台扣费", clean(row.feeType), clean(row.platformOrderId), yuan(row.amountFen), "计入利润估算"]);
  for (const row of data.otherExpenses) if (summary.storeIds.includes(row.storeId) && inRange(row.expenseDate, summary.start, summary.end)) rows.push([row.expenseDate, clean(storeName.get(row.storeId)), "其他支出", clean(row.expenseType), clean(row.platformOrderId), yuan(row.amountFen), clean(row.note || row.allocationMethod || "计入利润估算")]);
  for (const row of data.settlements) if (summary.storeIds.includes(row.storeId) && inRange(row.settlementDate, summary.start, summary.end)) rows.push([row.settlementDate, clean(storeName.get(row.storeId)), "实际到账", clean(row.settlementStatus), clean(row.platformOrderId), yuan(row.amountFen), row.confirmed ? "已确认；仅供核对到账" : "未确认；仅供核对到账"]);
  return rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

export function createWorkbook(data, summary, selectedStoreName) {
  if (!globalThis.XLSX) throw new Error("Excel 导出组件未加载，请刷新页面后重试。");
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: "卖家利润助手经营报告", Subject: "按当前筛选范围生成的本地经营结果", Author: "卖家利润助手（本地生成）" };
  createOverviewSheet(wb, summary, selectedStoreName);

  addTableSheet(wb, "每日经营", "每日经营情况", "销售、订单和成本按下单日期统计；退款按完成日期、费用按发生日期统计。利润是已导入数据估算。", ["日期", "成交订单", "售出数量", "商品销售额", "退款", "匹配成本", "平台扣费", "其他支出", "预计利润", "预计利润率"], dailyRows(data, summary), [14, 12, 12, 16, 14, 14, 14, 14, 16, 14], { 2: QUANTITY_FORMAT, 3: MONEY_FORMAT, 4: MONEY_FORMAT, 5: MONEY_FORMAT, 6: MONEY_FORMAT, 7: MONEY_FORMAT, 8: MONEY_FORMAT, 9: PERCENT_FORMAT });
  addTableSheet(wb, "商品表现", "商品表现排行", "商品退款和店铺级费用按商品销售额比例分摊，仅用于经营参考；缺少商品成本时，该商品利润会偏高。", ["商品名称", "商品编号", "售出数量", "商品销售额", "已匹配成本", "分摊退款及费用", "预计贡献利润", "预计利润率", "成本情况"], productRows(data, summary), [28, 18, 12, 16, 16, 18, 18, 14, 28], { 2: QUANTITY_FORMAT, 3: MONEY_FORMAT, 4: MONEY_FORMAT, 5: MONEY_FORMAT, 6: MONEY_FORMAT, 7: PERCENT_FORMAT });
  addTableSheet(wb, "订单明细", "订单和商品明细", "订单状态为“未计入”的记录不会计入本期销售。金额为导入的商品实付金额。", ["下单日期", "店铺名称", "订单编号", "订单状态", "统计处理", "商品名称", "商品编号", "商品数量", "商品金额"], orderRows(data, summary), [14, 24, 22, 18, 14, 30, 18, 12, 16], { 7: QUANTITY_FORMAT, 8: MONEY_FORMAT });
  addTableSheet(wb, "退款费用到账", "退款、费用和实际到账", "实际到账单独列示，仅供和平台账单核对，不会与预计利润重复相加。", ["日期", "店铺名称", "记录类型", "项目", "订单编号", "金额", "说明"], moneyRecordRows(data, summary), [14, 24, 16, 24, 22, 16, 32], { 5: MONEY_FORMAT });

  const stores = new Map(data.stores.map((row) => [row.id, row.name]));
  const costs = data.productCosts.filter((row) => summary.storeIds.includes(row.storeId) && row.effectiveFrom <= summary.end && (!row.effectiveTo || row.effectiveTo >= summary.start));
  addTableSheet(wb, "商品成本", "商品成本记录", "只展示生效日期与本期有重叠的成本记录；同一商品可能有多条不同日期的成本。", ["店铺名称", "商品名称", "商品编号", "单位成本", "生效日期", "截止日期", "来源"], costs.map((row) => [clean(stores.get(row.storeId)), clean(row.productName), clean(row.skuId), yuan(row.unitCostFen), clean(row.effectiveFrom), clean(row.effectiveTo), clean(row.costSource || "手动维护")]), [24, 30, 18, 16, 14, 14, 20], { 3: MONEY_FORMAT });
  const issues = data.issues.filter((row) => summary.storeIds.includes(row.storeId) && row.status !== "resolved");
  addTableSheet(wb, "需要留意", "需要留意的问题", "列出当前未处理的问题，不受日期范围限制；处理状态可在网站的“异常核对”页面查看。", ["店铺名称", "问题", "程度", "处理状态", "发现时间", "情况说明", "处理备注"], issues.map((row) => [clean(stores.get(row.storeId)), safeText(issueLabel(row.issueType)), safeText(statusLabel(row.severity)), safeText(statusLabel(row.status)), clean(row.createdAt), clean(row.description), clean(row.resolutionNote)]), [24, 24, 14, 14, 22, 60, 36]);
  const batches = data.importBatches.filter((row) => summary.storeIds.includes(row.storeId) && row.coverageStart <= summary.end && row.coverageEnd >= summary.start);
  addTableSheet(wb, "导入记录", "本期相关的导入记录", "展示覆盖本期日期范围的导入批次，帮助确认报告依据哪些文件生成。", ["店铺名称", "表格类型", "文件名", "导入时间", "文件行数", "新增记录", "未通过", "重复", "冲突", "导入结果"], batches.map((row) => [clean(stores.get(row.storeId)), safeText(reportLabel(row.reportType)), clean(row.originalFilename), clean(row.importedAt), Number(row.rowCount || 0), Number(row.acceptedCount || 0), Number(row.rejectedCount || 0), Number(row.duplicateCount || 0), Number(row.conflictCount || 0), safeText(statusLabel(row.status))]), [24, 18, 36, 22, 12, 12, 12, 12, 12, 16], { 4: INTEGER_FORMAT, 5: INTEGER_FORMAT, 6: INTEGER_FORMAT, 7: INTEGER_FORMAT, 8: INTEGER_FORMAT });
  return wb;
}

export function downloadWorkbook(data, summary, selectedStoreName) {
  const workbook = createWorkbook(data, summary, selectedStoreName);
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  XLSX.writeFile(workbook, `卖家利润助手_经营报告_${stamp}.xlsx`, { compression: true });
}
