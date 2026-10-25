import { clearAllData, openDatabase, putOne, readAll, readSnapshot, writeRecords } from "./db.mjs";
import { CALCULATION_RULE_VERSION, REPORTS, STORE_NAMES, calculateSummary, classifyOrderStatus, dailyTrend, dedupeCandidates, findFeeSettlementMismatches, formatFen, formatQuantity, normalizeDate, parseMoneyFen, periodKey, productSummary, reconcileFeeSettlementIssues, reconcileMissingCostIssues, stableRecordKey } from "./domain.mjs";
import { commitImport, MAX_DATA_ROWS, MAX_FILE_BYTES, prepareImport, readTabularFile, sha256, suggestMapping } from "./importer.mjs";
import { makeBackup, restoreBackup, validateBackup } from "./backup.mjs";
import { downloadWorkbook } from "./exporter.mjs";
import { productBars, trendSvg } from "./charts.mjs";
import { loadDemoData } from "./sample.mjs";

const PREFS_KEY = "seller-profit-assistant:prefs:v1";
const PAGE_META = {
  overview: ["经营总览", "SELLER PROFIT WORKSPACE"], stores: ["店铺管理", "LOCAL SHOP PROFILES"], import: ["导入数据", "IMPORT LOCALLY"],
  records: ["经营记录", "LOCAL BUSINESS RECORDS"], costs: ["商品成本", "PRODUCT COSTS"], issues: ["异常核对", "REVIEW & RECONCILE"],
  settings: ["备份与设置", "DEVICE DATA & BACKUP"], guide: ["使用指南", "QUICK START GUIDE"],
};
const ISSUE_LABELS = {
  missing_cost: "缺少商品成本", fee_settlement_mismatch: "结算金额差异", unknown_order_status: "订单状态未识别",
  import_validation: "导入内容待检查", duplicate_record: "重复记录", record_conflict: "业务记录冲突",
  unmatched_fee: "费用未关联订单", order_status_conflict: "订单信息冲突",
};
const EMPTY_DATA = () => Object.fromEntries(STORE_NAMES.map((name) => [name, []]));
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const uid = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const dateOffset = (dateString, offset) => {
  const d = new Date(`${dateString}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const bytesLabel = (value) => {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw || raw.length > 4096) return {};
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

const savedPrefs = readPrefs();
const state = {
  db: null,
  page: PAGE_META[savedPrefs.page] ? savedPrefs.page : "overview",
  selectedStoreId: typeof savedPrefs.storeId === "string" ? savedPrefs.storeId : "all",
  start: typeof savedPrefs.start === "string" ? savedPrefs.start : "",
  end: typeof savedPrefs.end === "string" ? savedPrefs.end : "",
  recordType: "orders",
  importStoreId: "",
  pendingFile: null,
  importMapping: null,
  importPlan: null,
  data: EMPTY_DATA(),
  isBusy: false,
};

function savePrefs() {
  const prefs = { page: state.page, storeId: state.selectedStoreId, start: state.start, end: state.end };
  const serialized = JSON.stringify(prefs);
  if (serialized.length > 2048) return;
  try { localStorage.setItem(PREFS_KEY, serialized); }
  catch { toast("浏览器没有保存偏好设置；经营记录仍由 IndexedDB 管理。", "warn"); }
}

function toast(message, type = "ok", duration = 4300) {
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : type === "warn" ? "warn" : ""}`;
  node.textContent = message;
  $("#toast-stack").append(node);
  window.setTimeout(() => node.remove(), duration);
}

function presentError(error, context = "操作未完成") {
  const quota = error?.name === "QuotaExceededError" || error?.code === 22 || /quota|storage.*full/i.test(error?.message || "");
  if (quota) {
    toast("浏览器本地空间不足，操作没有保存。请先导出备份，清理无用数据或释放设备空间后重试。", "error", 8000);
  } else {
    toast(`${context}：${error?.message || "未知错误"}。数据没有被标记为已保存。`, "error", 8000);
  }
  console.error(context, error);
}

async function refreshData() {
  state.data = await readSnapshot(state.db);
  const derivedIssues = [...reconcileFeeSettlementIssues(state.data), ...reconcileMissingCostIssues(state.data)];
  if (derivedIssues.length) {
    await writeRecords(state.db, { issues: derivedIssues }, "put");
    state.data = await readSnapshot(state.db);
  }
  const storeIds = new Set(state.data.stores.map((store) => store.id));
  if (state.selectedStoreId !== "all" && !storeIds.has(state.selectedStoreId)) state.selectedStoreId = "all";
  if (state.importStoreId && !storeIds.has(state.importStoreId)) state.importStoreId = "";
  if (!state.start || !state.end) setDefaultPeriod(state.data);
  if (state.start > state.end) [state.start, state.end] = [state.end, state.start];
}

function setDefaultPeriod(data) {
  const dates = [
    ...data.orders.map((row) => row.orderedAt), ...data.refunds.map((row) => row.completedAt),
    ...data.platformFees.map((row) => row.feeDate), ...data.otherExpenses.map((row) => row.expenseDate),
  ].filter(Boolean).sort();
  const end = dates.at(-1) || localToday();
  state.end = end;
  state.start = dateOffset(end, -29);
}

function selectedStoreName(data = state.data) {
  if (state.selectedStoreId === "all") return "全部店铺";
  return data.stores.find((row) => row.id === state.selectedStoreId)?.name || "全部店铺";
}

function fillGlobalControls(data) {
  const storeSelect = $("#global-store-select");
  storeSelect.innerHTML = `<option value="all">全部店铺</option>${data.stores.map((store) => `<option value="${esc(store.id)}">${esc(store.name)} · ${esc(store.platform)}</option>`).join("")}`;
  storeSelect.value = state.selectedStoreId;
  $("#global-start").value = state.start;
  $("#global-end").value = state.end;
  const openIssues = data.issues.filter((issue) => issue.status === "open" || issue.status === "review").length;
  $("#nav-issue-count").textContent = openIssues ? String(openIssues) : "";
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === state.page);
    if (button.dataset.nav === "import") button.setAttribute("aria-label", "导入数据");
    if (button.dataset.nav === "issues") button.setAttribute("aria-label", `异常核对，${openIssues} 条待处理`);
  });
  const title = PAGE_META[state.page] || PAGE_META.overview;
  $("#top-title").textContent = title[0];
  $("#top-eyebrow").textContent = title[1];
}

function currentSummary(data = state.data) {
  return calculateSummary(data, { storeId: state.selectedStoreId, start: state.start, end: state.end });
}

function storeName(data, storeId) { return data.stores.find((row) => row.id === storeId)?.name || "未知店铺"; }

function pageHeading(kicker, title, description, actions = "") {
  return `<div class="page-heading"><div><div class="kicker">${esc(kicker)}</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function emptyState(title, text, actions = "") {
  return `<section class="card empty-state"><div class="empty-art" aria-hidden="true">◌</div><h2>${title}</h2><p>${text}</p><div class="button-row">${actions}</div></section>`;
}

function metricCard(label, value, note, symbol, tone = "") {
  return `<article class="metric-card ${tone}"><div class="metric-label"><span>${esc(label)}</span><span class="metric-symbol" aria-hidden="true">${esc(symbol)}</span></div><strong class="metric-value">${esc(value)}</strong><span class="metric-note">${esc(note)}</span></article>`;
}

function renderDashboard(data) {
  const summary = currentSummary(data);
  const productRows = productSummary(data, summary);
  const trend = dailyTrend(data, summary);
  const dashboardIssues = data.issues.filter((issue) => (issue.status === "open" || issue.status === "review")
    && (state.selectedStoreId === "all" || issue.storeId === state.selectedStoreId));
  if (!data.stores.length) {
    return `${pageHeading("经营数据工作台", "经营情况，一眼看清。", "先创建店铺并导入报表，或载入虚构样例，快速体验本地计算和导出。", `<button class="button secondary" data-nav="stores">创建店铺</button><button class="button" data-action="load-demo">载入虚构样例</button>`)}${emptyState("这里还没有经营数据", "你可以先载入演示数据，也可以添加自己的店铺。数据只写入当前浏览器。", `<button class="button" data-action="load-demo">载入演示数据</button><button class="button secondary" data-nav="stores">添加店铺</button>`)}`;
  }
  const margin = summary.profitMargin === null ? "—" : `${(summary.profitMargin * 100).toFixed(1)}%`;
  const missingDetails = summary.missingCosts.map((item) => `${esc(item.skuId)}（${esc(item.productName)}）`).join("、");
  const knownRecords = data.orders.length + data.refunds.length + data.platformFees.length + data.productCosts.length + data.otherExpenses.length;
  const recentBatches = [...data.importBatches].sort((a, b) => b.importedAt.localeCompare(a.importedAt)).slice(0, 5);
  const summaryCard = summary.complete
    ? `<div class="completeness-card"><span class="completeness-icon">✓</span><div><strong>当前导入范围未发现明显缺项</strong><p>该提示仅表示已导入字段齐备，不代表平台账单已完整，也不是会计或税务结论。</p></div></div>`
    : `<div class="completeness-card warning"><span class="completeness-icon">!</span><div><strong>当前为部分数据估算</strong><p>${summary.missingInputs.map(esc).join("；")}。缺失成本未计入成本扣减，已知项目利润可能偏高。</p>${missingDetails ? `<div class="list-inline"><span>缺少成本：${missingDetails}</span></div>` : ""}</div></div>`;
  const dashboardIssueCard = dashboardIssues.length ? `<section class="dashboard-issues" aria-labelledby="dashboard-issues-title">
    <div class="dashboard-issues-heading"><div><div class="section-eyebrow">NEEDS REVIEW</div><h2 id="dashboard-issues-title">待核对异常 <span>${dashboardIssues.length}</span></h2><p>点选异常可跳转到异常核对并定位记录。</p></div><button class="button ghost small" data-nav="issues">查看全部 →</button></div>
    <div class="dashboard-issue-list">${dashboardIssues.slice(0, 6).map((issue) => `<button class="dashboard-issue-link" data-action="open-issue" data-issue-id="${esc(issue.id)}" aria-label="查看异常：${esc(ISSUE_LABELS[issue.issueType] || issue.issueType)}。${esc(issue.description)}"><span class="tag ${issue.severity === "error" ? "tag-danger" : "tag-warn"}">${issue.severity === "error" ? "严重" : "待核对"}</span><span class="dashboard-issue-copy"><strong>${esc(ISSUE_LABELS[issue.issueType] || issue.issueType)}</strong><span>${esc(issue.description)}</span></span><span class="dashboard-issue-arrow" aria-hidden="true">↗</span></button>`).join("")}</div>
    ${dashboardIssues.length > 6 ? `<p class="dashboard-issues-more">此处显示 6 条，共 ${dashboardIssues.length} 条；可进入异常核对查看全部。</p>` : ""}
  </section>` : "";
  const html = `${pageHeading("本地经营数据", "经营情况，一眼看清。", `数据范围：${esc(summary.start)} 至 ${esc(summary.end)} · ${esc(selectedStoreName(data))}`, `<button class="button secondary" data-action="export-xlsx">导出 Excel</button><button class="button" data-nav="import">导入报表 <span aria-hidden="true">↗</span></button>`)}
    ${summaryCard}
    ${dashboardIssueCard}
    <section class="metrics">
      ${metricCard("商品销售额", formatFen(summary.grossSalesFen), "仅计入已识别的有效订单", "↗", "blue")}
      ${metricCard("已知项目利润估算", formatFen(summary.knownProfitFen), summary.complete ? "按当前已导入数据计算" : "成本或费用缺项，结果不完整", "◒", "profit")}
      ${metricCard("利润率估算", margin, "已知项目利润 ÷ 净销售额", "%", "")}
      ${metricCard("有效订单数", summary.orderCount.toLocaleString("zh-CN"), `${summary.cancelledCount} 单取消；${summary.unknownCount} 单状态未识别`, "▤", "blue")}
      ${metricCard("销售件数", `${formatQuantity(summary.itemCountMilli)} 件`, "按已导入订单明细统计", "◇", "")}
      ${metricCard("退款金额", formatFen(summary.refundFen), `${summary.refundCount} 笔已确认退款（按退款完成日）`, "↩", "")}
      ${metricCard("已匹配商品成本", formatFen(summary.costFen), "按订单日期匹配 SKU 生效成本", "▱", "blue")}
      ${metricCard("平台及其他费用", formatFen(summary.feeFen + summary.expenseFen), `平台费用 ${formatFen(summary.feeFen)} · 其他 ${formatFen(summary.expenseFen)}`, "−", "")}
    </section>
    <section class="dashboard-grid">
      <article class="card chart-card"><div class="section-title"><div><div class="section-eyebrow">SALES TREND</div><h2>每日商品销售额</h2><p>订单按下单日期归属，退款按退款完成日期统计。</p></div><span class="tag tag-blue">${trend.length} 天</span></div>${trendSvg(trend)}</article>
      <article class="card chart-card"><div class="section-title"><div><div class="section-eyebrow">PRODUCT RANKING</div><h2>商品销售对比</h2><p>销售额从高到低，缺成本商品会单独标记。</p></div></div>${productBars(productRows)}</article>
    </section>
    <section class="grid grid-2">
      <article class="card card-pad"><div class="section-title"><div><div class="section-eyebrow">RECENT IMPORTS</div><h2>最近导入</h2><p>共保存 ${data.importBatches.length} 个批次 · ${knownRecords.toLocaleString("zh-CN")} 条经营记录</p></div><button class="button ghost small" data-nav="import">查看全部 →</button></div>
        ${recentBatches.length ? `<div class="table-wrap"><table><thead><tr><th>报表</th><th>文件</th><th>新增</th><th>导入时间</th></tr></thead><tbody>${recentBatches.map((batch) => `<tr><td>${esc(REPORTS[batch.reportType]?.label || batch.reportType)}</td><td>${esc(batch.originalFilename)}</td><td>${batch.acceptedCount}</td><td>${esc(new Date(batch.importedAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline">还没有导入批次。</div>`}</article>
      <article class="card card-pad"><div class="section-title"><div><div class="section-eyebrow">NEEDS REVIEW</div><h2>待处理异常</h2><p>重复、缺成本或无法核对的记录会留在这里。</p></div><button class="button ghost small" data-nav="issues">查看异常 →</button></div>
        ${data.issues.filter((issue) => issue.status === "open" || issue.status === "review").slice(0, 4).map((issue) => `<div class="issue-row"><span class="tag ${issue.severity === "error" ? "tag-danger" : issue.severity === "info" ? "tag-blue" : "tag-warn"}">${esc(issue.severity)}</span><div><strong>${esc(issue.issueType)}</strong><p>${esc(issue.description)}</p></div></div>`).join("") || `<div class="empty-inline">当前没有待处理异常。</div>`}</article>
    </section>`;
  saveCalculation(data, summary).catch((error) => presentError(error, "保存计算结果失败"));
  return html;
}

async function saveCalculation(data, summary) {
  const currentStore = state.selectedStoreId;
  const id = periodKey(currentStore, summary.start, summary.end);
  const record = { id, storeId: currentStore, start: summary.start, end: summary.end, ruleVersion: CALCULATION_RULE_VERSION,
    calculatedAt: new Date().toISOString(), inputSnapshot: { stores: data.stores.length, orders: data.orders.length, items: data.orderItems.length,
      refunds: data.refunds.length, fees: data.platformFees.length, costs: data.productCosts.length, expenses: data.otherExpenses.length },
    outputSummary: summary, warnings: summary.missingInputs };
  await putOne(state.db, "calculationResults", record);
}

function renderStores(data) {
  const platforms = ["淘宝/天猫", "拼多多", "抖音电商", "闲鱼", "其他/演示"];
  const content = data.stores.length ? `<div class="grid grid-2">${data.stores.map((store) => `<article class="card card-pad store-card"><div class="store-card-top"><span class="store-platform">${esc(store.platform)}</span><span class="tag ${store.demo ? "tag-warn" : "tag-ok"}">${store.demo ? "虚构数据" : "本地店铺"}</span></div><h2>${esc(store.name)}</h2><p>${esc(store.currency || "CNY")} · 创建于 ${esc(String(store.createdAt || "").slice(0, 10))}</p><button class="button secondary small" data-action="select-store" data-store-id="${esc(store.id)}">查看该店铺</button></article>`).join("")}</div>` : emptyState("先添加一个店铺", "店铺只用于区分本地导入的数据，不会连接你的平台账号。", "");
  return `${pageHeading("店铺档案", "把不同店铺分开管理。", "店铺资料只用于本地筛选和归类，不会发起平台授权或自动同步。")}
    <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><h2>添加店铺</h2><p>平台和店铺名称可以随时在本机查看。</p></div></div>
      <form data-form="add-store" class="form-grid"><div class="field"><label for="store-platform">销售平台</label><select id="store-platform" name="platform" required>${platforms.map((p) => `<option>${esc(p)}</option>`).join("")}</select></div><div class="field"><label for="store-name">店铺名称</label><input id="store-name" name="name" maxlength="80" placeholder="例如：晴日数码小店" required></div><div class="field"><label for="store-currency">币种</label><select id="store-currency" name="currency"><option value="CNY">人民币（CNY）</option></select></div><div class="field full"><button class="button" type="submit">保存店铺到本机</button></div></form>
      <p class="form-note">保存后数据只存在当前设备和浏览器中；更换设备或浏览器不会自动同步。</p></article><article class="card card-pad"><div class="section-title"><div><h2>店铺列表</h2><p>${data.stores.length} 个本地店铺</p></div></div>${content}</article></section>`;
}

function renderImport(data) {
  const stores = data.stores;
  if (!stores.length) return `${pageHeading("导入向导", "先创建一个本地店铺。", "每个报表都会关联到某个店铺；你可以先添加真实店铺名称，或载入虚构样例。", `<button class="button secondary" data-nav="stores">创建店铺</button><button class="button" data-action="load-demo">载入样例</button>`)}${emptyState("尚无店铺", "添加店铺后即可选择报表类型、映射字段并在本机预览文件。")}`;
  const importStoreId = state.importStoreId && stores.some((row) => row.id === state.importStoreId) ? state.importStoreId : state.selectedStoreId !== "all" ? state.selectedStoreId : stores[0].id;
  state.importStoreId = importStoreId;
  const pending = state.pendingFile;
  const reportType = pending?.reportType || "orders";
  const mapping = state.importMapping || (pending ? suggestMapping(reportType, pending.headers) : {});
  const options = Object.entries(REPORTS).map(([key, report]) => `<option value="${key}" ${reportType === key ? "selected" : ""}>${esc(report.label)}</option>`).join("");
  const fields = pending ? REPORTS[reportType].fields.map((field) => `<div class="map-row"><label class="${field.required ? "required" : ""}" for="map-${esc(field.key)}">${esc(field.label)}</label><select id="map-${esc(field.key)}" data-map-field="${esc(field.key)}"><option value="">不映射</option>${pending.headers.map((header) => `<option value="${esc(header)}" ${mapping[field.key] === header ? "selected" : ""}>${esc(header)}</option>`).join("")}</select></div>`).join("") : "";
  let planBox = "";
  if (state.importPlan) {
    const p = state.importPlan;
    const duplicateFile = p.duplicateFile;
    planBox = `<div class="summary-strip">
      <div class="summary-chip"><span>可新增记录</span><strong>${p.accepted.length}</strong></div>
      <div class="summary-chip warn"><span>无效行</span><strong>${p.rejected.length}</strong></div>
      <div class="summary-chip"><span>重复行</span><strong>${p.duplicates.length}</strong></div>
      <div class="summary-chip warn"><span>冲突行</span><strong>${p.conflicts.length}</strong></div>
    </div>${duplicateFile ? `<div class="preflight-error">这份文件已于 ${esc(p.batchAlreadyImported.importedAt)} 完整导入。为防止重复统计，本次导入已锁定。</div>` : p.accepted.length ? `<div class="preflight-good">已在本机完成校验。确认导入后，记录会写入 IndexedDB；原始文件本身不会被保存。</div>` : `<div class="preflight-error">没有可新增的有效记录。请检查映射、文件内容或重复提示。</div>`}
    ${p.rejected.slice(0, 5).map((row) => `<div class="preflight-error">第 ${row.rowNumber} 行：${esc(row.message)}</div>`).join("")}
    ${p.conflicts.slice(0, 5).map((row) => `<div class="preflight-error">第 ${row.rowNumber} 行：该业务编号已有不同内容，现有记录不会被覆盖。</div>`).join("")}
    <div class="button-row" style="margin-top:14px"><button class="button" data-action="commit-import" ${duplicateFile || !p.accepted.length ? "disabled" : ""}>确认导入 ${p.accepted.length} 条记录</button><button class="button secondary" data-action="clear-import">取消本次导入</button></div>`;
  }
  const preview = pending ? `<div class="file-meta"><strong>${esc(pending.fileName)}</strong><span>${esc(bytesLabel(pending.size))} · ${esc(pending.sheetName)} · ${pending.rows.length} 行</span></div><div class="section-title"><div><h3><span class="step-number">2</span>核对字段映射</h3><p>必填字段需要映射；订单金额和商品单价至少映射一项。未映射的可选字段会留空。</p></div></div><div class="mapping-grid">${fields}</div>
    ${reportType === "orders" ? `<div class="warning-note" style="margin-top:12px">订单状态采用明确的中英文状态清单识别。取消订单不计入销售；无法识别的状态会进入异常列表，不会猜测金额。</div>` : ""}
    <div class="button-row" style="margin-top:15px"><button class="button blue" data-action="validate-import">在本机校验映射</button></div>
    ${planBox || ""}<div class="mapping-preview"><table><thead><tr>${pending.headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${pending.rows.slice(0, 8).map((row) => `<tr>${pending.headers.map((_, i) => `<td>${esc(row[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
  return `${pageHeading("报表导入", "先预览，再写入本机。", "选择报表类型并映射字段。解析、去重和计算都在当前浏览器中完成。")}
    <section class="card card-pad"><div class="section-title"><div><h2><span class="step-number">1</span>选择店铺和报表</h2><p>支持 CSV / TSV / XLS / XLSX / XLSM，单文件最大 20 MB、最多 50,000 行。</p></div><span class="tag tag-ok">本地处理</span></div>
      <div class="form-grid"><div class="field"><label for="import-store">归属店铺</label><select id="import-store" data-import-store>${stores.map((store) => `<option value="${esc(store.id)}" ${store.id === importStoreId ? "selected" : ""}>${esc(store.name)} · ${esc(store.platform)}</option>`).join("")}</select></div><div class="field"><label for="import-kind">报表类型</label><select id="import-kind" data-import-kind>${options}</select></div><div class="field full"><label class="dropzone" for="import-file"><span class="drop-icon">⇧</span><strong>${pending ? "更换文件" : "选择或拖入本地报表"}</strong><span>文件只在浏览器内存中读取，不会上传；导入后只保存解析出的本地记录。</span></label><input id="import-file" type="file" accept=".csv,.tsv,.txt,.xls,.xlsx,.xlsm" hidden></div></div>
      ${preview}</section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>重复保护与数据留存</h2><p>防止相同文件或相同业务记录被重复统计。</p></div></div><ul class="rule-list"><li>同一店铺、报表类型和文件内容的重复文件会阻止再次导入。</li><li>订单明细、退款、费用和结算记录按平台业务编号去重；有差异的冲突行不会覆盖旧数据。</li><li>导入批次和行校验结果会保存在本机 IndexedDB；不会保存原始文件二进制。</li></ul></section>`;
}

function renderRecords(data) {
  const type = state.recordType;
  const categories = {
    orders: ["orders", "订单"], orderItems: ["orderItems", "订单商品"], refunds: ["refunds", "退款"],
    platformFees: ["platformFees", "平台费用"], otherExpenses: ["otherExpenses", "其他费用"], settlements: ["settlements", "结算"],
  };
  const [storeNameKey, title] = categories[type] || categories.orders;
  const rows = data[storeNameKey].filter((row) => state.selectedStoreId === "all" || row.storeId === state.selectedStoreId).slice(-200).reverse();
  const columns = {
    orders: [["platformOrderId", "订单号"], ["orderedAt", "下单日期"], ["orderStatus", "原始状态"], ["statusClass", "识别结果"]],
    orderItems: [["platformOrderId", "订单号"], ["skuId", "SKU"], ["productName", "商品名称"], ["quantityMilli", "数量", "quantity"], ["amountFen", "实付金额", "money"], ["orderedAt", "下单日期"]],
    refunds: [["platformRefundId", "退款单号"], ["platformOrderId", "订单号"], ["refundStatus", "状态"], ["amountFen", "退款金额", "money"], ["completedAt", "退款日期"], ["confirmed", "已确认"]],
    platformFees: [["feeId", "费用编号"], ["platformOrderId", "订单号"], ["feeType", "费用类型"], ["amountFen", "费用金额", "money"], ["feeDate", "费用日期"]],
    otherExpenses: [["expenseId", "费用编号"], ["expenseType", "费用类型"], ["amountFen", "金额", "money"], ["expenseDate", "费用日期"], ["allocationMethod", "分摊方式"]],
    settlements: [["transactionId", "结算流水"], ["platformOrderId", "订单号"], ["settlementStatus", "结算状态"], ["amountFen", "结算金额", "money"], ["settlementDate", "结算日期"]],
  }[type];
  return `${pageHeading("已保存的本地数据", "经营记录，随时可查。", "记录表由 IndexedDB 保存在当前浏览器。这里显示最近 200 条，Excel 报告可导出全部记录。", `<button class="button secondary" data-action="export-xlsx">导出 Excel</button>`)}
    <section class="card card-pad"><div class="section-title"><div><h2>${title}</h2><p>共 ${data[storeNameKey].length.toLocaleString("zh-CN")} 条记录${data[storeNameKey].length > rows.length ? ` · 当前展示最近 ${rows.length} 条` : ""}</p></div><select data-record-type aria-label="切换经营记录类型">${Object.entries(categories).map(([key, value]) => `<option value="${key}" ${key === type ? "selected" : ""}>${value[1]}</option>`).join("")}</select></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>店铺</th>${columns.map(([, label]) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(storeName(data, row.storeId))}</td>${columns.map(([key, , kind]) => `<td>${esc(kind === "money" ? formatFen(row[key]) : kind === "quantity" ? `${formatQuantity(row[key])} 件` : typeof row[key] === "boolean" ? (row[key] ? "是" : "否") : row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline">此类型还没有记录。</div>`}</section>`;
}

function renderCosts(data) {
  const rows = data.productCosts.filter((row) => state.selectedStoreId === "all" || row.storeId === state.selectedStoreId).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const skuNames = new Map(data.orderItems.map((row) => [row.skuId, row.productName]));
  return `${pageHeading("SKU 成本管理", "让利润估算有成本依据。", "成本按 SKU 和生效日期维护。订单会按下单日期匹配当时有效的单位成本。", `<button class="button secondary" data-nav="import">导入成本表</button>`)}
    <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><h2>手动添加成本</h2><p>保存到本机 IndexedDB；相同 SKU 的相同生效日期不能重复。</p></div></div>
      ${data.stores.length ? `<form data-form="add-cost" class="form-grid"><div class="field"><label for="cost-store">归属店铺</label><select id="cost-store" name="storeId" required>${data.stores.map((store) => `<option value="${esc(store.id)}" ${store.id === (state.selectedStoreId === "all" ? data.stores[0].id : state.selectedStoreId) ? "selected" : ""}>${esc(store.name)}</option>`).join("")}</select></div><div class="field"><label for="cost-sku">SKU 编号</label><input id="cost-sku" name="skuId" maxlength="100" placeholder="与订单报表中的 SKU 一致" required></div><div class="field"><label for="cost-product">商品名称</label><input id="cost-product" name="productName" maxlength="150" placeholder="${esc(skuNames.values().next().value || "可选")}"></div><div class="field"><label for="cost-value">单位成本（元）</label><input id="cost-value" name="unitCost" inputmode="decimal" placeholder="例如 12.50" required></div><div class="field"><label for="cost-from">生效日期</label><input id="cost-from" name="effectiveFrom" type="date" value="${localToday()}" required></div><div class="field"><label for="cost-to">失效日期（可选）</label><input id="cost-to" name="effectiveTo" type="date"></div><div class="field full"><button class="button" type="submit">保存成本</button></div></form>` : `<div class="empty-inline">请先添加一个店铺。</div>`}</article>
      <article class="card card-pad"><div class="section-title"><div><h2>成本匹配说明</h2><p>金额使用整数分计算，不以浮点数直接累计。</p></div></div><div class="formula"><strong>已匹配商品成本</strong> = 单位成本 × 销售数量（按分和千分位数量四舍五入）</div><p class="help-text" style="margin-top:12px">SKU 必须与订单明细中的 SKU 编号一致。没有匹配成本时不会把成本当成 0 后宣称利润完整，而会标记缺项。设置新的生效日期可保留历史成本版本。</p></article></section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>已保存的成本</h2><p>${rows.length} 条成本版本</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>店铺</th><th>SKU</th><th>商品</th><th>单位成本</th><th>生效日期</th><th>失效日期</th><th>来源</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(storeName(data, row.storeId))}</td><td>${esc(row.skuId)}</td><td>${esc(row.productName || "—")}</td><td>${formatFen(row.unitCostFen)}</td><td>${esc(row.effectiveFrom)}</td><td>${esc(row.effectiveTo || "无")}</td><td>${esc(row.costSource || "文件导入")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline">还没有成本记录。可以手动添加或导入成本表。</div>`}</section>`;
}

function renderIssues(data) {
  const issues = [...data.issues].filter((row) => state.selectedStoreId === "all" || row.storeId === state.selectedStoreId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const open = issues.filter((row) => row.status === "open" || row.status === "review").length;
  const mismatches = findFeeSettlementMismatches(data);
  const mismatchNote = mismatches.length ? `<div class="warning-note" style="margin-bottom:14px"><strong>${mismatches.length} 条简化结算差异需复核。</strong>只比较已关联订单的商品金额 − 已确认退款 − 平台费用与结算金额，不含运费、补贴、跨单调整等平台口径；不能替代平台账单对账。</div>` : "";
  const cards = issues.length ? issues.map((issue) => `<article class="issue-card" id="issue-${esc(issue.id)}" tabindex="-1"><div class="issue-card-head"><span class="tag ${issue.severity === "error" ? "tag-danger" : issue.severity === "info" ? "tag-blue" : "tag-warn"}">${esc(issue.severity)}</span><strong>${esc(ISSUE_LABELS[issue.issueType] || issue.issueType)}</strong><span class="tag ${issue.status === "resolved" ? "tag-ok" : "tag-neutral"}">${esc(issue.status)}</span></div><p>${esc(issue.description)}</p><div class="issue-card-foot"><span>${esc(storeName(data, issue.storeId))} · ${esc(String(issue.createdAt || "").slice(0, 16).replace("T", " "))}</span>${issue.status !== "resolved" ? `<button class="button secondary small" data-action="resolve-issue" data-issue-id="${esc(issue.id)}">标记已处理</button>` : `<span class="help-text">${esc(issue.resolutionNote || "已标记处理")}</span>`}</div></article>`).join("") : `<div class="empty-inline">当前没有导入异常记录。</div>`;
  return `${pageHeading("需要人工核对", "异常都在这里。", `${open} 条待处理记录。程序只指出可复核的差异，不自动修改订单或推断缺失金额。`, `<button class="button secondary" data-action="export-xlsx">导出异常报表</button>`)}${mismatchNote}<section class="card card-pad"><div class="section-title"><div><h2>异常和复核记录</h2><p>共 ${issues.length} 条，包括导入校验失败、未知状态、重复或冲突记录。</p></div><span class="tag ${open ? "tag-warn" : "tag-ok"}">${open} 待处理</span></div><div class="issue-list">${cards}</div></section>`;
}

function renderSettings(data) {
  const counts = STORE_NAMES.map((name) => `${name}: ${data[name].length}`).join(" · ");
  return `${pageHeading("数据由你掌控", "备份、恢复和清空。", "所有经营记录保存在当前设备浏览器的 IndexedDB 中。换浏览器或换设备不会自动同步。")}
    <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><h2>当前浏览器存储</h2><p id="storage-summary">正在读取浏览器存储额度…</p></div><span class="tag tag-ok">本机</span></div><div class="storage-meter"><span id="storage-meter-fill"></span></div><div class="storage-meta"><span id="storage-used">已使用 —</span><span id="storage-quota">可用额度 —</span></div><p class="help-text" id="storage-persistent-note" style="margin-top:12px">浏览器清除站点数据会删除本地记录。建议定期下载备份。</p><button class="button secondary small" data-action="request-persistence" style="margin-top:10px">请求浏览器保留此站点数据</button></article>
    <article class="card card-pad"><div class="section-title"><div><h2>下载本地备份</h2><p>导出 JSON 包含店铺、记录、导入行、异常和计算快照。</p></div><span class="tag tag-blue">${data.stores.length} 店铺</span></div><p class="help-text">备份文件可能含订单和费用详情。请保存在你信任的位置，不要公开分享。该文件不会自动上传。</p><button class="button" data-action="download-backup">下载备份 JSON</button></article></section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>恢复备份</h2><p>恢复会用备份文件中的数据整体替换当前浏览器数据。</p></div></div><div class="inline-form"><div class="field"><label for="restore-file">选择卖家利润助手 JSON 备份</label><input id="restore-file" type="file" accept=".json,application/json"></div></div><p class="form-note">选择文件后会先校验格式并显示记录数量；需要两次确认后才写入。写入失败时 IndexedDB 事务会回滚。</p></section>
    <section class="card card-pad danger-zone" style="margin-top:16px"><div class="section-title"><div><h2>清空当前浏览器中的全部数据</h2><p>包括店铺、订单、成本、费用、导入批次、异常和计算结果。该操作无法撤销。</p></div><span class="tag tag-danger">不可恢复</span></div><button class="button danger" data-action="clear-data">清空全部本地数据</button></section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>本机数据概况</h2><p>${esc(counts)}</p></div></div><p class="help-text">订单数量、SKU 成本、费用记录和导入校验结果只放在 IndexedDB；localStorage 只保留当前页面、店铺和日期等少量偏好设置。</p></section>`;
}

function renderGuide() {
  return `${pageHeading("快速上手", "几步开始，利润数据留在本机。", "本应用不要求注册账号、不连接平台 API，也不会把导入文件发给服务器或 AI。")}
    <section class="guide-grid">
      <article class="card guide-step"><span class="guide-step-num">01 / SHOP</span><span class="guide-icon">▣</span><h3>创建店铺</h3><p>在“店铺管理”填写平台和名称。它只是本地分类，不会登录淘宝、拼多多、抖音或闲鱼。</p></article>
      <article class="card guide-step"><span class="guide-step-num">02 / IMPORT</span><span class="guide-icon">⇧</span><h3>选择报表并映射字段</h3><p>上传 CSV 或 Excel 后先核对表头映射和异常预览，再确认导入。原文件不会被上传，也不会保留二进制副本。</p></article>
      <article class="card guide-step"><span class="guide-step-num">03 / COST</span><span class="guide-icon">◇</span><h3>维护 SKU 成本</h3><p>按 SKU 和生效日期维护单位成本。没有成本匹配的销售会显示缺项，避免将利润误报为完整结果。</p></article>
      <article class="card guide-step"><span class="guide-step-num">04 / REVIEW</span><span class="guide-icon">↗</span><h3>查看估算和异常</h3><p>总览、商品排名和异常清单都从 IndexedDB 中的记录确定性计算。可导出 Excel 或下载完整 JSON 备份。</p></article>
    </section>
    <section class="grid grid-2" style="margin-top:16px"><article class="card card-pad"><div class="section-title"><div><h2>确定性计算规则</h2><p>货币先转成整数分，数量按千分位存储。</p></div></div><div class="formula"><strong>已知项目利润估算</strong> = 有效订单商品实付 − 已确认退款 − 已匹配商品成本 − 平台费用 − 其他费用</div><ul class="rule-list" style="margin-top:14px"><li>销售按下单日期进入统计区间；退款按退款完成日期进入统计区间，所以跨月退款会在退款完成月体现。</li><li>取消订单不计入销售；无法识别的订单状态进入异常，不猜测是否成交。</li><li>重复文件和重复业务编号会跳过；同编号但内容变化的记录作为冲突，不覆盖原值。</li><li>未匹配成本不会从利润中减去，但会显示缺项并标注估算可能偏高。</li><li>订单级结算差异只作简化复核信号，不包含运费、补贴、跨单调整等平台结算口径。</li></ul></article>
      <article class="card card-pad"><div class="section-title"><div><h2>设备和浏览器说明</h2><p>本地优先也意味着数据由当前浏览器负责。</p></div></div><ul class="rule-list"><li>关闭页面后，只要浏览器站点数据未被清理，IndexedDB 记录会在下一次打开时恢复。</li><li>切换设备、浏览器或清除浏览器站点数据不会自动同步；请定期下载 JSON 备份。</li><li>静态托管只提供页面代码；应用没有订单上传 API、云数据库或 AI 接口。</li><li>建议使用较新的 Edge、Chrome、Firefox 或 Safari，并通过 localhost/HTTPS 打开以启用安全文件校验。</li></ul><div class="warning-note" style="margin-top:15px">统计结果是基于已导入数据的经营估算，不是会计记账、税务申报或平台官方结算结论。</div><details class="disclosure" style="margin-top:15px"><summary>第三方开源组件</summary><div>Excel 文件读取和导出使用 SheetJS Community Edition 0.20.3，本地随站点提供，不从 CDN 加载。<a class="license-link" href="./THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener">查看开源许可</a>。</div></details></article></section>`;
}

function renderPage(data = state.data) {
  fillGlobalControls(data);
  const root = $("#page-content");
  const renderers = { overview: renderDashboard, stores: renderStores, import: renderImport, records: renderRecords, costs: renderCosts, issues: renderIssues, settings: renderSettings, guide: () => renderGuide() };
  root.innerHTML = (renderers[state.page] || renderDashboard)(data);
  root.focus({ preventScroll: true });
  if (state.page === "settings") updateStorageDetails();
}

function setPage(page) {
  if (!PAGE_META[page]) return;
  state.page = page;
  savePrefs();
  renderPage();
}

function setFilterFromControls() {
  state.selectedStoreId = $("#global-store-select").value || "all";
  const start = $("#global-start").value;
  const end = $("#global-end").value;
  if (normalizeDate(start) && normalizeDate(end)) {
    state.start = start;
    state.end = end;
    if (state.start > state.end) [state.start, state.end] = [state.end, state.start];
  }
  savePrefs();
  renderPage();
}

function normalizeIdbError(error) {
  if (error?.name === "ConstraintError") return new Error("业务编号或生效日期重复，本次事务未保存任何记录。请检查重复或冲突提示。", { cause: error });
  if (error?.name === "DataCloneError") return new Error("有字段不能安全写入本地数据库，本次事务没有保存。", { cause: error });
  return error;
}

async function addStore(form) {
  const values = new FormData(form);
  const name = String(values.get("name") || "").trim();
  const platform = String(values.get("platform") || "").trim();
  if (!name || !platform) throw new Error("请填写店铺名称并选择平台。");
  const id = uid();
  const record = { id, platform, name, currency: "CNY", createdAt: new Date().toISOString() };
  await writeRecords(state.db, { stores: [record] }, "add");
  state.selectedStoreId = id;
  state.importStoreId = id;
  savePrefs();
  await refreshData();
  state.page = "import";
  renderPage();
  toast("店铺已保存到当前浏览器。", "ok");
}

async function addManualCost(form) {
  const values = new FormData(form);
  const storeId = String(values.get("storeId") || "");
  const skuId = String(values.get("skuId") || "").trim();
  const productName = String(values.get("productName") || "").trim();
  const effectiveFrom = normalizeDate(values.get("effectiveFrom"));
  const effectiveTo = normalizeDate(values.get("effectiveTo")) || null;
  const unitCostFen = parseMoneyFen(values.get("unitCost"));
  if (!state.data.stores.some((store) => store.id === storeId)) throw new Error("请选择有效店铺。");
  if (!skuId || !effectiveFrom || unitCostFen === null || unitCostFen < 0) throw new Error("SKU、有效日期和非负成本都需要填写。");
  if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("失效日期不能早于生效日期。");
  const record = { id: uid(), storeId, skuId, productName, unitCostFen, effectiveFrom, effectiveTo,
    costSource: "手动维护", updatedAt: new Date().toISOString() };
  record.recordKey = stableRecordKey("costs", record);
  record.rowHash = JSON.stringify({ storeId, skuId, productName, unitCostFen, effectiveFrom, effectiveTo });
  await writeRecords(state.db, { productCosts: [record] }, "add");
  await refreshData();
  renderPage();
  toast("商品成本已写入 IndexedDB。", "ok");
}

async function handleImportFile(file) {
  if (!file) return;
  state.importPlan = null;
  state.pendingFile = null;
  state.importMapping = null;
  renderPage();
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 20 MB。");
    const parsed = await readTabularFile(file);
    const fileHash = await sha256(parsed.buffer);
    const reportType = $("#import-kind")?.value || "orders";
    const storeId = $("#import-store")?.value || state.importStoreId || state.data.stores[0]?.id;
    state.pendingFile = { fileName: file.name, size: file.size, reportType, storeId, fileHash, headers: parsed.headers, rows: parsed.rows, sheetName: parsed.sheetName };
    state.importMapping = suggestMapping(reportType, parsed.headers);
    renderPage();
    toast(`文件已在本机解析：${parsed.rows.length} 行，尚未写入数据库。`, "ok");
  } catch (error) { presentError(error, "解析文件失败"); }
}

function validateMapping(reportType, mapping) {
  const missing = REPORTS[reportType].fields.filter((field) => field.required && !mapping[field.key]).map((field) => field.label);
  if (reportType === "orders" && !mapping.itemAmount && !mapping.unitPrice) missing.push("商品实付金额或商品单价（二选一）");
  if (missing.length) throw new Error(`请先映射：${missing.join("、")}`);
}

async function validateImport() {
  const pending = state.pendingFile;
  if (!pending) throw new Error("请先选择一个本地文件。");
  const reportType = $("#import-kind")?.value || pending.reportType;
  const storeId = $("#import-store")?.value || pending.storeId;
  const mapping = Object.fromEntries(REPORTS[reportType].fields.map((field) => [field.key, $(`[data-map-field="${field.key}"]`)?.value || ""]));
  validateMapping(reportType, mapping);
  state.pendingFile = { ...pending, reportType, storeId };
  state.importMapping = mapping;
  state.importPlan = await prepareImport(state.db, { name: pending.fileName, size: pending.size }, reportType, storeId, pending.headers, pending.rows, mapping, pending.fileHash);
  renderPage();
  toast("映射和重复项检查已完成。", "ok");
}

async function importValidatedRows() {
  const plan = state.importPlan;
  if (!plan || plan.duplicateFile || !plan.accepted.length) throw new Error("没有可导入的有效记录。");
  const invalidCount = plan.rejected.length + plan.conflicts.length;
  const message = `即将在本机保存 ${plan.accepted.length} 条新记录，跳过 ${plan.duplicates.length} 条重复记录，记录 ${invalidCount} 行待复核。\n\n原文件不会上传或保存。是否继续？`;
  if (!window.confirm(message)) return;
  try {
    const result = await commitImport(state.db, plan);
    state.selectedStoreId = plan.storeId;
    state.importStoreId = plan.storeId;
    if (plan.coverageStart && plan.coverageEnd && (plan.coverageEnd < state.start || plan.coverageStart > state.end)) {
      state.start = plan.coverageStart;
      state.end = plan.coverageEnd;
    }
    state.pendingFile = null;
    state.importPlan = null;
    state.importMapping = null;
    await refreshData();
    state.page = "overview";
    savePrefs();
    renderPage();
    toast(`导入事务已完成：新增 ${result.importedCount} 条，重复 ${result.duplicateCount} 条，拒绝 ${result.rejectedCount} 行。`, "ok", 6500);
  } catch (error) { presentError(normalizeIdbError(error), "导入未完成"); }
}

function clickDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportBackup() {
  const snapshot = await readSnapshot(state.db);
  const backup = makeBackup(snapshot);
  const json = JSON.stringify(backup, null, 2);
  if (json.length > 120 * 1024 * 1024) throw new Error("备份文件超过浏览器可安全导出的大小，请分批清理或检查异常记录数。");
  const date = localToday().replaceAll("-", "");
  clickDownload(new Blob([json], { type: "application/json;charset=utf-8" }), `卖家利润助手_本地备份_${date}.json`);
  toast(`备份文件已生成：${snapshot.stores.length} 个店铺、${snapshot.orders.length} 个订单。请妥善保管下载文件。`, "ok", 6000);
}

async function handleRestoreFile(file) {
  if (!file) return;
  try {
    if (file.size > 120 * 1024 * 1024) throw new Error("备份文件大于 120 MB，无法安全读取。");
    const parsed = validateBackup(JSON.parse(await file.text()));
    const counts = Object.entries(parsed.stores).filter(([, rows]) => rows.length).map(([name, rows]) => `${name} ${rows.length}`).join("，") || "空数据集";
    if (!window.confirm(`备份校验通过。恢复将整体替换当前本地数据。\n\n${counts}\n\n建议先下载当前数据备份。是否继续？`)) return;
    const confirmation = window.prompt("最后确认：输入“替换”以覆盖当前浏览器中的全部经营数据。", "");
    if (confirmation !== "替换") { toast("未输入“替换”，恢复已取消；当前数据未变更。", "warn"); return; }
    const result = await restoreBackup(state.db, parsed);
    await refreshData();
    renderPage();
    toast(`恢复事务已完成：${result.stores} 个店铺、${result.orders} 个订单、${result.orderItems} 个商品明细。`, "ok", 6500);
  } catch (error) { presentError(error, "备份恢复失败；原有数据未被标记为已替换"); }
}

async function clearBrowserData() {
  if (!window.confirm("确认清空当前浏览器中的所有店铺、订单、退款、费用、成本、异常和计算结果？此操作无法撤销。")) return;
  const confirmation = window.prompt("请再次输入“清空”以确认删除全部本地数据。", "");
  if (confirmation !== "清空") { toast("未输入“清空”，数据未删除。", "warn"); return; }
  try {
    await clearAllData(state.db);
    try { localStorage.removeItem(PREFS_KEY); } catch { /* settings are optional */ }
    state.selectedStoreId = "all";
    state.start = "";
    state.end = "";
    state.page = "overview";
    await refreshData();
    renderPage();
    toast("全部本地数据已清空。", "ok", 6000);
  } catch (error) { presentError(error, "清空失败；数据库事务没有完成"); }
}

async function updateStorageDetails() {
  const summary = $("#storage-summary");
  if (!summary) return;
  try {
    const estimate = await navigator.storage?.estimate?.();
    const used = Number(estimate?.usage || 0);
    const quota = Number(estimate?.quota || 0);
    const persisted = await navigator.storage?.persisted?.();
    const ratio = quota ? Math.min(100, used / quota * 100) : 0;
    summary.textContent = persisted ? "浏览器已将此站点标记为持久存储。" : "已使用浏览器本地存储；是否被清理由浏览器策略决定。";
    $("#storage-used").textContent = `已使用 ${bytesLabel(used)}`;
    $("#storage-quota").textContent = quota ? `浏览器估算额度 ${bytesLabel(quota)}` : "浏览器未提供额度估算";
    $("#storage-meter-fill").style.width = `${ratio.toFixed(1)}%`;
    $("#storage-persistent-note").textContent = persisted ? "持久存储已启用，但设备损坏、浏览器清除站点数据或用户主动删除仍会移除记录。请另存备份。" : "可以请求浏览器尽量保留此站点数据；浏览器仍可能因用户清理或设备策略删除站点数据。建议定期下载备份。";
  } catch (error) {
    summary.textContent = "浏览器未提供本地存储额度信息；实际写入结果仍会检查并报告。";
    console.warn("无法读取存储额度", error);
  }
}

async function requestStoragePersistence() {
  if (!navigator.storage?.persist) throw new Error("此浏览器不支持持久存储申请。建议定期下载备份。");
  const persisted = await navigator.storage.persist();
  await updateStorageDetails();
  toast(persisted ? "浏览器已允许此站点请求持久存储。" : "浏览器未批准持久存储申请；数据仍存于 IndexedDB，但应定期备份。", persisted ? "ok" : "warn", 6000);
}

async function exportXlsx() {
  const summary = currentSummary();
  try {
    downloadWorkbook(state.data, summary, selectedStoreName());
    toast("Excel 报告已在浏览器本机生成；明细页包含本机已保存记录。", "ok", 5500);
  } catch (error) { presentError(error, "生成 Excel 失败"); }
}

async function resolveIssue(issueId) {
  const issue = state.data.issues.find((row) => row.id === issueId);
  if (!issue) throw new Error("找不到此异常记录。");
  const note = window.prompt("可填写处理备注（可留空）：", issue.resolutionNote || "");
  if (note === null) return;
  await putOne(state.db, "issues", { ...issue, status: "resolved", resolutionNote: note.trim(), resolvedAt: new Date().toISOString() });
  await refreshData();
  renderPage();
  toast("异常处理状态已保存。", "ok");
}

async function handleClick(event) {
  const nav = event.target.closest("[data-nav]");
  if (nav) { event.preventDefault(); setPage(nav.dataset.nav); return; }
  const control = event.target.closest("[data-action]");
  if (!control || control.disabled) return;
  try {
    switch (control.dataset.action) {
      case "load-demo": {
        control.disabled = true;
        const result = await loadDemoData(state.db);
        if (!result.loaded) toast("虚构演示数据已经载入过，没有重复写入。", "warn");
        else toast(`已载入虚构样例：${result.orderCount} 个订单、${result.itemCount} 条商品明细。`, "ok", 6000);
        state.selectedStoreId = "demo-store-local-v1";
        await refreshData();
        state.page = "overview";
        savePrefs();
        renderPage();
        break;
      }
      case "validate-import": await validateImport(); break;
      case "commit-import": await importValidatedRows(); break;
      case "clear-import": state.pendingFile = null; state.importPlan = null; state.importMapping = null; renderPage(); break;
      case "download-backup": await exportBackup(); break;
      case "clear-data": await clearBrowserData(); break;
      case "request-persistence": await requestStoragePersistence(); break;
      case "export-xlsx": await exportXlsx(); break;
      case "resolve-issue": await resolveIssue(control.dataset.issueId); break;
      case "open-issue": {
        state.page = "issues";
        savePrefs();
        renderPage();
        const target = document.getElementById(`issue-${control.dataset.issueId}`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.focus({ preventScroll: true });
        }
        break;
      }
      case "select-store": state.selectedStoreId = control.dataset.storeId; savePrefs(); await refreshData(); setPage("overview"); break;
      default: break;
    }
  } catch (error) { presentError(normalizeIdbError(error), "操作失败"); }
}

async function handleChange(event) {
  const target = event.target;
  if (target.matches("#global-store-select, #global-start, #global-end")) { setFilterFromControls(); return; }
  if (target.matches("[data-record-type]")) { state.recordType = target.value; renderPage(); return; }
  if (target.matches("[data-import-store]")) {
    state.importStoreId = target.value;
    state.importPlan = null;
    if (state.pendingFile) state.pendingFile.storeId = target.value;
    renderPage(); return;
  }
  if (target.matches("[data-import-kind]")) {
    if (state.pendingFile) {
      state.pendingFile.reportType = target.value;
      state.importMapping = suggestMapping(target.value, state.pendingFile.headers);
      state.importPlan = null;
      renderPage();
    }
    return;
  }
  if (target.matches("[data-map-field]")) {
    state.importMapping = state.importMapping || {};
    state.importMapping[target.dataset.mapField] = target.value;
    state.importPlan = null;
    return;
  }
  if (target.matches("#import-file")) { await handleImportFile(target.files?.[0]); return; }
  if (target.matches("#restore-file")) { await handleRestoreFile(target.files?.[0]); return; }
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
  try {
    if (form.dataset.form === "add-store") await addStore(form);
    else if (form.dataset.form === "add-cost") await addManualCost(form);
  } catch (error) { presentError(normalizeIdbError(error), "保存失败"); }
  finally { if (submit?.isConnected) submit.disabled = false; }
}

function handleDrag(event) {
  const zone = event.target.closest(".dropzone");
  if (!zone) return;
  if (event.type === "dragover") { event.preventDefault(); zone.classList.add("dragover"); }
  if (event.type === "dragleave") zone.classList.remove("dragover");
  if (event.type === "drop") {
    event.preventDefault(); zone.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) handleImportFile(file);
  }
}

async function start() {
  try {
    state.db = await openDatabase();
    await refreshData();
    fillGlobalControls(state.data);
    $("#app-shell").addEventListener("click", handleClick);
    $("#app-shell").addEventListener("change", handleChange);
    $("#app-shell").addEventListener("submit", handleSubmit);
    $("#app-shell").addEventListener("dragover", handleDrag);
    $("#app-shell").addEventListener("dragleave", handleDrag);
    $("#app-shell").addEventListener("drop", handleDrag);
    window.addEventListener("unhandledrejection", (event) => presentError(event.reason, "本地操作异常"));
    renderPage();
    if (navigator.storage?.persisted) {
      const persisted = await navigator.storage.persisted();
      document.body.dataset.storagePersisted = String(persisted);
    }
  } catch (error) {
    console.error("Application startup failed", error);
    $("#page-content").innerHTML = `<section class="card empty-state"><div class="empty-art">!</div><h2>无法完成本地数据初始化</h2><p>${esc(error.message || "浏览器没有打开 IndexedDB。")}</p><p>请使用最新版浏览器，通过 localhost 或 HTTPS 访问；确认浏览器没有禁用站点存储后刷新。没有数据被报告为已保存。</p></section>`;
  }
}

start();
