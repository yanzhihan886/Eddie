import { DB_VERSION, STORE_NAMES } from "./domain.mjs";

export const DB_NAME = "seller-profit-assistant-local";

const DEFINITIONS = {
  stores: [["platform", "platform"], ["name", "name"]],
  orders: [["store", ["storeId", "orderedAt"]], ["orderNumber", ["storeId", "platformOrderId"], true], ["status", "statusClass"]],
  orderItems: [["storeSku", ["storeId", "skuId"]], ["orderId", "orderId"], ["recordKey", "recordKey", true]],
  refunds: [["storeDate", ["storeId", "completedAt"]], ["orderNumber", ["storeId", "platformOrderId"]], ["recordKey", "recordKey", true]],
  platformFees: [["storeDate", ["storeId", "feeDate"]], ["orderNumber", ["storeId", "platformOrderId"]], ["recordKey", "recordKey", true]],
  productCosts: [["storeSku", ["storeId", "skuId"]], ["skuStart", ["storeId", "skuId", "effectiveFrom"], true], ["recordKey", "recordKey", true]],
  otherExpenses: [["storeDate", ["storeId", "expenseDate"]], ["recordKey", "recordKey", true]],
  settlements: [["storeDate", ["storeId", "settlementDate"]], ["orderNumber", ["storeId", "platformOrderId"]], ["recordKey", "recordKey", true]],
  importBatches: [["storeReportDate", ["storeId", "reportType", "importedAt"]], ["fileKey", ["storeId", "reportType", "fileHash"], true]],
  rawRecords: [["batch", "batchId"], ["batchRow", ["batchId", "rowNumber"], true]],
  issues: [["storeStatus", ["storeId", "status"]], ["severity", "severity"], ["stableKey", "stableKey", true]],
  calculationResults: [["storePeriod", ["storeId", "start", "end", "ruleVersion"], true]],
};

function ensureObjectStore(db, tx, name) {
  const store = db.objectStoreNames.contains(name)
    ? tx.objectStore(name)
    : db.createObjectStore(name, { keyPath: "id" });
  for (const [indexName, keyPath, unique = false] of DEFINITIONS[name] || []) {
    if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, { unique });
  }
}

const MIGRATIONS = [
  {
    version: 1,
    apply(db, tx) {
      for (const name of STORE_NAMES) ensureObjectStore(db, tx, name);
    },
  },
  // Future schema changes belong in a new, numbered migration. Never delete and
  // recreate user stores here; migrate records in place inside the upgrade tx.
];

let opening;

export function openDatabase(name = DB_NAME) {
  if (name === DB_NAME && opening) return opening;
  if (!globalThis.indexedDB) return Promise.reject(new Error("这个浏览器暂不支持保存数据。请使用最新版 Edge、Chrome 或 Firefox。"));
  const promise = new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(name, DB_VERSION); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      for (const migration of MIGRATIONS) {
        if (event.oldVersion < migration.version && event.newVersion >= migration.version) migration.apply(db, request.transaction);
      }
    };
    request.onblocked = () => reject(new Error("另一个打开的页面正在使用这份数据。请关闭其他此网站的标签页，再刷新。"));
    request.onerror = () => reject(request.error || new Error("打不开这个浏览器里的数据。请检查浏览器是否允许网站保存数据，再刷新。"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
  if (name === DB_NAME) opening = promise.catch((error) => { opening = undefined; throw error; });
  return name === DB_NAME ? opening : promise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("保存没有完成，原有数据没有更改。"));
    tx.onerror = () => reject(tx.error || new Error("保存失败，原有数据没有更改。"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("读取本地数据失败。"));
  });
}

export async function readAll(db, storeName) {
  if (!STORE_NAMES.includes(storeName)) throw new Error("未知数据表：" + storeName);
  const tx = db.transaction(storeName, "readonly");
  const done = txDone(tx);
  const result = await requestResult(tx.objectStore(storeName).getAll());
  await done;
  return result;
}

export async function readSnapshot(db) {
  const tx = db.transaction(STORE_NAMES, "readonly");
  const done = txDone(tx);
  const pairs = await Promise.all(STORE_NAMES.map(async (name) => [name, await requestResult(tx.objectStore(name).getAll())]));
  await done;
  return Object.fromEntries(pairs);
}

export async function putOne(db, storeName, value) {
  return writeRecords(db, { [storeName]: [value] }, "put");
}

export async function writeRecords(db, bundle, method = "add") {
  const names = Object.keys(bundle).filter((name) => STORE_NAMES.includes(name));
  if (!names.length) return;
  let tx;
  try { tx = db.transaction(names, "readwrite", { durability: "strict" }); }
  catch { tx = db.transaction(names, "readwrite"); }
  const done = txDone(tx);
  try {
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const record of bundle[name] || []) store[method](record);
    }
  } catch (error) {
    try { tx.abort(); } catch { /* transaction already ended */ }
    try { await done; } catch { /* retain the original error */ }
    throw error;
  }
  await done;
}

export async function replaceSnapshot(db, snapshot) {
  let tx;
  try { tx = db.transaction(STORE_NAMES, "readwrite", { durability: "strict" }); }
  catch { tx = db.transaction(STORE_NAMES, "readwrite"); }
  const done = txDone(tx);
  try {
    for (const name of STORE_NAMES) {
      const store = tx.objectStore(name);
      store.clear();
      for (const row of snapshot[name] || []) store.add(row);
    }
  } catch (error) {
    try { tx.abort(); } catch { /* transaction already ended */ }
    try { await done; } catch { /* prior data remains after an aborted tx */ }
    throw error;
  }
  await done;
}

export async function clearAllData(db) {
  let tx;
  try { tx = db.transaction(STORE_NAMES, "readwrite", { durability: "strict" }); }
  catch { tx = db.transaction(STORE_NAMES, "readwrite"); }
  const done = txDone(tx);
  try {
    for (const name of STORE_NAMES) tx.objectStore(name).clear();
  } catch (error) {
    try { tx.abort(); } catch { /* transaction already ended */ }
    try { await done; } catch { /* retain the original error */ }
    throw error;
  }
  await done;
}

export async function getByIndex(db, storeName, indexName, key) {
  const tx = db.transaction(storeName, "readonly");
  const done = txDone(tx);
  const row = await requestResult(tx.objectStore(storeName).index(indexName).get(key));
  await done;
  return row || null;
}

export function closeDatabase(db) {
  if (db) db.close();
  opening = undefined;
}
