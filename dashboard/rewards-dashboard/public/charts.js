import { escapeAttr, escapeHtml, fmtNumber, fmtSigned, keyAddDays, keyDayOfWeek, localDateLabel, tzDayKey } from "./util.js";

const PAD = { left: 46, right: 14, top: 14, bottom: 26 };

function niceMax(value) {
  if (value <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function ticks(max, count = 4) {
  const out = [];
  for (let i = 0; i <= count; i++) out.push(Math.round((max / count) * i));
  return [...new Set(out)];
}

function frame(width, height, max, { zeroFloor = 0 } = {}) {
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yOf = (v) =>
    PAD.top + innerH - ((v - zeroFloor) / (max - zeroFloor || 1)) * innerH;

  let grid = "";
  for (const t of ticks(max)) {
    const y = yOf(t);
    grid += `<line class="chart-grid" x1="${PAD.left}" y1="${y}" x2="${width - PAD.right}" y2="${y}" />`;
    grid += `<text class="chart-axis" x="${PAD.left - 8}" y="${y + 4}" text-anchor="end">${escapeHtml(fmtNumber(t))}</text>`;
  }
  return { innerW, innerH, yOf, grid };
}

function emptyState(container, message) {
  container.innerHTML = `<p class="empty-note chart-empty">${escapeHtml(message)}</p>`;
}

/**
 * Line chart of absolute values over time (an account's point total).
 * @param points [{ key: 'YYYY-MM-DD', value: number, label?: string }]
 */
export function lineChart(
  container,
  points,
  { emptyMessage = "No data yet.", signed = false, ariaLabel = "Point total over time" } = {},
) {
  if (!points || points.length === 0)
    return emptyState(container, emptyMessage);

  const width = Math.max(320, container.clientWidth || 640);
  const height = Math.max(200, Math.min(320, Math.round(width * 0.34)));

  const values = points.map((p) => p.value);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  const span = rawMax - rawMin;
  const floor =
    span === 0 ? Math.max(0, rawMax - 10) : Math.max(0, rawMin - span * 0.15);
  const max = span === 0 ? rawMax + 10 : rawMax + span * 0.15;

  const { innerW, yOf, grid } = frame(width, height, max, { zeroFloor: floor });
  const xOf = (i) =>
    PAD.left +
    (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);

  const coords = points.map((p, i) => [xOf(i), yOf(p.value)]);
  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${(height - PAD.bottom).toFixed(1)} L${coords[0][0].toFixed(1)},${(height - PAD.bottom).toFixed(1)} Z`;

  const fmt = signed ? fmtSigned : fmtNumber;
  const dots = points
    .map((p, i) => {
      const [x, y] = coords[i];
      const title = `${p.label || p.key}：${fmt(p.value)} 积分`;
      return `<circle class="chart-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${escapeAttr(title)}</title></circle>`;
    })
    .join("");

  const every = Math.max(1, Math.ceil(points.length / 6));
  const labels = points
    .map((p, i) => {
      if (i % every !== 0 && i !== points.length - 1) return "";
      const x = Math.min(width - PAD.right, Math.max(PAD.left, xOf(i)));
      const text =
        p.key.length === 10
          ? localDateLabel(p.key, { month: "short", day: "numeric" })
          : p.key;
      return `<text class="chart-axis" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(text)}</text>`;
    })
    .join("");

  container.innerHTML = `
        <svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
             aria-label="${escapeAttr(ariaLabel)}">
            ${grid}
            <path class="chart-area" d="${area}" />
            <path class="chart-line" pathLength="1" d="${line}" />
            <line class="chart-cursor" y1="${PAD.top}" y2="${height - PAD.bottom}" hidden />
            ${dots}
            ${labels}
        </svg>
        <div class="chart-tip" hidden></div>`;

  // 悬停交互（用户：原来鼠标划过只有曲线，看不到各个点的数字）——
  // 竖向虚线光标吸附最近点、该点放大高亮、浮动提示框显示日期与数值。
  const svg = container.querySelector("svg");
  const tip = container.querySelector(".chart-tip");
  const cursor = container.querySelector(".chart-cursor");
  const dotEls = [...svg.querySelectorAll(".chart-dot")];
  let activeDot = null;

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (px - PAD.left) / innerW;
    const i = Math.max(
      0,
      Math.min(points.length - 1, Math.round(ratio * (points.length - 1))),
    );
    const [x, y] = coords[i];

    cursor.setAttribute("x1", x.toFixed(1));
    cursor.setAttribute("x2", x.toFixed(1));
    cursor.hidden = false;

    if (activeDot) activeDot.classList.remove("chart-dot--active");
    activeDot = dotEls[i] || null;
    if (activeDot) activeDot.classList.add("chart-dot--active");

    const p = points[i];
    const label =
      p.label ||
      (p.key.length === 10
        ? localDateLabel(p.key, { month: "short", day: "numeric" })
        : p.key);
    tip.innerHTML = `<span class="chart-tip-label">${escapeHtml(label)}</span><strong>${escapeHtml(fmt(p.value))} 积分</strong>`;
    tip.hidden = false;
    const leftPct = (x / width) * 100;
    tip.style.left = `${leftPct}%`;
    tip.style.top = `${(y / height) * 100}%`;
    // 靠边的提示框改向内侧锚定，别甩出容器
    tip.classList.toggle("chart-tip--left", leftPct > 78);
    tip.classList.toggle("chart-tip--right", leftPct < 22);
  });

  svg.addEventListener("mouseleave", () => {
    cursor.hidden = true;
    tip.hidden = true;
    if (activeDot) {
      activeDot.classList.remove("chart-dot--active");
      activeDot = null;
    }
  });
}

/**
 * Bar chart of per-day totals (points collected each day).
 * @param bars [{ key: 'YYYY-MM-DD', value: number, sub?: string }]
 */
export function barChart(
  container,
  bars,
  { emptyMessage = "No runs recorded yet." } = {},
) {
  if (!bars || bars.length === 0) return emptyState(container, emptyMessage);

  const width = Math.max(320, container.clientWidth || 640);
  const height = Math.max(200, Math.min(300, Math.round(width * 0.32)));

  const max = niceMax(Math.max(1, ...bars.map((b) => b.value)));
  const { innerW, yOf, grid } = frame(width, height, max);

  const slot = innerW / bars.length;
  const barW = Math.max(3, Math.min(28, slot * 0.68));
  const baseY = height - PAD.bottom;

  const rects = bars
    .map((b, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      const y = yOf(b.value);
      const h = Math.max(b.value > 0 ? 2 : 0, baseY - y);
      const title = `${localDateLabel(b.key, { weekday: "short", month: "short", day: "numeric" })}：${fmtSigned(b.value)} 积分${b.sub ? `（${b.sub}）` : ""}`;
      return `<rect class="chart-bar" x="${(cx - barW / 2).toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${escapeAttr(title)}</title></rect>`;
    })
    .join("");

  const every = Math.max(1, Math.ceil(bars.length / 7));
  const labels = bars
    .map((b, i) => {
      if (i % every !== 0 && i !== bars.length - 1) return "";
      const cx = PAD.left + slot * i + slot / 2;
      return `<text class="chart-axis" x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(localDateLabel(b.key, { month: "short", day: "numeric" }))}</text>`;
    })
    .join("");

  container.innerHTML = `
        <svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
             aria-label="Points collected per day">
            ${grid}
            <line class="chart-grid chart-baseline" x1="${PAD.left}" y1="${baseY}" x2="${width - PAD.right}" y2="${baseY}" />
            ${rects}
            ${labels}
        </svg>`;
}

// Chart Constants
const ACCUM_WINDOW_DAYS = 84; // ~12 weeks
const ACCUM_MAX_HEIGHT_PCT = 100;
const ACCUM_MIN_HEIGHT_PCT = 20;
const HEATMAP_MIN_WEEKS = 53; // a full year of columns, minimum
const HEATMAP_FUTURE_BUFFER_WEEKS = 8; // ~2 months of "coming up" room, always
// Colour intensity is scaled relative to this account's own typical
// (average) day rather than a fixed point threshold or its single best day
// - self-calibrates regardless of how many points a given account usually
// earns, and one big catch-up day doesn't wash every ordinary day out into
// looking inactive. Ratios are the upper edge of levels 1/2/3 (anything at
// or above the last one is level 4).
const HEATMAP_LEVEL_RATIOS = [0.6, 1.1, 1.75];

function heatmapLevel(gained, avg) {
  if (gained <= 0) return 0;
  const ratio = gained / avg;
  if (ratio < HEATMAP_LEVEL_RATIOS[0]) return 1;
  if (ratio < HEATMAP_LEVEL_RATIOS[1]) return 2;
  if (ratio < HEATMAP_LEVEL_RATIOS[2]) return 3;
  return 4;
}

export function buildHeatmapHtml(days) {
  if (!days.length) return "";

  const byDay = new Map(days.map((d) => [d.dayKey, d]));
  days = [...days].sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const activeGains = days.map((d) => d.gained).filter((g) => g > 0);
  const avgGained = activeGains.length
    ? activeGains.reduce((sum, g) => sum + g, 0) / activeGains.length
    : 1;

  // "今天"必须和 byDay 的键用同一个时区：那些键是面板按 TZ（Asia/Shanghai）用
  // tzDayKey 切出来的。以前这里用浏览器本地 getter，浏览器不在 UTC+8 时"今天"
  // 高亮会落到相邻格子上。
  // 这个模块是具名导入（见文件头），没有 `U` 这个名字 —— 写成 U.tzDayKey 会抛
  // ReferenceError，被 overview 的 catch 接住，面板上显示成"overview 刷新失败：
  // U is not defined"，整张热力图都渲染不出来。U 是 app.js 的写法（import * as U）。
  const todayStr = tzDayKey(new Date());

  // 1. Anchor to the beginning (Left Justified)
  // 整张网格都在"日期键"上走：key 直接来自 days 的键空间（与 byDay 同源），加减用纯 UTC，
  // 不经过浏览器本地日历。以前是 new Date(dayKey + "T12:00:00") + setDate/getDay/getMonth ——
  // 起点是**浏览器本地**的，浏览器不在 +8 时本地正午 12:00 在面板 TZ 里已经是第二天，
  // 整张网格偏一格；而且月份标签走浏览器本地、格子走面板 TZ，同一个网格里两个时区，
  // 月份标题会和它下面的格子对不上。
  // keyAddDays / keyDayOfWeek 来自 util.js —— runs.js 的日期游标也要用同一套键运算，
  // 放在 util 里共用，避免两处各写一份、其中一处再退回本地日历。

  let startKey = days[0].dayKey;

  // Never let the window stretch back further than needed to still leave
  // HEATMAP_FUTURE_BUFFER_WEEKS of "coming up" room ahead of today - without
  // this, a long-tenured account's window grows a week wider forever, and
  // once it passes a year old it stops leaving any future runway at all
  // (right back to the original "today pinned at the far edge" problem,
  // just deferred).
  const earliestKey = keyAddDays(
    todayStr,
    -(HEATMAP_MIN_WEEKS - HEATMAP_FUTURE_BUFFER_WEEKS) * 7,
  );
  if (startKey < earliestKey) startKey = earliestKey;

  // Align to Monday so weeks stay vertical
  while (keyDayOfWeek(startKey) !== 1) {
    startKey = keyAddDays(startKey, -1);
  }

  // The clamp above guarantees the window is always bounded, so the grid is
  // always exactly HEATMAP_MIN_WEEKS wide - constant size regardless of how
  // long the account has been running.
  const totalWeeks = HEATMAP_MIN_WEEKS;

  // Collect Month Labels accurately calculating width mapping to `.heatmap-cell` (10px + 2px gap)
  let monthWidths = [];
  let currentMonthSpan = 0;
  let lastMonth = -1;
  let currentMonthName = "";
  
  let gridHtml = '<div class="heatmap">';

  for (let week = 0; week < totalWeeks; week++) {
    gridHtml += '<div class="heatmap-week">';
    
    // Evaluate month mappings natively to flex rows above the cell block wrapper
    const weekStartKey = keyAddDays(startKey, week * 7);
    const weekMonth = Number(weekStartKey.slice(5, 7)) - 1; // 0-11，与下面 lastMonth 的比较口径一致
    const weekKey = `${weekStartKey.slice(0, 7)}-01`;

    if (lastMonth === -1) {
        lastMonth = weekMonth;
        currentMonthName = localDateLabel(weekKey, { month: "short" });
        currentMonthSpan = 1;
    } else if (weekMonth !== lastMonth) {
        // Drop the first month label for tidiness if it started mid-month (spans 2 weeks or less)
        if (monthWidths.length === 0 && currentMonthSpan <= 2) {
            currentMonthName = "";
        }
        monthWidths.push({ name: currentMonthName, span: currentMonthSpan });
        
        currentMonthSpan = 1;
        lastMonth = weekMonth;
        currentMonthName = localDateLabel(weekKey, { month: "short" });
    } else {
        currentMonthSpan++;
    }

    for (let day = 0; day < 7; day++) {
      // 键直接由 startKey 递推 —— 不再经过浏览器本地日历，所以没有偏一格的可能
      const key = keyAddDays(weekStartKey, day);
      const entry = byDay.get(key);
      const level = entry ? heatmapLevel(entry.gained, avgGained) : 0;

      // Any day after today is considered a future/unfilled square
      const future = key > todayStr;

      const cls = [
        "heatmap-cell",
        `heatmap-level-${level}`,
        future ? "heatmap-future" : "",
        key === todayStr ? "heatmap-today" : ""
      ].filter(Boolean).join(" ");

      // 提示直接出中文（用户：原生 title 里的 pts/Total 没翻译）；fmtSigned 自带 + 号，别再叠一个。
      // 走 data-tip（共享动态气泡）而不是原生 title —— title 无法加动画，且会和气泡双弹
      const tip = entry
        ? `${localDateLabel(key, { weekday: "long", month: "short", day: "numeric" })}\n${fmtSigned(entry.gained)} 积分\n总计 ${entry.lastTotal.toLocaleString()}`
        : localDateLabel(key, { weekday: "long", month: "short", day: "numeric" });

      gridHtml += `<div class="${cls}" data-tip="${escapeAttr(tip)}" aria-label="${escapeAttr(tip)}"></div>`;
    }

    gridHtml += "</div>";
  }

  gridHtml += "</div>";
  
  if (currentMonthSpan > 0) {
      monthWidths.push({ name: currentMonthName, span: currentMonthSpan });
  }

  // 列距与 style.css 的 .heatmap-week/.heatmap-cell 同步：10px 格 + 2px 缝 = 12px/列
  // （用户：格子从 8px 加宽到 10px，月份行跟着拉宽，右侧不再那么空）
  let monthsHtml = '<div class="heatmap-months" style="display: flex; font-size: 0.65rem; color: var(--text-muted); margin-bottom: 4px; line-height: 1;">';
  for (const m of monthWidths) {
      // nowrap：月份标签永远横排 —— 最右的"10月"原来列宽不够被挤成"10/月"两行（用户点名）
      monthsHtml += `<div style="width: ${m.span * 12}px; flex-shrink: 0; white-space: nowrap; overflow: visible;">${escapeHtml(m.name)}</div>`;
  }
  monthsHtml += '</div>';

  return `<div class="heatmap-container" style="display: flex; flex-direction: column; width: max-content;">${monthsHtml}${gridHtml}</div>`;
}

export function buildAccumBarHtml(days, globalMaxGained, maxDays = null) {
  // 用与数据分桶同一个「时区感知」的日期键。原来这里用 toISOString()（UTC），
  // 本地 00:00 到 08:00 之间会得到昨天：窗口会多切掉一天、"今天"的柱子也不高亮。
  // 换掉之后还留着第二个毛病：cutoff 的**加减**走 setDate/getDate（浏览器本地日历），
  // 只有最后一步 tzDayKey 是时区感知的 —— 浏览器不在 +8 时切点照样偏一天。
  // 现在两步都在键上做：先取面板 TZ 的今天，再纯 UTC 往前推 N 天。
  const todayKey = tzDayKey(new Date());
  const cutoffKey = keyAddDays(todayKey, -ACCUM_WINDOW_DAYS);

  let windowed = days.filter((d) => d.dayKey >= cutoffKey);
  if (maxDays != null) windowed = windowed.slice(-maxDays);
  if (!windowed.length) return "";

  let html = "";
  let prevWeekKey = null;
  let weekGained = 0;
  let altToggle = false;

  const flushWeekMarker = () => {
    if (prevWeekKey === null) return;
    const label = localDateLabel(prevWeekKey, {
      month: "short",
      day: "numeric",
    });
    const weekTip = escapeAttr(`${label} 当周\n${fmtSigned(weekGained)} 积分`);
    html += `<div class="accum-week-marker" data-tip="${weekTip}" aria-label="${weekTip}"></div>`;
    weekGained = 0;
  };

  const len = windowed.length;
  for (let i = 0; i < len; i++) {
    const day = windowed[i];
    if (prevWeekKey !== null && day.weekKey !== prevWeekKey) flushWeekMarker();
    prevWeekKey = day.weekKey;
    weekGained += day.gained;

    if (i > 0) {
      const prev = windowed[i - 1];
      const missed = Math.max(
        0,
        Math.round((new Date(day.dayKey) - new Date(prev.dayKey)) / 86400000) -
        1,
      );
      if (missed >= 1) {
        const gapClass = missed === 1 ? " accum-gap--warn" : " accum-gap--bad";
        const gapTip = escapeAttr(`中断 ${missed} 天`);
        html += `<div class="accum-gap${gapClass}" style="width:${missed * 16}px" data-tip="${gapTip}" aria-label="${gapTip}"></div>`;
      }
    }

    const dateLabel = localDateLabel(day.dayKey, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const isToday = day.dayKey === todayKey;
    const heightPct = Math.max(
      ACCUM_MIN_HEIGHT_PCT,
      Math.round((day.gained / globalMaxGained) * ACCUM_MAX_HEIGHT_PCT),
    );
    const opacity = (0.35 + 0.65 * (i / (len - 1 || 1))).toFixed(2);
    altToggle = !altToggle;

    // 提示走 data-tip（共享动态气泡）而不是原生 title —— title 无法加动画，且会和气泡双弹。
    // 内容上下两行：上行日期、下行积分（用户点名对齐热力图的两行结构）
    const tip = escapeAttr(
      `${dateLabel}${isToday ? "（今天）" : ""}\n${fmtSigned(day.gained)} 积分（总计 ${day.lastTotal.toLocaleString()}）`,
    );
    html += `<div class="accum-day ${altToggle ? "accum-day--a" : "accum-day--b"}${isToday ? " accum-day--today" : ""}" style="height:${heightPct}%;opacity:${opacity};--i:${i}" data-tip="${tip}" aria-label="${tip}"></div>`;
  }

  return html;
}

/* ============ 共享动态提示气泡（时间线积分条 / 热力点 / 中断标记 / 周标记） ============
   这些元素反复 innerHTML 重渲，监听器一律走 document 级事件委托，不绑定到具体节点；
   气泡懒建一个、跟随鼠标，进出带 淡入+上浮+回弹 动画（原生 title 做不到，已弃用）。 */
let sharedTipEl = null;
// 滚动抑制窗口：鼠标不动、只滚滚轮时，浏览器会在滚动后补发「合成 mousemove」
// （光标下的内容变了），hide 完立刻又被它重新显示 —— 用户看到的「气泡不会消失」bug。
// 滚动后 350ms 内禁止再显示，合成事件就落在窗口里；真实移动超出窗口后正常恢复。
let tipSuppressUntil = 0;

function positionSharedTip(x, y) {
  const el = sharedTipEl;
  const gap = 14;
  let left = x + gap;
  let top = y + gap + 4;
  if (left + el.offsetWidth > window.innerWidth - 8)
    left = x - el.offsetWidth - gap;
  if (top + el.offsetHeight > window.innerHeight - 8)
    top = y - el.offsetHeight - gap;
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${Math.max(4, top)}px`;
}

function showSharedTip(text, x, y) {
  if (!text || performance.now() < tipSuppressUntil) return;
  if (!sharedTipEl) {
    sharedTipEl = document.createElement("div");
    sharedTipEl.className = "chartTip--float";
    sharedTipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(sharedTipEl);
  }
  if (sharedTipEl.textContent !== text) sharedTipEl.textContent = text;
  positionSharedTip(x, y);
  sharedTipEl.classList.add("on");
}

function hideSharedTip() {
  sharedTipEl?.classList.remove("on");
}

const tipTargetOf = (e) =>
  e.target instanceof Element ? e.target.closest("[data-tip]") : null;

document.addEventListener("mouseover", (e) => {
  const t = tipTargetOf(e);
  if (t) showSharedTip(t.getAttribute("data-tip"), e.clientX, e.clientY);
});
document.addEventListener("mousemove", (e) => {
  if (!sharedTipEl || !sharedTipEl.classList.contains("on")) return;
  const t = tipTargetOf(e);
  if (!t) {
    // 目标被重渲移除或移出热点区：下一段 mousemove 落到别的元素上时收掉
    hideSharedTip();
    return;
  }
  showSharedTip(t.getAttribute("data-tip"), e.clientX, e.clientY);
});
document.addEventListener("mouseout", (e) => {
  if (!tipTargetOf(e)) return;
  const to =
    e.relatedTarget instanceof Element
      ? e.relatedTarget.closest("[data-tip]")
      : null;
  if (to !== tipTargetOf(e)) hideSharedTip();
});
window.addEventListener(
  "scroll",
  () => {
    tipSuppressUntil = performance.now() + 350;
    hideSharedTip();
  },
  true,
);