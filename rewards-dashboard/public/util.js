export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) =>
  Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, html = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  if (html) node.innerHTML = html;
  return node;
}

// fomrat

const DASH = "\u2013";
const LOCALE = "zh-CN";

export function fmtNumber(n) {
  if (n == null || Number.isNaN(n)) return DASH;
  return Number(n).toLocaleString(LOCALE);
}

export function fmtSigned(n) {
  if (n == null || Number.isNaN(n)) return DASH;
  return (n > 0 ? "+" : "") + Number(n).toLocaleString(LOCALE);
}

export function fmtDateTime(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(LOCALE, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtTime(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const date = `${get("year")}年${get("month")}月${get("day")}日`;
  const clock = `${get("hour")}:${get("minute")}:${get("second")}`;
  return `${date} ${clock}`;
}

export function fmtRelative(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const elapsed = Date.now() - d.getTime();
  const suffix = elapsed < 0 ? "后" : "前";
  const mins = Math.round(Math.abs(elapsed) / 60000);
  if (mins < 1) return elapsed < 0 ? "即将" : "刚刚";
  if (mins < 60) return `${mins} 分钟${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时${suffix}`;
  return `${Math.round(hours / 24)} 天${suffix}`;
}

// Like fmtRelative, but keeps the smaller unit so long-running items read
// "2h 15m ago" instead of rounding to "2h ago". Floors (never rounds up) so
// 1h 40m can't show as "2h". Used only where the extra precision matters.
export function fmtRelativeDetailed(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours} 小时 ${remMins} 分钟前` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days} 天 ${remHours} 小时前` : `${days} 天前`;
}

export function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return DASH;
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m} 分钟 ${s} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分钟`;
}

export function fmtUptime(sec) {
  if (sec == null) return DASH;
  if (sec < 60) return `${Math.round(sec)} 秒`;
  return fmtDuration(sec);
}

// Whole seconds left in the wrapper's pre-run sleep, or null when not
// sleeping (no sleep reported, already elapsed, or the bot is running).
export function sleepRemainingSec(status) {
  const sleep = status?.pendingSleep;
  if (!sleep || status?.botRunning) return null;
  const remaining = Math.ceil(
    sleep.seconds - (Date.now() - Date.parse(sleep.sinceTs)) / 1000,
  );
  return Number.isFinite(remaining) && remaining > 0 ? remaining : null;
}

// day bucket

let timeZone = null;
export function setTimeZone(tz) {
  timeZone = tz || null;
}

export function tzDateParts(instant) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function tzDayKey(instant) {
  const { year, month, day } = tzDateParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isoWeekStartKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

export function localDateLabel(key, options) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(LOCALE, options);
}

// Buckets history rows by day, using the TRUE point movement detected
// between consecutive check-ins (points[i] - points[i-1]) rather than
// summing each row's own self-reported `gained` value. A run only reports
// what IT did (e.g. searches/activities), but the account's visible balance
// can also move between runs from other sources (delayed credit posting,
// Xbox/GamePass rewards, manual redemption reversals, etc.) - summing
// self-reported gained silently drops that movement from "today" and the
// heatmap. A detected change is attributed to the day it was OBSERVED
// (the later row's day), not any day it may have actually been earned on,
// since that's the only thing the dashboard can ever know for certain.
export function bucketByDay(history) {
  const days = new Map();
  let prevPoints = null;
  for (const h of history) {
    const trueGained = prevPoints == null ? (h.gained ?? 0) : h.points - prevPoints;
    prevPoints = h.points;

    const { year, month, day } = tzDateParts(h.ts);
    const dayKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!days.has(dayKey)) {
      days.set(dayKey, {
        dayKey,
        weekKey: isoWeekStartKey(year, month, day),
        gained: 0,
        lastTotal: h.points,
      });
    }
    const bucket = days.get(dayKey);
    bucket.gained += trueGained;
    bucket.lastTotal = h.points;
  }
  return [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

// toooooooooooooooast

let toastHost = null;

// Translate known internal messages only when displaying them. Parsers and
// status checks continue to receive the original log and error strings.
const DISPLAY_MESSAGES = new Map([
  ["Run stalled before this account finished", "运行停滞，账号尚未完成"],
  ["Microsoft bot-score warning detected", "检测到 Microsoft 的自动化行为评分警告"],
  ["Run completed, but this account's own result was never logged (its worker likely failed silently).", "运行已结束，但未收到此账号的运行结果，处理该账号的进程可能已异常退出。"],
  ["started", "已启动"],
  ["started after dashboard restart", "已在面板重启后启动"],
  ["skipped (a run was already in progress)", "已跳过（已有任务正在运行）"],
  ["skipped (the API already had a run active)", "已跳过（控制 API 中已有任务正在运行）"],
  ["missed run skipped after dashboard restart", "已在面板重启后跳过错过的运行"],
]);

export function displayMessage(message) {
  if (message == null) return "";
  const text = String(message);
  const known = DISPLAY_MESSAGES.get(text);
  if (known) return known;

  const unfinished = /^Run (stalled|stopped|interrupted|crashed) before this account finished$/.exec(text);
  if (unfinished) {
    const states = { stalled: "停滞", stopped: "停止", interrupted: "中断", crashed: "崩溃" };
    return `运行已${states[unfinished[1]]}，账号尚未完成`;
  }
  const skipped = /^Skipped: (.+)$/.exec(text);
  if (skipped) return `已跳过：${skipped[1]}`;
  const failed = /^failed: (.+)$/.exec(text);
  if (failed) return `启动失败：${displayMessage(failed[1])}`;
  const missed = /^missed run skipped \(outside (\d+)-minute grace period\)$/.exec(text);
  if (missed) return `已跳过错过的运行（已超过 ${missed[1]} 分钟的补偿期限）`;

  return text;
}

export function toast(message, kind = "info", ms = 4000) {
  if (!toastHost) {
    toastHost = el("div", {
      class: "toast-host",
      role: "status",
      "aria-live": "polite",
    });
    document.body.appendChild(toastHost);
  }
  const node = el(
    "div",
    { class: `toast toast--${kind}` },
    escapeHtml(displayMessage(message)),
  );
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add("toast--out");
    setTimeout(() => node.remove(), 200);
  }, ms);
}

// ticker

// Renders `text` into `container` as plain content by default. On mobile
// (or always, if mobileOnly is false), if the content actually overflows
// the element's width, it's promoted to a scrolling ticker instead of
// being clipped or wrapped - otherwise it stays a normal static line.
// Shared by any component that needs this (run-progress meta, the
// control-strip detail line, etc.) rather than each one reimplementing it.
//
// Callers may invoke this very frequently (once per SSE state push, easily
// several times a second during an active run), so this updates text in
// place and only touches the ticker/animation state when the overflow
// status actually changes - rebuilding the DOM (and restarting the CSS
// animation) on every call would mean a multi-second scroll animation
// never gets the uninterrupted time it needs to complete a single loop.
// Activating vs deactivating also uses different thresholds (hysteresis):
// a line sitting right at the fits/doesn't-fit boundary would otherwise
// flip in and out of ticker mode on consecutive renders, resetting the
// animation each time and looking like it never moves at all.
//
// The track is duplicated (each copy carrying a trailing `separator` once
// ticking, so the loop doesn't run text directly into itself) and the pair
// (the wrap) animated from 0 to -50% of its own combined width - i.e.
// exactly one copy's width - so the loop hands off seamlessly: no blank
// lead-in, no snap-back partway through.
export function renderTicker(
  container,
  text,
  { mobileOnly = true, separator = "\u00a0\u00a0\u2022\u00a0\u00a0" } = {},
) {
  text = text ?? "";

  let wrap = container.querySelector(":scope > .ticker-track-wrap");
  let track;
  let clone;

  if (wrap) {
    track = wrap.querySelector(".ticker-track:not([aria-hidden])");
    clone = wrap.querySelector(".ticker-track[aria-hidden]");
  } else {
    container.classList.add("ticker");
    container.innerHTML = "";
    wrap = el("span", { class: "ticker-track-wrap" });
    track = el("span", { class: "ticker-track" });
    wrap.appendChild(track);
    container.appendChild(wrap);
  }

  const wasTicker = container.classList.contains("is-ticker");
  const displayText = wasTicker ? text + separator : text;
  if (track.textContent !== displayText) {
    track.textContent = displayText;
    if (clone) clone.textContent = displayText;
  }

  const isMobile = !mobileOnly || window.matchMedia("(max-width: 768px)").matches;

  if (!text || !isMobile) {
    if (wasTicker) {
      container.classList.remove("is-ticker");
      container.style.removeProperty("--ticker-duration");
      clone?.remove();
      track.textContent = text;
    }
    return;
  }

  // Needs the mobile CSS's overflow:hidden/white-space:nowrap already in
  // effect on `container` to measure correctly.
  const overflowing = track.scrollWidth > container.clientWidth + 1;
  const clearlyFits = track.scrollWidth <= container.clientWidth - 6;

  if (overflowing && !wasTicker) {
    container.classList.add("is-ticker");
    track.textContent = text + separator;
    clone = track.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    wrap.appendChild(clone);
    // ~40px/sec, clamped so very short overflow doesn't whip by and very
    // long lines don't take forever to loop.
    const seconds = Math.min(30, Math.max(8, Math.round(track.scrollWidth / 40)));
    container.style.setProperty("--ticker-duration", `${seconds}s`);
  } else if (clearlyFits && wasTicker) {
    container.classList.remove("is-ticker");
    container.style.removeProperty("--ticker-duration");
    clone?.remove();
    track.textContent = text;
  }
  // Otherwise the overflow status is unchanged - leave the animation
  // running uninterrupted even though the text may have just been updated.
}

// other

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const PILLS = {
  full: ["pill-success", "全部完成"],
  success: ["pill-success", "成功"],
  partial: ["pill-warn", "部分完成"],
  skipped: ["pill-idle", "已跳过"],
  done: ["pill-success", "已完成"],
  error: ["pill-error", "错误"],
  crashed: ["pill-error", "已崩溃"],
  interrupted: ["pill-warn", "已中断"],
  stopped: ["pill-warn", "已停止"],
  stalled: ["pill-warn", "已停滞"],
  running: ["pill-running", "运行中"],
  starting: ["pill-running", "启动中"],
  stopping: ["pill-warn", "停止中"],
  pending: ["pill-pending", "等待中"],
  sleeping: ["pill-pending", "延迟启动"],
  idle: ["pill-idle", "空闲"],
};

const STATUS_ALIASES = {
  full: "success",
  done: "success",
  completed: "success",
  partial: "success",
  crashed: "error",
  failed: "error",
  cancelled: "stopped",
};

export function runAccountMap(status) {
  return new Map(
    (status?.bot?.run?.accounts || [])
      .filter((account) => account?.email)
      .map((account) => [account.email.trim().toLowerCase(), account]),
  );
}

export function accountDisplayStatus(account, runAccount, runActive = false) {
  const watchdogStall =
    account.status === "error" &&
    account.lastError === "Run stalled before this account finished";
  if (watchdogStall && runActive && runAccount && runAccount.success == null)
    return "running";
  return account.status;
}

export function pillParts(status) {
  const normalized = STATUS_ALIASES[status] || status;
  const [cls] = PILLS[normalized] || PILLS.idle;
  const [, label] = PILLS[status] || PILLS[normalized] || PILLS.idle;
  return { cls, label };
}

export function statusPill(status, title = "") {
  const { cls, label } = pillParts(status);
  const attr = title ? ` title="${escapeAttr(displayMessage(title))}"` : "";
  return `<span class="pill ${cls}"${attr}>${label}</span>`;
}
