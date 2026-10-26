import { formatFen, formatQuantity } from "./domain.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function trendSvg(points) {
  const width = 720, height = 250, left = 74, right = 18, top = 18, bottom = 38;
  const values = points.flatMap((point) => [point.grossSalesFen, point.profitFen]);
  const max = Math.max(...values, 100);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 100);
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const coords = points.map((p, index) => ({
    x: points.length <= 1 ? left + chartWidth / 2 : left + index * chartWidth / (points.length - 1),
    salesY: top + chartHeight - ((p.grossSalesFen - min) / range) * chartHeight,
    profitY: top + chartHeight - ((p.profitFen - min) / range) * chartHeight,
  }));
  const salesLine = coords.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.salesY.toFixed(1)}`).join(" ");
  const profitLine = coords.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.profitY.toFixed(1)}`).join(" ");
  const area = `${salesLine} L${(left + chartWidth).toFixed(1)},${(top + chartHeight).toFixed(1)} L${left},${top + chartHeight} Z`;
  const labels = [0, Math.floor((points.length - 1) / 2), Math.max(0, points.length - 1)]
    .filter((index, i, all) => points[index] && all.indexOf(index) === i);
  const grid = [0, 0.5, 1].map((fraction) => {
    const y = top + chartHeight * fraction;
    const value = Math.round(max - range * fraction);
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="chart-grid"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" class="chart-label">${esc(formatFen(value))}</text>`;
  }).join("");
  const xLabels = labels.map((index) => {
    const p = points[index], x = coords[index]?.x ?? left;
    return `<text x="${x}" y="${height - 12}" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}" class="chart-label">${esc(p.date.slice(5))}</text>`;
  }).join("");
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日销售额和预计利润趋势图">
    <defs><linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#19a889" stop-opacity=".22"/><stop offset="100%" stop-color="#19a889" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#trend-fill)"/><path d="${salesLine}" class="chart-line chart-line-sales"/><path d="${profitLine}" class="chart-line chart-line-profit"/>
    ${coords.map((p, i) => `<circle cx="${p.x}" cy="${p.salesY}" r="3.5" class="chart-dot chart-dot-sales"><title>${esc(points[i].date)} 销售额：${esc(formatFen(points[i].grossSalesFen))}</title></circle><circle cx="${p.x}" cy="${p.profitY}" r="3.5" class="chart-dot chart-dot-profit"><title>${esc(points[i].date)} 预计利润：${esc(formatFen(points[i].profitFen))}</title></circle>`).join("")}${xLabels}
  </svg>`;
}

export function productBars(products) {
  if (!products.length) return `<div class="empty-inline">导入订单后显示商品销售对比。</div>`;
  const max = Math.max(...products.map((p) => p.salesFen), 1);
  const rows = products.slice(0, 8).map((product) => {
    const width = Math.max(3, product.salesFen / max * 100);
    return `<div class="bar-row">
      <div class="bar-label"><strong title="${esc(product.productName)}">${esc(product.productName || product.skuId)}</strong><span>${esc(formatQuantity(product.quantityMilli))} 件 · ${esc(formatFen(product.salesFen))}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%"></div></div>
      ${product.missingCost ? `<span class="tag tag-warn">缺成本</span>` : `<span class="tag tag-ok">成本已匹配</span>`}
    </div>`;
  }).join("");
  return `<div class="bars">${rows}</div>`;
}
