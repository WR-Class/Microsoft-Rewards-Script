import * as U from "../util.js";
import { icon } from "../icons.js";

// 账户列表 + 批量运行条已按用户要求迁到运行页（runs.js，「每日积分」卡下面）——
// 跑一次、看趋势、看退出都在同一页。本页只剩一件事：读写机器人的 .env。

let rootEl = null;
let context = null;

// --- the bot's own accounts (its .env) -------------------------------------
// Everything in this view is about accounts the bot will *read on its next
// start* — the only thing the dashboard can write. Saving here edits the bot's
// .env; only the bot's own restart makes the change real, so the save path ends
// by offering that restart rather than implying the account is already live.

let managePayload = null;

function renderManageBox(root) {
  const hint = U.$("#accountsManageHint", root);
  const form = U.$("#accountsManageForm", root);
  const list = U.$("#accountsManageList", root);
  const addBtn = U.$("#accountsManageAdd", root);
  if (!hint || !form || !list) return;

  if (!managePayload) {
    hint.textContent = "正在读取机器人的 .env …";
    return;
  }

  if (!managePayload.enabled) {
    hint.textContent =
      "此功能已关闭：面板的 .env 里没有配置 BOT_ENV_PATH（指向机器人目录下的 .env）。配置好并重启面板即可启用。";
    if (addBtn) addBtn.disabled = true;
    list.innerHTML = "";
    return;
  }

  const accounts = managePayload.accounts || [];
  const where = `文件：${managePayload.envPath}`;

  if (managePayload.readError) {
    hint.textContent = `读取出错：${managePayload.readError}`;
  } else if (accounts.length) {
    hint.textContent = `机器人 .env 里已有 ${accounts.length} 个账号。${where}。改动需要重启机器人后才生效。`;
  } else {
    hint.textContent = `机器人 .env 里还没有账号，填一个邮箱即可。${where}`;
  }

  if (addBtn) addBtn.disabled = false;
  list.innerHTML = accounts
    .map((a) => {
      // 密码状态不显示（用户点名去掉"密码已存"），只留 TOTP/地区/语言这些
      // 弹窗里不会回显、又影响登录行为的信息。
      const meta = [
        a.hasTotpSecret ? "TOTP 已存" : "",
        a.geoLocale ? `地区 ${a.geoLocale}` : "",
        a.langCode ? `语言 ${a.langCode}` : "",
      ].filter(Boolean);

      return `
      <div class="acc-manage-row">
        <span class="acc-manage-index">${a.index}</span>
        <span class="acc-manage-mail">${U.escapeHtml(a.email)}</span>
        ${meta.length ? `<span class="hint" style="flex:0 0 auto;">${U.escapeHtml(meta.join(" · "))}</span>` : ""}
        <button type="button" class="btn btn-small" data-manage-edit="${a.index}">编辑</button>
        <button type="button" class="btn btn-danger btn-small" data-manage-remove="${a.index}">删除</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll("button[data-manage-edit]").forEach((btn) =>
    btn.addEventListener("click", () => startEditAccount(Number(btn.dataset.manageEdit))),
  );

  list.querySelectorAll("button[data-manage-remove]").forEach((btn) =>
    btn.addEventListener("click", () => removeManagedAccount(Number(btn.dataset.manageRemove))),
  );
}

async function loadManage(root) {
  if (!context?.api?.manageAccounts) return;
  try {
    managePayload = await context.api.manageAccounts();
  } catch (e) {
    managePayload = { enabled: false, accounts: [], readError: e.message };
  }
  renderManageBox(root || rootEl);
}

// The bot parses .env once, at start. A save nobody restarts looks identical to
// a save that failed, so ask - and if the answer is no, say plainly that it is
// written but not yet in effect.
function offerRestart() {
  const yes = window.confirm(
    "机器人只在启动时读取 .env。现在重启机器人让它生效？\n（如果正在跑任务，会先被停止。）",
  );
  if (!yes) {
    U.toast("已保存到 .env。重启机器人后才会生效。", "warn", 6000);
    return;
  }
  context.api
    .control("restart")
    .then(() => U.toast("已请求重启机器人", "success"))
    .catch((e) => U.toast(`重启失败：${e.message}`, "error", 6000));
}

// --- editing an account that is already saved --------------------------------
// The write path already updates in place (lib/accountEnv.js: an explicit index
// wins, otherwise the email is matched), and an empty field means "keep what is
// stored". Both facts are what make editing safe here: the form may leave the
// password blank, and it carries the row's own index so that renaming an
// account cannot fork it into a second entry for one mailbox.

function manageForm() {
  return {
    form: U.$("#accountsManageForm", rootEl),
    index: U.$("#accountsManageForm input[name=index]", rootEl),
    title: U.$("#accountsManageModalTitle", rootEl),
    submit: U.$("#accountsManageSubmit", rootEl),
    note: U.$("#accountsManageEditNote", rootEl),
  };
}

function openManageModal() {
  const m = U.$("#accountsManageModal", rootEl);
  if (m) m.hidden = false;
}

function closeManageModal() {
  const m = U.$("#accountsManageModal", rootEl);
  if (m) m.hidden = true;
  exitEditMode();
}

function exitEditMode() {
  const f = manageForm();
  if (!f.form) return;
  f.form.reset();
  if (f.index) f.index.value = "";
  if (f.note) f.note.hidden = true;
}

function startAddAccount() {
  const f = manageForm();
  if (!f.form) return;
  exitEditMode();
  if (f.title) f.title.textContent = "添加账号";
  if (f.submit) f.submit.textContent = "添加账号";
  openManageModal();
  const email = f.form.elements.email;
  if (email) email.focus();
}

function startEditAccount(index) {
  const account = (managePayload?.accounts || []).find((a) => a.index === index);
  const f = manageForm();
  if (!account || !f.form) return;

  f.form.reset();
  if (f.index) f.index.value = String(index);
  for (const name of ["email", "recoveryEmail", "geoLocale", "langCode"]) {
    const field = f.form.elements[name];
    if (field) field.value = account[name] || "";
  }
  // The API reports secrets as presence only, so these two stay empty - and an
  // empty value means "leave it alone", which is what an edit usually wants.
  const password = f.form.elements.password;
  if (password) password.value = "";

  if (f.title) f.title.textContent = `编辑 ACCOUNT_${index}`;
  if (f.submit) f.submit.textContent = "保存修改";
  if (f.note) {
    f.note.hidden = false;
    f.note.textContent =
      `正在编辑 ACCOUNT_${index}（${account.email}）：密码和 TOTP 留空＝不改动，已存的值不会被清除；` +
      `改邮箱会就地更新这一条，不会新增账号。`;
  }
  openManageModal();
  if (password) password.focus();
}

async function submitManagedAccount(form) {
  const data = new FormData(form);
  const body = {
    // Present only while editing: it pins the save to this row, which is what
    // lets the email itself be changed without creating a duplicate.
    index: Number(data.get("index")) || undefined,
    email: String(data.get("email") || "").trim(),
    password: String(data.get("password") || ""),
    totpSecret: String(data.get("totpSecret") || "").trim(),
    recoveryEmail: String(data.get("recoveryEmail") || "").trim(),
    geoLocale: String(data.get("geoLocale") || "").trim(),
    langCode: String(data.get("langCode") || "").trim(),
  };
  if (!body.email) return;

  const submit = U.$("#accountsManageSubmit", rootEl);
  if (submit) submit.disabled = true;

  try {
    const result = await context.api.addAccount(body);
    U.toast(
      `${result.created ? "已写入" : "已更新"} .env：ACCOUNT_${result.index} ${body.email}`,
      "success",
    );
    exitEditMode();
    closeManageModal();
    await loadManage();
    offerRestart();
  } catch (e) {
    U.toast(`写入失败：${e.message}`, "error", 6000);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function removeManagedAccount(index) {
  const yes = window.confirm(
    `从机器人的 .env 里删除 ACCOUNT_${index}？\n该账号的所有配置行都会被移除（改前会自动备份一份 .env.bak）。`,
  );
  if (!yes) return;

  try {
    await context.api.removeBotAccount(index);
    U.toast(`已从 .env 删除 ACCOUNT_${index}`, "success");
    await loadManage();
    offerRestart();
  } catch (e) {
    U.toast(`删除失败：${e.message}`, "error", 6000);
  }
}

export default {
  id: "accounts",
  label: "Accounts",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
      <div class="card" id="accountsManageBox">
          <div class="card-h">
              <div class="card-ic vio">${icon("sliders", "i sm")}</div>
              <div><div class="card-title" id="accountsManageTitle">账号管理（写入机器人的 .env）</div></div>
              <div class="card-tools">
                  <button type="button" class="btn btn-small" id="accountsManageReload">重新读取</button>
                  <button type="button" class="btn btn-primary btn-small" id="accountsManageAdd">添加账号</button>
              </div>
          </div>
          <div class="card-b">
              <p class="hint" id="accountsManageHint">正在读取机器人的 .env …</p>
              <div id="accountsManageList"></div>
          </div>
      </div>

      <p class="hint" style="margin-top: 1.5rem;">账号保存在机器人的 <code>.env</code>（<code>ACCOUNT_N_*</code>），写入时只改这几行，
      注释和其他设置原样保留，改前会备份一份 <code>.env.bak</code>。
      控制 API 会显示完整邮箱，但从不回传密码、恢复邮箱、TOTP 密钥或代理凭据——本页面写入后也不回显这些值。</p>

      <div class="modal-mask" id="accountsManageModal" hidden>
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="accountsManageModalTitle">
              <div class="modal-h">
                  <div class="card-title" id="accountsManageModalTitle">添加账号</div>
                  <button type="button" class="modal-x" id="accountsManageModalClose" aria-label="关闭">&times;</button>
              </div>
              <p class="hint" id="accountsManageEditNote" hidden></p>
              <form class="form" id="accountsManageForm" autocomplete="off">
              <input type="hidden" name="index" value="">
              <div class="field-grid">
                  <label class="field field-item">邮箱
                      <input class="input" type="email" name="email" required spellcheck="false" placeholder="someone@outlook.com">
                      <span class="field-hint">机器人登录用的账号（必填）</span>
                  </label>
                  <label class="field field-item">密码
                      <input class="input" type="password" name="password" autocomplete="new-password">
                      <span class="field-hint">留空＝保持原值（改密码时才填）</span>
                  </label>
                  <label class="field field-item">TOTP 密钥
                      <input class="input" type="password" name="totpSecret" autocomplete="off">
                      <span class="field-hint">base32 密钥；留空＝保持原值</span>
                  </label>
                  <label class="field field-item">恢复邮箱
                      <input class="input" type="email" name="recoveryEmail" spellcheck="false">
                      <span class="field-hint">可留空（留空＝保持原值）</span>
                  </label>
                  <label class="field field-item">地区
                      <input class="input" type="text" name="geoLocale" spellcheck="false" placeholder="auto">
                      <span class="field-hint">geoLocale，留空则由机器人自己判断</span>
                  </label>
                  <label class="field field-item">语言
                      <input class="input" type="text" name="langCode" spellcheck="false" placeholder="en">
                      <span class="field-hint">langCode，如 zh-CN / en</span>
                  </label>
              </div>
              <div class="form-actions">
                  <button type="submit" class="btn btn-primary btn-small" id="accountsManageSubmit">添加账号</button>
                  <button type="button" class="btn btn-small" id="accountsManageCancel">取消</button>
              </div>
          </form>
          </div>
      </div>
    `;

    U.$("#accountsManageForm", root).addEventListener("submit", (e) => {
      e.preventDefault();
      submitManagedAccount(e.target);
    });

    U.$("#accountsManageReload", root).addEventListener("click", () => loadManage(root));
    U.$("#accountsManageCancel", root).addEventListener("click", () => closeManageModal());
    U.$("#accountsManageAdd", root).addEventListener("click", () => startAddAccount());
    U.$("#accountsManageModalClose", root).addEventListener("click", () => closeManageModal());
    const mask = U.$("#accountsManageModal", root);
    mask.addEventListener("click", (e) => {
      if (e.target === mask) closeManageModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !mask.hidden) closeManageModal();
    });
    loadManage(root);
  },

  // .env 内容不会自己变 —— 本页没有需要轮询的东西，refresh 只记下上下文。
  async refresh(ctx) {
    context = ctx;
  },
};
