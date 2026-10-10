"use strict";

// Who may make the dashboard write credentials to disk.
//
// The dashboard binds every interface by default (server.listen(PORT)) and
// ships with authentication disabled, so "can load the page" must not imply
// "can write secrets into the bot's .env". Access is therefore explicit and
// doubly conditional:
//
//   * the operator named the target file (BOT_ENV_PATH), so the feature is off
//     unless someone deliberately turned it on, and
//   * the request is either authenticated (dashboard auth enabled) or comes
//     from this machine.
//
// Kept in its own module so the predicate can be unit-tested against addresses
// a real socket on this host cannot produce.

const LOOPBACK_EXACT = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackAddress(address) {
  if (typeof address !== "string" || !address) return false;
  if (LOOPBACK_EXACT.has(address)) return true;
  // The whole 127/8 block is loopback, and IPv4-mapped IPv6 peers arrive with
  // the ::ffff: prefix.
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

function credentialWriteAllowed({ remoteAddress, dashboardAuthEnabled, envPath }) {
  if (!envPath) {
    return {
      allowed: false,
      status: 409,
      error: "面板未配置 BOT_ENV_PATH，账号写入功能是关闭的。",
      hint: "在面板的 .env 里把 BOT_ENV_PATH 指向机器人目录下的 .env，然后重启面板。",
    };
  }

  if (dashboardAuthEnabled) return { allowed: true };
  if (isLoopbackAddress(remoteAddress)) return { allowed: true };

  return {
    allowed: false,
    status: 403,
    error: "为安全起见，只有本机请求可以写账号。",
    hint: "设置 DASHBOARD_USERNAME / DASHBOARD_PASSWORD 开启面板登录后，才允许其他机器写入。",
  };
}

module.exports = { isLoopbackAddress, credentialWriteAllowed };
