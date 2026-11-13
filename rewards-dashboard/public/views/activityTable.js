import * as U from "../util.js";

/**
 * Renders one account's activity accounting for one Rewards day:
 *   - a points table (one row per activity group, expandable to its items)
 *   - a reconciliation footer (collected vs attributed vs unattributed)
 *   - a streak board and streak/level facts
 *
 * Input comes from GET /api/activity-days (see lib/activityModel.js). Every
 * function here is pure: state (selected day, expanded rows) is owned by the
 * caller and passed in.
 */

const STATES = {
  done: { label: "已完成", icon: "ph-check-circle", cls: "done" },
  // v4 reports points per source but never says an activity was completed.
  reported: { label: "已上报", icon: "ph-receipt", cls: "reported" },
  partial: { label: "部分完成", icon: "ph-circle-half", cls: "partial" },
  unverified: { label: "未验证", icon: "ph-question", cls: "unverified" },
  unavailable: { label: "未提供", icon: "ph-prohibit", cls: "unavailable" },
  attention: { label: "需关注", icon: "ph-warning-circle", cls: "attention" },
  pending: { label: "待完成", icon: "ph-clock", cls: "pending" },
  "n/a": { label: "不适用", icon: "ph-minus-circle", cls: "na" },
};

// Plain-language text for the cause codes produced by classifyDetail() and the
// script's own reason codes. Unknown codes fall back to the script's message.
const CAUSE_TEXT = {
  confirmed: "已确认",
  "not-offered": "此账号未提供该活动",
  "likely-not-offered": "可能未提供（此账号没有连续签到记录）",
  "listed-without-card": "Microsoft 已列出该活动，但页面上没有对应卡片",
  "not-applicable": "不适用",
  "quota-unavailable": "无法读取额度",
  "activation-data-unavailable": "无法读取活动数据",
  "offer-not-confirmed": "尚未确认完成",
  "claim-not-confirmed": "尚未确认领取",
  "claimable-bonus-unknown": "可领取的奖励未知",
  "offer-progress-unchanged": "未检测到进度变化",
  "switch-unavailable": "无法确认",
  "desktop-token-unavailable": "无法确认",
  "ambiguous-target": "脚本无法确定应点击的按钮",
  "activation-control-missing": "页面上未找到操作控件",
  "search-attempt-limit-reached": "已达到搜索尝试次数上限",
  "earn-pass-incomplete": "赚取积分页面的操作未完成",
  "step-incomplete": "此步骤尚未完成",
  failed: "失败",
};

const humanize = (code) =>
  String(code || "")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

const shorten = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}\u2026` : text);

// A failure's own error text is the useful part ("net::ERR_HTTP2_PROTOCOL_ERROR"),
// so show it instead of a bare "Failed".
const causeText = (item) =>
  item.cause === "failed" && item.message
    ? `失败：${shorten(U.displayMessage(item.message), 140)}`
    : CAUSE_TEXT[item.cause] || (item.message ? U.displayMessage(item.message) : "") || humanize(item.cause || item.reason);

export function stateChip(state, labelOverride, iconOverride) {
  const s = STATES[state] || STATES["n/a"];
  return `<span class="act-state act-state--${s.cls}"><i class="ph ${iconOverride || s.icon}" aria-hidden="true"></i>${U.escapeHtml(labelOverride || s.label)}</span>`;
}

const ESTIMATE_HINT =
  "根据此活动前后的积分余额变化估算。未经脚本验证，也不计入任何合计。";

function pointsCell(points, known, estimated = 0) {
  if (points > 0)
    return `<span class="act-pts">${U.fmtSigned(points)}${known ? "" : `<sup class="act-pts-unknown" title="${U.escapeAttr(estimated > 0 ? `部分积分未上报（根据余额变化，估计还有约 ${estimated} 积分）` : "脚本未上报此组中的部分积分")}">?</sup>`}</span>`;
  if (!known && estimated > 0)
    return `<span class="act-pts act-pts--est" title="${U.escapeAttr(ESTIMATE_HINT)}">~${U.fmtSigned(estimated)}</span>`;
  if (!known)
    return '<span class="act-pts act-pts--unknown" title="脚本未上报此活动的积分">?</span>';
  return '<span class="act-pts act-pts--zero">\u2013</span>';
}

/** "Oct week 4: 6/8 · 2 locked (as of Oct 28)" for each known punch card. */
export function punchcardText(cards) {
  return (cards || [])
    .map((c) => {
      const bits = [`${c.done}/${c.total}`];
      if (c.done >= c.total) bits[0] += " 已完成";
      if (c.locked) bits.push(`${c.locked} 项未解锁`);
      if (c.points != null)
        bits.push(`${U.fmtSigned(c.points)}${c.pointsAvailable != null ? ` / ${U.fmtNumber(c.pointsAvailable)}` : ""} 积分`);
      let text = `${c.title ? `${c.title}：` : ""}${bits.join(" \u00b7 ")}`;
      if (c.asOf) text += `（截至 ${U.localDateLabel(c.asOf, { month: "short", day: "numeric" })}）`;
      return text;
    })
    .join("；");
}

function groupDetail(g, day) {
  const parts = [];
  if (g.id === "promotions" && day.schema === "v4") parts.push("每日任务与更多活动合并上报");
  let sameCause = false;
  const active = g.items.length - g.counts.unavailable - g.counts["n/a"];

  if (g.id === "punchcards" && day.punchcards && day.punchcards.length) {
    parts.push(punchcardText(day.punchcards));
  }
  if (g.id === "search" && day.searchSummary) {
    const s = day.searchSummary;
    parts.push(`桌面搜索 ${U.fmtNumber(s.desktop)} \u00b7 移动搜索 ${U.fmtNumber(s.mobile)}${s.bonus ? ` \u00b7 奖励搜索 ${U.fmtNumber(s.bonus)}` : ""}`);
  } else if (g.items.length > 1 && active > 0) {
    // Desktop and mobile flows often report the same problem twice; say it once.
    const live = g.items.filter((it) => it.state !== "unavailable" && it.state !== "n/a");
    sameCause = !g.counts.done && live.every((it) => it.cause === live[0].cause);
    parts.push(sameCause ? causeText(live[0]) : `已完成 ${g.counts.done}/${active} 项`);
  } else if (g.id === "edge-browsing" && day.schema === "v4" && g.items.length === 1 && g.items[0].message) {
    parts.push(g.items[0].message); // e.g. "6/6 reports"
  } else if (g.items.length === 1 && g.state !== "done" && g.state !== "reported") {
    parts.push(causeText(g.items[0]));
  }
  if (g.items.length > 1 && !sameCause) {
    if (g.counts.attention) parts.push(`${g.counts.attention} 项需关注`);
    if (g.counts.unverified) parts.push(`${g.counts.unverified} 项未验证`);
  }
  if (!g.pointsKnown && g.counts.done && !(g.id === "edge-browsing" && day.schema === "v4"))
    parts.push(
      g.estimatedPoints > 0
        ? `根据余额估算约 ${U.fmtNumber(g.estimatedPoints)} 积分`
        : "积分未上报",
    );
  return parts.join(" \u00b7 ");
}

// In narrow cards the Detail column is hidden (CSS) and this line shows under the name instead.
const inlineDetail = (text) =>
  text ? `<span class="act-detail-inline">${U.escapeHtml(U.displayMessage(text))}</span>` : "";

const PLATFORM_TEXT = {
  desktop: "桌面端",
  mobile: "移动端",
  browser: "浏览器",
  api: "API",
};

function itemRows(g, keyBase, hidden) {
  return g.items
    .map((it) => {
      const name = it.title || it.label || it.activity;
      const detail = [it.platform ? PLATFORM_TEXT[it.platform] || humanize(it.platform) : "", causeText(it)]
        .filter(Boolean)
        .join(" \u00b7 ");
      return `<tr class="act-item-row" data-act-items="${U.escapeAttr(keyBase)}" ${hidden ? "hidden" : ""}>
        <td class="act-name"><span class="act-item-name">${U.escapeHtml(name)}</span>${inlineDetail(detail)}</td>
        <td>${stateChip(it.state)}</td>
        <td class="act-num">${pointsCell(it.points, it.pointsKnown || it.state !== "done", it.pointsKnown ? 0 : it.estimatedPoints)}</td>
        <td class="act-detail">${U.escapeHtml(detail)}</td>
      </tr>`;
    })
    .join("");
}

function groupRow(g, day, email, expanded) {
  const key = `${email}|${day.day}|${g.id}`;
  const open = expanded.has(key);
  const detail = groupDetail(g, day);
  const count = g.items.length > 1 ? `<span class="act-count">${g.items.length}</span>` : "";
  return `<tr class="act-row act-row--${(STATES[g.state] || STATES["n/a"]).cls}">
      <td class="act-name"><button type="button" class="act-toggle" data-act-toggle="${U.escapeAttr(key)}" aria-expanded="${open}" title="${open ? "收起" : "展开"}活动明细"><i class="ph ph-caret-right" aria-hidden="true"></i><span>${U.escapeHtml(g.label)}</span>${count}</button>${inlineDetail(detail)}</td>
      <td>${stateChip(g.state)}</td>
      <td class="act-num">${pointsCell(g.points, g.pointsKnown, g.estimatedPoints)}</td>
      <td class="act-detail">${U.escapeHtml(detail)}</td>
    </tr>${itemRows(g, key, !open)}`;
}

const QUIET_STATES = new Set(["unavailable", "n/a"]);

/** What a v4 day cannot show, tagged the way the config view tags v5-only options. */
function v5OnlyRow() {
  return `<tr class="act-row act-row--quiet">
      <td colspan="4"><span class="cfg-version-tag">仅限 v5</span>
        <span class="act-quiet-list">每日任务与更多活动分开显示 \u00b7 每项活动状态 \u00b7 移动搜索额度 \u00b7 搜索福利 \u00b7 余额估算</span></td>
    </tr>`;
}

function quietRow(groups) {
  if (!groups.length) return "";
  return `<tr class="act-row act-row--quiet">
      <td colspan="4"><span class="act-state act-state--unavailable">未提供 / 不适用</span>
        <span class="act-quiet-list">${U.escapeHtml(groups.map((g) => g.label).join(" \u00b7 "))}</span></td>
    </tr>`;
}

function syntheticRows(day) {
  const rows = [];
  if (day.punchcards && day.punchcards.length && !day.groups.some((g) => g.id === "punchcards")) {
    const complete = day.punchcards.every((c) => c.done >= c.total);
    const text = punchcardText(day.punchcards);
    const pts = day.punchcards.reduce((s, c) => s + (c.points || 0), 0);
    rows.push(`<tr class="act-row act-row--${complete ? "done" : "pending"}">
      <td class="act-name"><span class="act-static">打卡任务</span>${inlineDetail(text)}</td>
      <td>${stateChip(complete ? "done" : "pending", complete ? "已完成" : "进行中")}</td>
      <td class="act-num">${pts > 0 ? pointsCell(pts, true) : '<span class="act-pts act-pts--zero">\u2013</span>'}</td>
      <td class="act-detail">${U.escapeHtml(text)}</td>
    </tr>`);
  }
  if (day.schema === "v4" && day.earnable) {
    const e = day.earnable;
    const bits = [["桌面搜索", e.browser], ["移动搜索", e.mobile], ["应用", e.app]]
      .filter(([, v]) => Number.isFinite(v))
      .map(([k, v]) => `${k} ${U.fmtNumber(v)}`);
    if (bits.length) {
      const text = bits.join(" \u00b7 ");
      rows.push(`<tr class="act-row">
      <td class="act-name"><span class="act-static">运行开始时可获取的积分</span>${inlineDetail(text)}</td>
      <td><span class="act-state act-state--na">\u2014</span></td>
      <td class="act-num"><span class="act-pts act-pts--zero">\u2013</span></td>
      <td class="act-detail">${U.escapeHtml(text)}</td>
    </tr>`);
    }
  }
  const app = day.schema === "v4" ? 0 : Number(day.earnable && day.earnable.app);
  if (app > 0) {
    rows.push(`<tr class="act-row act-row--pending">
      <td class="act-name"><span class="act-static">应用活动</span>${inlineDetail(`移动应用中可获取 ${U.fmtNumber(app)} 积分`)}</td>
      <td>${stateChip("pending", "未领取")}</td>
      <td class="act-num"><span class="act-pts act-pts--zero">\u2013</span></td>
      <td class="act-detail">移动应用中可获取 ${U.fmtNumber(app)} 积分</td>
    </tr>`);
  }
  if (day.points.unattributed) {
    const est = day.points.estimatedUnattributed || 0;
    const why = `已获得积分，但脚本未将其归入具体活动${est > 0 ? `；根据余额变化，约 ${U.fmtNumber(est)} 积分与上述未上报的活动对应` : "（例如打卡任务的步骤奖励）"}`;
    rows.push(`<tr class="act-row act-row--unattributed">
      <td class="act-name"><span class="act-static">未归属积分</span>${inlineDetail(why)}</td>
      <td><span class="act-state act-state--na">\u2014</span></td>
      <td class="act-num"><span class="act-pts">${U.fmtSigned(day.points.unattributed)}</span></td>
      <td class="act-detail">${U.escapeHtml(why)}</td>
    </tr>`);
  }
  return rows.join("");
}

function totals(day) {
  const p = day.points;
  const delta =
    p.balanceStart != null && p.balanceEnd != null ? p.balanceEnd - p.balanceStart : null;
  const diff = p.gained - p.attributed - p.unattributed;
  const cell = (label, value, cls = "") =>
    `<div class="act-total ${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="act-totals">
      ${cell("脚本获得的积分", U.fmtSigned(p.gained))}
      ${cell("已归属积分", U.fmtSigned(p.attributed))}
      ${cell("未归属积分", U.fmtSigned(p.unattributed))}
      ${cell("积分余额", p.balanceEnd != null ? `${U.fmtNumber(p.balanceEnd)}${delta != null ? ` <span class="act-total-sub">(${U.fmtSigned(delta)})</span>` : ""}` : "\u2013")}
    </dl>${p.reconciled ? "" : `<p class="act-warn"><i class="ph ph-warning" aria-hidden="true"></i> 获得的积分与「已归属 + 未归属」之和相差 ${U.fmtSigned(diff)}。</p>`}`;
}

function streakBoard(day, now, isLatest) {
  if (day.schema === "v4")
    return '<p class="act-empty">连续签到记录 <span class="cfg-version-tag">仅限 v5</span></p>';
  if (!day.streaks.length)
    return '<p class="act-empty">此日未采集到连续签到数据。</p>';
  const own = Date.parse(day.resetAt);
  const resetAt = Number.isFinite(own)
    ? own
    : day.streaks.map((s) => Date.parse(s.resetAt)).find(Number.isFinite);
  const resetLine =
    isLatest && resetAt && resetAt > now
      ? `<p class="act-reset">${U.fmtDuration((resetAt - now) / 1000)}后重置${day.resetAtSource === "estimated" ? "（预计）" : ""}</p>`
      : "";
  return `<div class="act-streaks">${day.streaks
    .map((s) => {
      const total = s.totalDays || 7;
      const dots = Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const done = n <= s.completedDays;
        const today = done && n === s.completedDays && s.completedToday;
        // Today's step, not yet completed. The script's currentDay is a 0-based
        // index (it equals completedDays - 1 once today's step is done).
        const next =
          !done && !s.completedToday && s.isEnabled !== false &&
          Number.isInteger(s.currentDay) && n === s.currentDay + 1;
        const reward = Array.isArray(s.dailyPoints) ? s.dailyPoints[i] : null;
        return `<li class="act-dot${done ? " act-dot--done" : ""}${today ? " act-dot--today" : ""}${next ? " act-dot--next" : ""}" title="第 ${n} 天${reward != null ? ` \u00b7 ${reward} 积分` : ""}${next ? " \u00b7 今日步骤" : ""}">${reward != null ? U.escapeHtml(String(reward)) : ""}</li>`;
      }).join("");
      return `<div class="act-streak">
        <div class="act-streak-head"><span>${U.escapeHtml(String(s.label || s.partner).replace(/ Streak$/, ""))}</span><span class="act-streak-count">${s.isEnabled === false ? "未启用" : `${s.completedDays}/${total}`}</span></div>
        <ol class="act-dots" aria-label="${U.escapeAttr(`${s.label || s.partner}：已完成 ${s.completedDays}/${total} 天`)}">${dots}</ol>
      </div>`;
    })
    .join("")}</div>${resetLine}`;
}

function facts(day) {
  const p = day.streakProtection;
  const items = [];
  if (p && p.streakCounter != null)
    items.push(["连续签到", `${U.fmtNumber(p.streakCounter)} 天`]);
  if (p)
    items.push([
      "连续签到保护",
      p.enabled ? `已开启 \u00b7 剩余 ${p.remainingDays ?? "?"} 天` : "已关闭",
    ]);
  if (p && p.updatedAt) items.push(["保护状态检查时间", U.fmtRelative(p.updatedAt)]);
  if (day.level != null) items.push(["等级", `等级 ${day.level}`]);
  if (!items.length) return "";
  return `<dl class="act-facts">${items
    .map(([k, v]) => `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(v)}</dd></div>`)
    .join("")}</dl>`;
}

export function verdictText(day) {
  const v = day.verdict;
  switch (v.state) {
    case "complete": return "已完成";
    case "complete-unverified": return `已完成 \u00b7 ${v.unverified} 项无法验证`;
    case "attention": return `需关注 \u00b7 ${v.attention} 项`;
    case "pending": return `${v.pending} 项待完成`;
    case "not-run": return `未运行 \u00b7 ${day.deferral ? day.deferral.label : "已跳过"}`;
    case "basic": return "基础视图 \u00b7 v4";
    default: return "";
  }
}

const VERDICT_CLASS = {
  complete: "done",
  "complete-unverified": "unverified",
  attention: "attention",
  pending: "pending",
  "not-run": "attention",
  basic: "reported",
};

export function verdictChip(day) {
  const cls = VERDICT_CLASS[day.verdict.state] || "na";
  return `<span class="act-state act-state--${cls}">${U.escapeHtml(verdictText(day))}</span>`;
}

/** Amber chip for an account that has no v5 activity data yet. */
export function migrationChip(major) {
  return major === 4
    ? stateChip("pending", "下次运行后显示", "ph-hourglass-medium")
    : stateChip("partial", "首次完整运行 v5 后完成迁移", "ph-hourglass-medium");
}

/** Red chip when the latest run did not (fully) run the account. */
function deferralChip(day) {
  const d = day.deferral;
  if (!d) return "";
  return stateChip("attention", `${d.cutShort ? "运行提前停止" : "最近一次运行已跳过"} \u00b7 ${d.label}`, "ph-prohibit");
}

/** What the collapsed "Activity Status" line shows: the verdict, plus any deferral. */
export function summaryChips(day) {
  return verdictChip(day) + (day.deferral && day.verdict.state !== "not-run" ? deferralChip(day) : "");
}

const notice = (kind, icon, title, text) =>
  `<div class="act-notice act-notice--${kind}" role="status"><i class="ph ${icon}" aria-hidden="true"></i><div><strong>${U.escapeHtml(title)}</strong>${text ? `<p>${U.escapeHtml(text)}</p>` : ""}</div></div>`;

export function renderMigration(major) {
  if (major === 4)
    return notice(
      "info",
      "ph-info",
      "此账号下次运行后将显示基础视图。",
      "v4 显示各来源的积分、搜索积分分类和可获取积分。v5 还提供每项活动状态、连续签到等信息。",
    );
  return notice(
    "warn",
    "ph-hourglass-medium",
    "此账号首次完整运行 v5 后将显示活动详情。",
    "v5 之前的运行记录不包含此表所需的数据，因此暂时没有可显示的内容。",
  );
}

export const renderLoading = (text = "正在加载活动\u2026") => `<p class="act-empty">${U.escapeHtml(text)}</p>`;

export function renderLoadError(message) {
  return notice("error", "ph-warning-circle", "无法从脚本读取运行历史。", `原因：${U.displayMessage(message)}。正在自动重试。`);
}

function notRunNotice(day) {
  const d = day.deferral || { kind: "skipped", label: "已跳过", reason: "" };
  const when = day.lastEndedAt ? ` 上次尝试：${U.fmtRelative(day.lastEndedAt)}。` : "";
  if (d.kind === "bot-score")
    return notice("error", "ph-prohibit", "账号未运行：机器人评分过高",
      `Microsoft 对此账号显示了机器人评分警告，脚本因此跳过该账号，没有执行任何活动。${when}`);
  return notice("error", "ph-prohibit", `账号未运行：${d.label}`, `脚本报告：${U.displayMessage(d.reason)}。${when}`);
}

export function pickDay(days, selected) {
  return days.find((d) => d.day === selected) || days[0];
}

function dayLabel(d, index) {
  const label = U.localDateLabel(d.day, { weekday: "short", month: "short", day: "numeric" });
  return `${label}${index === 0 ? "（最近）" : ""} \u00b7 ${U.fmtSigned(d.points.gained)}`;
}

/**
 * @param {object[]} days      one account's days, newest first
 * @param {{email:string, selectedDay?:string, expanded:Set<string>, now?:number}} opts
 */
export function renderActivity(days, { email, selectedDay, expanded, now = Date.now() }) {
  const day = pickDay(days, selectedDay);
  const isLatest = day === days[0];
  const options = days
    .map(
      (d, i) =>
        `<option value="${U.escapeAttr(d.day)}" ${d === day ? "selected" : ""}>${U.escapeHtml(dayLabel(d, i))}</option>`,
    )
    .join("");
  const rows =
    day.groups
      .filter((g) => !QUIET_STATES.has(g.state))
      .map((g) => groupRow(g, day, email, expanded))
      .join("") +
    syntheticRows(day) +
    quietRow(day.groups.filter((g) => QUIET_STATES.has(g.state))) +
    (day.schema === "v4" ? v5OnlyRow() : "");

  const grid = `<div class="act-grid">
      <section class="act-card" aria-label="积分明细">
        <h3 class="act-card-title">积分明细</h3>
        <div class="act-table-wrap">
          <table class="act-table">
            <thead><tr><th scope="col">活动</th><th scope="col">状态</th><th scope="col" class="act-num">积分</th><th scope="col">详情</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${totals(day)}
      </section>
      <section class="act-card" aria-label="连续签到与进度">
        <h3 class="act-card-title">连续签到与进度</h3>
        ${streakBoard(day, now, isLatest)}
        ${facts(day)}
      </section>
    </div>`;

  return `<div class="act-panel">
    <div class="act-head">
      <span class="act-head-chips">${day.verdict.state === "not-run" ? "" : deferralChip(day)}</span>
      <label class="act-day"><span class="act-day-label">日期</span>
        <select class="act-day-select" data-act-day-select="${U.escapeAttr(email)}" aria-label="Rewards 积分日期">${options}</select>
      </label>
    </div>
    ${day.verdict.state === "not-run" ? notRunNotice(day) : grid}
  </div>`;
}
