"use strict";

// Reads and edits the *bot's* .env - the file `loadAccounts()` parses in
// Microsoft-Rewards-Script/src/util/Load.ts. Two rules govern everything here.
//
//  1. The bot's parser is deliberately simple: split at the first "=", trim
//     both sides, strip one pair of surrounding quotes, no escape sequences.
//     parseEnvLine() implements exactly those rules, and formatEnvValue()
//     re-parses its own output with them - so a value this module writes is a
//     value the bot will actually read back. A credential that round-trips
//     wrong is worse than a refused write, so an unrepresentable value throws
//     instead of being written approximately.
//  2. The file is shared with settings this module knows nothing about
//     (proxies, fingerprint flags, unrelated app config). Edits therefore
//     touch single KEY=value lines in place: comments, blank lines, unknown
//     keys and the file's line-ending style all survive untouched.

const fs = require("node:fs");

// The per-account keys the bot's loadAccounts() actually reads. Anything else
// matching ACCOUNT_<n>_* belongs to some other feature and is never rewritten
// by an update; a removal takes the whole ACCOUNT_<n>_* group so a later
// account reusing that index cannot silently inherit a stale proxy.
const MANAGED_FIELDS = [
  { key: "EMAIL", label: "email", secret: false, trim: true },
  { key: "PASSWORD", label: "password", secret: true, trim: false },
  { key: "TOTP_SECRET", label: "totpSecret", secret: true, trim: true },
  { key: "RECOVERY_EMAIL", label: "recoveryEmail", secret: false, trim: true },
  { key: "GEO_LOCALE", label: "geoLocale", secret: false, trim: true },
  { key: "LANG_CODE", label: "langCode", secret: false, trim: true },
];

const INDEX_EMAIL_RE = /^ACCOUNT_(\d+)_EMAIL$/;

// Mirrors Microsoft-Rewards-Script/src/util/Load.ts:45-57 exactly.
function parseEnvLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;

  const key = trimmed.slice(0, eq).trim();
  if (!key) return null;

  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

// Try the plain form first, then a quoted form, and accept only a candidate
// that this module's own parser reads back byte-identical. That single check
// covers every awkward value - surrounding whitespace, a leading "#", a value
// that is itself quoted - without a hand-written escaping table that could
// drift from the bot's real parser.
function formatEnvValue(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error("值不能包含换行符（.env 无法表示）。");
  }

  for (const candidate of [text, `"${text}"`]) {
    const parsed = parseEnvLine(`KEY=${candidate}`);
    if (parsed && parsed.value === text) return candidate;
  }

  throw new Error("这个值写进 .env 后无法原样读回，已拒绝写入。");
}

function readEnvText(envPath) {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function detectNewline(text) {
  return text && text.includes("\r\n") ? "\r\n" : "\n";
}

// A text ending in a newline splits into a trailing "" element, which is what
// makes join() reproduce the original file byte for byte. New lines go before
// that element so the final-newline style is preserved.
function toLines(text) {
  return text === null ? [] : text.split(/\r?\n/);
}

function appendPosition(lines) {
  return lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function keyPattern(key) {
  return new RegExp(`^\\s*${key}\\s*=`);
}

function setKeyLine(lines, key, value) {
  const pattern = keyPattern(key);
  const line = `${key}=${formatEnvValue(value)}`;

  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      const next = lines.slice();
      next[i] = line;
      return { lines: next, updated: true };
    }
  }

  const next = lines.slice();
  next.splice(appendPosition(next), 0, line);
  return { lines: next, updated: false };
}

function accountIndexes(lines) {
  const found = new Set();
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const match = INDEX_EMAIL_RE.exec(parsed.key);
    if (match && parsed.value) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

function findIndexByEmail(lines, email) {
  const wanted = String(email).trim().toLowerCase();
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (!INDEX_EMAIL_RE.test(parsed.key)) continue;
    if (parsed.value.trim().toLowerCase() === wanted) {
      return Number(INDEX_EMAIL_RE.exec(parsed.key)[1]);
    }
  }
  return 0;
}

function nextIndex(lines) {
  const indexes = accountIndexes(lines);
  return indexes.length ? Math.max(...indexes) + 1 : 1;
}

function readAccount(lines, index) {
  const values = {};
  for (const field of MANAGED_FIELDS) {
    const key = `ACCOUNT_${index}_${field.key}`;
    const pattern = keyPattern(key);
    const line = lines.find((l) => pattern.test(l));
    values[field.label] = line ? parseEnvLine(line)?.value ?? "" : "";
  }

  // Secrets are reported as presence only. The API and the UI never need the
  // value back, and a value that is never returned cannot leak through a log,
  // a snapshot or a devtools panel.
  return {
    index,
    email: values.email,
    recoveryEmail: values.recoveryEmail,
    geoLocale: values.geoLocale,
    langCode: values.langCode,
    hasPassword: Boolean(values.password),
    hasTotpSecret: Boolean(values.totpSecret),
  };
}

function listAccounts(envPath) {
  const text = readEnvText(envPath);
  if (text === null) return [];
  const lines = toLines(text);
  return accountIndexes(lines).map((index) => readAccount(lines, index));
}

function writeEnvFile(envPath, lines, previousText) {
  const body = lines.join(detectNewline(previousText));
  const final = previousText === null && !body.endsWith("\n") ? `${body}\n` : body;

  // One rollback point. The previous contents are copied aside before writing,
  // so a bad edit is recoverable without re-entering any credential.
  if (previousText !== null) {
    try {
      fs.copyFileSync(envPath, `${envPath}.bak`);
    } catch {
      // A missing backup must not block the edit the operator asked for.
    }
  }

  fs.writeFileSync(envPath, final, { encoding: "utf8", mode: 0o600 });
}

function upsertAccount(envPath, input) {
  const email = String(input.email ?? "").trim();
  if (!email) throw new Error("邮箱不能为空。");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确。");

  const previousText = readEnvText(envPath);
  let lines = toLines(previousText);

  // An existing account with the same email is updated where it already sits,
  // so re-adding an account never leaves two entries for one mailbox.
  let index = Number(input.index) > 0 ? Number(input.index) : findIndexByEmail(lines, email);
  let created = false;
  if (!index) {
    index = nextIndex(lines);
    created = true;
  }

  const values = {
    EMAIL: email,
    PASSWORD: input.password,
    TOTP_SECRET: input.totpSecret,
    RECOVERY_EMAIL: input.recoveryEmail,
    GEO_LOCALE: input.geoLocale,
    LANG_CODE: input.langCode,
  };

  for (const field of MANAGED_FIELDS) {
    const raw = values[field.key];
    if (raw === undefined || raw === null) continue;
    const value = field.trim ? String(raw).trim() : String(raw);
    // An empty field means "leave what is already there", so editing the email
    // of an existing account cannot silently erase its password.
    if (value === "") continue;
    lines = setKeyLine(lines, `ACCOUNT_${index}_${field.key}`, value).lines;
  }

  writeEnvFile(envPath, lines, previousText);
  return { index, created };
}

function removeAccount(envPath, index) {
  const numeric = Number(index);
  if (!Number.isInteger(numeric) || numeric < 1) throw new Error("账号索引不合法。");

  const previousText = readEnvText(envPath);
  if (previousText === null) return { removed: false };

  const pattern = new RegExp(`^\\s*ACCOUNT_${numeric}_`);
  const kept = toLines(previousText).filter((line) => !pattern.test(line));
  const removed = kept.length !== toLines(previousText).length;
  if (!removed) return { removed: false };

  writeEnvFile(envPath, kept, previousText);
  return { removed: true };
}

module.exports = {
  MANAGED_FIELDS,
  parseEnvLine,
  formatEnvValue,
  listAccounts,
  upsertAccount,
  removeAccount,
};
