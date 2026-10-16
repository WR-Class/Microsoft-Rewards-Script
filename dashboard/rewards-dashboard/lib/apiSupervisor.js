"use strict";

// 把控制 API 从"死了"变回"活着"。
//
// 为什么必须在面板自己的进程里做：面板访问控制 API 的唯一通道就是 API 本身
// （server.js 里的 /api/control/* 全是 forward）。API 一死就没有接收方，所以一个
// "转发式"的启动按钮，恰恰在最需要它的那种情况下必然失效。
//
// 为什么必须 detached + unref：2026-10-16 实测，从一个终端的进程树里起的 API 会
// 跟着那个终端一起被带走 —— 日志停在就绪行、没有任何关机记录。同理，面板自己重启
// 也不能把 API 带走，否则按一次按钮只换来一个短命进程。
//
// 命令完全由配置拼出来，请求体里的值一概不参与。这个端点是执行进程的，一旦接受
// 外部传入的路径或命令，它就是一个远程执行漏洞。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// API 启动成功后会自己打印这一行（scripts/api/server.js 的 __API_READY__）。全仓库
// 没有别的东西消费它 —— 它是留给"启动者"的握手信号，比 sleep 猜时长可靠：能区分
// "真的起来了"和"起了一半又死了"。
const READY_PREFIX = "__API_READY__";

function parseReadyLine(line) {
  if (typeof line !== "string") return null;
  const text = line.trim();
  if (!text.startsWith(READY_PREFIX)) return null;
  try {
    return JSON.parse(text.slice(READY_PREFIX.length).trim());
  } catch {
    return null;
  }
}

// 从一段日志里取最后一条就绪记录。API 的 stdout 是追加进 api.log 的，所以"有没有
// 起来"这件事在文件里也留了证据，不必只看端口。
function readReadyFromTail(text) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseReadyLine(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

function launchSpec({ execPath, repoRoot, port }) {
  return {
    command: execPath,
    args: [
      "--env-file-if-exists=.env",
      path.join("scripts", "api", "server.js"),
      "--port",
      String(port),
    ],
    cwd: repoRoot,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probePort(port, host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function createApiSupervisor({
  execPath,
  repoRoot,
  host = "127.0.0.1",
  port,
  logDir,
  readyTimeoutMs = 45000,
  pollMs = 500,
  probe = probePort,
  spawnFn = spawn,
  now = Date.now,
  log = () => {},
}) {
  const logPath = path.join(logDir, "api.log");
  const errPath = path.join(logDir, "api.log.err");

  // 只读日志尾部：整份 api.log 会很大（实测 3.4 MB），取末尾一块就够找就绪行。
  function tail(bytes = 8192) {
    try {
      const size = fs.statSync(logPath).size;
      const from = Math.max(0, size - bytes);
      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      return buf.toString("utf8");
    } catch {
      return "";
    }
  }

  async function start() {
    if (!repoRoot) return { started: false, reason: "no-repo-root" };

    // 先确认真有东西可起。在容器里部署时面板与 API 不同机，这条会直接挡住，
    // 而不是留下一个按了没反应的按钮。
    const spec = launchSpec({ execPath, repoRoot, port });
    const script = path.join(repoRoot, spec.args[1]);
    if (!fs.existsSync(script)) {
      return { started: false, reason: "script-missing", script };
    }

    // 已经在监听就什么都不做。和 scripts/win/start-services.ps1 同一条规矩：否则按
    // 两次就起两份，第二份抢不到端口，日志里全是报错。
    if (await probe(port, host)) return { started: false, reason: "already-listening" };

    let out = "ignore";
    let err = "ignore";
    try {
      fs.mkdirSync(logDir, { recursive: true });
      out = fs.openSync(logPath, "a");
      err = fs.openSync(errPath, "a");
    } catch (e) {
      log("warn", `控制 API 的日志打不开，本次改为丢弃：${e.message}`);
      out = "ignore";
      err = "ignore";
    }

    const child = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true, // 脱离面板：面板重启不会带走它
      stdio: ["ignore", out, err],
    });
    child.unref?.();
    // 子进程已经拿到自己的描述符，父进程这份可以关掉，免得每按一次泄一个 fd。
    for (const fd of [out, err]) {
      if (typeof fd === "number") {
        try {
          fs.closeSync(fd);
        } catch {
          /* 已经关了就算了 */
        }
      }
    }

    let exited = null;
    child.once?.("exit", (code, signal) => {
      exited = { code, signal };
    });

    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      if (exited) {
        return { started: false, reason: "exited-early", pid: child.pid, exit: exited };
      }
      if (await probe(port, host)) {
        return { started: true, pid: child.pid, ready: readReadyFromTail(tail()) };
      }
      await sleep(pollMs);
    }
    return { started: false, reason: "timeout", pid: child.pid };
  }

  return { start, tail, spec: () => launchSpec({ execPath, repoRoot, port }) };
}

module.exports = {
  READY_PREFIX,
  parseReadyLine,
  readReadyFromTail,
  launchSpec,
  probePort,
  createApiSupervisor,
};
