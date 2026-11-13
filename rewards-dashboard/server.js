"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { ControlApiClient, entryToDockerLine } = require("./lib/apiClient");
const { EventHub } = require("./lib/eventHub");
const { parseLine } = require("./lib/parser");
const { Store } = require("./lib/store");
const { completedBotOutcome } = require("./lib/outcome");
const { describeCron, isValidCron, nextRun } = require("./lib/cron");
const { Scheduler } = require("./lib/scheduler");
const { transformThemeModule } = require("./lib/tsLite");
const { generateIndexModule, THEMES_DIR } = require("./lib/themeLoader");
const { PendingLoginCodes } = require("./lib/pendingLoginCodes");
const { mergeAccounts } = require("./lib/accounts");
const { ActivityStore } = require("./lib/activityStore");
const { ControlDataStore } = require("./lib/controlData");

// confg
const PORT = Number(process.env.PORT || 8890);
const CONTROL_API_URL =
  process.env.CONTROL_API_URL || "http://microsoft-rewards-script:3010";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DASHBOARD_AUTH_ENABLED = Boolean(
  DASHBOARD_USERNAME && DASHBOARD_PASSWORD,
);
const DISPLAY_NAME = process.env.DASHBOARD_TITLE || "Microsoft Rewards";
const TIMEZONE = process.env.TZ || "UTC";
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 5000));
const LOG_REPLAY = Number(process.env.LOG_REPLAY || 300);
const PUBLIC_DIR = path.join(__dirname, "public");

const client = new ControlApiClient({
  baseUrl: CONTROL_API_URL,
  token: CONTROL_API_TOKEN,
});
const store = new Store();
const pendingLoginCodes = new PendingLoginCodes();

const log = (level, msg) => {
  const line = `[server] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const hub = new EventHub({ client, replay: LOG_REPLAY, log });
// Structured per-activity data from the Control API (/history + /status extras).
const activity = new ActivityStore(store.db, {
  log,
  resetHourUtc: process.env.ACTIVITY_RESET_HOUR_UTC ? Number(process.env.ACTIVITY_RESET_HOUR_UTC) : null,
});
const controlData = new ControlDataStore(store.db);

const scheduler = new Scheduler({
  client,
  store,
  isBusy: () =>
    Boolean(
      backend.bot &&
      backend.bot.state !== "idle" &&
      backend.bot.state !== "unknown",
    ),
  onChange: () => {
    backend.schedule = describeSchedule(scheduler.get());
    hub.broadcast("state", currentState());
  },
  log,
});

function describeSchedule(sched) {
  return {
    ...sched,
    description: sched.enabled
      ? describeCron(sched.cron) || sched.cron
      : "未设置定时任务",
  };
}

// The bot's cron lives inside its own container and has no concept of
// "next run" bookkeeping — it's computed here client-side from the same
// cron grammar the dashboard already uses, purely for display. The actual
// firing is up to the container's OS cron, not this calculation.
function describeRemoteSchedule(sched) {
  if (!sched) return null;
  const next =
    sched.enabled && sched.cron ? nextRun(sched.cron, new Date()) : null;
  return {
    ...sched,
    description:
      sched.enabled && sched.cron
        ? describeCron(sched.cron) || sched.cron
        : "未设置定时任务",
    nextRunAt: next ? next.toISOString() : null,
  };
}

const AUTH_HINT =
  "控制 API 拒绝了令牌，请确保 CONTROL_API_TOKEN 与 API 的 API_TOKEN 一致。";

// live
const backend = {
  reachable: false,
  authRequired: false,
  authOk: true,
  lastError: null,
  checkedAt: null,
  name: null,
  version: null,
  uptimeSec: null,
  bot: null, // last /status payload
  schedule: null,
  remoteSchedule: null, // last GET /schedule payload from the bot's Control API
  remoteScheduleSupported: null, // null = unknown yet, true/false once determined
};

let lastLogId = null;
let lastHealthUptime = null;
let lastHealthyCheckedAt = null;
let controlHistoryKey = null;
let controlHistoryAt = 0;
let controlHistoryRetryAt = 0;
let controlHistoryRequest = null;
let accountCache = { accounts: [], at: 0 };
let accountRequest = null;
let botStatusRevision = 0;

function setBotStatus(status) {
  backend.bot = status;
  botStatusRevision++;
}

// A polling response may arrive after a newer SSE event or another reader.
// Keep that newer snapshot, including when the older request fails.
async function readBotStatus() {
  const revision = botStatusRevision;
  try {
    const status = await client.get("/status");
    if (revision === botStatusRevision) setBotStatus(status);
    return backend.bot;
  } catch (error) {
    if (revision !== botStatusRevision) return backend.bot;
    throw error;
  }
}

function legacyStatus(status) {
  const version = status?.version || backend.version;
  const major = Number.parseInt(version, 10);
  return major > 0 && major < 5 ? { ...status, version } : null;
}

// The v4 API retains full balances only in its latest /status result. Save
// them before the next run resets it, and recover older outcomes from history.
// This storage is independent of the ordered log cursor and is idempotent.
async function syncControlData(status) {
  const snapshot = status && legacyStatus(status);
  if (!snapshot) return;
  if (controlHistoryRequest) {
    await controlHistoryRequest;
    controlData.ingestStatus(snapshot);
    return;
  }

  const now = Date.now();
  const key = snapshot.lastExit?.at || null;
  const due = now >= controlHistoryRetryAt &&
    (!controlHistoryAt || key !== controlHistoryKey || now - controlHistoryAt >= 60000);
  if (!due) {
    controlData.ingestStatus(snapshot);
    return;
  }

  controlHistoryRequest = (async () => {
    try {
      const history = await client.get("/history?limit=100");
      controlData.ingestHistory(history.runs || []);
      controlHistoryKey = key;
      controlHistoryAt = Date.now();
      controlHistoryRetryAt = 0;
    } catch (error) {
      controlHistoryRetryAt = Date.now() + 60000;
      log("warn", `无法同步控制 API 运行历史：${error.message}`);
    }
    controlData.ingestStatus(snapshot);
  })();
  try {
    await controlHistoryRequest;
  } finally {
    controlHistoryRequest = null;
  }
}

// Overview and Accounts request the same roster concurrently. Share the
// sanitized API response so both views count configured accounts consistently.
async function readControlAccounts() {
  if (Date.now() - accountCache.at < 4000)
    return { accounts: accountCache.accounts, apiError: null };
  if (accountRequest) return accountRequest;
  accountRequest = (async () => {
    try {
      const data = await client.get("/accounts");
      accountCache = { accounts: Array.isArray(data.accounts) ? data.accounts : [], at: Date.now() };
      return { accounts: accountCache.accounts, apiError: null };
    } catch (error) {
      return {
        accounts: accountCache.accounts,
        apiError: error.statusCode === 401 ? AUTH_HINT : error.message,
      };
    }
  })();
  try {
    return await accountRequest;
  } finally {
    accountRequest = null;
  }
}

function currentState() {
  const botOutcome = completedBotOutcome(backend.bot);
  return {
    reachable: backend.reachable,
    authRequired: backend.authRequired,
    authOk: backend.authOk,
    lastError: backend.lastError,
    checkedAt: backend.checkedAt,
    displayName: DISPLAY_NAME,
    timezone: TIMEZONE,
    controlApiUrl: CONTROL_API_URL,
    name: backend.name,
    version: backend.version,
    uptimeSec: backend.uptimeSec,
    bot: backend.bot,
    botState: backend.bot ? backend.bot.state : "unknown",
    botOutcome,
    botRunning: Boolean(
      backend.bot &&
      backend.bot.state !== "idle" &&
      botOutcome === null,
    ),
    schedule: backend.schedule,
    remoteSchedule: describeRemoteSchedule(backend.remoteSchedule),
    remoteScheduleSupported: backend.remoteScheduleSupported === true,
    stream: hub.stats,
    lastEventAt: store.lastTs,
    pendingDelay: store.pendingDelay,
    pendingSleep: store.pendingSleep,
    codes: pendingLoginCodes.list(),
  };
}

// live logg sse
hub.on("entry", (entry) => {
  try {
    if (!entry) return;
    if (lastLogId != null && entry.id != null && entry.id <= lastLogId) return;

    const line = entryToDockerLine(entry);
    const event = line ? parseLine(line) : null;
    if (event) {
      // Card progress only exists in this log line; idempotent, so replays are harmless.
      if (event.kind === "punchcard-progress") activity.recordPunchcard(event);
      if (event.kind === "account-skip-v4") activity.recordSkip(event);
      store.apply(event);
      hub.broadcast("state", currentState());
      if (event.kind === "login-number") {
        pendingLoginCodes.add(event.userName, event.number, event.ts);
        hub.broadcast("codes", { codes: pendingLoginCodes.list() });
      } else if (event.kind === "login-number-resolved") {
        pendingLoginCodes.resolve(event.userName);
        hub.broadcast("codes", { codes: pendingLoginCodes.list() });
      }
    }
    if (entry.id != null)
      lastLogId = lastLogId == null ? entry.id : Math.max(lastLogId, entry.id);
  } catch (e) {
    log("warn", `无法处理日志行：${e.message}`);
  }
});

hub.on("status", (status) => {
  const wasRunning = Boolean(backend.bot && backend.bot.state !== "idle");
  setBotStatus(status);
  syncControlData(status).then(() => {
    hub.broadcast("state", currentState());
  }).catch((error) => {
    log("warn", `无法保存控制 API 运行结果：${error.message}`);
  });

  if (status.reason === "exit" && wasRunning && status.lastExit) {
    try {
      // The Control API processes the log itself, so run.totals (set only by
      // RUN-END) tells us the script finished even if this dashboard missed
      // the line.
      store.closeRunOnExit(status.lastExit, {
        summarySeen: Boolean(status.run?.totals),
      });
    } catch (e) {
      log("warn", `无法记录运行退出事件：${e.message}`);
    }
    // Capture /status extras (earnable, searchSummary...) before the next run
    // replaces them, and pull the finished run from /history.
    activity.syncSoon(client, status);
  }

  hub.broadcast("state", currentState());
});

// poll
async function pollOnce() {
  let health;
  try {
    health = await client.get("/health");
  } catch (error) {
    if (error.statusCode !== 401) throw error;
    backend.reachable = true;
    backend.authRequired = true;
    backend.authOk = false;
    backend.lastError = AUTH_HINT;
    backend.checkedAt = new Date().toISOString();
    setBotStatus({ state: "unknown" });
    return;
  }
  backend.reachable = true;
  backend.name = health.name || null;
  backend.version = health.version || null;
  backend.uptimeSec =
    typeof health.uptimeSec === "number" ? health.uptimeSec : null;
  backend.authRequired = health.authRequired === true;
  // Snapshot before overwriting: this is our cutoff for "definitely started
  // before the restart we're about to react to", not this poll's own time.
  const priorHealthyCheckedAt = lastHealthyCheckedAt;
  backend.checkedAt = new Date().toISOString();
  backend.lastError = null;

  if (typeof health.uptimeSec === "number") {
    if (lastHealthUptime != null && health.uptimeSec < lastHealthUptime) {
      log("warn", "控制 API 已重启，正在重置日志读取位置。");
      lastLogId = null;
      // The container (bot + Control API together) can be torn down mid-run
      // for all sorts of ordinary reasons (image update, manual restart,
      // host reboot) - nothing will ever close that run's row on its own
      // since the process that would have logged RUN-END is gone. Close it
      // out now instead of leaving it stuck 'running' until the roster/echo
      // backstop in apply() eventually notices, possibly hours later.
      //
      // The SSE stream can independently notice the same disconnect (its own
      // upstream connection drops) and reconnect faster than our next poll,
      // already tracking a brand new run by the time we get here. Passing
      // notStartedAfter tells the store to only touch a run that was already
      // 'running' as of our last known-good check - never one that could be
      // that legitimate new run.
      try {
        if (
          store.markInterruptedByBackendRestart(new Date().toISOString(), {
            notStartedAfter: priorHealthyCheckedAt,
          })
        ) {
          log("warn", "后端在运行期间重启，已结束停留在运行状态的记录。");
        }
      } catch (e) {
        log("warn", `无法结束已中断的运行记录：${e.message}`);
      }
      hub.markUpstreamRestarted();
    }
    lastHealthUptime = health.uptimeSec;
  }
  lastHealthyCheckedAt = backend.checkedAt;

  if (backend.authRequired && !CONTROL_API_TOKEN) {
    backend.authOk = false;
    backend.lastError =
      "控制 API 需要令牌，请将 CONTROL_API_TOKEN 设置为与其 API_TOKEN 相同的值。";
    setBotStatus({ state: health.state || "unknown" });
    return;
  }

  let authFailed = false;

  try {
    await readBotStatus();
  } catch (e) {
    // Do not keep reporting a previous "running" snapshot when the status
    // endpoint is unavailable (for example while the Control API restarts).
    setBotStatus(null);
    if (e.statusCode === 401) authFailed = true;
    backend.lastError =
      e.statusCode === 401 ? AUTH_HINT : `无法获取状态（${e.message}）`;
  }
  if (backend.bot && !authFailed) {
    try {
      await syncControlData(backend.bot);
    } catch (error) {
      log("warn", `无法保存控制 API 运行结果：${error.message}`);
    }
  }

  // The bot's own /schedule endpoint is optional - older bot images (or ones
  // running without API_ALLOW_SCHEDULE_WRITE) won't have it. A 404 means
  // "not supported, hide the remote scheduler option"; any other error is
  // treated as a transient blip so the UI doesn't flicker the option away.
  try {
    backend.remoteSchedule = await client.get("/schedule");
    backend.remoteScheduleSupported = true;
  } catch (e) {
    backend.remoteSchedule = null;
    if (e.statusCode === 404) backend.remoteScheduleSupported = false;
  }

  backend.schedule = describeSchedule(scheduler.get());

  backend.authOk = !authFailed;
}

async function pollLoop() {
  for (; ;) {
    try {
      await pollOnce();
      // Boot backfill, and a safety net if an exit event was missed.
      if (backend.reachable && backend.authOk && activity.needsSync(backend.bot))
        activity.syncSoon(client, backend.bot);
    } catch (e) {
      backend.reachable = false;
      setBotStatus(null);
      backend.lastError = e.message;
      backend.checkedAt = new Date().toISOString();
    }
    hub.broadcast("state", currentState());
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// helpers
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function safeEqual(value, expected) {
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestBasicCredentials(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;

  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isDashboardAuthorized(req) {
  if (!DASHBOARD_AUTH_ENABLED) return true;

  const credentials = requestBasicCredentials(req);
  return (
    credentials !== null &&
    safeEqual(credentials.username, DASHBOARD_USERNAME) &&
    safeEqual(credentials.password, DASHBOARD_PASSWORD)
  );
}

function requireDashboardAuth(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Rewards Dashboard", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("请登录后访问");
}

function readJsonBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error("请求内容过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求内容不是有效的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function waitForCompletedBotToIdle() {
  if (!completedBotOutcome(backend.bot)) return false;

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await readBotStatus();
    } catch {
      return false;
    }
    hub.broadcast("state", currentState());
    if (status?.state === "idle") return true;
    if (!completedBotOutcome(status)) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function forward(res, method, apiPath, body, retryCompletedStart = true) {
  try {
    const data = await client.request(method, apiPath, { body });
    return sendJson(res, 200, data ?? {});
  } catch (e) {
    const status = e.statusCode || 502;
    if (
      retryCompletedStart &&
      method === "POST" &&
      apiPath === "/start" &&
      status === 409 &&
      await waitForCompletedBotToIdle()
    ) {
      return forward(res, method, apiPath, body, false);
    }
    const payload =
      e.body && typeof e.body === "object"
        ? e.body
        : { error: e.message || "无法连接控制 API" };
    if (status === 401) payload.hint = AUTH_HINT;
    return sendJson(res, status, payload);
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("禁止访问");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("未找到资源");
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
}

function serveThemeIndex(res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(generateIndexModule());
}

function serveThemeFile(res, filename) {
  const filePath = path.join(THEMES_DIR, filename);
  if (!filePath.startsWith(THEMES_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("禁止访问");
  }
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("未找到资源");
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(transformThemeModule(data));
  });
}

// routes
const DIAG_FILES = new Set(["screenshot.png", "error.txt", "dump.html"]);

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || "GET";

  // live
  if (pathname === "/api/events" && method === "GET") {
    return hub.addClient(req, res, currentState());
  }

  // read
  if (pathname === "/api/summary" && method === "GET") {
    const { accounts: configured, apiError } = await readControlAccounts();
    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const histories = controlData.mergeHistories(store.allAccountHistories({ since }), { since });
    return sendJson(res, 200, {
      status: currentState(),
      accounts: mergeAccounts(
        configured,
        controlData.mergeAccounts(store.snapshotAccounts(), backend.bot),
        histories,
        store.accountActivities(),
      ),
      runs: controlData.mergeRuns(store.snapshotRuns(100), { limit: 30 }),
      activity: store.snapshotActivity(120),
      apiError,
    });
  }

  if (pathname === "/api/accounts" && method === "GET") {
    const { accounts: apiAccounts, apiError } = await readControlAccounts();
    const historyDays = Math.min(
      3650,
      Math.max(0, Number(searchParams.get("historyDays")) || 0),
    );
    const effectiveHistoryDays = searchParams.has("historyDays")
      ? historyDays
      : 365;
    const since =
      effectiveHistoryDays > 0
        ? new Date(
          Date.now() - effectiveHistoryDays * 24 * 60 * 60 * 1000,
        ).toISOString()
        : null;
    const histories =
      effectiveHistoryDays > 0
        ? controlData.mergeHistories(store.allAccountHistories({ since }), { since })
        : {};
    return sendJson(res, 200, {
      accounts: mergeAccounts(
        apiAccounts,
        controlData.mergeAccounts(store.snapshotAccounts(), backend.bot),
        histories,
        store.accountActivities(),
      ),
      histories,
      historyDays: effectiveHistoryDays,
      apiError,
    });
  }

  if (pathname === "/api/runs" && method === "GET") {
    const limit = Math.min(
      500,
      Math.max(1, Number(searchParams.get("limit")) || 50),
    );
    let exits = [];
    let apiError = null;
    try {
      const data = await client.get(`/history?limit=${limit}`);
      exits = data.runs || [];
      if (legacyStatus(backend.bot)) {
        controlData.ingestHistory(exits);
        controlData.ingestStatus(backend.bot);
      }
    } catch (e) {
      apiError = e.statusCode === 401 ? AUTH_HINT : e.message;
    }
    return sendJson(res, 200, {
      runs: controlData.mergeRuns(store.snapshotRuns(Math.min(500, limit * 2)), { limit }),
      exits,
      apiError,
    });
  }

  // Per-account, per-Rewards-day activity tables (see lib/activityModel.js).
  if (pathname === "/api/activity-days" && method === "GET") {
    const days = Math.min(
      60,
      Math.max(1, Number(searchParams.get("days")) || 14),
    );
    const p = activity.payload({ days });
    const headers = {
      "Cache-Control": "no-cache", // always revalidate; unchanged data is a 304
      ETag: p.etag,
      Vary: "Accept-Encoding",
    };
    if (req.headers["if-none-match"] === p.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const body = gz ? p.gzip : p.json;
    res.writeHead(200, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...(gz ? { "Content-Encoding": "gzip" } : {}),
    });
    return res.end(body);
  }

  if (pathname === "/api/logs" && method === "GET") {
    const q = new URLSearchParams();
    q.set(
      "limit",
      String(
        Math.min(5000, Math.max(1, Number(searchParams.get("limit")) || 500)),
      ),
    );
    const level = searchParams.get("level");
    if (level) q.set("level", level);
    return forward(res, "GET", `/logs?${q.toString()}`);
  }

  if (pathname === "/api/errors" && method === "GET") {
    const q = new URLSearchParams();
    q.set(
      "limit",
      String(
        Math.min(1000, Math.max(1, Number(searchParams.get("limit")) || 100)),
      ),
    );
    if (searchParams.get("warnings") === "false") q.set("warnings", "false");
    return forward(res, "GET", `/errors?${q.toString()}`);
  }

  if (pathname === "/api/login-codes" && method === "GET") {
    return sendJson(res, 200, { codes: pendingLoginCodes.list() });
  }

  // schedule
  if (pathname === "/api/schedule") {
    if (method === "GET") {
      return sendJson(res, 200, {
        local: describeSchedule(scheduler.get()),
        remote: describeRemoteSchedule(backend.remoteSchedule),
        remoteSupported: backend.remoteScheduleSupported === true,
      });
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const target = body.target === "remote" ? "remote" : "local";
      const patch = { ...body };
      delete patch.target;

      if (target === "remote") {
        if (backend.remoteScheduleSupported !== true) {
          return sendJson(res, 409, {
            error:
              "脚本的控制 API 不支持远程定时任务。请升级脚本镜像并设置 API_ALLOW_SCHEDULE_WRITE=true，或使用面板自带的定时任务。",
          });
        }
        try {
          const updated = await client.put("/schedule", patch);
          backend.remoteSchedule = updated;
          hub.broadcast("state", currentState());
          return sendJson(res, 200, {
            local: describeSchedule(scheduler.get()),
            remote: describeRemoteSchedule(updated),
            remoteSupported: true,
          });
        } catch (e) {
          const status = e.statusCode || 502;
          const payload =
            e.body && typeof e.body === "object"
              ? e.body
              : { error: e.message || "无法连接控制 API" };
          return sendJson(res, status, payload);
        }
      }

      try {
        const updated = scheduler.set(patch);
        return sendJson(res, 200, {
          local: describeSchedule(updated),
          remote: describeRemoteSchedule(backend.remoteSchedule),
          remoteSupported: backend.remoteScheduleSupported === true,
        });
      } catch (e) {
        return sendJson(res, e.code === "BAD_REQUEST" ? 400 : 500, {
          error: e.message,
        });
      }
    }
  }

  if (pathname === "/api/cron" && method === "GET") {
    const expr = searchParams.get("expr") || "";
    const valid = isValidCron(expr);
    return sendJson(res, 200, {
      expr,
      valid,
      description: valid ? describeCron(expr) : null,
      error: valid
        ? null
        : "需要 5 个字段：分钟、小时、日期、月份、星期。",
    });
  }

  // config
  if (pathname === "/api/config") {
    if (method === "GET") {
      const reveal = searchParams.get("reveal") === "1" ? "?reveal=1" : "";
      return forward(res, "GET", `/config${reveal}`);
    }
    if (method === "PUT" || method === "PATCH") {
      const body = await readJsonBody(req);
      return forward(res, method, "/config", body);
    }
  }

  if (pathname === "/api/config/diff" && method === "GET") {
    return forward(res, "GET", "/config/diff");
  }

  if (pathname === "/api/config/sync" && method === "POST") {
    return forward(res, "POST", "/config/sync", {});
  }

  // diag
  if (pathname === "/api/diagnostics" && method === "GET") {
    return forward(res, "GET", "/diagnostics");
  }

  if (pathname.startsWith("/api/diagnostics/") && method === "GET") {
    const parts = pathname
      .slice("/api/diagnostics/".length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts.length !== 2) return sendJson(res, 404, { error: "未找到资源" });
    const [name, file] = parts;
    if (!/^error-[A-Za-z0-9._:-]+$/.test(name) || !DIAG_FILES.has(file)) {
      return sendJson(res, 400, { error: "诊断文件路径无效" });
    }
    try {
      const upstream = await client.stream(
        `/diagnostics/${encodeURIComponent(name)}/${encodeURIComponent(file)}`,
      );
      res.writeHead(200, {
        "Content-Type":
          upstream.headers["content-type"] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      return upstream.pipe(res);
    } catch (e) {
      return sendJson(res, e.statusCode || 502, { error: e.message });
    }
  }

  // sessions
  if (pathname === "/api/sessions" && method === "GET") {
    return forward(res, "GET", "/sessions");
  }

  if (pathname.startsWith("/api/sessions/") && method === "DELETE") {
    const email = pathname.slice("/api/sessions/".length);
    if (!email) return sendJson(res, 400, { error: "缺少账号邮箱" });
    return forward(res, "DELETE", `/sessions/${email}`);
  }

  // dashboard-local account data (separate from the bot's own accounts/
  // sessions, which live on the Control API and are untouched by this)
  if (pathname.startsWith("/api/dashboard-accounts/") && method === "DELETE") {
    const email = decodeURIComponent(
      pathname.slice("/api/dashboard-accounts/".length),
    );
    if (!email) return sendJson(res, 400, { error: "缺少账号邮箱" });
    try {
      controlData.deleteAccount(email);
      store.deleteAccount(email);
      hub.broadcast("state", currentState());
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // control
  if (pathname.startsWith("/api/control/") && method === "POST") {
    const action = pathname.slice("/api/control/".length);
    if (!["start", "stop", "restart", "shutdown"].includes(action)) {
      return sendJson(res, 404, { error: "未知的控制操作" });
    }
    const body = await readJsonBody(req);
    return forward(res, "POST", `/${action}`, body);
  }

  // health
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      controlApi: backend.reachable,
      controlApiAuthOk: backend.authOk,
      streamConnected: hub.connected,
    });
  }

  return sendJson(res, 404, { error: "未找到资源", path: pathname });
}

const server = http.createServer((req, res) => {
  if (!isDashboardAuthorized(req)) return requireDashboardAuth(res);

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/themes/index.js") return serveThemeIndex(res);
  if (pathname.startsWith("/themes/") && pathname.endsWith(".ts")) {
    return serveThemeFile(res, pathname.slice("/themes/".length));
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, url).catch((e) => {
      log("error", `请求失败：${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  }

  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  log("info", `Rewards 面板正在监听端口 ${PORT}`);
  log(
    "info",
    `控制 API：${CONTROL_API_URL}${CONTROL_API_TOKEN ? "（已设置令牌）" : "（未设置令牌）"}`,
  );
  if (!CONTROL_API_TOKEN) {
    log(
      "warn",
      "CONTROL_API_TOKEN 为空，只有控制 API 未设置 API_TOKEN 时才能连接。",
    );
  }
  if (Boolean(DASHBOARD_USERNAME) !== Boolean(DASHBOARD_PASSWORD)) {
    log(
      "warn",
      "面板登录验证已关闭，需要同时设置 DASHBOARD_USERNAME 和 DASHBOARD_PASSWORD 才能启用。",
    );
  }
  log(
    "info",
    `面板登录验证：${DASHBOARD_AUTH_ENABLED ? `已启用（用户名：${DASHBOARD_USERNAME}）` : "已关闭"}`,
  );
  scheduler.init();
  backend.schedule = describeSchedule(scheduler.get());
  hub.start();
  pollLoop();
});

function shutdown() {
  log("info", "正在关闭…");
  scheduler.stop();
  hub.stop();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
