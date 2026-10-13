import * as U from "../util.js";
import { icon } from "../icons.js";

const MAX_LINES = 3000;
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

let rootEl = null;
let entries = []; // sorted by id
let seen = new Set();
let paused = false;
let pendingWhilePaused = 0;
let filterLevel = "all";
let filterText = "";
let autoscroll = true;

const matches = (e) => {
  if (
    filterLevel !== "all" &&
    (LEVEL_RANK[e.level] ?? 1) < LEVEL_RANK[filterLevel]
  )
    return false;
  if (!filterText) return true;
  const hay =
    `${e.title || ""} ${e.platform || ""} ${e.user || ""} ${e.message || ""}`.toLowerCase();
  return hay.includes(filterText);
};

// --- 运行历史表（从运行页迁来，用户要求放在日志页） --------------------------
// 过滤口径与原 runs.js 一致：一次真实执行会在历史里留下最多 4 行（wrapper 的
// 锁获取/释放空行 + 应用自己的 RUN-START/RUN-END），只保留有真实数据的行，
// 以及任何非纯成功的行（错误/崩溃没有完整数据也值得看）。
let runsPayload = null;

function hasData(r) {
  return r.accountsProcessed != null || r.totalGained != null || r.newTotal != null;
}
function isInformative(r) {
  if (r.status === "running" || r.status === "done") return hasData(r);
  return true;
}

function renderRuns() {
  const body = U.$("#runsBody", rootEl);
  if (!body) return;
  const runs = (runsPayload?.runs || []).filter(isInformative);

  if (!runs.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="empty-note">No runs recorded yet.</td></tr>';
    return;
  }

  body.innerHTML = runs
    .map((r) => {
      const duration =
        r.runtimeMin != null
          ? U.fmtDuration(r.runtimeMin * 60)
          : r.startTs && r.endTs
            ? U.fmtDuration(
              (Date.parse(r.endTs) - Date.parse(r.startTs)) / 1000,
            )
            : "–";
      return `<tr>
                <td>${U.statusPill(r.status)}</td>
                <td>${U.escapeHtml(U.fmtDateTime(r.startTs || r.endTs))}</td>
                <td>${U.escapeHtml(duration)}</td>
                <td class="num">${r.accountsProcessed != null ? U.fmtNumber(r.accountsProcessed) : "–"}${r.totalAccounts ? ` / ${U.fmtNumber(r.totalAccounts)}` : ""}</td>
                <td class="num strong">${r.totalGained != null ? U.fmtSigned(r.totalGained) : "–"}</td>
                <td class="num">${r.newTotal != null ? U.fmtNumber(r.newTotal) : "–"}</td>
                <td>${r.version ? `v${U.escapeHtml(r.version)}` : "–"}</td>
            </tr>`;
    })
    .join("");
}

function lineHtml(e) {
  const time = e.ts || (e.receivedAt ? U.fmtTime(e.receivedAt) : "");
  const commaIdx = time.indexOf(", ");
  const datePart = commaIdx === -1 ? "" : time.slice(0, commaIdx);
  const timePart = commaIdx === -1 ? time : time.slice(commaIdx + 2);
  const tag = e.title || e.level;
  return `<div class="log-line log-line--${U.escapeAttr(e.level)}">
        <span class="log-time">${datePart ? `<span class="log-date">${U.escapeHtml(datePart)}, </span>` : ""}${U.escapeHtml(timePart)}</span>
        <span class="log-level log-level--${U.escapeAttr(e.level)}">${U.escapeHtml(e.level)}</span>
        <span class="log-tag">${U.escapeHtml(tag || "")}</span>
        <span class="log-msg">${U.escapeHtml(e.message || e.raw || "")}</span>
    </div>`;
}

function atTop(box) {
  return box.scrollTop < 60;
}

// 用户要求：最新日志显示在最上面，滚动条往下滑看以前的 —— 渲染时把缓冲反转，
// "自动滚动"的锚点也从吸底改为吸顶。
function renderAll() {
  const box = U.$("#logBox", rootEl);
  const visible = entries.filter(matches);
  box.innerHTML = visible.length
    ? visible.slice(-MAX_LINES).reverse().map(lineHtml).join("")
    : '<p class="empty-note">No log lines match the current filter.</p>';
  if (autoscroll) box.scrollTop = 0;
  updateMeta();
}

function updateMeta() {
  U.$("#logCount", rootEl).textContent =
    `${entries.length.toLocaleString()} line${entries.length === 1 ? "" : "s"} buffered`;
  const btn = U.$("#logPause", rootEl);
  btn.textContent = paused
    ? pendingWhilePaused
      ? `Resume (${pendingWhilePaused} new)`
      : "Resume"
    : "Pause";
  btn.classList.toggle("btn-primary", paused);
}

function addEntry(entry, live) {
  if (!entry || entry.id == null || seen.has(entry.id)) return false;
  seen.add(entry.id);

  const inOrder = !entries.length || entry.id > entries[entries.length - 1].id;
  if (inOrder) entries.push(entry);
  else {
    entries.push(entry);
    entries.sort((a, b) => a.id - b.id);
  }

  if (entries.length > MAX_LINES * 2) {
    const dropped = entries.splice(0, entries.length - MAX_LINES);
    for (const d of dropped) seen.delete(d.id);
  }

  if (!live) return true;

  if (paused) {
    pendingWhilePaused++;
    updateMeta();
    return true;
  }

  if (!inOrder) {
    renderAll();
    return true;
  }

  if (matches(entry)) {
    const box = U.$("#logBox", rootEl);
    const wasAtTop = atTop(box);
    if (box.querySelector(".empty-note")) box.innerHTML = "";
    box.insertAdjacentHTML("afterbegin", lineHtml(entry));
    while (box.childElementCount > MAX_LINES) box.lastElementChild.remove();
    if (autoscroll && wasAtTop) box.scrollTop = 0;
  }
  updateMeta();
  return true;
}

function download() {
  const text = entries.map((e) => e.raw || e.message || "").join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `rewards-log-${U.tzStamp()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export default {
  id: "logs",
  label: "Logs",
  interval: 0, // live — nothing to poll

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <div class="card batch" aria-labelledby="logs-heading">
                <div class="card-tools">
                    <h2 class="card-title" id="logs-heading">Live logs</h2>
                    <label class="field field--inline">
                        <span>Level</span>
                        <select id="logLevel" class="input">
                            <option value="all">全部</option>
                            <option value="info">信息及以上</option>
                            <option value="warn">警告及以上</option>
                            <option value="error">仅错误</option>
                        </select>
                    </label>
                    <label class="field field--grow">
                        <span class="visually-hidden">Search</span>
                        <input id="logSearch" class="input" type="search" placeholder="筛选日志行…" autocomplete="off">
                    </label>
                </div>
                <div class="card-tools">
                    <label class="check">
                        <input type="checkbox" id="logAutoscroll" checked>
                        <span>Autoscroll</span>
                    </label>
                    <button type="button" id="logPause" class="btn btn-small">Pause</button>
                    <button type="button" id="logMore" class="btn btn-small">Load 2000</button>
                    <button type="button" id="logDownload" class="btn btn-small">${icon("down", "i sm")}Download</button>
                    <button type="button" id="logClear" class="btn btn-small">Clear</button>
                </div>
            </div>

            <div class="term">
                <div class="term-bar">
                    <span class="tdot" style="background:#FF5F57"></span>
                    <span class="tdot" style="background:#FEBC2E"></span>
                    <span class="tdot" style="background:#28C840"></span>
                    <span class="term-title">runtime.log &mdash; tail -f</span>
                    <span class="term-count" id="logCount">0 lines buffered</span>
                </div>
                <div class="log-box term-body" id="logBox" tabindex="0" aria-live="off">
                    <p class="empty-note">Waiting for log lines…</p>
                </div>
            </div>

            <section class="card" aria-labelledby="runs-table-heading">
                <div class="card-h">
                    <div class="card-ic">${icon("activity", "i sm")}</div>
                    <div><div class="card-title" id="runs-table-heading">Run history</div><div class="card-sub">Parsed from the bot&rsquo;s own log output</div></div>
                </div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Status</th><th>Started</th><th>Duration</th>
                                <th>Accounts</th><th>Gained</th><th>New total</th><th>Version</th>
                            </tr>
                        </thead>
                        <tbody id="runsBody"></tbody>
                    </table>
                </div>
            </section>`;

    U.$("#logLevel", root).addEventListener("change", (e) => {
      filterLevel = e.target.value;
      renderAll();
    });
    U.$("#logSearch", root).addEventListener(
      "input",
      U.debounce((e) => {
        filterText = e.target.value.trim().toLowerCase();
        renderAll();
      }, 200),
    );
    U.$("#logAutoscroll", root).addEventListener("change", (e) => {
      autoscroll = e.target.checked;
      if (autoscroll) {
        const box = U.$("#logBox", rootEl);
        box.scrollTop = 0;
      }
    });
    U.$("#logPause", root).addEventListener("click", () => {
      paused = !paused;
      if (!paused) {
        pendingWhilePaused = 0;
        renderAll();
      }
      updateMeta();
    });
    U.$("#logClear", root).addEventListener("click", () => {
      entries = [];
      seen = new Set();
      pendingWhilePaused = 0;
      renderAll();
    });
    U.$("#logDownload", root).addEventListener("click", download);
    U.$("#logMore", root).addEventListener("click", async () => {
      try {
        const res = await ctx.api.logs(2000);
        for (const e of res.logs || []) addEntry(e, false);
        renderAll();
        U.toast(
          `Buffer filled to ${entries.length.toLocaleString()} lines.`,
          "success",
        );
      } catch (e) {
        U.toast(e.message, "error");
      }
    });
  },

  async refresh(ctx) {
    // 运行历史卡随日志页一起加载（本视图 interval 为 0 不轮询，进 tab 时拉一次）。
    try {
      runsPayload = await ctx.api.runs(100);
      renderRuns();
    } catch (e) {
      U.toast(`运行历史加载失败：${e.message}`, "error");
    }
    if (entries.length) return;
    try {
      const res = await ctx.api.logs(500);
      for (const e of res.logs || []) addEntry(e, false);
    } catch (e) {
      // 以前这里是空的 catch {}：抓取失败被完全吞掉，紧接着 renderAll() 把界面渲染成
      // "没有匹配的日志行" —— 把一次网络故障说成"确实没有日志"，是最坏的一种误导。
      // 同文件上面的导出路径本来就是用 toast 报错的，这里保持一致。
      U.toast(`日志加载失败：${e.message}`, "error");
    }
    renderAll();
  },

  onLog(entry) {
    if (!rootEl) return;
    addEntry(entry, true);
  },

  onReset() {
    entries = [];
    seen = new Set();
    pendingWhilePaused = 0;
    if (rootEl) renderAll();
  },

  redraw() {
    if (rootEl) renderAll();
  },
};
