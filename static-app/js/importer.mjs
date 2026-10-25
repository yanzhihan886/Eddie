import { REPORTS, classifyOrderStatus, dedupeCandidates, isRefundConfirmed, isSettlementConfirmed, multiplyFenByMilli, normalizeDate, parseMoneyFen, parseQuantityMilli, stableRecordKey } from "./domain.mjs";
import { getByIndex, readAll, writeRecords } from "./db.mjs";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DATA_ROWS = 50000;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === "," || ch === "\t") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      row.push(field); field = "";
      if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
      row = [];
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
    } else field += ch;
    if (rows.length > MAX_DATA_ROWS + 1) throw new Error(`文件超过 ${MAX_DATA_ROWS.toLocaleString()} 行限制。`);
  }
  row.push(field);
  if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
  if (quoted) throw new Error("CSV 文件中有未闭合的引号，请检查源文件。");
  return rows;
}

function decodeCsv(buffer) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!utf8.includes("\uFFFD")) return utf8;
  try { return new TextDecoder("gb18030", { fatal: false }).decode(buffer); }
  catch { return utf8; }
}

export async function sha256(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error("当前页面不支持安全文件校验。请通过 localhost 或 HTTPS 打开本应用。文件未导入。");
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readTabularFile(file) {
  if (!file) throw new Error("请先选择文件。");
  if (file.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 20 MB。请拆分后再导入。");
  const buffer = await file.arrayBuffer();
  const extension = file.name.split(".").pop()?.toLowerCase();
  let matrix;
  if (extension === "csv" || extension === "tsv" || extension === "txt") {
    matrix = parseCsv(decodeCsv(buffer));
  } else if (["xlsx", "xlsm", "xls"].includes(extension)) {
    if (!globalThis.XLSX) throw new Error("Excel 解析组件未加载。请刷新页面后重试；所有文件解析仍仅在本机进行。");
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false, dense: true, sheetRows: MAX_DATA_ROWS + 1 });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("Excel 文件没有可读取的工作表。");
    matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false, blankrows: false, dateNF: "yyyy-mm-dd" });
  } else {
    throw new Error("支持 CSV、TSV、XLS、XLSX 和 XLSM 文件。");
  }
  if (!matrix.length || !matrix[0]?.some((cell) => String(cell).trim())) throw new Error("文件为空，或首行没有字段标题。");
  if (matrix.length - 1 > MAX_DATA_ROWS) throw new Error(`文件超过 ${MAX_DATA_ROWS.toLocaleString()} 行限制。`);
  const headers = matrix[0].map((value, i) => String(value ?? "").trim() || `未命名列 ${i + 1}`);
  const rows = matrix.slice(1).map((cells) => headers.map((_, i) => cells?.[i] ?? ""));
  return { buffer, headers, rows, sheetName: extension === "csv" || extension === "tsv" ? "CSV" : "第一个工作表" };
}

function headerKey(value) { return String(value ?? "").trim().toLowerCase().replace(/[\s_\-（）()]/g, ""); }

export function suggestMapping(reportType, headers) {
  const spec = REPORTS[reportType];
  if (!spec) throw new Error("请选择有效的报表类型。");
  return Object.fromEntries(spec.fields.map((field) => {
    const aliases = new Set([field.key, field.label, ...field.aliases].map(headerKey));
    const found = headers.find((header) => aliases.has(headerKey(header)));
    return [field.key, found ?? ""];
  }));
}

function valueOf(row, headers, mapping, key) {
  const header = mapping[key];
  if (!header) return "";
  const index = headers.indexOf(header);
  return index < 0 ? "" : row[index];
}

function asText(value) { return String(value ?? "").trim(); }

function parseMappedDate(value) {
  if (typeof value === "number" && value > 20000 && value < 80000 && globalThis.XLSX?.SSF?.parse_date_code) {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) return normalizeDate(`${date.y}-${date.m}-${date.d}`);
  }
  return normalizeDate(value);
}

function canonicalRowHash(data) {
  const clean = Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]]));
  return JSON.stringify(clean);
}

function requiredValue(value, label) {
  if (value === null || value === undefined || value === "") throw new Error(`缺少${label}`);
  return value;
}

function normalizeCandidate(reportType, raw, headers, mapping, storeId, rowNumber) {
  const mapped = Object.fromEntries(REPORTS[reportType].fields.map((field) => [field.key, valueOf(raw, headers, mapping, field.key)]));
  const sourceDate = {
    orders: "orderedAt", refunds: "completedAt", fees: "feeDate", costs: "effectiveFrom", expenses: "expenseDate", settlements: "settlementDate",
  }[reportType];
  let data;
  if (reportType === "orders") {
    const platformOrderId = asText(requiredValue(mapped.platformOrderId, "平台订单号"));
    const orderedAt = requiredValue(parseMappedDate(mapped.orderedAt), "有效下单日期");
    const orderStatus = asText(requiredValue(mapped.orderStatus, "订单状态"));
    const skuId = asText(requiredValue(mapped.skuId, "SKU 编号"));
    const quantityMilli = requiredValue(parseQuantityMilli(mapped.quantity), "有效销售数量");
    if (quantityMilli <= 0) throw new Error("销售数量必须大于 0");
    const unitPriceFen = parseMoneyFen(mapped.unitPrice);
    const discountFen = parseMoneyFen(mapped.discountAmount) ?? 0;
    let amountFen = parseMoneyFen(mapped.itemAmount);
    if (amountFen === null) {
      if (unitPriceFen === null) throw new Error("商品实付金额和商品单价至少填写一项");
      amountFen = multiplyFenByMilli(unitPriceFen, quantityMilli) - discountFen;
    }
    if (amountFen < 0) throw new Error("商品实付金额不能为负数，请将退款记录放到退款表");
    data = { storeId, platformOrderId, orderedAt, orderStatus, statusClass: classifyOrderStatus(orderStatus), skuId,
      productName: asText(mapped.productName), platformItemId: asText(mapped.platformItemId) || "",
      quantityMilli, unitPriceFen, amountFen, discountFen };
  } else if (reportType === "refunds") {
    data = { storeId, platformRefundId: asText(mapped.platformRefundId) || "", platformOrderId: asText(requiredValue(asText(mapped.platformOrderId), "平台订单号")),
      platformItemId: asText(mapped.platformItemId) || "", refundStatus: asText(requiredValue(asText(mapped.refundStatus), "退款状态")),
      confirmed: isRefundConfirmed(mapped.refundStatus), amountFen: requiredValue(parseMoneyFen(mapped.refundAmount), "有效退款金额"),
      completedAt: requiredValue(parseMappedDate(mapped.completedAt), "有效退款完成日期") };
  } else if (reportType === "fees") {
    data = { storeId, feeId: asText(mapped.feeId) || "", platformOrderId: asText(mapped.platformOrderId) || "", feeType: asText(requiredValue(asText(mapped.feeType), "费用类型")),
      amountFen: requiredValue(parseMoneyFen(mapped.feeAmount), "有效费用金额"), feeDate: requiredValue(parseMappedDate(mapped.feeDate), "有效费用日期") };
  } else if (reportType === "costs") {
    const effectiveFrom = parseMappedDate(mapped.effectiveFrom) || "1970-01-01";
    const effectiveTo = mapped.effectiveTo ? parseMappedDate(mapped.effectiveTo) : null;
    if (mapped.effectiveTo && !effectiveTo) throw new Error("失效日期格式无效");
    if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("失效日期不能早于生效日期");
    data = { storeId, skuId: asText(requiredValue(asText(mapped.skuId), "SKU 编号")), productName: asText(mapped.productName),
      unitCostFen: requiredValue(parseMoneyFen(mapped.unitCost), "有效单位成本"), effectiveFrom, effectiveTo };
    if (data.unitCostFen < 0) throw new Error("单位成本不能为负数");
  } else if (reportType === "expenses") {
    data = { storeId, expenseId: asText(mapped.expenseId) || "", expenseType: asText(requiredValue(asText(mapped.expenseType), "费用类型")),
      amountFen: requiredValue(parseMoneyFen(mapped.expenseAmount), "有效费用金额"), expenseDate: requiredValue(parseMappedDate(mapped.expenseDate), "有效费用日期"),
      allocationMethod: asText(mapped.allocationMethod) || "店铺级", platformOrderId: asText(mapped.platformOrderId) || "", skuId: asText(mapped.skuId) || "", note: asText(mapped.note) };
  } else if (reportType === "settlements") {
    data = { storeId, transactionId: asText(mapped.transactionId) || "", platformOrderId: asText(mapped.platformOrderId) || "",
      amountFen: requiredValue(parseMoneyFen(mapped.settlementAmount), "有效结算金额"), settlementStatus: asText(requiredValue(asText(mapped.settlementStatus), "结算状态")),
      confirmed: isSettlementConfirmed(mapped.settlementStatus), settlementDate: requiredValue(parseMappedDate(mapped.settlementDate), "有效结算日期") };
  } else throw new Error("暂不支持此报表类型。");

  const recordKey = stableRecordKey(reportType, data);
  return { data, recordKey, rowHash: canonicalRowHash(data), rowNumber, raw };
}

export async function prepareImport(db, file, reportType, storeId, headers, rows, mapping, fileHash) {
  if (!REPORTS[reportType]) throw new Error("请选择报表类型。");
  const existingBatch = await getByIndex(db, "importBatches", "fileKey", [storeId, reportType, fileHash]);
  const good = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    try { good.push(normalizeCandidate(reportType, rows[index], headers, mapping, storeId, index + 2)); }
    catch (error) { rejected.push({ rowNumber: index + 2, raw: rows[index], message: error.message || "数据格式无法识别" }); }
  }
  const objectStore = { orders: "orderItems", refunds: "refunds", fees: "platformFees", costs: "productCosts", expenses: "otherExpenses", settlements: "settlements" }[reportType];
  const existing = (await readAll(db, objectStore)).filter((record) => record.storeId === storeId);
  const split = dedupeCandidates(good, existing);
  const dateKey = { orders: "orderedAt", refunds: "completedAt", fees: "feeDate", costs: "effectiveFrom", expenses: "expenseDate", settlements: "settlementDate" }[reportType];
  const coverageDates = split.accepted.map((row) => row.data[dateKey]).filter(Boolean).sort();
  return {
    fileName: file.name, size: file.size, reportType, storeId, fileHash, headers, rows, mapping,
    accepted: split.accepted, duplicates: split.duplicates, conflicts: split.conflicts, rejected,
    duplicateFile: Boolean(existingBatch), batchAlreadyImported: existingBatch || null,
    coverageStart: coverageDates[0] || null, coverageEnd: coverageDates.at(-1) || null,
    rowCount: rows.length,
  };
}

function uuid() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function entityStore(reportType) {
  return { orders: "orderItems", refunds: "refunds", fees: "platformFees", costs: "productCosts", expenses: "otherExpenses", settlements: "settlements" }[reportType];
}

function entityData(reportType, candidate, batchId) {
  const base = { ...candidate.data, id: uuid(), recordKey: candidate.recordKey, rowHash: candidate.rowHash, importBatchId: batchId, sourceRowNumber: candidate.rowNumber };
  if (reportType === "orders") return { ...base, orderId: "" };
  if (reportType === "refunds") return { ...base, platformRefundId: base.platformRefundId || "" };
  return base;
}

export async function commitImport(db, plan) {
  if (plan.duplicateFile) throw new Error("這份文件已完整匯入過，未重複寫入資料。");
  const batchId = uuid();
  const importedAt = new Date().toISOString();
  const allCandidates = [...plan.accepted, ...plan.duplicates, ...plan.conflicts];
  const dates = allCandidates.map((row) => row.data[{
    orders: "orderedAt", refunds: "completedAt", fees: "feeDate", costs: "effectiveFrom", expenses: "expenseDate", settlements: "settlementDate",
  }[plan.reportType]]).filter(Boolean).sort();
  const batch = {
    id: batchId, storeId: plan.storeId, reportType: plan.reportType, originalFilename: plan.fileName,
    fileHash: plan.fileHash, importedAt, rowCount: plan.rowCount, acceptedCount: plan.accepted.length,
    rejectedCount: plan.rejected.length, duplicateCount: plan.duplicates.length, conflictCount: plan.conflicts.length,
    status: plan.rejected.length || plan.conflicts.length ? "partial" : "imported", fieldMapping: plan.mapping,
    coverageStart: dates[0] || "", coverageEnd: dates.at(-1) || "", appSchemaVersion: 1,
  };
  const bundle = { importBatches: [batch], rawRecords: [], issues: [], [entityStore(plan.reportType)]: [] };
  const issue = (rowNumber, type, severity, description, status = "open") => {
    const stableKey = `import|${batchId}|${rowNumber}|${type}`;
    bundle.issues.push({ id: uuid(), storeId: plan.storeId, issueType: type, severity, status, description,
      sourceRecordId: "", relatedRecordIds: [], amountDifferenceFen: null, resolutionNote: "", createdAt: importedAt, stableKey });
  };

  for (const row of [...plan.accepted, ...plan.duplicates, ...plan.conflicts, ...plan.rejected]) {
    const isBad = "message" in row;
    const decision = isBad ? "rejected" : plan.duplicates.includes(row) ? "duplicate" : plan.conflicts.includes(row) ? "conflict" : "accepted";
    bundle.rawRecords.push({ id: uuid(), batchId, rowNumber: row.rowNumber, sourceValues: row.raw, decision, validationMessage: isBad ? row.message : "" });
    if (isBad) issue(row.rowNumber, "import_validation", "warning", `第 ${row.rowNumber} 行：${row.message}`);
    else if (decision === "duplicate") issue(row.rowNumber, "duplicate_record", "info", `第 ${row.rowNumber} 行与已有数据相同，已跳过。`, "resolved");
    else if (decision === "conflict") issue(row.rowNumber, "record_conflict", "warning", `第 ${row.rowNumber} 行的业务编号已存在，但字段值不同；原记录未被覆盖。`);
  }

  if (plan.reportType === "orders") {
    const currentOrders = (await readAll(db, "orders")).filter((row) => row.storeId === plan.storeId);
    const orderByPlatformId = new Map(currentOrders.map((row) => [row.platformOrderId, row]));
    const pendingOrders = new Map();
    for (const candidate of plan.accepted) {
      const item = entityData("orders", candidate, batchId);
      let order = orderByPlatformId.get(candidate.data.platformOrderId) || pendingOrders.get(candidate.data.platformOrderId);
      if (!order) {
        order = { id: uuid(), storeId: plan.storeId, platformOrderId: candidate.data.platformOrderId,
          orderedAt: candidate.data.orderedAt, orderStatus: candidate.data.orderStatus,
          statusClass: candidate.data.statusClass, createdAt: importedAt, importBatchId: batchId };
        pendingOrders.set(candidate.data.platformOrderId, order);
      } else if (order.orderedAt !== candidate.data.orderedAt || order.statusClass !== candidate.data.statusClass) {
        issue(candidate.rowNumber, "order_status_conflict", "warning", `订单 ${candidate.data.platformOrderId} 的日期或状态与现有记录不同；保留现有订单信息。`);
      }
      item.orderId = order.id;
      bundle.orderItems.push(item);
      if (candidate.data.statusClass === "unknown") issue(candidate.rowNumber, "unknown_order_status", "warning", `订单 ${candidate.data.platformOrderId} 的状态“${candidate.data.orderStatus}”未识别，未计入销售。`);
    }
    bundle.orders = [...pendingOrders.values()];
  } else {
    for (const candidate of plan.accepted) bundle[entityStore(plan.reportType)].push(entityData(plan.reportType, candidate, batchId));
  }

  if (plan.reportType === "fees") {
    const orderIds = new Set((await readAll(db, "orders")).filter((o) => o.storeId === plan.storeId).map((o) => o.platformOrderId));
    for (const candidate of plan.accepted) if (candidate.data.platformOrderId && !orderIds.has(candidate.data.platformOrderId)) {
      issue(candidate.rowNumber, "unmatched_fee", "warning", `费用流水“${candidate.data.feeId || candidate.data.feeType}”关联的订单不存在或尚未导入。`);
    }
  }

  await writeRecords(db, bundle, "add");
  return { batch, importedCount: plan.accepted.length, rejectedCount: plan.rejected.length, duplicateCount: plan.duplicates.length, conflictCount: plan.conflicts.length, issueCount: bundle.issues.length };
}
