// 控制 API 启动器的回归测试。
//
// 这个模块的能力是"执行进程"，所以测试重点不是它能不能起来，而是它**不会**做
// 什么：不接受外部输入的路径或命令、已经在监听就绝不起第二份、没有脚本可起时
// 直接拒绝而不是留个按了没反应的按钮。真正的拉起在验收里做一次，单元测试只钉
// 这些判据。
//
// 用法：node tools/test-api-supervisor.mjs   （退出码 0 = 全过）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  parseReadyLine,
  readReadyFromTail,
  launchSpec,
  createApiSupervisor,
} = require(path.join(here, "..", "lib", "apiSupervisor.js"));
const { isLoopbackAddress } = require(path.join(here, "..", "lib", "netAccess.js"));

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-sup-"));
// 造一个"仓库"：启动器要求 scripts/api/server.js 真的在。
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "scripts", "api"), { recursive: true });
fs.writeFileSync(path.join(repo, "scripts", "api", "server.js"), "// fake\n");
const logs = path.join(tmp, "logs");
const fakeChild = (pid) => ({ pid, unref() {}, once() {} });

console.log("[1] 就绪行解析：只认自己那一行，坏 JSON 不算数");
{
  const r = parseReadyLine(
    '__API_READY__ {"host":"127.0.0.1","port":3010,"pid":31748,"auth":true}',
  );
  ok("解析真实就绪行", Boolean(r) && r.port === 3010 && r.pid === 31748);
  ok("普通日志行返回 null", parseReadyLine("[api] [INFO] listening") === null);
  ok("坏 JSON 返回 null", parseReadyLine("__API_READY__ {oops") === null);
  ok("非字符串返回 null", parseReadyLine(null) === null);
}

console.log("[2] 从日志尾部取最后一条就绪记录");
{
  const text = [
    "[api] [INFO] Log backfill: 8682/8682",
    '__API_READY__ {"port":3010,"pid":1}',
    "[api] [INFO] 跑了一整天",
    '__API_READY__ {"port":3010,"pid":2}',
    "",
  ].join("\n");
  const r = readReadyFromTail(text);
  ok("取到的是最后一条（pid=2）", Boolean(r) && r.pid === 2);
  ok("空文本返回 null", readReadyFromTail("") === null);
}

console.log("[3] 命令完全由配置拼出，请求体不参与");
{
  const spec = launchSpec({ execPath: "C:\\node.exe", repoRoot: repo, port: 3010 });
  ok("可执行文件来自配置", spec.command === "C:\\node.exe");
  ok("cwd 是仓库根", spec.cwd === repo);
  ok(
    "参数里带脚本与端口",
    spec.args.includes("3010") &&
      spec.args.some((a) => a.endsWith(path.join("api", "server.js"))),
  );
  const other = launchSpec({ execPath: "C:\\node.exe", repoRoot: repo, port: 3999 });
  ok(
    "只有端口会变（没有隐藏输入）",
    JSON.stringify(spec.args).replace("3010", "3999") === JSON.stringify(other.args),
  );
}

console.log("[4] 已经在监听：绝不起第二份");
{
  let spawned = 0;
  const sup = createApiSupervisor({
    execPath: "node",
    repoRoot: repo,
    port: 3010,
    logDir: logs,
    probe: async () => true,
    spawnFn: () => {
      spawned += 1;
      return fakeChild(1);
    },
  });
  const r = await sup.start();
  ok("返回 already-listening", r.started === false && r.reason === "already-listening");
  ok("一次都没 spawn", spawned === 0);
}

console.log("[5] 拒绝的三种情况：没有仓库根 / 没有脚本 / 起不来");
{
  const noRoot = createApiSupervisor({
    execPath: "node",
    repoRoot: "",
    port: 3010,
    logDir: logs,
    probe: async () => false,
    spawnFn: () => fakeChild(1),
  });
  ok("推不出仓库根 → no-repo-root", (await noRoot.start()).reason === "no-repo-root");

  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty, { recursive: true });
  const noScript = createApiSupervisor({
    execPath: "node",
    repoRoot: empty,
    port: 3010,
    logDir: logs,
    probe: async () => false,
    spawnFn: () => fakeChild(1),
  });
  ok("容器式部署（没有脚本可起）→ script-missing", (await noScript.start()).reason === "script-missing");

  const slow = createApiSupervisor({
    execPath: "node",
    repoRoot: repo,
    port: 3010,
    logDir: logs,
    readyTimeoutMs: 40,
    pollMs: 10,
    probe: async () => false,
    spawnFn: () => fakeChild(4242),
  });
  const r3 = await slow.start();
  ok("一直没监听 → timeout 且带上 pid", r3.reason === "timeout" && r3.pid === 4242);
}

console.log("[6] 闸门用的就是账号写入那条判据");
{
  ok("本机 IPv4 放行", isLoopbackAddress("127.0.0.1") === true);
  ok("本机 IPv6 放行", isLoopbackAddress("::1") === true);
  ok("局域网地址不放行", isLoopbackAddress("192.168.1.5") === false);
  ok("公网地址不放行", isLoopbackAddress("8.8.8.8") === false);
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows 上偶发占用，清理失败不该把全过的测试变成失败 */
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
