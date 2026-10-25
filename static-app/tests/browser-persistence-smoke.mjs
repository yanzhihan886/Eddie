import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { STORE_NAMES } from "../js/domain.mjs";
import { validateBackup } from "../js/backup.mjs";

const require = createRequire(import.meta.url);
const XLSX = require("../vendor/xlsx.full.min.js");

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edgePath = process.env.EDGE_PATH || [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(existsSync);
if (!edgePath) throw new Error("找不到 Edge 或 Chrome。可设置 EDGE_PATH 环境变量后重试。");

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitUntil(fn, message, timeout = 20000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; }
    catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`${message}${lastError ? `：${lastError.message}` : ""}`);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolveOpen, reject) => {
      this.ws.addEventListener("open", resolveOpen, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("无法连接本地测试浏览器的调试端口。")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    });
  }
  on(method, listener) {
    const group = this.listeners.get(method) || [];
    group.push(listener);
    this.listeners.set(method, group);
  }
  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function findPageTarget(debugPort, targetId) {
  return waitUntil(async () => {
    const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
    return targets.find((item) => item.type === "page" && (!targetId || item.id === targetId));
  }, "找不到测试页面");
}

async function evaluate(cdp, expression, timeout = 15000) {
  const response = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}

async function waitForReady(cdp) {
  return waitUntil(async () => {
    const state = await evaluate(cdp, `(() => { const text = document.querySelector('#page-content')?.innerText || ''; return {ready: !!document.querySelector('#top-title') && !text.includes('正在打开本地数据库'), fatal: text.includes('无法打开本地数据库'), text: text.slice(0, 80)} })()`);
    if (state?.fatal || state?.text?.includes("无法完成本地数据初始化")) throw new Error(state.text);
    return state?.ready;
  }, "本地应用没有完成初始化");
}

async function counts(cdp) {
  const names = JSON.stringify(STORE_NAMES);
  return evaluate(cdp, `(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('seller-profit-assistant-local', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const names = ${names}; const tx = db.transaction(names, 'readonly');
    const result = await Promise.all(names.map(name => new Promise((resolve, reject) => { const request = tx.objectStore(name).count(); request.onsuccess = () => resolve([name, request.result]); request.onerror = () => reject(request.error); })));
    db.close(); return Object.fromEntries(result);
  })()`);
}

function assertPersistedCounts(before, after, label) {
  for (const name of STORE_NAMES.filter((name) => name !== "calculationResults")) {
    assert.equal(after[name], before[name], `${label}：${name} 记录数应保持不变`);
  }
  assert.ok(after.calculationResults >= before.calculationResults, `${label}：已保存的计算结果不能减少`);
}

async function setFileInput(cdp, selector, filePath) {
  const documentInfo = await cdp.call("DOM.getDocument", { depth: -1, pierce: true });
  const input = await cdp.call("DOM.querySelector", { nodeId: documentInfo.root.nodeId, selector });
  assert.ok(input.nodeId, `找不到文件输入：${selector}`);
  await cdp.call("DOM.setFileInputFiles", { files: [filePath], nodeId: input.nodeId });
}

const serverPort = await freePort();
const debugPort = await freePort();
const fixtureRoot = join(tmpdir(), `seller-profit-local-test-${Date.now()}`);
const profileDir = join(fixtureRoot, "edge-profile");
const downloadDir = join(fixtureRoot, "downloads");
mkdirSync(downloadDir, { recursive: true });
const url = `http://127.0.0.1:${serverPort}/`;
const server = spawn("python", ["-m", "http.server", String(serverPort), "--bind", "127.0.0.1", "--directory", appRoot], { stdio: "ignore", windowsHide: true });
let edge;
let browserCdp;
let pageCdp;
const requestUrls = new Set();
const dialogTypes = [];
const promptResponses = [];

async function launchBrowser() {
  edge = spawn(edgePath, ["--headless=new", `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*", `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-background-networking", "--disable-features=Translate,MediaRouter", url], { stdio: "ignore", windowsHide: true });
  const version = await waitUntil(() => getJson(`http://127.0.0.1:${debugPort}/json/version`), "Edge 远程调试端口未启动", 30000);
  browserCdp = new CDP(version.webSocketDebuggerUrl);
  await browserCdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  const target = await waitUntil(async () => {
    const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
    return targets.find((item) => item.type === "page" && item.url.startsWith(url));
  }, "Edge 没有打开本地站点");
  pageCdp = new CDP(target.webSocketDebuggerUrl);
  pageCdp.on("Network.requestWillBeSent", (request) => { requestUrls.add(request.request.url); });
  pageCdp.on("Page.javascriptDialogOpening", async (dialog) => {
    dialogTypes.push(dialog.type);
    await pageCdp.call("Page.handleJavaScriptDialog", { accept: true, promptText: dialog.type === "prompt" ? (promptResponses.shift() || "替换") : "" });
  });
  await pageCdp.call("Page.enable");
  await pageCdp.call("Runtime.enable");
  await pageCdp.call("Network.enable");
  await waitForReady(pageCdp);
}

async function closeBrowser() {
  pageCdp?.close();
  browserCdp?.close();
  try { await fetch(`http://127.0.0.1:${debugPort}/json/close/${(await findPageTarget(debugPort)).id}`); } catch { /* browser may be closed */ }
  if (edge && !edge.killed) {
    edge.kill();
    await Promise.race([new Promise((resolveExit) => edge.once("exit", resolveExit)), sleep(4000)]);
  }
}

try {
  await waitUntil(async () => {
    try { return (await fetch(url)).ok; } catch { return false; }
  }, "本地静态服务器没有启动");
  await launchBrowser();
  const firstPageText = await evaluate(pageCdp, `document.querySelector('#page-content').innerText`);
  assert.match(firstPageText, /经营情况|没有经营数据/);

  await evaluate(pageCdp, `document.querySelector('[data-action="load-demo"]')?.click()`);
  const afterSeed = await waitUntil(async () => {
    const c = await counts(pageCdp);
    return c.orders === 12 && c.orderItems === 12 && c.calculationResults >= 1 ? c : null;
  }, "演示数据没有完整保存到 IndexedDB");
  assert.equal(afterSeed.stores, 1);
  assert.equal(afterSeed.refunds, 1);
  assert.ok(afterSeed.platformFees >= 8);
  assert.equal(await evaluate(pageCdp, `!!document.querySelector('#nav-import-count')`), false, "导入批次数字徽标应已移除");
  assert.ok(Number(await evaluate(pageCdp, `document.querySelector('#nav-issue-count')?.textContent || 0`)) > 0, "异常核对仍应显示待处理数量");
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('.dashboard-issue-link')`), "总览没有列出已有的待处理异常");
  const dashboardIssueId = await evaluate(pageCdp, `document.querySelector('.dashboard-issue-link')?.dataset.issueId`);
  assert.ok(dashboardIssueId, "总览异常项需要包含可定位的记录编号");
  await evaluate(pageCdp, `document.querySelector('.dashboard-issue-link')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('#top-title')?.textContent === '异常核对' && !!document.getElementById('issue-' + ${JSON.stringify(dashboardIssueId)})`), "点击总览异常没有定位到异常核对记录");
  await evaluate(pageCdp, `document.querySelector('[data-nav="overview"]')?.click()`);
  const pageSummary = await evaluate(pageCdp, `document.querySelector('#page-content').innerText`);
  assert.match(pageSummary, /已知项目利润估算/);

  const importFilePath = join(fixtureRoot, "orders-import.csv");
  writeFileSync(importFilePath, "订单号,订单日期,订单状态,商品编码,商品名称,数量,实付金额,明细编号\r\nWEB-001,2026-10-24,已完成,SKU-X,测试商品,2,20.00,WEBITEM-001\r\n", "utf8");
  const malformedFilePath = join(fixtureRoot, "malformed.csv");
  writeFileSync(malformedFilePath, '订单号,备注\nBROKEN,"未闭合引号\n', "utf8");
  const duplicateFilePath = join(fixtureRoot, "orders-same-business-row.csv");
  writeFileSync(duplicateFilePath, "订单号,订单日期,订单状态,商品编码,商品名称,数量,实付金额,明细编号,备注\nWEB-001,2026-10-24,已完成,SKU-X,测试商品,2,20.00,WEBITEM-001,\n", "utf8");
  const xlsxPath = join(fixtureRoot, "orders.xlsx");
  const xlsxWorkbook = XLSX.utils.book_new();
  const xlsxSheet = XLSX.utils.aoa_to_sheet([
    ["订单号", "订单日期", "订单状态", "商品编码", "商品名称", "数量", "实付金额", "明细编号"],
    ["WEB-002", "2026-10-24", "已完成", "SKU-X", '=HYPERLINK("https://example.invalid","打开链接")', 1, 15, "WEBITEM-002"],
  ]);
  XLSX.utils.book_append_sheet(xlsxWorkbook, xlsxSheet, "订单");
  writeFileSync(xlsxPath, Buffer.from(XLSX.write(xlsxWorkbook, { type: "array", bookType: "xlsx", compression: true })));
  await evaluate(pageCdp, `document.querySelector('[data-nav="import"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('#import-file')`), "错误文件测试未打开导入界面");
  await setFileInput(pageCdp, "#import-file", malformedFilePath);
  const parseError = await waitUntil(() => evaluate(pageCdp, `document.querySelector('.toast.error')?.innerText.includes('解析文件失败')`), "无法解析的文件没有显示明确错误");
  assert.equal(parseError, true);
  assert.equal((await counts(pageCdp)).orders, 12, "解析失败不得写入或改变 IndexedDB");
  await evaluate(pageCdp, `document.querySelector('[data-nav="import"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('#import-file')`), "导入界面没有打开");
  await setFileInput(pageCdp, "#import-file", importFilePath);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('.file-meta')?.innerText.includes('orders-import.csv')`), "订单 CSV 没有在浏览器中解析");
  await evaluate(pageCdp, `document.querySelector('[data-action="validate-import"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('.summary-chip strong')?.textContent === '1'`), "字段映射校验没有识别出 1 条有效订单");
  await evaluate(pageCdp, `document.querySelector('[data-action="commit-import"]')?.click()`);
  const afterCsvImport = await waitUntil(async () => {
    const c = await counts(pageCdp);
    return c.orders === 13 && c.orderItems === 13 && c.importBatches === 7 && c.rawRecords === 1 ? c : null;
  }, "确认导入后订单没有写入 IndexedDB");
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('#top-title')?.textContent === '经营总览'`), "导入完成后的页面没有返回总览");

  await evaluate(pageCdp, `document.querySelector('[data-nav="import"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('#import-file')`), "Excel 导入界面没有打开");
  await setFileInput(pageCdp, "#import-file", xlsxPath);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('.file-meta')?.innerText.includes('orders.xlsx')`), "XLSX 没有在浏览器中解析");
  await evaluate(pageCdp, `document.querySelector('[data-action="validate-import"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('.summary-chip strong')?.textContent === '1'`), "Excel 字段映射没有识别出有效订单");
  await evaluate(pageCdp, `document.querySelector('[data-action="commit-import"]')?.click()`);
  const afterUpload = await waitUntil(async () => {
    const c = await counts(pageCdp);
    return c.orders === 14 && c.orderItems === 14 && c.importBatches === 8 && c.rawRecords === 2 ? c : null;
  }, "Excel 确认导入后订单没有写入 IndexedDB");
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('#top-title')?.textContent === '经营总览'`), "Excel 导入完成后的页面没有返回总览");

  await evaluate(pageCdp, `document.querySelector('[data-nav="import"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('#import-file')`), "再次打开导入界面失败");
  await setFileInput(pageCdp, "#import-file", importFilePath);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('.file-meta')?.innerText.includes('orders-import.csv')`), "重复文件没有解析");
  await evaluate(pageCdp, `document.querySelector('[data-action="validate-import"]')?.click()`);
  let duplicateFileWarning;
  try { duplicateFileWarning = await waitUntil(() => evaluate(pageCdp, `document.querySelector('.preflight-error')?.innerText.includes('已于')`), "相同文件的重复导入没有被拦截"); }
  catch (error) { console.error("重复文件校验页面：", await evaluate(pageCdp, `document.querySelector('#page-content').innerText`)); throw error; }
  assert.equal(duplicateFileWarning, true);

  await evaluate(pageCdp, `document.querySelector('[data-nav="import"]')?.click()`);
  await setFileInput(pageCdp, "#import-file", duplicateFilePath);
  await waitUntil(() => evaluate(pageCdp, `document.querySelector('.file-meta')?.innerText.includes('orders-same-business-row.csv')`), "带不同文件哈希的重复业务行没有解析");
  await evaluate(pageCdp, `document.querySelector('[data-action="validate-import"]')?.click()`);
  const duplicateCounts = await waitUntil(() => evaluate(pageCdp, `Array.from(document.querySelectorAll('.summary-chip strong')).map(x => x.textContent).join(',')`), "重复业务行没有完成校验");
  assert.match(duplicateCounts, /^0,0,1,0$/);

  await pageCdp.call("Page.reload", { ignoreCache: true });
  await waitForReady(pageCdp);
  const afterRefresh = await counts(pageCdp);
  assert.deepEqual(afterRefresh, afterUpload, "刷新后 IndexedDB 记录数应保持不变");

  await evaluate(pageCdp, `document.querySelector('[data-nav="overview"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('[data-action="export-xlsx"]')`), "经营总览导出按钮没有出现");
  await evaluate(pageCdp, `document.querySelector('[data-action="export-xlsx"]')?.click()`);
  const reportPath = await waitUntil(() => {
    const names = readdirSync(downloadDir).filter((name) => name.endsWith(".xlsx"));
    return names.length ? join(downloadDir, names[0]) : null;
  }, "Excel 报告没有下载");
  const reportWorkbook = XLSX.read(readFileSync(reportPath), { type: "buffer" });
  assert.ok(reportWorkbook.SheetNames.includes("经营摘要"));
  assert.ok(reportWorkbook.SheetNames.includes("订单商品"));
  const itemRows = XLSX.utils.sheet_to_json(reportWorkbook.Sheets["订单商品"], { defval: "" });
  assert.equal(itemRows.length, 14, "报告商品明细行数应与 IndexedDB 一致");
  assert.ok(itemRows.some((row) => String(row["商品名称"]).startsWith("'=HYPERLINK")), "导出的文本公式前缀应转义，避免作为电子表格公式执行");

  await evaluate(pageCdp, `document.querySelector('[data-nav="settings"]')?.click()`);
  const backupButtons = await evaluate(pageCdp, `!!document.querySelector('[data-action="download-backup"]')`);
  assert.equal(backupButtons, true);
  await evaluate(pageCdp, `document.querySelector('[data-action="download-backup"]')?.click()`);
  const backupPath = await waitUntil(() => {
    const names = readdirSync(downloadDir).filter((name) => name.endsWith(".json"));
    return names.length ? join(downloadDir, names[0]) : null;
  }, "备份 JSON 没有下载");
  const parsedBackup = validateBackup(JSON.parse(readFileSync(backupPath, "utf8")));
  assert.equal(parsedBackup.stores.orders.length, 14);

  const dialogsBeforeClear = dialogTypes.length;
  promptResponses.push("清空");
  await evaluate(pageCdp, `document.querySelector('[data-nav="settings"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('[data-action="clear-data"]')`), "清空设置界面没有打开");
  await evaluate(pageCdp, `document.querySelector('[data-action="clear-data"]')?.click()`);
  await waitUntil(async () => (await counts(pageCdp)).orders === 0, "双重确认后没有清空测试数据");
  assert.deepEqual(dialogTypes.slice(dialogsBeforeClear), ["confirm", "prompt"], "清空操作应出现二次确认");
  assert.equal((await counts(pageCdp)).orders, 0, "测试环境中清空后订单数应为 0");

  const dialogsBeforeRestore = dialogTypes.length;
  promptResponses.push("替换");
  await evaluate(pageCdp, `document.querySelector('[data-nav="settings"]')?.click()`);
  await waitUntil(() => evaluate(pageCdp, `!!document.querySelector('#restore-file')`), "恢复备份界面没有打开");
  await setFileInput(pageCdp, "#restore-file", backupPath);
  const afterRestore = await waitUntil(async () => {
    const c = await counts(pageCdp);
    return c.orders === afterUpload.orders && c.orderItems === afterUpload.orderItems ? c : null;
  }, "从备份恢复后没有找到原有记录", 15000);
  assert.deepEqual(dialogTypes.slice(dialogsBeforeRestore), ["confirm", "prompt"], "覆盖恢复应出现二次确认");
  assert.deepEqual(afterRestore, afterUpload, "备份恢复后数据表计数应与备份前一致");

  await closeBrowser();
  await launchBrowser();
  const afterReopen = await counts(pageCdp);
  assertPersistedCounts(afterUpload, afterReopen, "关闭并重新打开浏览器后");
  await pageCdp.call("Page.reload", { ignoreCache: true });
  await waitForReady(pageCdp);
  assertPersistedCounts(afterUpload, await counts(pageCdp), "重新打开后刷新页面");

  const appOrigin = new URL(url).origin;
  for (const requestUrl of requestUrls) {
    const parsed = new URL(requestUrl);
    assert.ok(["http:", "https:", "blob:", "data:"].includes(parsed.protocol), `应用产生了不安全或未知协议请求：${requestUrl}`);
    if (["http:", "https:"].includes(parsed.protocol)) assert.equal(parsed.origin, appOrigin, `应用向外部地址请求资源：${requestUrl}`);
  }
  console.log(JSON.stringify({ result: "PASS", appOrigin: url, importCountBadgeRemoved: "PASS", dashboardExceptionListAndDirectNavigation: "PASS", parseFailureVisibleWithoutWrite: "PASS", csvImportAndMapping: "PASS", xlsxImportAndMapping: "PASS", duplicateFileProtection: "PASS", duplicateBusinessRecordProtection: "PASS", xlsxReportAndFormulaEscaping: "PASS", closeReopen: "PASS", refresh: "PASS", backupDownloadAndValidate: "PASS", doubleConfirmedClear: "PASS", doubleConfirmedRestore: "PASS", counts: afterUpload, requestedUrls: [...requestUrls] }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await closeBrowser();
  server.kill();
}
