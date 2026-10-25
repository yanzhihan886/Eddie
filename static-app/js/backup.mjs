import { DB_VERSION, STORE_NAMES } from "./domain.mjs";
import { replaceSnapshot } from "./db.mjs";

export const BACKUP_FORMAT = "seller-profit-assistant-local-backup";
export const BACKUP_VERSION = 1;
const MAX_BACKUP_RECORDS = 250000;

export function makeBackup(snapshot) {
  return {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    appSchemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    note: "此文件包含所选浏览器中的经营记录和导入行内容。仅保存在用户设备上，不会自动上传。",
    stores: Object.fromEntries(STORE_NAMES.map((name) => [name, snapshot[name] || []])),
  };
}

function ensureUnique(rows, keyFn, label) {
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) throw new Error(`备份中的${label}存在重复唯一编号，已取消恢复。`);
    seen.add(key);
  }
}

export function validateBackup(input) {
  if (!input || typeof input !== "object" || input.format !== BACKUP_FORMAT) throw new Error("文件不是卖家利润助手的有效备份。");
  if (!Number.isInteger(input.backupVersion) || input.backupVersion > BACKUP_VERSION) throw new Error("备份版本比当前应用更新，请先升级应用后再恢复。");
  if (input.backupVersion !== BACKUP_VERSION) throw new Error("当前版本不支持此旧版备份格式；文件未写入，也未修改现有数据。");
  if (input.appSchemaVersion !== DB_VERSION) throw new Error("备份数据库结构与当前版本不一致；文件未写入，也未修改现有数据。");
  if (!input.stores || typeof input.stores !== "object") throw new Error("备份缺少数据表。");
  const stores = {};
  let total = 0;
  for (const name of STORE_NAMES) {
    const rows = input.stores[name];
    if (!Array.isArray(rows)) throw new Error(`备份中的“${name}”不是有效记录列表。`);
    stores[name] = rows;
    total += rows.length;
    if (total > MAX_BACKUP_RECORDS) throw new Error("备份记录数超过安全恢复上限（250,000 条）。");
    ensureUnique(rows, (row) => row?.id, `${name}记录 ID`);
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id) throw new Error(`备份中的“${name}”有无效记录。`);
    }
  }
  const unique = {
    orderNumber: [stores.orders, (r) => `${r.storeId}|${r.platformOrderId}`, "订单号"],
    itemKey: [stores.orderItems, (r) => r.recordKey, "订单商品业务编号"],
    refundKey: [stores.refunds, (r) => r.recordKey, "退款业务编号"],
    feeKey: [stores.platformFees, (r) => r.recordKey, "平台费用业务编号"],
    costKey: [stores.productCosts, (r) => `${r.storeId}|${r.skuId}|${r.effectiveFrom}`, "成本生效编号"],
    expenseKey: [stores.otherExpenses, (r) => r.recordKey, "其他费用业务编号"],
    settlementKey: [stores.settlements, (r) => r.recordKey, "结算业务编号"],
    batchKey: [stores.importBatches, (r) => `${r.storeId}|${r.reportType}|${r.fileHash}`, "导入文件编号"],
    rawRowKey: [stores.rawRecords, (r) => `${r.batchId}|${r.rowNumber}`, "导入行编号"],
    issueKey: [stores.issues, (r) => r.stableKey, "异常编号"],
    resultKey: [stores.calculationResults, (r) => `${r.storeId}|${r.start}|${r.end}|${r.ruleVersion}`, "计算结果编号"],
  };
  for (const [rows, keyFn, label] of Object.values(unique)) ensureUnique(rows, keyFn, label);
  const storeIds = new Set(stores.stores.map((row) => row.id));
  const orderIds = new Set(stores.orders.map((row) => row.id));
  for (const row of [...stores.orders, ...stores.orderItems, ...stores.refunds, ...stores.platformFees, ...stores.productCosts, ...stores.otherExpenses, ...stores.settlements, ...stores.importBatches, ...stores.issues]) {
    if (row.storeId && !storeIds.has(row.storeId)) throw new Error("备份中有记录关联到不存在的店铺，已取消恢复。");
  }
  for (const item of stores.orderItems) if (!orderIds.has(item.orderId)) throw new Error("备份中有商品明细关联到不存在的订单，已取消恢复。");
  return { ...input, stores };
}

export async function restoreBackup(db, input) {
  const validated = validateBackup(input);
  await replaceSnapshot(db, validated.stores);
  return Object.fromEntries(STORE_NAMES.map((name) => [name, validated.stores[name].length]));
}
