import { clearAllData, openDatabase, putOne, readAll, readSnapshot, writeRecords } from "./db.mjs";
import { CALCULATION_RULE_VERSION, REPORTS, STORE_NAMES, calculateSummary, classifyOrderStatus, dedupeCandidates, findCost, findFeeSettlementMismatches, formatFen, formatQuantity, multiplyFenByMilli, normalizeDate, parseMoneyFen, periodKey, productSummary, reconcileFeeSettlementIssues, reconcileMissingCostIssues, stableRecordKey } from "./domain.mjs";
import { commitImport, MAX_DATA_ROWS, MAX_FILE_BYTES, prepareImport, readTabularFile, sha256, suggestMapping } from "./importer.mjs";
import { makeBackup, restoreBackup, validateBackup } from "./backup.mjs";
import { downloadWorkbook } from "./exporter.mjs";
import { trendSvg } from "./charts.mjs";
import { loadDemoData } from "./sample.mjs";

const PREFS_KEY = "seller-profit-assistant:prefs:v1";
const PAGE_META = {
  overview: ["经营总览", "看看最近经营情况"], stores: ["店铺管理", "管理你的店铺"], import: ["导入表格", "添加订单和费用"],
  records: ["数据明细", "查看已保存的数据"], costs: ["商品成本", "补上商品进货成本"], issues: ["需要处理", "检查导入中的问题"],
  settings: ["备份数据", "保护和搬运本机数据"], guide: ["新手教程", "第一次使用看这里"],
};
const ISSUE_LABELS = {
  missing_cost: "还没有商品成本", fee_settlement_mismatch: "到账金额对不上", unknown_order_status: "订单状态看不懂",
  import_validation: "表格内容有问题", duplicate_record: "重复数据", record_conflict: "订单信息不一致",
  unmatched_fee: "有费用找不到对应订单", order_status_conflict: "订单信息不一致",
};
const SEVERITY_LABELS = { error: "需要处理", warning: "请留意", info: "提示" };
const ISSUE_STATUS_LABELS = { open: "待处理", review: "检查中", resolved: "已处理" };
const EMPTY_DATA = () => Object.fromEntries(STORE_NAMES.map((name) => [name, []]));
const GUIDED_TOUR_STEPS = [
  { page: "overview", target: '[data-nav="overview"]', name: "经营总览", title: "先看经营总览", copy: "这里集中显示销售额、退款、预计利润和趋势图。下面会用虚构样例演示这些数字从哪里来。" },
  { page: "issues", target: '[data-nav="issues"]', name: "需要处理", title: "提醒会集中放在这里", copy: "点开后可以查看缺少商品成本、订单状态看不懂或到账金额对不上等问题，再按每条说明检查。" },
  { page: "costs", target: '[data-nav="costs"]', name: "商品成本", title: "补上每件商品的进货价", copy: "成本按商品编号匹配订单。编号相同，系统才能把进货价算进预计利润；样例里已经放好了几项成本。" },
  { page: "import", target: '[data-nav="import"]', name: "导入表格", title: "自己的数据从这里导入", copy: "选店铺、表格类型和文件。保存前先核对列名、预览和问题条数；本次体验不需要上传你的文件。" },
  { page: "overview", target: '[data-nav="overview"]', name: "经营总览", title: "最后回到总览看结果", copy: "样例图表、销售额、退款和预计利润都在这里。演示店铺名称带有“虚构数据”字样，不会和你的真实店铺混在一起。" },
];
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
  guidedTourSeen: savedPrefs.guidedTourSeen === true,
  lastBackupAt: typeof savedPrefs.lastBackupAt === "string" ? savedPrefs.lastBackupAt : "",
  guidedTourActive: false,
  guidedTourStep: 0,
  recordType: "orders",
  importStoreId: "",
  pendingFile: null,
  importMapping: null,
  importPlan: null,
  data: EMPTY_DATA(),
  isBusy: false,
};

function savePrefs() {
  const prefs = { page: state.page, storeId: state.selectedStoreId, start: state.start, end: state.end, guidedTourSeen: state.guidedTourSeen, lastBackupAt: state.lastBackupAt };
  const serialized = JSON.stringify(prefs);
  if (serialized.length > 2048) return;
  try { localStorage.setItem(PREFS_KEY, serialized); }
  catch { toast("浏览器没有保存页面偏好；经营记录仍保存在此浏览器。", "warn"); }
}

function toast(message, type = "ok", duration = 4300) {
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : type === "warn" ? "warn" : ""}`;
  node.textContent = message;
  $("#toast-stack").append(node);
  window.setTimeout(() => node.remove(), duration);
}

function openTutorial() {
  const dialog = $("#welcome-tutorial");
  if (!dialog.open) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
}

function closeTutorial() {
  const dialog = $("#welcome-tutorial");
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    if (!state.guidedTourActive) markTutorialSeen();
  }
}

function markTutorialSeen() {
  state.guidedTourSeen = true;
  savePrefs();
}

function positionGuidedTour() {
  if (!state.guidedTourActive) return;
  const step = GUIDED_TOUR_STEPS[state.guidedTourStep];
  const target = step && $(step.target);
  const layer = $("#guided-tour");
  const spotlight = $("#guided-tour-spotlight");
  const card = $("#guided-tour-card");
  if (!step || !target) return;
  layer.hidden = false;
  const rect = target.getBoundingClientRect();
  spotlight.style.left = `${Math.max(0, rect.left - 4)}px`;
  spotlight.style.top = `${Math.max(0, rect.top - 4)}px`;
  spotlight.style.width = `${rect.width + 8}px`;
  spotlight.style.height = `${rect.height + 8}px`;
  spotlight.setAttribute("aria-label", `点击高亮的${step.name}继续`);
  card.style.width = `min(360px, calc(100vw - 24px))`;
  const cardHeight = card.getBoundingClientRect().height;
  if (window.innerWidth <= 760) {
    card.style.left = "12px";
    card.style.top = `${Math.max(12, Math.min(rect.bottom + 16, window.innerHeight - cardHeight - 12))}px`;
  } else {
    const width = Math.min(360, window.innerWidth - 24);
    let left = rect.right + 20;
    if (left + width > window.innerWidth - 12) left = Math.max(12, rect.left - width - 20);
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(12, Math.min(rect.top - 18, window.innerHeight - cardHeight - 12))}px`;
  }
}

function renderGuidedTour() {
  const layer = $("#guided-tour");
  if (!state.guidedTourActive) { layer.hidden = true; return; }
  const step = GUIDED_TOUR_STEPS[state.guidedTourStep];
  if (!step) return;
  $("#guided-tour-step").textContent = `第 ${state.guidedTourStep + 1} 步，共 ${GUIDED_TOUR_STEPS.length} 步`;
  $("#guided-tour-title").textContent = step.title;
  $("#guided-tour-copy").textContent = step.copy;
  $("#guided-tour-prompt").textContent = `请点击高亮的“${step.name}”继续`;
  $("[data-action='guided-tour-back']").hidden = state.guidedTourStep === 0;
  layer.hidden = false;
  requestAnimationFrame(() => {
    $(step.target)?.scrollIntoView({ block: "nearest", inline: "center" });
    positionGuidedTour();
    $(step.target)?.focus({ preventScroll: true });
  });
}

function finishGuidedTour({ skipped = false } = {}) {
  state.guidedTourActive = false;
  $("#guided-tour").hidden = true;
  markTutorialSeen();
  if (skipped) toast("已退出引导。虚构样例仍保存在单独的演示店铺中。", "warn", 5500);
  else {
    state.page = "overview";
    savePrefs();
    renderPage();
    toast("体验完成，经营总览已显示虚构样例结果。", "ok", 6000);
  }
}

async function startGuidedTour(control) {
  if (control) control.disabled = true;
  try {
    await loadDemoData(state.db);
    state.selectedStoreId = "demo-store-local-v1";
    state.start = dateOffset(localToday(), -29);
    state.end = localToday();
    await refreshData();
    state.page = "overview";
    state.guidedTourStep = 0;
    state.guidedTourActive = true;
    closeTutorial();
    savePrefs();
    renderPage();
    renderGuidedTour();
  } catch (error) {
    presentError(normalizeIdbError(error), "无法开始引导");
    const description = $("#tutorial-description");
    if (description) description.textContent = `虚构样例没有载入成功：${error?.message || "请检查浏览器存储空间后重试。"}`;
  } finally {
    if (control?.isConnected) control.disabled = false;
  }
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
  storeSelect.innerHTML = `<option value="all">全部店铺</option>${data.stores.map((store) => `<option value="${esc(store.id)}">${esc(store.name)}</option>`).join("")}`;
  storeSelect.value = state.selectedStoreId;
  const selectedStore = data.stores.find((store) => store.id === state.selectedStoreId);
  const storeKind = $("#global-store-kind");
  storeKind.hidden = !selectedStore?.demo;
  storeKind.textContent = selectedStore?.demo ? "演示数据" : "";
  $("#global-start").value = state.start;
  $("#global-end").value = state.end;
  const openIssues = data.issues.filter((issue) => (issue.status === "open" || issue.status === "review") && isVisibleIssue(issue, data)).length;
  $("#nav-issue-count").textContent = openIssues ? String(openIssues) : "";
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === state.page);
    if (button.dataset.nav === "import") button.setAttribute("aria-label", "导入表格");
    if (button.dataset.nav === "issues") button.setAttribute("aria-label", `需要处理，${openIssues} 条待处理`);
  });
  const title = PAGE_META[state.page] || PAGE_META.overview;
  $("#top-title").textContent = title[0];
  $("#top-eyebrow").textContent = title[1];
  updateSidebarBackupStatus();
  document.querySelectorAll("[data-period]").forEach((button) => button.classList.toggle("active", matchesPreset(button.dataset.period)));
}

function matchesPreset(preset) {
  const today = localToday();
  if (preset === "7") return state.end === today && state.start === dateOffset(today, -6);
  if (preset === "30") return state.end === today && state.start === dateOffset(today, -29);
  if (preset === "month") return state.start === `${today.slice(0, 7)}-01` && state.end === today;
  if (preset === "previous-month") {
    const first = new Date(`${today.slice(0, 7)}-01T12:00:00`);
    first.setDate(0);
    const end = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
    return state.start === `${end.slice(0, 7)}-01` && state.end === end;
  }
  return false;
}

function updateSidebarBackupStatus(data = state.data) {
  const node = $("#sidebar-backup-status");
  if (!node) return;
  const hasSavedRecords = data && ["orders", "orderItems", "refunds", "platformFees", "productCosts", "otherExpenses", "settlements"].some((name) => data[name]?.length);
  if (!hasSavedRecords) {
    node.textContent = "添加经营数据后，可在此备份。";
    node.classList.remove("overdue");
    return;
  }
  if (!state.lastBackupAt) {
    node.textContent = "尚未备份，建议导出一份副本。";
    node.classList.add("overdue");
    return;
  }
  const backupDate = new Date(state.lastBackupAt);
  const dayCount = Number.isFinite(backupDate.valueOf()) ? Math.max(0, Math.floor((Date.now() - backupDate.valueOf()) / 86400000)) : Infinity;
  node.classList.toggle("overdue", dayCount > 7);
  node.textContent = dayCount > 7 ? `上次备份已过 ${dayCount} 天，建议导出最新副本。` : `上次备份：${backupDate.toLocaleDateString("zh-CN")}`;
}

function currentSummary(data = state.data) {
  return calculateSummary(data, { storeId: state.selectedStoreId, start: state.start, end: state.end });
}

function storeName(data, storeId) { return data.stores.find((row) => row.id === storeId)?.name || "未知店铺"; }

function pageHeading(kicker, title, description, actions = "") {
  return `<div class="page-heading"><div>${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ""}<h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function emptyState(title, text, actions = "") {
  return `<section class="card empty-state"><div class="empty-art" aria-hidden="true">◌</div><h2>${title}</h2><p>${text}</p><div class="button-row">${actions}</div></section>`;
}

function metricCard(label, value, note, symbol, tone = "") {
  return `<article class="metric-card ${tone}"><div class="metric-label"><span>${esc(label)}</span><span class="metric-symbol" aria-hidden="true">${esc(symbol)}</span></div><strong class="metric-value">${esc(value)}</strong><span class="metric-note">${esc(note)}</span></article>`;
}

function cleanStatus(value) { return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s_—-]/g, ""); }

function isPendingOrderStatus(value) {
  const status = cleanStatus(value);
  const pendingChinese = ["待付款", "待支付", "等待付款", "等待支付", "等待买家付款", "等待买家支付", "买家未付款", "未付款", "待买家付款", "待买家支付"];
  return pendingChinese.some((known) => status.includes(known)) || ["pending", "unpaid", "awaitingpayment"].includes(status);
}

function orderForIssue(issue, data = state.data) {
  if (issue.issueType !== "unknown_order_status") return null;
  const match = String(issue.description || "").match(/订单\s+(.+?)\s+的状态/);
  if (!match) return null;
  return data.orders.find((order) => order.storeId === issue.storeId && order.platformOrderId === match[1]) || null;
}

function isVisibleIssue(issue, data = state.data) {
  if (issue.issueType !== "unknown_order_status") return true;
  const order = orderForIssue(issue, data);
  return !(order && order.statusClass !== "valid" && isPendingOrderStatus(order.orderStatus));
}

function uniqueVisibleIssues(issues, data = state.data) {
  const seen = new Set();
  return issues.filter((issue) => {
    if (!isVisibleIssue(issue, data)) return false;
    const order = orderForIssue(issue, data);
    const key = order ? `unknown-order|${order.id}|${issue.status}` : issue.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderIssueActions(issue, order) {
  if (!order || issue.status === "resolved") return "";
  return `<div class="order-status-actions"><button class="button small" data-action="order-status" data-resolution="include" data-order-id="${esc(order.id)}" data-issue-id="${esc(issue.id)}">按已成交计入</button><button class="button secondary small" data-action="order-status" data-resolution="ignore" data-order-id="${esc(order.id)}" data-issue-id="${esc(issue.id)}">忽略</button><button class="button ghost small" data-action="order-status" data-resolution="manual" data-order-id="${esc(order.id)}" data-issue-id="${esc(issue.id)}">手动指定状态</button></div>`;
}

function dashboardIssueMarkup(issue, data) {
  const order = orderForIssue(issue, data);
  if (order) return `<article class="dashboard-issue-link status-issue-row"><div class="dashboard-issue-copy"><strong>${esc(ISSUE_LABELS[issue.issueType] || "需要检查")}</strong><span>订单 ${esc(order.platformOrderId)} 的状态“${esc(order.orderStatus)}”无法识别，默认没有计入销售。</span></div>${orderIssueActions(issue, order)}</article>`;
  return `<button class="dashboard-issue-link" data-action="open-issue" data-issue-id="${esc(issue.id)}"><span class="tag ${issue.severity === "error" ? "tag-danger" : "tag-warn"}">${esc(SEVERITY_LABELS[issue.severity] || "请检查")}</span><span class="dashboard-issue-copy"><strong>${esc(ISSUE_LABELS[issue.issueType] || "需要检查")}</strong><span>${esc(issue.description)}</span></span><span class="dashboard-issue-arrow" aria-hidden="true">↗</span></button>`;
}

function financialTrend(data, summary) {
  const days = new Map();
  const start = new Date(`${summary.start}T00:00:00Z`);
  const end = new Date(`${summary.end}T00:00:00Z`);
  for (let date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    days.set(date.toISOString().slice(0, 10), { date: date.toISOString().slice(0, 10), grossSalesFen: 0, costFen: 0, refundFen: 0, feeFen: 0, expenseFen: 0 });
  }
  const allowed = new Set(summary.storeIds);
  const orders = data.orders.filter((order) => allowed.has(order.storeId) && order.statusClass === "valid" && days.has(order.orderedAt));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  for (const item of data.orderItems) {
    const order = orderById.get(item.orderId);
    if (!order) continue;
    const point = days.get(order.orderedAt);
    point.grossSalesFen += item.amountFen;
    const cost = findCost(data.productCosts, item.storeId, item.skuId, order.orderedAt);
    if (cost) point.costFen += multiplyFenByMilli(cost.unitCostFen, item.quantityMilli);
  }
  for (const refund of data.refunds) if (allowed.has(refund.storeId) && refund.confirmed && days.has(refund.completedAt)) days.get(refund.completedAt).refundFen += refund.amountFen;
  for (const fee of data.platformFees) if (allowed.has(fee.storeId) && days.has(fee.feeDate)) days.get(fee.feeDate).feeFen += fee.amountFen;
  for (const expense of data.otherExpenses) if (allowed.has(expense.storeId) && days.has(expense.expenseDate)) days.get(expense.expenseDate).expenseFen += expense.amountFen;
  return [...days.values()].map((point) => ({ ...point, profitFen: point.grossSalesFen - point.costFen - point.refundFen - point.feeFen - point.expenseFen }));
}

function previousPeriodSummary(data, summary) {
  const days = Math.round((Date.parse(`${summary.end}T00:00:00Z`) - Date.parse(`${summary.start}T00:00:00Z`)) / 86400000) + 1;
  const end = dateOffset(summary.start, -1);
  const start = dateOffset(end, -(Math.max(1, days) - 1));
  return calculateSummary(data, { storeId: state.selectedStoreId, start, end });
}

function periodDelta(current, previous, label) {
  const difference = current - previous;
  const percent = previous ? Math.abs(difference / Math.abs(previous) * 100).toFixed(1) : null;
  const direction = difference > 0 ? "up" : difference < 0 ? "down" : "flat";
  const text = previous ? `${direction === "up" ? "↑" : direction === "down" ? "↓" : "→"} ${percent}%` : difference ? "新增" : "持平";
  return `<span class="period-delta ${direction}">${esc(label)} ${text}（${difference > 0 ? "+" : ""}${esc(formatFen(difference))}）</span>`;
}

function feeComposition(data, summary) {
  const allowed = new Set(summary.storeIds);
  const fees = data.platformFees.filter((row) => allowed.has(row.storeId) && row.feeDate >= summary.start && row.feeDate <= summary.end);
  const expenses = data.otherExpenses.filter((row) => allowed.has(row.storeId) && row.expenseDate >= summary.start && row.expenseDate <= summary.end);
  const kind = (value) => String(value || "").toLowerCase();
  const shippingFee = fees.filter((row) => /运费|物流|配送/.test(kind(row.feeType))).reduce((sum, row) => sum + row.amountFen, 0);
  const shippingExpense = expenses.filter((row) => /运费|物流|配送/.test(kind(row.expenseType))).reduce((sum, row) => sum + row.amountFen, 0);
  const commission = fees.filter((row) => /佣金|技术服务|平台服务|扣点/.test(kind(row.feeType))).reduce((sum, row) => sum + row.amountFen, 0);
  const promotionFee = fees.filter((row) => /推广|广告|直通车|营销/.test(kind(row.feeType))).reduce((sum, row) => sum + row.amountFen, 0);
  const promotionExpense = expenses.filter((row) => /推广|广告|直通车|营销/.test(kind(row.expenseType))).reduce((sum, row) => sum + row.amountFen, 0);
  const shipping = shippingFee + shippingExpense;
  const promotion = promotionFee + promotionExpense;
  const other = summary.feeFen + summary.expenseFen - commission - shipping - promotion;
  return [
    ["商品销售额", summary.grossSalesFen, "income"], ["商品成本", summary.costFen, "deduction"], ["佣金", commission, "deduction"],
    ["运费", shipping, "deduction"], ["退款", summary.refundFen, "deduction"], ["推广", promotion, "deduction"],
    ["其他费用", other, "deduction"], ["预计利润", summary.knownProfitFen, "profit"],
  ];
}

function profitFlowValue(amount, kind) {
  if (kind === "income" || kind === "profit") return formatFen(amount);
  return amount < 0 ? `+ ${formatFen(Math.abs(amount))}` : `− ${formatFen(amount)}`;
}

function rankProducts(products, summary) {
  const totalSales = products.reduce((sum, row) => sum + row.salesFen, 0);
  const commonDeduction = summary.refundFen + summary.feeFen + summary.expenseFen;
  const rows = products.map((row) => {
    const allocated = totalSales ? Math.round(commonDeduction * row.salesFen / totalSales) : 0;
    const profitFen = row.salesFen - row.costFen - allocated;
    return { ...row, profitFen, margin: row.salesFen ? profitFen / row.salesFen : null };
  });
  return {
    highest: [...rows].sort((a, b) => b.profitFen - a.profitFen).slice(0, 5),
    loss: rows.filter((row) => row.profitFen < 0).sort((a, b) => a.profitFen - b.profitFen).slice(0, 5),
    lowMargin: rows.filter((row) => !row.missingCost && row.margin !== null).sort((a, b) => a.margin - b.margin).slice(0, 5),
  };
}

function rankedProductList(rows, value) {
  if (!rows.length) return `<p class="empty-inline">目前没有符合条件的商品。</p>`;
  return `<ol class="ranked-product-list">${rows.map((row) => `<li><span class="rank-product-copy"><strong title="${esc(row.productName)}">${esc(row.productName || row.skuId)}</strong><small>${esc(row.skuId)}${row.missingCost ? " · 缺少成本" : ""}</small></span><span class="rank-product-value ${row.profitFen < 0 ? "negative" : ""}">${esc(value(row))}</span></li>`).join("")}</ol>`;
}

function renderDashboard(data) {
  const summary = currentSummary(data);
  const productRows = productSummary(data, summary);
  const trend = financialTrend(data, summary);
  const previousSummary = previousPeriodSummary(data, summary);
  const composition = feeComposition(data, summary);
  const rankings = rankProducts(productRows, summary);
  const dashboardIssues = uniqueVisibleIssues(data.issues.filter((issue) => (issue.status === "open" || issue.status === "review")
    && (state.selectedStoreId === "all" || issue.storeId === state.selectedStoreId)), data);
  if (!data.stores.length) {
    return `${pageHeading("新手开始", "先看示例，或导入自己的订单。", "建议先载入虚构样例，熟悉后再添加店铺和导入真实表格。", `<button class="button secondary" data-nav="import">导入表格</button><button class="button" data-action="load-demo">先看演示</button>`)}
      <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><div class="section-eyebrow">推荐</div><h2>先体验一套示例数据</h2><p>示例完全虚构，只存在你的浏览器里，不会影响自己的店铺资料。</p></div></div><button class="button" data-action="load-demo">载入虚构样例</button></article>
      <article class="card card-pad"><div class="section-title"><div><div class="section-eyebrow">开始使用</div><h2>导入自己的订单</h2><p>先添加店铺名称，再选择平台导出的订单表。保存前可以先检查内容。</p></div></div><button class="button secondary" data-nav="stores">添加我的店铺</button></article></section>`;
  }
  const margin = summary.profitMargin === null ? "—" : `${(summary.profitMargin * 100).toFixed(1)}%`;
  const unrecognizedOrderCount = data.orders.filter((order) => summary.storeIds.includes(order.storeId) && order.orderedAt >= summary.start && order.orderedAt <= summary.end && order.statusClass === "unknown" && !isPendingOrderStatus(order.orderStatus)).length;
  const pendingOrderCount = data.orders.filter((order) => summary.storeIds.includes(order.storeId) && order.orderedAt >= summary.start && order.orderedAt <= summary.end && order.statusClass !== "valid" && isPendingOrderStatus(order.orderStatus)).length;
  const knownRecords = data.orders.length + data.refunds.length + data.platformFees.length + data.productCosts.length + data.otherExpenses.length + data.settlements.length;
  const recentBatches = [...data.importBatches].sort((a, b) => b.importedAt.localeCompare(a.importedAt)).slice(0, 5);
  const pendingReason = pendingOrderCount ? ` 另有 ${pendingOrderCount} 个待付款订单还没成交，因此没有计入销售。` : "";
  const nextAction = !data.orders.length
    ? `<span>还没有订单，先导入订单表开始查看。</span><button class="button small" data-nav="import">开始导入</button>`
    : summary.missingCosts.length
      ? `<span>${summary.missingCosts.length} 个商品未填成本，利润可能偏高。${pendingReason}</span><button class="button secondary small" data-nav="costs">补上成本</button>`
      : !summary.complete
        ? `<span>目前结果按已导入的订单估算；补充费用表可让利润更完整。${pendingReason}</span><button class="button secondary small" data-nav="import">补充数据</button>`
        : `<span>数据看起来齐全，数字按当前导入记录估算。${pendingReason}</span>`;
  const overviewReady = summary.complete && data.orders.length > 0;
  const summaryCard = `<div class="overview-status ${overviewReady ? "is-ready" : "is-incomplete"}" role="status"><span class="completeness-icon" aria-hidden="true">${overviewReady ? "✓" : "i"}</span><strong>${overviewReady ? "数据已准备好" : "经营数据提示"}</strong><span class="overview-status-copy">${nextAction}</span></div>`;
  const dashboardIssueCard = `<details class="dashboard-issues" aria-labelledby="dashboard-issues-title">
    <summary class="dashboard-issues-summary"><span class="issue-summary-title" id="dashboard-issues-title">需要处理</span><span class="issue-summary-count">${dashboardIssues.length ? `${dashboardIssues.length} 项` : "目前没有待处理问题"}</span><span class="issue-summary-action">${dashboardIssues.length ? "展开查看" : "查看已处理记录"}</span></summary>
    <div class="dashboard-issue-list">${dashboardIssues.slice(0, 6).map((issue) => dashboardIssueMarkup(issue, data)).join("") || `<p class="empty-inline">目前没有需要处理的问题。</p>`}</div>
    ${dashboardIssues.length > 6 ? `<p class="dashboard-issues-more">这里显示 6 条，共 ${dashboardIssues.length} 条；点“查看全部”可继续检查。</p>` : ""}
  </details>`;
  const hasAnyData = knownRecords > 0;
  const html = `${pageHeading("", "经营情况，一眼看清。", `统计时间：${esc(summary.start)} 至 ${esc(summary.end)} · ${esc(selectedStoreName(data))}`, `<button class="button secondary" data-action="export-xlsx">下载 Excel 报告</button>${hasAnyData ? "" : `<button class="button" data-nav="import">导入表格 <span aria-hidden="true">↗</span></button>`}`)}
    <section class="metrics metrics-primary">
      ${metricCard("商品销售额", formatFen(summary.grossSalesFen), "已导入订单中的商品金额", "↗", "blue")}
      ${metricCard("预计利润", formatFen(summary.knownProfitFen), summary.complete ? "按已导入的订单、成本和费用估算" : "还缺一些成本或费用，结果可能偏高", "◒", "profit")}
      ${metricCard("预计利润率", margin, "预计利润占销售额的比例", "%", "")}
      ${metricCard("计入统计的订单", summary.orderCount.toLocaleString("zh-CN"), `${summary.cancelledCount} 单已取消；${unrecognizedOrderCount} 个订单状态无法识别${pendingOrderCount ? `；${pendingOrderCount} 个待付款不计入` : ""}`, "▤", "blue")}
    </section>
    ${summaryCard}
    ${dashboardIssueCard}
    <section class="dashboard-grid">
      <article class="card chart-card"><div class="section-title"><div><div class="section-eyebrow">每日趋势</div><h2>销售额与预计利润</h2><p>销售按下单日统计；退款、扣费和支出按各自日期计入。</p></div><span class="tag tag-blue">${trend.length} 天</span></div>
        <div class="chart-legend"><span><i class="legend-sales"></i>销售额</span><span><i class="legend-profit"></i>预计利润</span></div>
        <div class="period-comparison"><span>较上一周期（${esc(previousSummary.start)} 至 ${esc(previousSummary.end)}）</span>${periodDelta(summary.grossSalesFen, previousSummary.grossSalesFen, "销售额")}${periodDelta(summary.knownProfitFen, previousSummary.knownProfitFen, "利润")}</div>${trendSvg(trend)}</article>
      <article class="card chart-card composition-card"><div class="section-title"><div><div class="section-eyebrow">利润构成</div><h2>销售额如何变成利润</h2><p>按当前导入项目归类；未识别的费用放在“其他费用”。</p></div></div>
        <div class="profit-flow">${composition.map(([label, amount, kind], index) => `<div class="profit-flow-step ${kind}"><span>${esc(label)}</span><strong>${esc(profitFlowValue(amount, kind))}</strong></div>${index < composition.length - 1 ? `<span class="profit-flow-arrow" aria-hidden="true">→</span>` : ""}`).join("")}</div>
      </article>
    </section>
    <section class="card card-pad product-rankings"><div class="section-title"><div><div class="section-eyebrow">商品排行</div><h2>哪些商品贡献利润，哪些需要留意</h2><p>利润估算会按销售额分摊未关联商品的退款和费用；缺成本时会偏高。</p></div><button class="button ghost small" data-nav="costs">查看商品成本 →</button></div>
      <div class="product-rank-grid"><article><h3>利润最高 · 前 5</h3>${rankedProductList(rankings.highest, (row) => formatFen(row.profitFen))}</article><article><h3>亏损商品 · 前 5</h3>${rankedProductList(rankings.loss, (row) => formatFen(row.profitFen))}</article><article><h3>低毛利 · 前 5</h3>${rankedProductList(rankings.lowMargin, (row) => row.margin === null ? "—" : `${(row.margin * 100).toFixed(1)}%`)}</article></div>
    </section>
    ${summary.missingCosts.length ? `<button class="missing-cost-reminder" data-nav="costs"><span>${summary.missingCosts.length} 个商品未填成本，利润可能偏高</span><span>去补充商品成本 →</span></button>` : ""}
    <section class="card card-pad recent-imports"><div class="section-title"><div><div class="section-eyebrow">最近导入</div><h2>刚才导入的表格</h2><p>已导入 ${data.importBatches.length} 次 · 保存了 ${knownRecords.toLocaleString("zh-CN")} 条记录</p></div><button class="button ghost small" data-nav="import">继续导入 →</button></div>
      ${recentBatches.length ? `<div class="table-wrap"><table><thead><tr><th>表格类型</th><th>文件名</th><th>新增条数</th><th>导入时间</th></tr></thead><tbody>${recentBatches.map((batch) => `<tr><td>${esc(REPORTS[batch.reportType]?.label || batch.reportType)}</td><td>${esc(batch.originalFilename)}</td><td>${batch.acceptedCount}</td><td>${esc(new Date(batch.importedAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline">还没有导入表格。</div>`}</section>`;
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
  const content = data.stores.length ? `<div class="grid grid-2">${data.stores.map((store) => `<article class="card card-pad store-card"><div class="store-card-top"><span class="store-platform">${esc(store.platform)}</span><span class="tag ${store.demo ? "tag-warn" : "tag-ok"}">${store.demo ? "演示数据" : "我的店铺"}</span></div><h2>${esc(store.name)}</h2><p>创建于 ${esc(String(store.createdAt || "").slice(0, 10))}</p><button class="button secondary small" data-action="select-store" data-store-id="${esc(store.id)}">查看数据</button></article>`).join("")}</div>` : emptyState("还没有添加店铺", "添加后，导入的订单和费用就会归到这个店铺。这里只记录名称，不会连接你的平台账号。", "");
  return `${pageHeading("我的店铺", "先添加店铺，再导入表格。", "店铺名称只用来分开整理数据，不需要登录或绑定平台账号。")}
    <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><h2>添加一个店铺</h2><p>例如你在淘宝、拼多多或抖音经营的店铺。</p></div></div>
      <form data-form="add-store" class="form-grid"><div class="field"><label for="store-platform">在哪个平台卖</label><select id="store-platform" name="platform" required>${platforms.map((p) => `<option>${esc(p)}</option>`).join("")}</select></div><div class="field"><label for="store-name">店铺叫什么</label><input id="store-name" name="name" maxlength="80" placeholder="例如：晴日数码小店" required></div><div class="field"><label for="store-currency">金额单位</label><select id="store-currency" name="currency"><option value="CNY">人民币（元）</option></select></div><div class="field full"><button class="button" type="submit">保存店铺</button></div></form>
      <p class="form-note">数据只保存在当前浏览器。换浏览器或换设备后，需要重新导入或恢复备份。</p></article><article class="card card-pad"><div class="section-title"><div><h2>我的店铺</h2><p>已添加 ${data.stores.length} 个店铺</p></div></div>${content}</article></section>`;
}

function renderImport(data) {
  const stores = data.stores;
  if (!stores.length) return `${pageHeading("导入表格", "先添加一个店铺。", "这样我们才能把你的订单归到正确的店铺。也可以先用虚构样例体验。", `<button class="button secondary" data-nav="stores">添加店铺</button><button class="button" data-action="load-demo">先看演示</button>`)}${emptyState("还没有店铺", "添加店铺后，选择平台导出的订单表就可以开始。")}`;
  const importStoreId = state.importStoreId && stores.some((row) => row.id === state.importStoreId) ? state.importStoreId : state.selectedStoreId !== "all" ? state.selectedStoreId : stores[0].id;
  state.importStoreId = importStoreId;
  const pending = state.pendingFile;
  const reportType = pending?.reportType || "orders";
  const mapping = state.importMapping || (pending ? suggestMapping(reportType, pending.headers) : {});
  const options = Object.entries(REPORTS).map(([key, report]) => `<option value="${key}" ${reportType === key ? "selected" : ""}>${esc(report.label)}</option>`).join("");
  const reportFields = REPORTS[reportType].fields;
  const alternativeKeys = reportType === "orders" ? new Set(["itemAmount", "unitPrice"]) : new Set();
  const fieldRow = (field) => {
    const marker = field.required ? "required" : alternativeKeys.has(field.key) ? "alternative" : "";
    return `<div class="map-row"><label class="${marker}" for="map-${esc(field.key)}">${esc(field.label)}</label><select id="map-${esc(field.key)}" data-map-field="${esc(field.key)}"><option value="">不选择这一列</option>${pending.headers.map((header) => `<option value="${esc(header)}" ${mapping[field.key] === header ? "selected" : ""}>${esc(header)}</option>`).join("")}</select></div>`;
  };
  const keyFields = reportFields.filter((field) => field.required || alternativeKeys.has(field.key));
  const optionalFields = reportFields.filter((field) => !field.required && !alternativeKeys.has(field.key));
  const fields = pending ? `${keyFields.map(fieldRow).join("")}${optionalFields.length ? `<details class="optional-mapping"><summary>其他信息（可以不填）</summary><div class="mapping-grid">${optionalFields.map(fieldRow).join("")}</div></details>` : ""}` : "";
  let planBox = "";
  if (state.importPlan) {
    const p = state.importPlan;
    const duplicateFile = p.duplicateFile;
    planBox = `<div class="summary-strip">
      <div class="summary-chip"><span>可以保存</span><strong>${p.accepted.length} 条</strong></div>
      <div class="summary-chip warn"><span>有问题</span><strong>${p.rejected.length} 条</strong></div>
      <div class="summary-chip"><span>重复跳过</span><strong>${p.duplicates.length} 条</strong></div>
      <div class="summary-chip warn"><span>内容不一致</span><strong>${p.conflicts.length} 条</strong></div>
    </div>${duplicateFile ? `<div class="preflight-error">这份表格已在 ${esc(p.batchAlreadyImported.importedAt)} 导入过了，为避免重复计算，本次不能再次导入。</div>` : p.accepted.length ? `<div class="preflight-good">表格检查完成。确认后会保存到当前浏览器；上传的原文件不会保留。</div>` : `<div class="preflight-error">没有可以保存的新记录。请按下面的提示检查表格内容。</div>`}
    ${p.rejected.slice(0, 5).map((row) => `<div class="preflight-error">第 ${row.rowNumber} 行：${esc(row.message)}</div>`).join("")}
    ${p.conflicts.slice(0, 5).map((row) => `<div class="preflight-error">第 ${row.rowNumber} 行：这个订单号已有不同内容，旧记录没有被改动。</div>`).join("")}
    <div class="button-row" style="margin-top:14px"><button class="button" data-action="commit-import" ${duplicateFile || !p.accepted.length ? "disabled" : ""}>保存这 ${p.accepted.length} 条记录</button><button class="button secondary" data-action="clear-import">取消</button></div>`;
  }
  const preview = pending ? `<div class="file-meta"><strong>${esc(pending.fileName)}</strong><span>${esc(bytesLabel(pending.size))} · ${esc(pending.sheetName)} · ${pending.rows.length} 行</span></div><div class="section-title"><div><h3><span class="step-number">2</span>检查表格内容</h3><p>左边是我们要读取的信息，右边选择你表格中对应的列。系统会先帮你选择，请检查是否正确；“其他信息”可以不填。</p></div></div><div class="mapping-grid">${fields}</div>
    ${reportType === "orders" ? `<div class="warning-note" style="margin-top:12px">取消的订单不会算作销售。系统看不懂的订单状态会列出来让你检查，不会自行猜金额。</div>` : ""}
    <div class="button-row" style="margin-top:15px"><button class="button blue" data-action="validate-import">检查这份表格</button></div>
    ${planBox || ""}<div class="mapping-preview"><table><thead><tr>${pending.headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${pending.rows.slice(0, 8).map((row) => `<tr>${pending.headers.map((_, i) => `<td>${esc(row[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
  return `${pageHeading("导入表格", "把平台导出的表格放进来。", "按步骤选择表格、检查内容，确认后保存。你的文件只在当前浏览器里处理。")}
    <section class="card card-pad"><div class="section-title"><div><h2><span class="step-number">1</span>选择店铺和表格</h2><p>支持 Excel 或 CSV 文件，单个文件最大 20 MB、最多 50,000 行。</p></div><span class="tag tag-ok">只在本机处理</span></div>
      <div class="form-grid"><div class="field"><label for="import-store">保存到哪个店铺</label><select id="import-store" data-import-store>${stores.map((store) => `<option value="${esc(store.id)}" ${store.id === importStoreId ? "selected" : ""}>${esc(store.name)} · ${esc(store.platform)}</option>`).join("")}</select></div><div class="field"><label for="import-kind">这是什么表格</label><select id="import-kind" data-import-kind>${options}</select></div><div class="field full"><label class="dropzone" for="import-file"><span class="drop-icon">⇧</span><strong>${pending ? "换一份表格" : "选择平台导出的表格"}</strong><span>选择 CSV 或 Excel 文件。文件不会上传；只有你确认后，识别出的记录才会保存在当前浏览器。</span></label><input id="import-file" type="file" accept=".csv,.tsv,.txt,.xls,.xlsx,.xlsm" hidden></div></div>
      ${preview}</section>
    <details class="card card-pad disclosure" style="margin-top:16px"><summary>重复导入和文件说明</summary><ul class="rule-list"><li>同一份表格不会重复计算。</li><li>相同订单号或流水号只保存一次；内容不一致时会提示你检查，旧记录不会被覆盖。</li><li>支持 .csv、.tsv、.xls、.xlsx、.xlsm 文件；每个文件最大 20 MB。</li><li>原始文件不会保存在网站或上传到服务器，只有确认后的记录会留在当前浏览器。</li></ul></details>`;
}

function renderRecords(data) {
  const type = state.recordType;
  const categories = {
    orders: ["orders", "订单"], orderItems: ["orderItems", "商品明细"], refunds: ["refunds", "退款"],
    platformFees: ["platformFees", "平台扣费"], otherExpenses: ["otherExpenses", "其他支出"], settlements: ["settlements", "到账记录"],
  };
  const [storeNameKey, title] = categories[type] || categories.orders;
  const rows = data[storeNameKey].filter((row) => state.selectedStoreId === "all" || row.storeId === state.selectedStoreId).slice(-200).reverse();
  const columns = {
    orders: [["platformOrderId", "订单号"], ["orderedAt", "下单日期"], ["orderStatus", "平台订单状态"], ["statusClass", "系统判断"]],
    orderItems: [["platformOrderId", "订单号"], ["skuId", "商品编号"], ["productName", "商品名称"], ["quantityMilli", "数量", "quantity"], ["amountFen", "实付金额", "money"], ["orderedAt", "下单日期"]],
    refunds: [["platformRefundId", "退款单号"], ["platformOrderId", "订单号"], ["refundStatus", "状态"], ["amountFen", "退款金额", "money"], ["completedAt", "退款日期"], ["confirmed", "已确认"]],
    platformFees: [["feeId", "费用编号"], ["platformOrderId", "订单号"], ["feeType", "费用类型"], ["amountFen", "费用金额", "money"], ["feeDate", "费用日期"]],
    otherExpenses: [["expenseId", "费用编号"], ["expenseType", "费用类型"], ["amountFen", "金额", "money"], ["expenseDate", "费用日期"], ["allocationMethod", "费用怎么分配"]],
    settlements: [["transactionId", "到账流水"], ["platformOrderId", "订单号"], ["settlementStatus", "到账状态"], ["amountFen", "实际到账", "money"], ["settlementDate", "到账日期"]],
  }[type];
  return `${pageHeading("我的数据", "导入过的内容都在这里。", "每类最多显示最近 200 条。需要全部数据时，可以下载 Excel 报告。", `<button class="button secondary" data-action="export-xlsx">下载 Excel 报告</button>`)}
    <section class="card card-pad"><div class="section-title"><div><h2>${title}</h2><p>共 ${data[storeNameKey].length.toLocaleString("zh-CN")} 条记录${data[storeNameKey].length > rows.length ? ` · 当前展示最近 ${rows.length} 条` : ""}</p></div><select data-record-type aria-label="切换经营记录类型">${Object.entries(categories).map(([key, value]) => `<option value="${key}" ${key === type ? "selected" : ""}>${value[1]}</option>`).join("")}</select></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>店铺</th>${columns.map(([, label]) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(storeName(data, row.storeId))}</td>${columns.map(([key, , kind]) => `<td>${esc(kind === "money" ? formatFen(row[key]) : kind === "quantity" ? `${formatQuantity(row[key])} 件` : typeof row[key] === "boolean" ? (row[key] ? "是" : "否") : key === "statusClass" ? ({ valid: "计入销售", cancelled: "已取消", ignored: "已忽略，不计入销售", unknown: isPendingOrderStatus(row.orderStatus) ? "待付款，不计入销售" : "状态无法识别" }[row[key]] || row[key]) : row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline">这里还没有记录。</div>`}</section>`;
}

function renderCosts(data) {
  const rows = data.productCosts.filter((row) => state.selectedStoreId === "all" || row.storeId === state.selectedStoreId).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const skuNames = new Map(data.orderItems.map((row) => [row.skuId, row.productName]));
  return `${pageHeading("商品成本", "补上进货价，利润会更接近实际。", "商品成本会按订单日期自动计算。商品编号要和订单表里的编号一致。", `<button class="button secondary" data-nav="import">导入成本表</button>`)}
    <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><h2>手动添加一个商品成本</h2><p>同一商品可以按日期更新进货价，之前的价格会保留。</p></div></div>
      ${data.stores.length ? `<form data-form="add-cost" class="form-grid"><div class="field"><label for="cost-store">属于哪个店铺</label><select id="cost-store" name="storeId" required>${data.stores.map((store) => `<option value="${esc(store.id)}" ${store.id === (state.selectedStoreId === "all" ? data.stores[0].id : state.selectedStoreId) ? "selected" : ""}>${esc(store.name)}</option>`).join("")}</select></div><div class="field"><label for="cost-sku">商品编号</label><input id="cost-sku" name="skuId" maxlength="100" placeholder="照着订单表里的商品编号填写" required></div><div class="field"><label for="cost-product">商品名称</label><input id="cost-product" name="productName" maxlength="150" placeholder="${esc(skuNames.values().next().value || "可以不填")}"></div><div class="field"><label for="cost-value">每件进货价（元）</label><input id="cost-value" name="unitCost" inputmode="decimal" placeholder="例如 12.50" required></div><div class="field"><label for="cost-from">从哪天开始使用这个价格</label><input id="cost-from" name="effectiveFrom" type="date" value="${localToday()}" required></div><div class="field"><label for="cost-to">哪天停止使用（可以不填）</label><input id="cost-to" name="effectiveTo" type="date"></div><div class="field full"><button class="button" type="submit">保存这个进货价</button></div></form>` : `<div class="empty-inline">请先添加一个店铺。</div>`}</article>
      <article class="card card-pad"><div class="section-title"><div><h2>成本怎么算进利润</h2><p>不用手动算，系统会按订单里的商品数量计算。</p></div></div><div class="formula"><strong>商品成本</strong> = 每件进货价 × 售出数量</div><p class="help-text" style="margin-top:12px">如果商品编号和订单表里的不一样，系统就认不出对应商品。缺少进货价时，利润可能偏高，会在总览里提醒。</p></article></section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>已添加的商品进货价</h2><p>共 ${rows.length} 条</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>店铺</th><th>商品编号</th><th>商品</th><th>每件进货价</th><th>开始日期</th><th>截止日期</th><th>来源</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(storeName(data, row.storeId))}</td><td>${esc(row.skuId)}</td><td>${esc(row.productName || "—")}</td><td>${formatFen(row.unitCostFen)}</td><td>${esc(row.effectiveFrom)}</td><td>${esc(row.effectiveTo || "仍在使用")}</td><td>${esc(row.costSource || "文件导入")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline">还没有商品进货价。可以手动添加，或导入成本表。</div>`}</section>`;
}

function renderIssues(data) {
  const issues = uniqueVisibleIssues([...data.issues].filter((row) => state.selectedStoreId === "all" || row.storeId === state.selectedStoreId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), data);
  const open = issues.filter((row) => row.status === "open" || row.status === "review").length;
  const mismatches = findFeeSettlementMismatches(data);
  const mismatchNote = mismatches.length ? `<div class="warning-note" style="margin-bottom:14px"><strong>有 ${mismatches.length} 笔订单的到账金额对不上。</strong>请打开平台账单，查看订单金额、退款和平台扣费是否一致。平台可能还会调整运费或补贴。</div>` : "";
  const cards = issues.length ? issues.map((issue) => {
    const order = orderForIssue(issue, data);
    const description = order
      ? `订单 ${order.platformOrderId} 的状态“${order.orderStatus}”无法识别，默认不计入销售。确认已成交后可按成交计入；如果是待付款，请保留不计入。`
      : issue.description;
    return `<article class="issue-card" id="issue-${esc(issue.id)}" tabindex="-1"><div class="issue-card-head"><span class="tag ${issue.severity === "error" ? "tag-danger" : issue.severity === "info" ? "tag-blue" : "tag-warn"}">${esc(SEVERITY_LABELS[issue.severity] || "请检查")}</span><strong>${esc(ISSUE_LABELS[issue.issueType] || "需要检查")}</strong><span class="tag ${issue.status === "resolved" ? "tag-ok" : "tag-neutral"}">${esc(ISSUE_STATUS_LABELS[issue.status] || "待处理")}</span></div><p>${esc(description)}</p>${orderIssueActions(issue, order)}<div class="issue-card-foot"><span>${esc(storeName(data, issue.storeId))} · ${esc(String(issue.createdAt || "").slice(0, 16).replace("T", " "))}</span>${issue.status !== "resolved" && !order ? `<button class="button secondary small" data-action="resolve-issue" data-issue-id="${esc(issue.id)}">标记已处理</button>` : issue.status === "resolved" ? `<span class="help-text">${esc(issue.resolutionNote || "已标记处理")}</span>` : ""}</div></article>`;
  }).join("") : `<div class="empty-inline">目前没有需要检查的问题。</div>`;
  return `${pageHeading("需要处理", "这里列出需要你检查的内容。", `共有 ${open} 条还没处理。点开每条可以看原因；处理后点击“标记已处理”。`, `<button class="button secondary" data-action="export-xlsx">下载问题清单</button>`)}${mismatchNote}<section class="card card-pad"><div class="section-title"><div><h2>问题清单</h2><p>共 ${issues.length} 条，包含表格内容、订单状态、重复记录和缺少进货价等问题。</p></div><span class="tag ${open ? "tag-warn" : "tag-ok"}">${open} 条待处理</span></div><div class="issue-list">${cards}</div></section>`;
}

function renderSettings(data) {
  const counts = `店铺 ${data.stores.length} 个 · 订单 ${data.orders.length} 笔 · 商品成本 ${data.productCosts.length} 条 · 退款 ${data.refunds.length} 笔`;
  return `${pageHeading("备份数据", "保存一份副本，换设备也能带走。", "数据只保存在当前设备和当前浏览器。清除浏览器记录后，数据可能无法找回。")}
    <section class="grid grid-2"><article class="card card-pad"><div class="section-title"><div><h2>当前浏览器空间</h2><p id="storage-summary">正在查看可用空间…</p></div><span class="tag tag-ok">当前设备</span></div><div class="storage-meter"><span id="storage-meter-fill"></span></div><div class="storage-meta"><span id="storage-used">已使用 —</span><span id="storage-quota">可用 —</span></div><p class="help-text" id="storage-persistent-note" style="margin-top:12px">浏览器清理网站数据可能会删除订单。建议定期下载备份。</p><button class="button secondary small" data-action="request-persistence" style="margin-top:10px">尽量保留此网站的数据</button></article>
    <article class="card card-pad"><div class="section-title"><div><h2>下载备份文件</h2><p>包含店铺、订单、成本、退款和问题记录。</p></div><span class="tag tag-blue">${data.stores.length} 个店铺</span></div><p class="help-text">备份文件可能包含订单和费用详情，请保存到安全的位置，不要公开分享。</p><button class="button" data-action="download-backup">下载备份文件</button></article></section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>从备份恢复</h2><p>可以把以前保存的记录放回这个浏览器。恢复会替换当前数据。</p></div></div><div class="inline-form"><div class="field"><label for="restore-file">选择以前下载的备份文件</label><input id="restore-file" type="file" accept=".json,application/json"></div></div><p class="form-note">选择后会先显示文件里的记录数量；确认两次后才会替换当前数据。</p></section>
    <section class="card card-pad danger-zone" style="margin-top:16px"><div class="section-title"><div><h2>清空这个浏览器里的数据</h2><p>会删除店铺、订单、成本、退款和问题记录，且不能撤销。</p></div><span class="tag tag-danger">不能撤销</span></div><button class="button danger" data-action="clear-data">清空全部数据</button></section>
    <section class="card card-pad" style="margin-top:16px"><div class="section-title"><div><h2>目前保存的数据</h2><p>${esc(counts)}</p></div></div><p class="help-text">更换浏览器、设备或网址后不会自动同步。请用备份文件搬运数据。</p></section>`;
}

function renderGuide() {
  return `${pageHeading("新手教程", "跟着页面点几步，最后看见完整结果。", "分步体验会载入单独的虚构样例，并带你查看总览、提醒、成本和导入页面。", `<button class="button secondary" data-action="tutorial-open">重新开始引导</button><button class="button" data-action="load-demo">载入虚构样例</button>`)}
    <section class="guide-grid">
      <article class="card guide-step"><span class="guide-step-num">第 1 步</span><span class="guide-icon">▣</span><h3>添加店铺名称</h3><p>点左侧“店铺管理”，选择你在哪个平台卖，并填写店铺名称。这里只做分类，不会登录或连接平台账号。</p></article>
      <article class="card guide-step"><span class="guide-step-num">第 2 步</span><span class="guide-icon">⇧</span><h3>导入平台导出的订单表</h3><p>点“导入表格”，选择店铺、订单表和文件。系统会先帮你认列名；检查预览没有问题后，再点“保存记录”。</p></article>
      <article class="card guide-step"><span class="guide-step-num">第 3 步</span><span class="guide-icon">◇</span><h3>补上商品进货价</h3><p>点“商品成本”，填写订单表里相同的商品编号和每件进货价。成本越齐，预计利润越接近实际。</p></article>
      <article class="card guide-step"><span class="guide-step-num">完成</span><span class="guide-icon">↗</span><h3>查看利润并下载报告</h3><p>回到“经营总览”查看销售额、退款和预计利润。黄色提醒会告诉你还有什么需要补充或检查。</p></article>
    </section>
    <section class="card card-pad guide-demo"><div><div class="section-eyebrow">第一次使用</div><h2>先看一套完整示例</h2><p>示例全部是虚构数据，只保存在你的浏览器里，不会影响真实店铺资料。</p></div><button class="button" data-action="load-demo">载入虚构样例</button></section>
    <section class="grid grid-2" style="margin-top:16px"><details class="card card-pad disclosure"><summary>为什么利润显示“预计”？</summary><p>系统只按你导入的订单、退款、进货价和费用计算。如果少了成本或费用，预计利润可能偏高；平台实际到账也可能因运费、补贴或调整而不同。</p></details>
      <details class="card card-pad disclosure"><summary>我的订单会保存在哪里？</summary><p>订单只保存在当前设备的当前浏览器中，不会上传到网站。换设备、换浏览器或换网址不会自动同步；需要搬家时，请先下载备份文件。</p></details>
      <details class="card card-pad disclosure"><summary>怎么把数据带到另一台电脑？</summary><p>先在“备份数据”下载备份文件，再在另一台电脑打开网站，选择“从备份恢复”。恢复会替换那台电脑当前保存的数据。</p></details>
      <details class="card card-pad disclosure"><summary>导入错了怎么办？</summary><p>先到“数据明细”查看结果。如果不确定，请不要清空数据，先下载备份，再联系维护人员协助处理。</p></details></section>
    <details class="card card-pad disclosure" style="margin-top:16px"><summary>开源组件和许可</summary><p>读取和导出 Excel 使用 SheetJS Community Edition。<a class="license-link" href="./THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener">查看开源许可</a>。</p></details>`;
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

function applyQuickPeriod(preset) {
  const today = localToday();
  if (preset === "7") { state.end = today; state.start = dateOffset(today, -6); }
  else if (preset === "30") { state.end = today; state.start = dateOffset(today, -29); }
  else if (preset === "month") { state.start = `${today.slice(0, 7)}-01`; state.end = today; }
  else if (preset === "previous-month") {
    const first = new Date(`${today.slice(0, 7)}-01T12:00:00`);
    first.setDate(0);
    state.end = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
    state.start = `${state.end.slice(0, 7)}-01`;
  } else return;
  savePrefs();
  renderPage();
}

function normalizeIdbError(error) {
  if (error?.name === "ConstraintError") return new Error("订单号重复，或同一商品同一天的进货价已经保存过了。没有新增记录。", { cause: error });
  if (error?.name === "DataCloneError") return new Error("有一项内容不能保存，请检查后重试。原有数据没有更改。", { cause: error });
  return error;
}

async function addStore(form) {
  const values = new FormData(form);
  const name = String(values.get("name") || "").trim();
  const platform = String(values.get("platform") || "").trim();
  if (!name || !platform) throw new Error("请填写店铺名称并选择销售平台。");
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
  if (!state.data.stores.some((store) => store.id === storeId)) throw new Error("请选择一个店铺。");
  if (!skuId || !effectiveFrom || unitCostFen === null || unitCostFen < 0) throw new Error("商品编号、开始日期和正确的进货价都需要填写。");
  if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("截止日期不能早于开始日期。");
  const record = { id: uid(), storeId, skuId, productName, unitCostFen, effectiveFrom, effectiveTo,
    costSource: "手动维护", updatedAt: new Date().toISOString() };
  record.recordKey = stableRecordKey("costs", record);
  record.rowHash = JSON.stringify({ storeId, skuId, productName, unitCostFen, effectiveFrom, effectiveTo });
  await writeRecords(state.db, { productCosts: [record] }, "add");
  await refreshData();
  renderPage();
  toast("商品进货价已保存。", "ok");
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
    toast(`读到了 ${parsed.rows.length} 行。检查无误后再保存。`, "ok");
  } catch (error) { presentError(error, "解析文件失败"); }
}

function validateMapping(reportType, mapping) {
  const missing = REPORTS[reportType].fields.filter((field) => field.required && !mapping[field.key]).map((field) => field.label);
  if (reportType === "orders" && !mapping.itemAmount && !mapping.unitPrice) missing.push("商品实付金额或商品单价（二选一）");
  if (missing.length) throw new Error(`请先在下拉菜单里选出这些表格列：${missing.join("、")}`);
}

async function validateImport() {
  const pending = state.pendingFile;
  if (!pending) throw new Error("请先选择一份表格。");
  const reportType = $("#import-kind")?.value || pending.reportType;
  const storeId = $("#import-store")?.value || pending.storeId;
  const mapping = Object.fromEntries(REPORTS[reportType].fields.map((field) => [field.key, $(`[data-map-field="${field.key}"]`)?.value || ""]));
  validateMapping(reportType, mapping);
  state.pendingFile = { ...pending, reportType, storeId };
  state.importMapping = mapping;
  state.importPlan = await prepareImport(state.db, { name: pending.fileName, size: pending.size }, reportType, storeId, pending.headers, pending.rows, mapping, pending.fileHash);
  renderPage();
  toast("表格检查完成，请看看下面的结果。", "ok");
}

async function importValidatedRows() {
  const plan = state.importPlan;
  if (!plan || plan.duplicateFile || !plan.accepted.length) throw new Error("没有可以保存的新记录。");
  const invalidCount = plan.rejected.length + plan.conflicts.length;
  const message = `将保存 ${plan.accepted.length} 条新记录，跳过 ${plan.duplicates.length} 条重复记录，另有 ${invalidCount} 行需要检查。\n\n表格文件不会上传或保存。要继续吗？`;
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
    toast(`导入完成：保存 ${result.importedCount} 条，跳过重复记录 ${result.duplicateCount} 条，有 ${result.rejectedCount} 行需要检查。`, "ok", 6500);
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
  state.lastBackupAt = new Date().toISOString();
  savePrefs();
  updateSidebarBackupStatus();
  toast(`备份文件已生成：${snapshot.stores.length} 个店铺、${snapshot.orders.length} 个订单。请妥善保管下载文件。`, "ok", 6000);
}

async function resolveOrderStatus(orderId, issueId, resolution) {
  const order = state.data.orders.find((row) => row.id === orderId);
  const issue = state.data.issues.find((row) => row.id === issueId);
  if (!order || !issue) throw new Error("找不到这笔订单或提醒，请刷新页面后重试。");
  let statusClass = "unknown";
  let orderStatus = order.orderStatus;
  if (resolution === "include") statusClass = "valid";
  else if (resolution === "ignore") statusClass = "ignored";
  else {
    orderStatus = String(window.prompt("手动输入订单状态（例如：已完成、已取消、待付款、忽略）：", order.orderStatus) || "").trim();
    if (!orderStatus) return;
    const clean = cleanStatus(orderStatus);
    if (isPendingOrderStatus(orderStatus) || ["忽略", "不计入", "已忽略"].includes(clean)) statusClass = "ignored";
    else if (classifyOrderStatus(orderStatus) !== "unknown") statusClass = classifyOrderStatus(orderStatus);
    else if (/(成交|支付成功|付款成功|已付款|已支付)/.test(orderStatus)) statusClass = "valid";
    else if (/(取消|关闭)/.test(orderStatus)) statusClass = "cancelled";
    else { toast("这个状态仍无法判断。请填写已成交、已取消、待付款或忽略。", "warn", 5500); return; }
  }
  const updatedOrder = { ...order, orderStatus, statusClass, updatedAt: new Date().toISOString() };
  const resolvedAt = new Date().toISOString();
  const resolutionNote = resolution === "include" ? "已按已成交计入销售。" : resolution === "ignore" ? "已忽略，未计入销售。" : `已手动指定为“${orderStatus}”。`;
  const linkedIssues = state.data.issues.filter((row) => row.issueType === "unknown_order_status" && orderForIssue(row, state.data)?.id === order.id);
  const updatedIssues = (linkedIssues.length ? linkedIssues : [issue]).map((row) => ({ ...row, status: "resolved", resolutionNote, resolvedAt }));
  await writeRecords(state.db, { orders: [updatedOrder], issues: updatedIssues }, "put");
  await refreshData();
  renderPage();
  toast(statusClass === "valid" ? "订单已计入销售，利润已更新。" : "订单已按指定状态处理，未计入销售。", "ok", 5000);
}

async function handleRestoreFile(file) {
  if (!file) return;
  try {
    if (file.size > 120 * 1024 * 1024) throw new Error("备份文件大于 120 MB，无法安全读取。");
    const parsed = validateBackup(JSON.parse(await file.text()));
    const labels = { stores: "店铺", orders: "订单", orderItems: "商品明细", refunds: "退款", platformFees: "平台扣费", productCosts: "商品成本", otherExpenses: "其他支出", settlements: "到账记录", importBatches: "导入记录", issues: "待处理问题" };
    const counts = Object.entries(parsed.stores).filter(([, rows]) => rows.length).map(([name, rows]) => `${labels[name] || name} ${rows.length} 条`).join("，") || "没有数据";
    if (!window.confirm(`备份文件可以使用。恢复后会替换当前浏览器里的数据。\n\n文件里有：${counts}\n\n建议先下载当前数据备份。要继续吗？`)) return;
    const confirmation = window.prompt("最后确认：输入“替换”以覆盖当前浏览器里的全部数据。", "");
    if (confirmation !== "替换") { toast("未输入“替换”，恢复已取消；当前数据未变更。", "warn"); return; }
    const result = await restoreBackup(state.db, parsed);
    await refreshData();
    renderPage();
    toast(`恢复完成：${result.stores} 个店铺、${result.orders} 笔订单、${result.orderItems} 条商品明细。`, "ok", 6500);
  } catch (error) { presentError(error, "备份恢复失败；原有数据未被标记为已替换"); }
}

async function clearBrowserData() {
  if (!window.confirm("确定清空这个浏览器里的店铺、订单、退款、费用和进货价吗？这一步不能撤销。")) return;
  const confirmation = window.prompt("请再次输入“清空”以确认删除全部本地数据。", "");
  if (confirmation !== "清空") { toast("未输入“清空”，数据未删除。", "warn"); return; }
  try {
    await clearAllData(state.db);
    try { localStorage.removeItem(PREFS_KEY); } catch { /* settings are optional */ }
    state.lastBackupAt = "";
    state.selectedStoreId = "all";
    state.start = "";
    state.end = "";
    state.page = "overview";
    await refreshData();
    renderPage();
    toast("全部本地数据已清空。", "ok", 6000);
  } catch (error) { presentError(error, "没有清空成功；原有数据仍在"); }
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
    summary.textContent = persisted ? "浏览器会尽量保留此网站的数据。" : "数据保存在此浏览器中，清理浏览记录时可能被删除。";
    $("#storage-used").textContent = `已使用 ${bytesLabel(used)}`;
    $("#storage-quota").textContent = quota ? `估计还能使用 ${bytesLabel(quota)}` : "浏览器没有提供空间信息";
    $("#storage-meter-fill").style.width = `${ratio.toFixed(1)}%`;
    $("#storage-persistent-note").textContent = persisted ? "浏览器会尽量保留数据，但清理网站记录或设备故障仍可能造成丢失。请定期下载备份。" : "可以请浏览器尽量保留数据，但浏览器仍可能清理。建议定期下载备份。";
  } catch (error) {
    summary.textContent = "浏览器没有提供空间信息；保存时如果失败会显示提示。";
    console.warn("无法读取存储额度", error);
  }
}

async function requestStoragePersistence() {
  if (!navigator.storage?.persist) throw new Error("这个浏览器不支持保留数据的设置。建议定期下载备份。");
  const persisted = await navigator.storage.persist();
  await updateStorageDetails();
  toast(persisted ? "浏览器会尽量保留此网站的数据。" : "浏览器没有开启保留设置；数据仍在本机，但请定期下载备份。", persisted ? "ok" : "warn", 6000);
}

async function exportXlsx() {
  const summary = currentSummary();
  try {
    downloadWorkbook(state.data, summary, selectedStoreName());
    toast("Excel 报告已生成并下载。", "ok", 5500);
  } catch (error) { presentError(error, "生成 Excel 失败"); }
}

async function resolveIssue(issueId) {
  const issue = state.data.issues.find((row) => row.id === issueId);
  if (!issue) throw new Error("找不到这条待处理问题。");
  const note = window.prompt("可填写处理备注（可留空）：", issue.resolutionNote || "");
  if (note === null) return;
  await putOne(state.db, "issues", { ...issue, status: "resolved", resolutionNote: note.trim(), resolvedAt: new Date().toISOString() });
  await refreshData();
  renderPage();
  toast("已标记为处理完成。", "ok");
}

async function handleClick(event) {
  const periodButton = event.target.closest("[data-period]");
  if (periodButton) { applyQuickPeriod(periodButton.dataset.period); return; }
  const nav = event.target.closest("[data-nav]");
  if (nav) {
    event.preventDefault();
    if (state.guidedTourActive) {
      const step = GUIDED_TOUR_STEPS[state.guidedTourStep];
      if (nav.dataset.nav !== step.page) { toast(`请先点击高亮的“${step.name}”继续。`, "warn", 2500); return; }
      setPage(step.page);
      if (state.guidedTourStep === GUIDED_TOUR_STEPS.length - 1) finishGuidedTour();
      else { state.guidedTourStep += 1; renderGuidedTour(); }
      return;
    }
    if (nav.closest("#welcome-tutorial")) closeTutorial();
    setPage(nav.dataset.nav);
    return;
  }
  if (state.guidedTourActive && !event.target.closest("#guided-tour-card")) {
    event.preventDefault();
    toast("请按提示点击高亮菜单，或退出引导。", "warn", 2500);
    return;
  }
  const control = event.target.closest("[data-action]");
  if (!control || control.disabled) return;
  try {
    switch (control.dataset.action) {
      case "tutorial-open": openTutorial(); break;
      case "tutorial-skip": closeTutorial(); break;
      case "tutorial-start-demo": await startGuidedTour(control); break;
      case "guided-tour-skip": finishGuidedTour({ skipped: true }); break;
      case "guided-tour-back":
        if (state.guidedTourStep > 0) {
          state.guidedTourStep -= 1;
          setPage(GUIDED_TOUR_STEPS[state.guidedTourStep].page);
          renderGuidedTour();
        }
        break;
      case "load-demo": {
        if (control.closest("#welcome-tutorial")) closeTutorial();
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
      case "order-status": await resolveOrderStatus(control.dataset.orderId, control.dataset.issueId, control.dataset.resolution); break;
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
    const tutorialDialog = $("#welcome-tutorial");
    tutorialDialog.addEventListener("click", handleClick);
    tutorialDialog.addEventListener("close", () => { if (!state.guidedTourActive) markTutorialSeen(); });
    tutorialDialog.addEventListener("click", (event) => { if (event.target === tutorialDialog) closeTutorial(); });
    const guidedTour = $("#guided-tour");
    const guidedTourSpotlight = $("#guided-tour-spotlight");
    guidedTour.addEventListener("click", handleClick);
    guidedTourSpotlight.addEventListener("click", (event) => {
      event.stopPropagation();
      $(GUIDED_TOUR_STEPS[state.guidedTourStep]?.target)?.click();
    });
    guidedTourSpotlight.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        $(GUIDED_TOUR_STEPS[state.guidedTourStep]?.target)?.click();
      }
    });
    window.addEventListener("resize", positionGuidedTour);
    window.addEventListener("scroll", positionGuidedTour, true);
    renderPage();
    if (!state.guidedTourSeen) openTutorial();
    if (navigator.storage?.persisted) {
      const persisted = await navigator.storage.persisted();
      document.body.dataset.storagePersisted = String(persisted);
    }
  } catch (error) {
    console.error("Application startup failed", error);
    $("#page-content").innerHTML = `<section class="card empty-state"><div class="empty-art">!</div><h2>暂时读不到这个浏览器里的数据</h2><p>${esc(error.message || "浏览器没有打开本地数据空间。")}</p><p>请使用新版 Edge、Chrome 或 Firefox，并通过 https 网址打开。确认浏览器允许网站保存数据后，再刷新页面。此时没有数据被报告为已保存。</p></section>`;
  }
}

start();
