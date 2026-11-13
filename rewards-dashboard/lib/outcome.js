"use strict";

const STOP_EXIT_CODES = [130, 137, 143];
// Mirrors the Store: only these signals mean an intentional stop.
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"];

/**
 * The live verdict on a finished run, from the Control API's /status payload:
 * null while it hasn't finished, otherwise "success" | "stopped" | "error" | "interrupted".
 * (Non-null is also how server.js knows a run is no longer active.)
 *
 * v5 distinguishes a finished run with incomplete features (`partial`) from
 * one that did not finish (`interrupted`). The totals check remains for older
 * Control API versions, which used `partial` for both cases.
 */
function completedBotOutcome(bot) {
  const run = bot?.run;
  if (!run?.finished) return null;

  // Some APIs keep the previous exit while the next run is still finishing.
  // Only use an exit that belongs to this run, or the API's idle snapshot.
  const startedAt = Date.parse(bot.startedAt || run.startedAt);
  const exitedAt = Date.parse(bot.lastExit?.at);
  const exit = bot.state === "idle" ||
    (Number.isFinite(startedAt) && Number.isFinite(exitedAt) && exitedAt >= startedAt)
    ? bot.lastExit : null;
  // An explicit failure outranks anything that merely looks like a stop.
  if (run.status === "failed") return "error";
  if (run.status === "stopped" || run.status === "cancelled") return "stopped";
  if (run.status === "interrupted") return "interrupted";
  if (exit?.error) return "error";
  if (STOP_SIGNALS.includes(exit?.signal) || STOP_EXIT_CODES.includes(exit?.code)) {
    return "stopped";
  }
  // Any other signal (SIGSEGV, SIGABRT...) is the process crashing.
  if (exit?.signal) return "error";
  if (run.status === "partial") return run.totals ? "success" : "error";
  if (exit?.code != null && exit.code !== 0) return "error";
  // v4.3.3 can exit normally after reporting failed activities. Its account
  // result is more specific than the process exit code.
  if (!run.status && (run.accounts || []).some((account) => account.success === false))
    return "error";
  return "success";
}

module.exports = { completedBotOutcome };
