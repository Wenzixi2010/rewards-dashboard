"use strict";

const { isValidCron, nextRun } = require("./cron");

const MISFIRE_POLICIES = new Set(["skip", "run-on-startup", "grace-period"]);
const DEFAULT = {
  enabled: false,
  cron: "0 9 * * *",
  skipIfRunning: true,
  misfirePolicy: "skip",
  misfireGraceMinutes: 60,
  excludedAccountIndexes: [],
};

class Scheduler {
  /**
   * @param client   ControlApiClient - used only to POST /start
   * @param store    Store            - persists the schedule across restarts
   * @param isBusy   () => boolean    - is a run already in progress?
   * @param onChange ()               - called when state changes, so the UI repaints
   * @param log      (level, msg)
   */
  constructor({
    client,
    store,
    isBusy = () => false,
    onChange = () => { },
    log = () => { },
  }) {
    this.client = client;
    this.store = store;
    this.isBusy = isBusy;
    this.onChange = onChange;
    this.log = log;

    this.config = { ...DEFAULT };
    this.timer = null;
    this.nextRunAt = null;
    this.lastTriggeredAt = null;
    this.lastResult = null;
    this.lastHandledScheduledAt = null;
    this.firing = false;
  }

  init() {
    const saved = this.store.getSchedule();
    const missedScheduledAt = saved?.nextRunAt || null;
    if (saved && typeof saved === "object") {
      this.config = {
        enabled: Boolean(saved.enabled),
        cron: typeof saved.cron === "string" ? saved.cron : DEFAULT.cron,
        skipIfRunning: saved.skipIfRunning !== false,
        misfirePolicy: MISFIRE_POLICIES.has(saved.misfirePolicy)
          ? saved.misfirePolicy
          : DEFAULT.misfirePolicy,
        misfireGraceMinutes: Number.isFinite(Number(saved.misfireGraceMinutes))
          ? Math.max(
            1,
            Math.min(1440, Math.round(Number(saved.misfireGraceMinutes))),
          )
          : DEFAULT.misfireGraceMinutes,
        excludedAccountIndexes: this._normalizeExcluded(
          saved.excludedAccountIndexes || [],
        ),
      };
      this.lastTriggeredAt = saved.lastTriggeredAt || null;
      this.lastResult = saved.lastResult || null;
      this.lastHandledScheduledAt = saved.lastHandledScheduledAt || null;
    }
    this._arm();
    this._recoverMissedRun(missedScheduledAt);
    this.log(
      "info",
      this.config.enabled
        ? `定时任务已启用（${this.config.cron}），下次运行：${this.nextRunAt ? this.nextRunAt.toISOString() : "无"}。`
        : "定时任务已停用。",
    );
    return this.get();
  }

  get() {
    const valid = isValidCron(this.config.cron);
    return {
      enabled: this.config.enabled,
      cron: this.config.cron,
      skipIfRunning: this.config.skipIfRunning,
      misfirePolicy: this.config.misfirePolicy,
      misfireGraceMinutes: this.config.misfireGraceMinutes,
      excludedAccountIndexes: [...this.config.excludedAccountIndexes],
      valid,
      error: valid ? null : "Cron 表达式无效，需要包含 5 个字段。",
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      lastTriggeredAt: this.lastTriggeredAt,
      lastResult: this.lastResult,
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    };
  }

  set(patch = {}) {
    const next = { ...this.config };

    if ("cron" in patch) {
      if (typeof patch.cron !== "string" || !isValidCron(patch.cron)) {
        const err = new Error(
          'Cron 表达式无效，需要包含 5 个字段，例如 "0 9 * * *"。',
        );
        err.code = "BAD_REQUEST";
        throw err;
      }
      next.cron = patch.cron.trim();
    }
    if ("enabled" in patch) next.enabled = Boolean(patch.enabled);
    if ("skipIfRunning" in patch)
      next.skipIfRunning = Boolean(patch.skipIfRunning);
    if ("misfirePolicy" in patch) {
      if (!MISFIRE_POLICIES.has(patch.misfirePolicy)) {
        const err = new Error("错过运行时的处理策略无效。");
        err.code = "BAD_REQUEST";
        throw err;
      }
      next.misfirePolicy = patch.misfirePolicy;
    }
    if ("misfireGraceMinutes" in patch) {
      const minutes = Number(patch.misfireGraceMinutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        const err = new Error(
          "错过运行的补偿期限必须在 1 到 1440 分钟之间。",
        );
        err.code = "BAD_REQUEST";
        throw err;
      }
      next.misfireGraceMinutes = Math.round(minutes);
    }
    if ("excludedAccountIndexes" in patch) {
      next.excludedAccountIndexes = this._normalizeExcluded(
        patch.excludedAccountIndexes,
      );
    }

    this.config = next;
    this._persist();
    this._arm();
    this.log(
      "info",
      next.enabled ? `定时任务已更新：${next.cron}` : "定时任务已停用。",
    );
    this.onChange();
    return this.get();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  _persist() {
    this.store.setSchedule({
      ...this.config,
      lastTriggeredAt: this.lastTriggeredAt,
      lastResult: this.lastResult,
      lastHandledScheduledAt: this.lastHandledScheduledAt,
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
    });
  }

  _arm() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;

    if (!this.config.enabled) {
      this._persist();
      return;
    }

    const next = nextRun(this.config.cron, new Date());
    if (!next) return;
    this.nextRunAt = next;

    // setTimeout caps out around 24.8 days; for anything further away, wake
    // up early and re-arm rather than silently never firing.
    const MAX_DELAY = 2 ** 31 - 1;
    const delay = Math.max(0, next.getTime() - Date.now());
    if (delay > MAX_DELAY) {
      this.timer = setTimeout(() => this._arm(), MAX_DELAY);
    } else {
      const scheduledAt = next.toISOString();
      this.timer = setTimeout(() => this._fire({ scheduledAt }), delay);
    }
    if (this.timer.unref) this.timer.unref();
    this._persist();
  }

  async _fire({
    scheduledAt = new Date().toISOString(),
    recovered = false,
  } = {}) {
    if (this.firing) return;
    this.firing = true;
    this.lastTriggeredAt = new Date().toISOString();
    this.lastHandledScheduledAt = scheduledAt;

    try {
      if (this.config.skipIfRunning && this.isBusy()) {
        this.lastResult = "已跳过（已有任务正在运行）";
        this.log(
          "warn",
          "已跳过定时运行，已有任务正在运行。",
        );
      } else {
        try {
          const body = this.config.excludedAccountIndexes.length
            ? { excludedAccountIndexes: this.config.excludedAccountIndexes }
            : {};
          await this.client.post("/start", body);
          this.lastResult = recovered
            ? "已在面板重启后启动"
            : "已启动";
          this.log(
            "info",
            recovered
              ? "已在面板重启后补充启动错过的定时任务。"
              : "定时任务已启动。",
          );
        } catch (e) {
          this.lastResult =
            e.statusCode === 409
              ? "已跳过（控制 API 中已有任务正在运行）"
              : `启动失败：${e.message}`;
          this.log("warn", `定时任务无法启动：${e.message}`);
        }
      }
    } finally {
      this._persist();
      this._arm(); // queue the following occurrence
      this.onChange();
      this.firing = false;
    }
  }

  _normalizeExcluded(value) {
    if (!Array.isArray(value)) {
      const err = new Error(
        "排除账号必须以账号序号数组的形式提供。",
      );
      err.code = "BAD_REQUEST";
      throw err;
    }
    const indexes = [...new Set(value.map(Number))];
    if (indexes.some((index) => !Number.isSafeInteger(index) || index < 1)) {
      const err = new Error(
        "排除账号的序号必须为正整数。",
      );
      err.code = "BAD_REQUEST";
      throw err;
    }
    return indexes.sort((a, b) => a - b);
  }

  _recoverMissedRun(scheduledAt) {
    if (
      !this.config.enabled ||
      !scheduledAt ||
      scheduledAt === this.lastHandledScheduledAt
    )
      return;
    const due = new Date(scheduledAt);
    if (Number.isNaN(due.getTime()) || due.getTime() > Date.now()) return;

    const ageMinutes = Math.max(0, (Date.now() - due.getTime()) / 60000);
    const shouldRun =
      this.config.misfirePolicy === "run-on-startup" ||
      (this.config.misfirePolicy === "grace-period" &&
        ageMinutes <= this.config.misfireGraceMinutes);

    if (shouldRun) {
      setTimeout(() => void this._fire({ scheduledAt, recovered: true }), 0);
      return;
    }

    this.lastHandledScheduledAt = scheduledAt;
    this.lastResult =
      this.config.misfirePolicy === "grace-period"
        ? `已跳过错过的运行（已超过 ${this.config.misfireGraceMinutes} 分钟的补偿期限）`
        : "已在面板重启后跳过错过的运行";
    this.log(
      "warn",
      `面板离线期间错过了 ${scheduledAt} 的定时运行。`,
    );
    this._persist();
    this.onChange();
  }
}

module.exports = { Scheduler };
