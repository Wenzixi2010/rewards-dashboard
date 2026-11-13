"use strict";

// v4's Control API retains results even when its log wording is unfamiliar to
// the dashboard. Keep those results separate from the log-derived tables: a
// replay or another poll must never insert a second account_history row.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS control_api_runs (
  id TEXT PRIMARY KEY,
  backend_run_id TEXT,
  start_ts TEXT,
  end_ts TEXT NOT NULL,
  version TEXT,
  status TEXT,
  outcome TEXT,
  total_accounts INTEGER,
  accounts_processed INTEGER,
  total_gained REAL,
  old_total REAL,
  new_total REAL,
  runtime_min REAL,
  exit_code INTEGER,
  exit_signal TEXT,
  source_rank INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_runs_end ON control_api_runs(end_ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_runs_backend_id
  ON control_api_runs(backend_run_id) WHERE backend_run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS control_api_account_results (
  run_id TEXT NOT NULL,
  email TEXT NOT NULL,
  initial_points REAL,
  final_points REAL,
  gained REAL,
  duration_sec REAL,
  success INTEGER,
  error TEXT,
  outcome TEXT,
  source_rank INTEGER NOT NULL,
  PRIMARY KEY (run_id, email)
);
CREATE INDEX IF NOT EXISTS idx_control_results_email
  ON control_api_account_results(email, run_id);
CREATE TABLE IF NOT EXISTS control_api_deleted_accounts (
  email TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
`;

const RUN_COLUMNS = [
  "id", "backend_run_id", "start_ts", "end_ts", "version", "status",
  "outcome", "total_accounts", "accounts_processed", "total_gained",
  "old_total", "new_total", "runtime_min", "exit_code", "exit_signal",
  "source_rank",
];
const RESULT_COLUMNS = [
  "run_id", "email", "initial_points", "final_points", "gained",
  "duration_sec", "success", "error", "outcome", "source_rank",
];
const STOP_CODES = new Set([130, 137, 143]);
const STOP_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"]);
const ACTIVE_STATES = new Set(["running", "starting", "stopping", "pending", "sleeping"]);
const ACCOUNT_OUTCOMES = new Set(["completed", "partial", "failed", "cancelled", "skipped"]);
const START_SLOP_MS = 5000;
const END_SLOP_MS = 15000;
// Without a real start, a near-identical end is the only temporal evidence.
// Do not turn an activity snapshot's artificial start into a large window.
const END_ONLY_MS = 2000;

const emailOf = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const textOf = (value) => typeof value === "string" && value.length ? value : null;
const numberOf = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const firstNumber = (...values) => {
  for (const value of values) if (numberOf(value) !== null) return value;
  return null;
};
const millis = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) && Number.isFinite(new Date(n).getTime()) ? n : null;
};
const isoOf = (value) => {
  const n = millis(value);
  return n === null ? null : new Date(n).toISOString();
};
const majorOf = (version) => {
  const match = /^v?(\d+)(?:\.|$)/i.exec(String(version || ""));
  return match ? Number(match[1]) : null;
};
const sameValues = (a, b, columns) => columns.every((key) => a[key] === b[key]);

function runVerdict(exit, outcome = null, accounts = []) {
  const code = numberOf(exit?.code);
  const signal = textOf(exit?.signal);
  if (outcome === "failed" || exit?.error)
    return { status: "crashed", outcome: "failed" };
  if (outcome === "cancelled" || outcome === "stopped" || STOP_CODES.has(code) || STOP_SIGNALS.has(signal))
    return { status: "stopped", outcome: "cancelled" };
  if (outcome === "interrupted") return { status: "interrupted", outcome };
  if (signal || (code !== null && code !== 0))
    return { status: "crashed", outcome: "failed" };
  const partial = accounts.some((account) => account?.success === false || account?.status === "failed" || account?.status === "partial");
  return {
    status: "done",
    outcome: partial && (!outcome || outcome === "completed")
      ? "partial" : outcome || (code === 0 ? "completed" : null),
  };
}

function syntheticAccountResult(error) {
  return /^Run (?:stalled|crashed|interrupted|stopped|skipped|error) before this account finished$/.test(error || "") ||
    error === "Run completed, but this account's own result was never logged (its worker likely failed silently).";
}

function emptyDerivedRun(log, api) {
  return log.accountsProcessed === 0 && api.accounts_processed > 0 &&
    [log.totalGained, log.oldTotal, log.newTotal].every((value) => value == null || value === 0);
}

function pendingHistoryRecord(record, end) {
  // Stage only the same allowlisted result fields that ingestion uses. The
  // API capability hint arrives in ingestStatus immediately after history.
  return {
    runId: textOf(record.runId || record.exit?.runId),
    startedAt: isoOf(record.startedAt), endedAt: end,
    version: textOf(record.version), status: textOf(record.status),
    collected: numberOf(record.collected),
    exit: {
      code: numberOf(record.exit?.code), signal: textOf(record.exit?.signal),
      at: isoOf(record.exit?.at), error: textOf(record.exit?.error),
    },
    accounts: (Array.isArray(record.accounts) ? record.accounts : []).map((account) => ({
      email: emailOf(account?.email), collected: numberOf(account?.collected),
      success: account?.success === true ? true : account?.success === false ? false : null,
      error: textOf(account?.error), status: textOf(account?.status),
      initialPoints: numberOf(account?.initialPoints), finalPoints: numberOf(account?.finalPoints),
      durationSeconds: numberOf(account?.durationSeconds),
    })),
  };
}

function accountStatus(result) {
  if (result.outcome === "skipped") return "skipped";
  if (result.outcome === "cancelled") return "stopped";
  if (result.outcome === "completed" || result.outcome === "partial") return "success";
  if (result.outcome === "failed" || result.success === 0) return "error";
  if (result.success === 1) return "success";
  return result.error ? "error" : "idle";
}

function trimResult(account, source) {
  const email = emailOf(account?.email);
  if (!email) return null;
  let gained = source === "status"
    ? numberOf(account.collectedPoints)
    : numberOf(account.collected);
  // live.gained starts at zero before any result is reported. A positive live
  // gain is evidence; its default zero is not a fabricated completed result.
  if (gained === null && source === "status" && numberOf(account.live?.gained) > 0)
    gained = account.live.gained;
  let balance = source === "legacy"
    ? numberOf(account.currentBalance)
    : firstNumber(account.finalPoints, source === "status" ? account.live?.balance : null);
  let duration = numberOf(account.durationSeconds);
  // Some failed workers report a placeholder 0/0 without a collected result.
  if (source === "status" && account.collectedPoints == null && balance === 0 && duration === 0) {
    balance = null;
    duration = null;
  }
  const success = account.success === true ? 1 : account.success === false ? 0 : null;
  const reported = ACCOUNT_OUTCOMES.has(account.status) ? account.status : null;
  return {
    email,
    initial_points: numberOf(account.initialPoints),
    final_points: balance,
    gained,
    duration_sec: duration,
    success,
    error: textOf(account.error),
    outcome: reported || (success === 1 ? "completed" : success === 0 ? "failed" : null),
  };
}

function historyMatchScore(ts, run) {
  const at = millis(ts);
  const end = millis(run.end_ts);
  const start = millis(run.start_ts);
  if (at === null || end === null) return null;
  if (start !== null) {
    if (at >= start && at <= end) return [0, end - at];
    if (at >= start && at <= end + END_SLOP_MS) return [1, Math.abs(end - at)];
    return null;
  }
  const gap = Math.abs(end - at);
  return gap <= END_ONLY_MS ? [2, gap] : null;
}

function runMatchScore(log, api) {
  if (log.id === api.id || (api.backend_run_id && log.runId === api.backend_run_id)) return [-1, 0];
  const start = millis(api.start_ts);
  const end = millis(api.end_ts);
  const logStart = millis(log.startTs);
  const logEnd = millis(log.endTs);
  if (end === null) return null;
  if (logStart !== null && logStart > end) return null; // a newer active run
  if (start !== null && logStart !== null && logStart < start - START_SLOP_MS) return null;
  if (start !== null && logEnd !== null && logEnd < start) return null;
  if (start !== null && logStart !== null && logStart >= start && logStart <= end && emptyDerivedRun(log, api))
    return [2, Math.abs(logStart - start)];
  if (logEnd === null) {
    // An open log row can be closed only by the API's actual run window.
    return start !== null && logStart !== null && logStart >= start && logStart <= end
      ? [2, Math.abs(logStart - start)] : null;
  }
  const gap = Math.abs(logEnd - end);
  if (start === null) return gap <= END_ONLY_MS ? [3, gap] : null;
  if (logStart !== null && Math.abs(logStart - start) <= START_SLOP_MS && logEnd <= end + END_SLOP_MS)
    return [0, Math.abs(logStart - start) + gap];
  return gap <= END_SLOP_MS ? [1, gap] : null;
}

function betterScore(a, b) {
  return b === null || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** Durable, allowlisted v4 API results, merged into the Store's read shapes. */
class ControlDataStore {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
    this._major = null;
    this._pendingHistory = new Map();
    this._legacyImported = false;
    db.exec(SCHEMA);
    this.stmts = {
      runById: db.prepare("SELECT * FROM control_api_runs WHERE id = ?"),
      runByBackendId: db.prepare("SELECT * FROM control_api_runs WHERE backend_run_id = ?"),
      runsByEnd: db.prepare("SELECT * FROM control_api_runs WHERE end_ts = ? ORDER BY source_rank DESC"),
      runs: db.prepare("SELECT * FROM control_api_runs ORDER BY end_ts DESC"),
      writeRun: db.prepare(`INSERT INTO control_api_runs (${RUN_COLUMNS.join(", ")})
        VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})
        ON CONFLICT(id) DO UPDATE SET ${RUN_COLUMNS.filter((key) => key !== "id").map((key) => `${key} = excluded.${key}`).join(", ")}`),
      result: db.prepare("SELECT * FROM control_api_account_results WHERE run_id = ? AND email = ?"),
      resultsForRun: db.prepare("SELECT * FROM control_api_account_results WHERE run_id = ?"),
      results: db.prepare(`SELECT a.*, r.start_ts, r.end_ts, r.status AS run_status,
        r.outcome AS run_outcome, r.version
        FROM control_api_account_results a JOIN control_api_runs r ON r.id = a.run_id
        ORDER BY r.end_ts DESC, a.email ASC`),
      writeResult: db.prepare(`INSERT INTO control_api_account_results (${RESULT_COLUMNS.join(", ")})
        VALUES (${RESULT_COLUMNS.map(() => "?").join(", ")})
        ON CONFLICT(run_id, email) DO UPDATE SET ${RESULT_COLUMNS.filter((key) => key !== "run_id" && key !== "email").map((key) => `${key} = excluded.${key}`).join(", ")}`),
      deleted: db.prepare("SELECT deleted_at FROM control_api_deleted_accounts WHERE email = ?"),
      deletedAll: db.prepare("SELECT email, deleted_at FROM control_api_deleted_accounts"),
      markDeleted: db.prepare(`INSERT INTO control_api_deleted_accounts (email, deleted_at)
        VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET deleted_at = excluded.deleted_at`),
      deleteResults: db.prepare("DELETE FROM control_api_account_results WHERE email = ?"),
      legacyTable: db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'run_account_snapshots'"),
    };
    this._importLegacy();
  }

  _transaction(fn) {
    // SAVEPOINT also works if the caller already has a transaction open.
    this.db.exec("SAVEPOINT control_data_write");
    try {
      const result = fn();
      this.db.exec("RELEASE control_data_write");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO control_data_write");
      this.db.exec("RELEASE control_data_write");
      throw error;
    }
  }

  _allowed(email, run) {
    const deleted = this.stmts.deleted.get(email);
    if (!deleted) return true;
    const cutoff = millis(deleted.deleted_at);
    const start = millis(run.start_ts);
    const end = millis(run.end_ts);
    // A missing start cannot prove that an account belongs to a new run after
    // deletion. The same run's /history record supplies that evidence.
    return end > cutoff && start !== null && start > cutoff;
  }

  _writeRun(incoming) {
    let current = incoming.backend_run_id
      ? this.stmts.runByBackendId.get(incoming.backend_run_id) : null;
    if (!current) {
      current = this.stmts.runsByEnd.all(incoming.end_ts).find((row) =>
        !incoming.backend_run_id || !row.backend_run_id || row.backend_run_id === incoming.backend_run_id,
      );
    }
    const id = current?.id || (incoming.backend_run_id
      ? `control:id:${incoming.backend_run_id}` : `control:end:${incoming.end_ts}`);
    const next = { id };
    for (const key of RUN_COLUMNS) {
      if (key === "id") continue;
      if (key === "source_rank") {
        next[key] = Math.max(incoming[key], current?.[key] || 0);
      } else {
        const value = incoming[key] ?? null;
        next[key] = value !== null && (!current || value === current[key] || incoming.source_rank >= current.source_rank || current[key] == null)
          ? value : current?.[key] ?? null;
      }
    }
    if (!current || !sameValues(current, next, RUN_COLUMNS)) {
      this.stmts.writeRun.run(...RUN_COLUMNS.map((key) => next[key]));
      return { row: next, changed: 1 };
    }
    return { row: current, changed: 0 };
  }

  _writeResult(run, result, rank) {
    if (!result || !this._allowed(result.email, run)) return 0;
    const current = this.stmts.result.get(run.id, result.email);
    const next = { run_id: run.id, email: result.email };
    for (const key of RESULT_COLUMNS) {
      if (key === "run_id" || key === "email") continue;
      if (key === "source_rank") {
        next[key] = Math.max(rank, current?.source_rank || 0);
      } else if (key === "error" && result.success === 1 && result.error === null && (!current || rank >= current.source_rank)) {
        next[key] = null; // a newer clean result clears an older failure
      } else {
        const value = result[key] ?? null;
        next[key] = value !== null && (!current || rank >= current.source_rank || current[key] == null)
          ? value : current?.[key] ?? null;
      }
    }
    if (current && sameValues(current, next, RESULT_COLUMNS)) return 0;
    this.stmts.writeResult.run(...RESULT_COLUMNS.map((key) => next[key]));
    return 1;
  }

  _fillTotals(runId) {
    const run = this.stmts.runById.get(runId);
    const results = this.stmts.resultsForRun.all(runId);
    if (!results.length) return 0;
    const next = { ...run };
    if (next.accounts_processed === null) next.accounts_processed = results.length;
    const completeRoster = next.accounts_processed === results.length;
    if (completeRoster) {
      for (const [field, column] of [["total_gained", "gained"], ["old_total", "initial_points"], ["new_total", "final_points"]]) {
        if (next[field] === null && results.every((row) => row[column] !== null))
          next[field] = results.reduce((sum, row) => sum + row[column], 0);
      }
    }
    if (sameValues(run, next, RUN_COLUMNS)) return 0;
    this.stmts.writeRun.run(...RUN_COLUMNS.map((key) => next[key]));
    return 1;
  }

  _importLegacy() {
    if (this._legacyImported || !this.stmts.legacyTable.get()) return;
    const groups = new Map();
    for (const row of this.db.prepare("SELECT email, ended_at, snapshot FROM run_account_snapshots").all()) {
      let stored;
      try { stored = JSON.parse(row.snapshot); } catch { continue; }
      if (stored?.account?.schema !== "v4") continue;
      const end = isoOf(stored.endedAt || row.ended_at);
      if (!end) continue;
      const result = trimResult({ ...stored.account, email: stored.email || row.email }, "legacy");
      if (!result) continue;
      if (!groups.has(end)) groups.set(end, []);
      groups.get(end).push(result);
    }
    this._transaction(() => {
      for (const [end, results] of groups) {
        // v4RunToEntries set startedAt = endedAt only for day grouping. Never
        // import that start or derive a zero runtime from it.
        const { row: run } = this._writeRun({ end_ts: end, status: "done", source_rank: 1 });
        for (const result of results) this._writeResult(run, result, 1);
        this._fillTotals(run.id);
      }
    });
    this._legacyImported = true;
  }

  /** Upsert GET /history.runs. Returns the number of changed independent rows. */
  ingestHistory(records) {
    this._importLegacy();
    return this._transaction(() => {
      let changed = 0;
      for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record !== "object") continue;
        const end = isoOf(record.endedAt || record.exit?.at);
        if (!end) continue;
        const major = majorOf(record.version);
        if (major !== 4 && !(major === null && this._major === 4)) {
          if (major === null && this._major === null) {
            this._pendingHistory.set(end, pendingHistoryRecord(record, end));
            if (this._pendingHistory.size > 100) {
              const oldest = [...this._pendingHistory.keys()].sort()[0];
              this._pendingHistory.delete(oldest);
            }
          }
          continue;
        }
        let start = isoOf(record.startedAt);
        if (start && millis(start) > millis(end)) start = null;
        const accounts = Array.isArray(record.accounts) ? record.accounts : [];
        const verdict = runVerdict(record.exit, textOf(record.status), accounts);
        const { row: run, changed: runChanged } = this._writeRun({
          backend_run_id: textOf(record.runId || record.exit?.runId),
          start_ts: start,
          end_ts: end,
          version: textOf(record.version),
          ...verdict,
          accounts_processed: accounts.length,
          total_gained: numberOf(record.collected),
          runtime_min: start ? (millis(end) - millis(start)) / 60000 : null,
          exit_code: numberOf(record.exit?.code),
          exit_signal: textOf(record.exit?.signal),
          source_rank: 2,
        });
        changed += runChanged;
        for (const account of accounts)
          changed += this._writeResult(run, trimResult(account, "history"), 2);
        changed += this._fillTotals(run.id);
      }
      return changed;
    });
  }

  /** Capture the latest v4 run only after the API process has actually exited. */
  ingestStatus(status) {
    this._importLegacy();
    const version = status?.run?.version || status?.version;
    const major = majorOf(version);
    if (major !== null) this._major = major;
    let deferredChanges = 0;
    if (this._major !== null && this._pendingHistory.size) {
      const pending = [...this._pendingHistory.values()];
      this._pendingHistory.clear();
      if (this._major === 4) deferredChanges = this.ingestHistory(pending);
    }
    if (major !== 4 && !(major === null && this._major === 4)) return 0;
    if (status?.state !== "idle") return deferredChanges;
    const summary = status?.run;
    const end = isoOf(status?.lastExit?.at);
    if (!summary || !end) return deferredChanges;
    // run.finished can become true before exit, while lastExit is still the
    // preceding run's exit. Requiring idle prevents that preceding key from
    // receiving new balances. v4 clears startedAt on idle; a cached active
    // start could belong to a missed earlier run, so only /history is trusted
    // to fill that start through the matching end key.
    const start = isoOf(summary.startedAt || status.startedAt);
    if (start && millis(start) >= millis(end)) return deferredChanges;
    const accounts = Array.isArray(summary.accounts) ? summary.accounts : [];
    const totals = summary.totals || {};
    const verdict = runVerdict(status.lastExit, textOf(summary.status), accounts);
    const changed = this._transaction(() => {
      const written = this._writeRun({
        backend_run_id: textOf(summary.runId || status.lastExit?.runId),
        start_ts: start,
        end_ts: end,
        // /history identifies the actual child version. The API server's
        // package version is only a capability hint when the run omits it.
        version: textOf(summary.version),
        ...verdict,
        total_accounts: numberOf(summary.accountsTotal),
        accounts_processed: firstNumber(totals.accountsProcessed, accounts.length),
        total_gained: firstNumber(totals.collected, summary.collected),
        old_total: numberOf(totals.oldTotal),
        new_total: numberOf(totals.newTotal),
        runtime_min: numberOf(totals.runtimeMinutes),
        exit_code: numberOf(status.lastExit?.code),
        exit_signal: textOf(status.lastExit?.signal),
        source_rank: 3,
      });
      let count = written.changed;
      for (const account of accounts)
        count += this._writeResult(written.row, trimResult(account, "status"), 3);
      count += this._fillTotals(written.row.id);
      return count;
    });
    return changed + deferredChanges;
  }

  _sameAccountRun(local, result) {
    const start = millis(local.lastStartAt);
    const end = millis(result.end_ts);
    if (start !== null && start > end) return false;
    return historyMatchScore(local.lastEndAt, result) !== null;
  }

  /** Supplement Store.snapshotAccounts(), preserving its metadata and newer rows. */
  mergeAccounts(observed, status = null) {
    this._importLegacy();
    const byEmail = new Map();
    for (const row of Array.isArray(observed) ? observed : []) {
      const email = emailOf(row?.email);
      if (email && !byEmail.has(email)) byEmail.set(email, { ...row });
    }
    const latest = new Map();
    const balances = new Map();
    for (const result of this.stmts.results.all()) {
      if (!latest.has(result.email)) latest.set(result.email, result);
      if (result.final_points !== null && !balances.has(result.email)) balances.set(result.email, result);
    }
    for (const [email, result] of latest) {
      const local = byEmail.get(email);
      const row = local || { email, status: "idle" };
      const apiEnd = millis(result.end_ts);
      const localEnd = millis(row.lastEndAt);
      const localStart = millis(row.lastStartAt);
      const newerLive = ACTIVE_STATES.has(row.status) && (localStart === null || localStart > apiEnd);
      const synthetic = syntheticAccountResult(row.lastError);
      const apiStart = millis(result.start_ts);
      const syntheticWindow = synthetic && localStart !== null && apiStart !== null && localStart >= apiStart && localStart <= apiEnd;
      const sameRun = local && (this._sameAccountRun(row, result) || syntheticWindow);
      const newerLog = localEnd !== null && localEnd > apiEnd && !sameRun;
      if (!newerLive && !newerLog) {
        if (sameRun && synthetic && result.success === 1) {
          // These exact diagnostics are synthesized by Store's watchdogs,
          // not ACCOUNT-END/ACCOUNT-ERROR evidence. A confirmed API result
          // repairs their stale status, timestamp and retained older metrics.
          row.status = accountStatus(result);
          row.lastEndAt = result.end_ts;
          row.lastGained = result.gained;
          row.lastPoints = result.final_points ?? row.lastPoints ?? balances.get(email)?.final_points ?? null;
          row.lastDurationSec = result.duration_sec;
          row.lastError = result.error;
          row.lastOutcome = result.outcome;
        } else if (sameRun && !ACTIVE_STATES.has(row.status)) {
          // A log account end has the precise account timestamp and outcome.
          // The API can fill absent metrics without replacing that evidence.
          if (row.lastPoints == null && result.final_points !== null) row.lastPoints = result.final_points;
          if (row.lastGained == null && result.gained !== null) row.lastGained = result.gained;
          if (row.lastDurationSec == null && result.duration_sec !== null) row.lastDurationSec = result.duration_sec;
          if (row.lastOutcome == null && result.outcome !== null) row.lastOutcome = result.outcome;
          if (!row.lastStartAt && result.start_ts) row.lastStartAt = result.start_ts;
        } else {
          row.status = accountStatus(result);
          row.lastStartAt = result.start_ts || row.lastStartAt || null;
          row.lastEndAt = result.end_ts;
          row.lastGained = result.gained;
          row.lastPoints = result.final_points ?? row.lastPoints ?? balances.get(email)?.final_points ?? null;
          row.lastDurationSec = result.duration_sec;
          row.lastError = result.error;
          row.lastOutcome = result.outcome;
        }
      }
      byEmail.set(email, row);
    }
    this._mergeLiveAccounts(byEmail, status);
    return [...byEmail.values()];
  }

  _mergeLiveAccounts(byEmail, status) {
    const major = majorOf(status?.version || status?.run?.version);
    if ((major !== 4 && !(major === null && this._major === 4)) || !status || status.state === "idle") return;
    const start = isoOf(status.startedAt);
    const startMs = millis(start);
    const deleted = new Map(this.stmts.deletedAll.all().map((row) => [row.email, millis(row.deleted_at)]));
    for (const account of Array.isArray(status.run?.accounts) ? status.run.accounts : []) {
      const email = emailOf(account?.email);
      if (!email) continue;
      if (deleted.has(email) && (startMs === null || startMs <= deleted.get(email))) continue;
      const updated = isoOf(account.live?.lastUpdateTs);
      const updatedMs = millis(updated);
      if (startMs !== null && updatedMs !== null && updatedMs < startMs) continue;
      const local = byEmail.get(email);
      const row = local || { email, status: "idle" };
      const logEnd = millis(row.lastEndAt);
      const logStart = millis(row.lastStartAt);
      const lastObserved = Math.max(logEnd ?? -Infinity, logStart ?? -Infinity);
      if (updatedMs !== null && updatedMs < lastObserved) continue;
      // Without an account update timestamp, only a genuinely newer process
      // start (or an entirely new row) can replace existing log evidence.
      const canReplace = updatedMs !== null || !local || (startMs !== null && startMs > lastObserved);
      const result = trimResult(account, "status");
      const endedThisRun = startMs !== null && logEnd !== null && logEnd >= startMs && !ACTIVE_STATES.has(row.status);
      const hasCompleteResult = result.final_points !== null && result.duration_sec !== null && account.collectedPoints != null;
      if (!endedThisRun && canReplace) {
        row.status = hasCompleteResult ? accountStatus(result) : "running";
        if (start && (logStart === null || logStart < startMs)) row.lastStartAt = start;
        row.lastOutcome = hasCompleteResult ? result.outcome : null;
        if (hasCompleteResult && updated) row.lastEndAt = updated;
        if (hasCompleteResult) row.lastError = result.error;
      }
      // These are live display values, never durable completed snapshots.
      if ((!endedThisRun && canReplace) || row.lastPoints == null) {
        const balance = result.final_points;
        if (balance !== null) row.lastPoints = balance;
      }
      if ((!endedThisRun && canReplace) || row.lastGained == null) {
        const gain = firstNumber(account.collectedPoints, account.live?.gained);
        if (gain !== null) row.lastGained = gain;
      }
      if (result.duration_sec !== null && ((!endedThisRun && canReplace) || row.lastDurationSec == null))
        row.lastDurationSec = result.duration_sec;
      byEmail.set(email, row);
    }
  }

  /** Merge point history by account and actual run window, never by balance. */
  mergeHistories(histories, { since = null } = {}) {
    this._importLegacy();
    const cutoff = millis(since);
    const out = Object.create(null);
    const keys = new Map();
    for (const [email, rows] of Object.entries(histories || {})) {
      const normalized = emailOf(email);
      if (!normalized) continue;
      const key = keys.get(normalized) || email;
      keys.set(normalized, key);
      out[key] ||= [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (cutoff === null || (millis(row.ts) !== null && millis(row.ts) >= cutoff))
          out[key].push({ ...row });
      }
    }
    const byEmail = new Map();
    for (const result of this.stmts.results.all()) {
      if (cutoff !== null && millis(result.end_ts) < cutoff) continue;
      if (!byEmail.has(result.email)) byEmail.set(result.email, []);
      byEmail.get(result.email).push(result);
    }
    for (const [email, results] of byEmail) {
      const key = keys.get(email) || email;
      const rows = out[key] || [];
      const matches = new Map();
      // Assign each log point to at most one API run. A strict real window
      // takes precedence over another run's nearby end at a boundary.
      for (let index = 0; index < rows.length; index++) {
        let best = null;
        let score = null;
        for (const result of results) {
          const candidate = historyMatchScore(rows[index].ts, result);
          if (candidate && betterScore(candidate, score)) { best = result; score = candidate; }
        }
        if (!best) continue;
        const current = matches.get(best.run_id);
        if (!current || betterScore(score, current.score)) matches.set(best.run_id, { index, score });
      }
      for (const result of results) {
        if (cutoff !== null && millis(result.end_ts) < cutoff) continue;
        const match = matches.get(result.run_id);
        if (match) {
          const row = rows[match.index];
          if (row.points == null && result.final_points !== null) row.points = result.final_points;
          if (row.gained == null && result.gained !== null) row.gained = result.gained;
          if (row.durationSec == null && result.duration_sec !== null) row.durationSec = result.duration_sec;
        } else if (result.final_points !== null) {
          rows.push({ ts: result.end_ts, points: result.final_points, gained: result.gained, durationSec: result.duration_sec });
        }
      }
      if (rows.length) {
        rows.sort((a, b) => (millis(a.ts) ?? 0) - (millis(b.ts) ?? 0));
        out[key] = rows;
      }
    }
    return out;
  }

  _runShape(run) {
    return {
      id: run.id,
      status: run.status || "done",
      startTs: run.start_ts,
      endTs: run.end_ts,
      version: run.version,
      totalAccounts: run.total_accounts,
      clusters: null,
      accountsProcessed: run.accounts_processed,
      totalGained: run.total_gained,
      oldTotal: run.old_total,
      newTotal: run.new_total,
      runtimeMin: run.runtime_min,
      exitCode: run.exit_code,
      exitSignal: run.exit_signal,
      outcome: run.outcome,
    };
  }

  /** Merge completed API runs with log rows; a matched log row keeps its id. */
  mergeRuns(logRuns, { limit = 30 } = {}) {
    this._importLegacy();
    const logs = (Array.isArray(logRuns) ? logRuns : []).map((run) => ({ ...run }));
    const apiRuns = this.stmts.runs.all();
    const assigned = new Map();
    for (let index = 0; index < logs.length; index++) {
      let best = null;
      let score = null;
      for (const api of apiRuns) {
        const candidate = runMatchScore(logs[index], api);
        if (candidate && betterScore(candidate, score)) { best = api; score = candidate; }
      }
      if (!best) continue;
      const current = assigned.get(best.id);
      if (!current || betterScore(score, current.score)) assigned.set(best.id, { index, score });
    }
    for (const api of apiRuns) {
      const shape = this._runShape(api);
      const match = assigned.get(api.id);
      if (!match) {
        logs.push(shape);
        continue;
      }
      const row = logs[match.index];
      const emptyDerived = emptyDerivedRun(row, api);
      const correctSyntheticStatus = emptyDerived && row.status !== "skipped" &&
        ["stalled", "interrupted", "crashed", "error"].includes(row.status) &&
        row.exitCode == null && row.exitSignal == null && row.outcome !== "failed";
      for (const [key, value] of Object.entries(shape))
        if (key !== "id" && row[key] == null && value !== null) row[key] = value;
      if (emptyDerived) {
        // _closeRunningRun derives all of these zeroes from an empty point
        // history. A real zero-gain account run has processed > 0 and does
        // not enter this branch. Adopt only fields the API actually knows.
        for (const key of ["accountsProcessed", "totalGained", "oldTotal", "newTotal", "runtimeMin"])
          if (shape[key] !== null) row[key] = shape[key];
        if (shape.endTs) row.endTs = shape.endTs;
        if (correctSyntheticStatus) {
          row.status = shape.status;
          row.outcome = shape.outcome;
        }
      }
      // The completed API record can resolve an open row whose end log was
      // missed. It cannot consume a newer active row outside its real window.
      if (ACTIVE_STATES.has(row.status)) row.status = shape.status;
    }
    logs.sort((a, b) => (millis(b.startTs || b.endTs) ?? 0) - (millis(a.startTs || a.endTs) ?? 0));
    const count = numberOf(limit);
    return logs.slice(0, count === null ? 30 : Math.max(0, Math.floor(count)));
  }

  /** Delete this source's account results and persist its replay cutoff. */
  deleteAccount(email) {
    const normalized = emailOf(email);
    if (!normalized) return 0;
    return this._transaction(() => {
      const removed = Number(this.stmts.deleteResults.run(normalized).changes);
      this.stmts.markDeleted.run(normalized, new Date().toISOString());
      return removed;
    });
  }
}

module.exports = { ControlDataStore };
