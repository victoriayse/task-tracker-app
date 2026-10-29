/* Task Tracker – single-page app (no build step) */
const SUPABASE_URL = "https://ypyxzrmmyqptoduzzazp.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlweXh6cm1teXFwdG9kdXp6YXpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxMTM0NjQsImV4cCI6MjEwODY4OTQ2NH0.jmvbrDabOvvHgCFRvNdBhM6Q63ZYPR-HHl5cdZfEtJo";
const VAPID_PUBLIC = "BJd0pVUgBPkI3t2OEexmrDiuDdxLtn6BavlNkpm8lBhuepe3vP9u4LUCXb4Bx0o2bSP6-PQkFoXUbTsKAofy56c";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const OWNER = "00000000-0000-0000-0000-000000000001"; // one shared, public tracker
const APP_VERSION = "16"; // bump together with version.json on every release
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SECTIONS = {
  today: "Today's tasks",
  due: "Tasks due",
  calendar: "Calendar",
  total: "Penalty points",
  chart: "Penalty points chart",
};
const DEFAULT_LAYOUT = ["today", "due", "calendar", "total", "chart"];

const state = {
  user: null,
  tasks: [],
  series: [],
  images: [],
  archived: [],
  entries: [],
  catalogue: [],
  thresholds: [],
  layout: DEFAULT_LAYOUT.slice(),
  collapsed: {},
  chartTab: "threshold",
  isAdmin: false,      // true only while the admin is in edit mode
  adminAuthed: false,  // signed in as admin
  editMode: false,
  adminEmail: "",
  calMonth: null, // "YYYY-MM"
  calSel: null,
  arranging: false,
  showHistory: false,
  bannerHiddenFor: null,
};

/* ---------- Singapore date helpers ---------- */
function sgDateStr(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dow(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
function fmtDate(iso, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-SG", { ...opts, timeZone: "UTC" });
}
function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
function relDay(iso) {
  const t = sgDateStr();
  if (iso === t) return "Today";
  if (iso === addDays(t, 1)) return "Tomorrow";
  if (iso === addDays(t, -1)) return "Yesterday";
  return fmtDate(iso);
}

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg) {
  if (/row-level security|permission denied|Unauthorized/i.test(String(msg))) msg = "Not signed in as admin — tap ⚙︎ → Admin sign in";
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}
function openSheet(html, onMount) {
  $("#sheetBody").innerHTML = html;
  $("#sheetWrap").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  onMount && onMount($("#sheetBody"));
}
function closeSheet() {
  $("#sheetWrap").classList.add("hidden");
  document.body.style.overflow = "";
}
$("#sheetWrap").addEventListener("click", (e) => { if (e.target.hasAttribute("data-close")) closeSheet(); });

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

/* ---------- Data ---------- */
async function loadAll() {
  await sb.rpc("apply_my_missed_penalties").then(() => {}, () => {});
  const [t, e, c, th, st, se, im] = await Promise.all([
    sb.from("tasks").select("*").order("due_date").order("due_time", { nullsFirst: true }).order("created_at"),
    sb.from("penalty_entries").select("*").eq("cleared", false).order("created_at", { ascending: false }),
    sb.from("catalogue_items").select("*").order("sort").order("created_at"),
    sb.from("thresholds").select("*").order("points"),
    sb.from("user_settings").select("*").maybeSingle(),
    sb.from("task_series").select("*"),
    sb.from("task_images").select("*").order("created_at"),
  ]);
  const err = [t, e, c, th, st, se, im].find((r) => r.error);
  state.images = im.data || [];
  if (err) toast("Couldn't load: " + err.error.message);
  state.archived = (t.data || []).filter((x) => x.archived).sort((a, b) => (b.archived_at || "").localeCompare(a.archived_at || ""));
  state.tasks = (t.data || []).filter((x) => !x.archived);
  state.entries = e.data || [];
  state.catalogue = c.data || [];
  state.thresholds = th.data || [];
  if (st.data?.layout) state.layout = normaliseLayout(st.data.layout);
  else if (!st.data) await sb.from("user_settings").upsert({ user_id: state.user.id });
  state.series = se.data || [];
  await topUpSeries();
}
function normaliseLayout(l) {
  const out = (Array.isArray(l) ? l : []).filter((k) => SECTIONS[k]);
  DEFAULT_LAYOUT.forEach((k) => { if (!out.includes(k)) out.push(k); });
  return out;
}

function totalPoints() { return state.entries.reduce((a, e) => a + e.points, 0); }
function sortedThresholds() { return state.thresholds.filter((t) => t.points > 0).sort((a, b) => a.points - b.points); }
function reachedThreshold() {
  const tot = totalPoints();
  return sortedThresholds().filter((t) => tot >= t.points).pop() || null;
}
function nextThreshold() {
  const tot = totalPoints();
  return sortedThresholds().find((t) => tot < t.points) || null;
}

async function pingThreshold() {
  // server sends the phone notification if a new threshold was crossed
  try { await sb.functions.invoke("notify", { body: { mode: "threshold" } }); } catch {}
}

/* ---------- Boot ---------- */
async function boot() {
  state.user = { id: OWNER };
  await checkAdmin();
  $("#app").classList.remove("hidden");
  state.collapsed = lsGet("tt_collapsed", {});
  state.chartTab = lsGet("tt_chartTab2", "threshold");
  state.bannerHiddenFor = lsGet("tt_bannerHidden", null);
  state.calMonth = sgDateStr().slice(0, 7);
  state.calSel = sgDateStr();
  $("#todayLabel").textContent = fmtDate(sgDateStr(), { weekday: "long", day: "numeric", month: "long" });
  renderAll();
  await loadAll();
  renderAll();
  registerSW();
  subscribeRealtime();
  checkForUpdate();
}

let rtChannel;
function subscribeRealtime() {
  // refresh when the app comes back to the foreground (another device may have changed things)
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.user) {
      $("#todayLabel").textContent = fmtDate(sgDateStr(), { weekday: "long", day: "numeric", month: "long" });
      await loadAll(); renderAll();
    }
  });
}

/* ---------- Rendering ---------- */
function renderAll() {
  renderBanner();
  const main = $("#sections");
  main.classList.toggle("arranging", state.arranging);
  main.innerHTML = state.layout.map((k, i) => {
    const collapsed = state.collapsed[k] && !state.arranging;
    return `<section class="card${collapsed ? " collapsed" : ""}" data-sec="${k}">
      <div class="card-head">
        <h2>${SECTIONS[k]}</h2>${headExtra(k)}
        <div class="move-btns">
          <button type="button" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" data-move="1" ${i === state.layout.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        </div>
        ${state.arranging ? "" : `<button type="button" class="collapse-btn" data-collapse aria-label="Collapse">${collapsed ? "▸" : "▾"}</button>`}
      </div>
      <div class="card-body">${renderSection(k)}</div>
    </section>`;
  }).join("");
}
function headExtra(k) {
  const t = sgDateStr();
  if (k === "today") {
    const list = state.tasks.filter((x) => activeOn(x, t));
    return list.length ? `<span class="count">${list.filter((x) => x.completed).length}/${list.length}</span>` : "";
  }
  if (k === "due") {
    const n = overdueList().length;
    return n ? `<span class="count red">${n} overdue</span>` : "";
  }
  return "";
}
function renderSection(k) {
  switch (k) {
    case "today": return renderToday();
    case "due": return renderDue();
    case "calendar": return renderCalendar();
    case "total": return renderTotal();
    case "chart": return renderChart();
  }
  return "";
}

function taskRow(t, showDate) {
  const today = sgDateStr();
  const late = !t.completed && t.due_date < today;
  const meta = [];
  if (isRange(t)) {
    if (!t.completed && !late && t.due_date === today) meta.push(`<span class="late">Due today</span>`);
    else if (showDate || late) meta.push(`<span class="${late ? "late" : ""}">${late ? "Overdue · due " : "Due "}${relDay(t.due_date)}</span>`);
    const r = activeOn(t, today) ? rangeDay(t, today) : null;
    meta.push(`<span>📅 ${rangeText(t)}${r && !t.completed ? ` · day ${r.day} of ${r.of}` : ""}</span>`);
  } else if (showDate) meta.push(`<span class="${late ? "late" : ""}">${late ? "Overdue · " : ""}${relDay(t.due_date)}</span>`);
  if (t.due_time) meta.push(`<span>🕒 ${fmtTime(t.due_time)}</span>`);
  const nm = t.notify_mode || (t.remind_from ? "hourly" : "default");
  if (!t.completed && nm !== "default") meta.push(`<span>${nm === "off" ? "🔕 off" : nm === "hourly" ? "🔔 hourly" : nm === "specific" ? `🔔 ${(t.notify_times || []).length}×` : "🔔 from–to"}</span>`);
  const rt = repeatText(t);
  if (rt) meta.push(`<span>🔁 ${esc(rt)}</span>`);
  if (t.penalized) meta.push(`<span class="late">Penalty charged</span>`);
  if (t._missedCount > 1) meta.push(`<span class="late">${t._missedCount} days missed</span>`);
  if (t.notes) meta.push(`<span>📝 ${esc(t.notes.slice(0, 40))}${t.notes.length > 40 ? "…" : ""}</span>`);
  const nImg = imagesFor(t.id).length;
  if (nImg) meta.push(`<span>📷 ${nImg}</span>`);
  const checkable = canCheck(t);
  const box = checkable || !(isRepeat(t) && t.due_date > sgDateStr())
    ? `<button type="button" class="check${t.completed ? " on" : ""}" data-check="${t.id}" ${checkable ? "" : "disabled"} aria-label="${t.completed ? "Mark not done" : "Mark done"}">${t.completed ? "✓" : ""}</button>`
    : `<span class="check locked${t.completed ? " on" : ""}" title="Repeating tasks can't be ticked before their day">${t.completed ? "✓" : "🔁"}</span>`;
  return `<div class="task${t.completed ? " done" : ""}" data-task="${t.id}">
    ${box}
    <div class="task-main" data-open="${t.id}">
      <div class="task-title">${esc(t.title)}</div>
      ${meta.length ? `<div class="task-meta">${meta.join("")}</div>` : ""}
    </div>
    <div class="task-side">
      ${t.penalty_points ? `<span class="pts">−${t.penalty_points}</span>` : ""}
      ${state.isAdmin ? `<div class="row-actions">
        <button type="button" class="mini-btn" data-edittask="${t.id}" aria-label="Edit task" title="Edit">✎</button>
        <button type="button" class="mini-btn del" data-deltask="${t.id}" aria-label="Delete task" title="Delete">🗑</button>
      </div>` : ""}
    </div>
  </div>`;
}

function renderToday() {
  const t = sgDateStr();
  const list = state.tasks.filter((x) => activeOn(x, t) && !(isRange(x) && x.completed && x.due_date !== t && x.completed_at && sgDateStr(new Date(x.completed_at)) < t))
    .sort((a, b) => (a.completed - b.completed) || a.due_date.localeCompare(b.due_date));
  if (!list.length) return `<div class="empty">Nothing scheduled for today.${state.isAdmin ? " Tap ＋ to add a task." : ""}</div>`;
  const done = list.filter((x) => x.completed).length;
  const atStake = list.filter((x) => !x.completed && x.due_date === t).reduce((a, x) => a + x.penalty_points, 0);
  const later = list.filter((x) => !x.completed && x.due_date > t).length;
  return `<div class="progress-line">${done} of ${list.length} done${atStake ? ` · <b style="color:var(--danger)">${atStake} pts at stake</b> by midnight` : later ? "" : " · all clear 🎉"}${later ? ` · ${later} due later` : ""}</div>
    ${list.map((x) => taskRow(x, false)).join("")}`;
}

// Repeating tasks appear once: latest missed day (overdue) and next upcoming day
function onePerSeries(list, pickLatest) {
  const seen = new Map(), out = [];
  for (const x of list) {
    if (!isRepeat(x)) { out.push(x); continue; }
    const k = x.series_id || x.title;
    const prev = seen.get(k);
    if (!prev) { const c = { ...x, _missedCount: 1 }; seen.set(k, c); out.push(c); }
    else {
      prev._missedCount++;
      if (pickLatest && x.due_date > prev.due_date) Object.assign(prev, { ...x, _missedCount: prev._missedCount });
    }
  }
  return out;
}
function overdueList() {
  const t = sgDateStr();
  return onePerSeries(state.tasks.filter((x) => !x.completed && x.due_date < t).sort((a, b) => a.due_date.localeCompare(b.due_date)), true);
}
function renderDue() {
  const t = sgDateStr();
  const overdue = overdueList();
  const upcoming = onePerSeries(state.tasks.filter((x) => !x.completed && x.due_date > t && x.due_date <= addDays(t, 7)), false)
    .map((x) => ({ ...x, _missedCount: 0 }));
  if (!overdue.length && !upcoming.length) return `<div class="empty">No overdue or upcoming tasks this week.</div>`;
  let h = "";
  if (overdue.length) h += `<div class="sub-h" style="color:var(--danger)">Overdue</div>` + overdue.map((x) => taskRow(x, true)).join("");
  if (upcoming.length) h += `<div class="sub-h">Next 7 days</div>` + upcoming.map((x) => taskRow(x, true)).join("");
  return h;
}

function renderCalendar() {
  const [y, m] = state.calMonth.split("-").map(Number);
  const first = `${state.calMonth}-01`;
  const startOffset = (dow(first) + 6) % 7; // Monday first
  const start = addDays(first, -startOffset);
  const today = sgDateStr();
  const byDay = {};
  state.tasks.forEach((t) => {
    if (!isRange(t)) return (byDay[t.due_date] = byDay[t.due_date] || []).push(t);
    for (let d = t.start_date; d <= t.due_date; d = addDays(d, 1)) (byDay[d] = byDay[d] || []).push(t);
  });
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i === 35 && d.slice(0, 7) !== state.calMonth) break;
    const list = byDay[d] || [];
    const chips = list.slice(0, 2).map((t) => {
      const cls = (t.completed ? "done" : t.due_date < today && d <= t.due_date && d < today ? "missed" : "") + (isRange(t) && d !== t.due_date ? " span" : "");
      return `<span class="chip ${cls}" data-open="${t.id}">${esc(t.title)}</span>`;
    }).join("");
    const more = list.length > 2 ? `<span class="chip-more">+${list.length - 2}</span>` : "";
    cells += `<button type="button" class="cal-day${d.slice(0, 7) !== state.calMonth ? " other" : ""}${d === today ? " today" : ""}${d === state.calSel ? " sel" : ""}" data-day="${d}">
      <span class="cal-num">${Number(d.slice(8))}</span>${chips}${more}</button>`;
  }
  const sel = state.calSel;
  const selList = (byDay[sel] || []);
  return `<div class="cal-nav">
      <button type="button" data-cal="-1" aria-label="Previous month">‹</button>
      <strong>${title}</strong>
      <button type="button" data-cal="1" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid">
      ${["M", "T", "W", "T", "F", "S", "S"].map((x) => `<div class="cal-dow">${x}</div>`).join("")}
      ${cells}
    </div>
    <div class="cal-sel">
      <div class="cal-sel-head"><strong>${fmtDate(sel, { weekday: "long", day: "numeric", month: "short" })}</strong>
        ${state.isAdmin ? `<button type="button" class="btn small" data-addon="${sel}">＋ Task</button>` : ""}</div>
      ${selList.length ? selList.map((x) => taskRow(x, false)).join("") : `<div class="empty">No tasks on this day.</div>`}
    </div>`;
}

function renderTotal() {
  const tot = totalPoints();
  const reached = reachedThreshold();
  const next = nextThreshold();
  const prevPts = reached ? reached.points : 0;
  let side = "";
  if (next) {
    const pct = Math.min(100, Math.round(((tot - prevPts) / (next.points - prevPts)) * 100));
    side = `<div><b>${next.points - tot}</b> pts until <b>${esc(next.punishment || next.points + " pts")}</b></div>
      <div class="bar"><i style="width:${Math.max(3, pct)}%"></i></div>
      <div class="muted" style="font-size:12px">Next threshold: ${next.points} pts</div>`;
  } else if (sortedThresholds().length) {
    side = `<div>Highest threshold reached.</div><div class="bar"><i style="width:100%"></i></div>`;
  } else side = `<div class="muted">Set thresholds in the chart below.</div>`;
  const hist = state.showHistory
    ? `<div class="sub-h">History (current period)</div><div class="hist">${state.entries.length ? state.entries.map((e) => `
        <div class="hist-item"><div class="h-main"><div>${esc(e.description)}</div>
          <div class="h-date">${new Date(e.created_at).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" })}${e.source === "missed_task" ? " · auto" : ""}</div></div>
          <span class="h-pts">+${e.points}</span>
          ${state.isAdmin ? `<button type="button" class="x-btn" data-delentry="${e.id}" aria-label="Remove">✕</button>` : ""}</div>`).join("") : `<div class="empty">No penalty points yet.</div>`}</div>`
    : "";
  return `<div class="total-wrap">
      <div class="total-num${tot === 0 ? " zero" : ""}">${tot}</div>
      <div class="total-side">${side}</div>
    </div>
    ${reached ? `<div class="reached">🚨 ${reached.points} pts reached → ${esc(reached.punishment)}</div>` : ""}
    <div class="btn-row">
      ${state.isAdmin ? `<button type="button" class="btn primary" data-act="addPenalty">＋ Add penalty</button>` : ""}
      <button type="button" class="btn" data-act="history">${state.showHistory ? "Hide history" : "History"}</button>
    </div>
    ${tot > 0 && state.isAdmin ? `<button type="button" class="link" data-act="served">Punishment served — reset points to 0</button>` : ""}
    ${hist}`;
}

function renderChart() {
  const tab = state.chartTab;
  const tabs = `<div class="tabs"><button type="button" data-tab="threshold" class="${tab === "threshold" ? "on" : ""}">Threshold</button><button type="button" data-tab="catalogue" class="${tab === "catalogue" ? "on" : ""}">Catalogue</button></div>`;
  if (tab === "catalogue") {
    return tabs + `<div class="chart-head"><span>Item</span><span style="text-align:center">Points</span><span></span></div>
      ${state.catalogue.map((c) => `<div class="chart-row" data-cat="${c.id}">
        <input type="text" value="${esc(c.item)}" data-field="item" ${RO()} placeholder="Item description">
        <input type="number" inputmode="numeric" class="num" value="${c.points}" data-field="points" min="0" ${RO()}>
        ${state.isAdmin ? `<button type="button" class="x-btn" data-delcat="${c.id}" aria-label="Delete">✕</button>` : "<span></span>"}</div>`).join("")}
      ${state.isAdmin ? `<button type="button" class="btn block" data-act="addCat">＋ Add item</button>` : ""}
      <p class="chart-tip">Changes save automatically. Catalogue items appear as quick picks when you add a task or penalty.</p>`;
  }
  const tot = totalPoints();
  return tabs + `<div class="chart-head th"><span style="text-align:center">Points</span><span>Punishment</span><span></span></div>
    ${state.thresholds.map((t) => `<div class="chart-row th${t.points > 0 && tot >= t.points ? " hit" : ""}" data-th="${t.id}">
      <input type="number" inputmode="numeric" class="num" value="${t.points}" data-field="points" min="0" ${RO()}>
      <input type="text" value="${esc(t.punishment)}" data-field="punishment" ${RO()} placeholder="Type of punishment">
      ${state.isAdmin ? `<button type="button" class="x-btn" data-delth="${t.id}" aria-label="Delete">✕</button>` : "<span></span>"}</div>`).join("")}
    ${state.isAdmin ? `<button type="button" class="btn block" data-act="addTh">＋ Add threshold</button>` : ""}
    <p class="chart-tip">When your total reaches a threshold you'll see a red bar at the top and get a phone notification.</p>`;
}

function renderBanner() {
  const b = $("#banner");
  const r = reachedThreshold();
  const tot = totalPoints();
  const key = r ? `${r.id}:${r.points}` : null;
  if (!r || state.bannerHiddenFor === key) { b.classList.add("hidden"); return; }
  b.innerHTML = `<div class="b-text">🚨 ${tot} penalty points — threshold reached<small>${r.points} pts = ${esc(r.punishment)}</small></div>
    <button type="button" id="bannerHide">Hide</button>`;
  b.classList.remove("hidden");
  $("#bannerHide").onclick = () => { state.bannerHiddenFor = key; lsSet("tt_bannerHidden", key); renderBanner(); };
}

/* ---------- Section interactions (event delegation) ---------- */
$("#sections").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-open],button");
  if (!el) return;
  const sec = el.closest("[data-sec]")?.dataset.sec;
  const d = el.dataset;

  if (d.move && !state.isAdmin) return;
  if (d.move) {
    const i = state.layout.indexOf(sec), j = i + Number(d.move);
    if (j < 0 || j >= state.layout.length) return;
    [state.layout[i], state.layout[j]] = [state.layout[j], state.layout[i]];
    renderAll();
    $(`[data-sec="${sec}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    saveLayout();
    return;
  }
  if (el.hasAttribute("data-collapse")) {
    state.collapsed[sec] = !state.collapsed[sec];
    lsSet("tt_collapsed", state.collapsed); renderAll(); return;
  }
  const WRITE = d.edittask || d.deltask || d.edit || d.addon || d.delcat || d.delth || d.delentry || d.move || ["addCat", "addTh", "addPenalty", "served"].includes(d.act);
  if (WRITE && !state.isAdmin) return toast(state.adminAuthed ? "Tap ✎ Edit at the top to make changes" : "View only — admin sign-in needed to make changes");
  if (d.check) return toggleTask(d.check);
  if (d.edittask) return openTaskSheet(state.tasks.find((x) => x.id === d.edittask));
  if (d.deltask) return confirmDelete(state.tasks.find((x) => x.id === d.deltask));
  if (d.open) return openTaskDetails(d.open);
  if (d.day) { state.calSel = d.day; renderAll(); return; }
  if (d.cal) {
    const [y, m] = state.calMonth.split("-").map(Number);
    const nd = new Date(Date.UTC(y, m - 1 + Number(d.cal), 1));
    state.calMonth = nd.toISOString().slice(0, 7);
    state.calSel = state.calMonth === sgDateStr().slice(0, 7) ? sgDateStr() : state.calMonth + "-01";
    renderAll(); return;
  }
  if (d.addon) return openTaskSheet(null, d.addon);
  if (d.tab) { state.chartTab = d.tab; lsSet("tt_chartTab2", d.tab); renderAll(); return; }
  if (d.delcat) return deleteRow("catalogue_items", "catalogue", d.delcat);
  if (d.delth) return deleteRow("thresholds", "thresholds", d.delth);
  if (d.delentry) return deleteEntry(d.delentry);
  if (d.act === "addCat") return addChartRow("catalogue_items", "catalogue", { item: "", points: 5, sort: state.catalogue.length + 1 });
  if (d.act === "addTh") {
    const maxPts = Math.max(0, ...state.thresholds.map((t) => t.points));
    return addChartRow("thresholds", "thresholds", { points: maxPts + 20, punishment: "", sort: state.thresholds.length + 1 });
  }
  if (d.act === "addPenalty") return openPenaltySheet();
  if (d.act === "history") { state.showHistory = !state.showHistory; renderAll(); return; }
  if (d.act === "served") return confirmServed();
});

// Inline chart editing — save on change
$("#sections").addEventListener("change", async (e) => {
  const inp = e.target;
  const field = inp.dataset.field;
  if (!field || !state.isAdmin) return;
  const catRow = inp.closest("[data-cat]"), thRow = inp.closest("[data-th]");
  const val = inp.type === "number" ? Math.max(0, parseInt(inp.value || "0", 10)) : inp.value.trim();
  if (catRow) {
    const id = catRow.dataset.cat;
    const { error } = await sb.from("catalogue_items").update({ [field]: val }).eq("id", id);
    if (error) return toast(error.message);
    Object.assign(state.catalogue.find((c) => c.id === id), { [field]: val });
    toast("Saved");
  } else if (thRow) {
    const id = thRow.dataset.th;
    const { error } = await sb.from("thresholds").update({ [field]: val }).eq("id", id);
    if (error) return toast(error.message);
    Object.assign(state.thresholds.find((t) => t.id === id), { [field]: val });
    if (field === "points") state.thresholds.sort((a, b) => a.points - b.points);
    toast("Saved");
    renderAll(); pingThreshold();
  }
});

let layoutTimer;
function saveLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => sb.from("user_settings").upsert({ user_id: state.user.id, layout: state.layout, updated_at: new Date().toISOString() }), 400);
}
$("#btnArrange").onclick = () => { state.arranging = !state.arranging; $("#arrangeBar").classList.toggle("hidden", !state.arranging); renderAll(); };
$("#btnArrangeDone").onclick = () => { state.arranging = false; $("#arrangeBar").classList.add("hidden"); renderAll(); toast("Layout saved"); };

/* ---------- Tasks ---------- */
// ISO timestamp -> "YYYY-MM-DDTHH:MM" in Singapore time for <input type="datetime-local">
function toLocalInput(iso) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 16);
}
const NOTIFY_LABEL = { default: "Default", hourly: "Hourly", specific: "Specific time(s)", range: "From – to", off: "Off" };
function timeRowHtml(iso) {
  return `<div class="row time-row" style="margin-top:6px;align-items:center"><input type="datetime-local" step="300" value="${toLocalInput(iso)}">
    <button type="button" class="x-btn" data-rmtime aria-label="Remove time">✕</button></div>`;
}
function fmtDT(iso) { return new Date(iso).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" }); }
function notifyText(t) {
  const m = t.notify_mode || (t.remind_from ? "hourly" : "default");
  if (m === "off") return "Off";
  if (m === "hourly") return (t.notify_from || t.remind_from) ? `Hourly from ${fmtDT(t.notify_from || t.remind_from)} until due` : "Hourly until due";
  if (m === "specific") return (t.notify_times || []).map(fmtDT).join(" · ") || "Specific times";
  if (m === "range") return t.notify_from && t.notify_to ? `Hourly ${fmtDT(t.notify_from)} → ${fmtDT(t.notify_to)}` : "From – to";
  return "";
}
function isRange(t) { return !!t.start_date && t.start_date < t.due_date; }
// is the task "on" for a given day? (its due day, or any day inside its from–to range)
function activeOn(t, d) { return isRange(t) ? t.start_date <= d && d <= t.due_date : t.due_date === d; }
function rangeText(t) { return `${fmtDate(t.start_date, { day: "numeric", month: "short" })} – ${fmtDate(t.due_date, { day: "numeric", month: "short" })}`; }
function rangeDay(t, d) {
  const n = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
  return { day: n(t.start_date, d) + 1, of: n(t.start_date, t.due_date) + 1 };
}
function isRepeat(t) { return !!t.series_id || (t.repeat && t.repeat !== "none"); }
// Repeating tasks can be ticked on their day or afterwards (admin override for overdue) — not ahead of time
function isOverdue(t) {
  if (t.due_time) return Date.now() >= Date.parse(`${t.due_date}T${t.due_time.slice(0, 8)}+08:00`);
  return t.due_date < sgDateStr();
}
// Everyone can tick open tasks; only the admin (in edit mode) can tick overdue ones
function canCheck(t) {
  if (t.archived) return false;
  if (isRepeat(t) && t.due_date > sgDateStr()) return false; // not before its day
  return state.isAdmin || !isOverdue(t);
}

async function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!canCheck(t)) return toast(isOverdue(t) ? (state.adminAuthed ? "Overdue — tap ✎ Edit at the top to tick it off" : "Overdue — only the admin can tick this off") : "Repeating tasks can't be ticked before their day");
  if (!t.completed) return openCompleteSheet(t);
  // un-tick (keeps any photos/notes already saved)
  t.completed = false; t.completed_at = null; renderAll();
  const { error } = state.isAdmin
    ? await sb.from("tasks").update({ completed: false, completed_at: null }).eq("id", id)
    : await sb.rpc("set_task_done", { p_task: id, p_done: false });
  if (error) { t.completed = true; renderAll(); toast(error.message); }
}

function openCompleteSheet(t) {
  let files = [];
  const charged = state.entries.filter((e) => e.task_id === t.id);
  const chargedPts = charged.reduce((a, e) => a + e.points, 0);
  const overdue = t.due_date < sgDateStr();
  openSheet(`<h3 class="serif">Mark as done</h3>
    <p class="muted" style="margin:0 0 4px">${esc(t.title)} · ${relDay(t.due_date)}${overdue ? ` <span class="status bad">Overdue</span>` : ""}</p>
    ${chargedPts && state.isAdmin ? `<div class="note"><label class="check-line"><input type="checkbox" id="cRefund" checked> Also remove the ${chargedPts} penalty point${chargedPts === 1 ? "" : "s"} charged for missing it</label></div>` : overdue ? `<div class="note">Admin override: this marks an overdue task as done.</div>` : ""}
    <label class="field"><span>Notes (optional)</span><textarea id="cNote" placeholder="How did it go?">${esc(t.completion_note || "")}</textarea></label>
    ${photoPickerHtml("cPhotos")}
    <button type="button" class="btn primary block" id="cSave">✓ Mark done</button>
    <button type="button" class="btn ghost block" data-close>Cancel</button>`, (el) => {
    bindPhotoPicker(el, "cPhotos", (f) => (files = f));
    $("#cSave", el).onclick = async () => {
      const btn = $("#cSave", el); btn.disabled = true; btn.textContent = files.length ? "Uploading photos…" : "Saving…";
      const completion_note = $("#cNote", el).value.trim() || null;
      const completed_at = new Date().toISOString();
      const { error } = state.isAdmin
        ? await sb.from("tasks").update({ completed: true, completed_at, completion_note }).eq("id", t.id)
        : await sb.rpc("set_task_done", { p_task: t.id, p_done: true, p_note: completion_note });
      if (error) { btn.disabled = false; btn.textContent = "✓ Mark done"; return toast(error.message); }
      Object.assign(t, { completed: true, completed_at, completion_note });
      let refunded = 0;
      if (chargedPts && $("#cRefund", el)?.checked) {
        const ids = charged.map((e) => e.id);
        const { error: re } = await sb.from("penalty_entries").delete().in("id", ids);
        if (re) toast(re.message);
        else { refunded = chargedPts; state.entries = state.entries.filter((e) => !ids.includes(e.id)); pingThreshold(); }
      }
      const ok = await uploadImages(t.id, files, "completion");
      if (navigator.vibrate) navigator.vibrate(15);
      closeSheet(); renderAll();
      toast(refunded ? `Done ✓ — ${refunded} penalty pts removed` : t.penalized ? "Done — the penalty for missing it still stands" : ok ? "Done ✓" : "Done ✓ (some photos failed)");
    };
  });
}

/* ---------- Photos ---------- */
const IMAGE_QUOTA = 100 * 1024 * 1024; // 100 MB across all images
function imagesFor(taskId, kind) {
  const own = state.images.filter((i) => i.task_id === taskId && (!kind || i.kind === kind));
  if (kind === "completion") return own;
  // repeating tasks share the photos attached when the task was created
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t?.series_id) return own;
  const sibs = new Set(state.tasks.filter((x) => x.series_id === t.series_id).map((x) => x.id));
  const shared = state.images.filter((i) => i.kind === "task" && sibs.has(i.task_id) && i.task_id !== taskId);
  return kind === "task" ? [...own.filter((i) => i.kind === "task"), ...shared] : [...own, ...shared];
}
function imgUrl(path) { return `${SUPABASE_URL}/storage/v1/object/public/task-images/${path}`; }
function usedBytes() { return state.images.reduce((a, i) => a + i.size, 0); }
function fmtMB(b) { return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB"; }

function photoPickerHtml(id) {
  return `<div class="field"><span>Photos (optional)</span>
    <label class="photo-add"><input type="file" id="${id}" accept="image/*" multiple hidden>📷 Add photos</label>
    <div class="thumbs" id="${id}Prev"></div>
    <div class="muted" style="font-size:12px;margin-top:4px">${fmtMB(usedBytes())} of 100 MB used for all photos</div></div>`;
}
function bindPhotoPicker(el, id, onChange) {
  let files = [];
  const prev = $(`#${id}Prev`, el);
  const draw = () => {
    prev.innerHTML = files.map((f, i) => `<div class="thumb"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-rm="${i}" aria-label="Remove">✕</button></div>`).join("");
    onChange(files);
  };
  $(`#${id}`, el).addEventListener("change", async (e) => {
    const picked = [...e.target.files];
    e.target.value = "";
    for (const f of picked) files.push(await shrinkImage(f));
    const pending = files.reduce((a, f) => a + f.size, 0);
    if (usedBytes() + pending > IMAGE_QUOTA) {
      toast(`Too big — only ${fmtMB(Math.max(0, IMAGE_QUOTA - usedBytes()))} of photo space left`);
      while (files.length && usedBytes() + files.reduce((a, f) => a + f.size, 0) > IMAGE_QUOTA) files.pop();
    }
    draw();
  });
  prev.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    files.splice(Number(b.dataset.rm), 1); draw();
  });
}
// Resize big photos (max 1600px, JPEG) so the 100 MB lasts much longer
async function shrinkImage(file) {
  try {
    if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return file; }
}
async function uploadImages(taskId, files, kind) {
  let ok = true;
  for (const f of files) {
    if (usedBytes() + f.size > IMAGE_QUOTA) { toast("Photo space full (100 MB)"); return false; }
    const ext = (f.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${taskId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const up = await sb.storage.from("task-images").upload(path, f, { contentType: f.type || "image/jpeg" });
    if (up.error) { ok = false; console.warn(up.error); continue; }
    const { data, error } = state.isAdmin
      ? await sb.from("task_images").insert({ task_id: taskId, path, size: f.size, kind }).select().single()
      : await sb.rpc("add_completion_image", { p_task: taskId, p_path: path, p_size: f.size });
    if (error) { ok = false; toast(error.message); await sb.storage.from("task-images").remove([path]); continue; }
    state.images.push(data);
  }
  return ok;
}
async function deleteImages(list) {
  if (!list.length) return;
  await sb.storage.from("task-images").remove(list.map((i) => i.path));
  await sb.from("task_images").delete().in("id", list.map((i) => i.id));
  const ids = new Set(list.map((i) => i.id));
  state.images = state.images.filter((i) => !ids.has(i.id));
}
function galleryHtml(list, removable) {
  if (!list.length) return "";
  return `<div class="thumbs">${list.map((i) => `<div class="thumb"><a href="${imgUrl(i.path)}" target="_blank" rel="noopener"><img src="${imgUrl(i.path)}" alt="" loading="lazy"></a>${removable ? `<button type="button" data-rmimg="${i.id}" aria-label="Remove photo">✕</button>` : ""}</div>`).join("")}</div>`;
}

/* ---------- Task details pop-up ---------- */
// escape text, then turn web addresses into tappable links
function linkify(text) {
  return esc(text).replace(/\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"])/gi, (m) => {
    const href = m.startsWith("www.") ? "https://" + m : m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-link">${m}</a>`;
  });
}
function openTaskDetails(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const today = sgDateStr();
  const status = t.completed ? `<span class="status ok">✓ Done</span>`
    : t.due_date < today ? `<span class="status bad">Missed${t.penalized ? " · penalty charged" : ""}</span>`
    : `<span class="status">Not done yet</span>`;
  const rows = [
    isRange(t)
      ? ["Time range", `${fmtDate(t.start_date, { weekday: "short", day: "numeric", month: "short" })} → ${fmtDate(t.due_date, { weekday: "short", day: "numeric", month: "short" })} <span class="muted">(due on the last day)</span>`]
      : ["Due date", fmtDate(t.due_date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })],
    t.due_time ? ["Time", fmtTime(t.due_time)] : null,
    notifyText(t) && !t.completed ? ["Notifications", esc(notifyText(t))] : null,
    ["Penalty if missed", `${t.penalty_points} pts`],
    repeatText(t) ? ["Repeats", esc(repeatText(t))] : null,
  ].filter(Boolean);
  const taskImgs = imagesFor(t.id, "task"), doneImgs = imagesFor(t.id, "completion");
  const completedAt = t.completed_at ? new Date(t.completed_at).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" }) : "";
  const checkable = canCheck(t);
  openSheet(`<div class="detail-head">${status}</div>
    <h3 class="serif">${esc(t.title)}</h3>
    <dl class="detail">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${t.notes ? `<div class="sub-h">Notes</div><p class="detail-text">${linkify(t.notes)}</p>` : ""}
    ${taskImgs.length ? `<div class="sub-h">Photos</div>${galleryHtml(taskImgs)}` : ""}
    ${t.completed ? `<div class="sub-h" style="color:var(--ok)">Completed ${completedAt}</div>
      ${t.completion_note ? `<p class="detail-text">${linkify(t.completion_note)}</p>` : ""}
      ${galleryHtml(doneImgs)}` : ""}
    ${checkable || state.isAdmin ? `<div class="btn-row">
      ${checkable ? `<button type="button" class="btn ${t.completed ? "" : "primary"}" id="dCheck">${t.completed ? "Mark not done" : "✓ Mark done"}</button>` : ""}
      ${state.isAdmin ? `<button type="button" class="btn" id="dEdit">Edit</button>` : ""}</div>` : ""}
    ${state.isAdmin ? `<button type="button" class="link" id="dManage" style="color:var(--danger)">Archive or delete…</button>` : ""}
    ${!checkable && !t.completed ? `<p class="muted" style="font-size:12.5px">${isOverdue(t) ? "Overdue — only the admin can tick this off." : "Repeating tasks can't be ticked before their day."}</p>` : ""}
    <button type="button" class="btn ghost block" data-close>Close</button>`, (el) => {
    $("#dCheck", el) && ($("#dCheck", el).onclick = () => { closeSheet(); toggleTask(t.id); });
    $("#dEdit", el) && ($("#dEdit", el).onclick = () => openTaskSheet(t));
    $("#dManage", el) && ($("#dManage", el).onclick = () => openManageSheet(t));
  });
}

const REPEAT_LABEL = { none: "Once", daily: "Every day", weekly: "Every week", monthly: "Every month", days: "Selected days" };
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HORIZON_DAYS = 60;   // repeating tasks are created this far ahead…
const TOPUP_DAYS = 30;     // …and topped up whenever fewer than this many days remain

function repeatText(t) {
  const s = t.series_id && state.series.find((x) => x.id === t.series_id);
  const r = s ? s.repeat : t.repeat;
  if (!r || r === "none") return "";
  if (r === "days") return (s ? s.days : []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW_SHORT[d]).join(", ");
  return REPEAT_LABEL[r];
}

function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m is 1-based
function matchesRule(d, s) {
  const w = dow(d);
  if (s.repeat === "daily") return true;
  if (s.repeat === "weekly") return w === dow(s.anchor);
  if (s.repeat === "days") return s.days.includes(w);
  if (s.repeat === "monthly") {
    const want = Number(s.anchor.slice(8));
    const [y, m, day] = d.split("-").map(Number);
    return day === Math.min(want, lastDayOfMonth(y, m));
  }
  return false;
}
function seriesDates(s, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (d >= s.anchor && matchesRule(d, s)) out.push(d);
  return out;
}
function seriesRows(s, dates) {
  return dates.map((d) => ({ title: s.title, notes: s.notes, due_time: s.due_time, penalty_points: s.penalty_points, due_date: d, repeat: s.repeat, series_id: s.id, notify_mode: s.notify_mode || "default" }));
}
// keep active repeating tasks topped up so they never run out
async function topUpSeries() {
  const today = sgDateStr();
  const target = addDays(today, HORIZON_DAYS);
  for (const s of state.series) {
    if (!s.active || s.generated_until >= addDays(today, TOPUP_DAYS)) continue;
    const rows = seriesRows(s, seriesDates(s, addDays(s.generated_until, 1), target)).map((r) => ({ ...r, new_notified: true }));
    if (rows.length) {
      const { data, error } = await sb.from("tasks").insert(rows).select();
      if (error) { console.warn(error); continue; }
      state.tasks.push(...data);
    }
    await sb.from("task_series").update({ generated_until: target }).eq("id", s.id);
    s.generated_until = target;
  }
  state.tasks.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

function quickPicks(prefix) {
  if (!state.catalogue.length) return "";
  return `<div class="quick">${state.catalogue.filter((c) => c.item).map((c) =>
    `<button type="button" data-pick="${c.id}">${esc(c.item)} · ${c.points}</button>`).join("")}</div>`;
}

function openTaskSheet(task, presetDate) {
  const isEdit = !!task;
  const t = task || { title: "", notes: "", due_date: presetDate || sgDateStr(), due_time: null, penalty_points: 5, repeat: "none" };
  let repeat = "none";
  let days = [dow(t.due_date)];
  let mode = isRange(t) ? "range" : "one";
  let nmode = t.notify_mode || (t.remind_from ? "hourly" : "default");
  openSheet(`<h3 class="serif">${isEdit ? "Edit task" : "New task"}</h3>
    <label class="field"><span>Task</span><input id="fTitle" type="text" value="${esc(t.title)}" placeholder="e.g. Submit report" maxlength="120"></label>
    ${quickPicks()}
    ${t.series_id ? "" : `<div class="field"><span>When</span><div class="seg" id="fWhen">
      <button type="button" data-w="one" class="${mode === "one" ? "on" : ""}">One due date</button>
      <button type="button" data-w="range" class="${mode === "range" ? "on" : ""}">Time range</button>
    </div></div>`}
    <div class="row">
      <label class="field ${mode === "range" ? "" : "hidden"}" id="fStartWrap"><span>From</span><input id="fStart" type="date" value="${t.start_date || t.due_date}"></label>
      <label class="field"><span id="fDateLbl">${mode === "range" ? "To (due day)" : "Due date"}</span><input id="fDate" type="date" value="${t.due_date}"></label>
    </div>
    <label class="field"><span>Time (optional)</span><input id="fTime" type="time" value="${t.due_time ? t.due_time.slice(0, 5) : ""}"></label>
    <div class="field" id="fNotif"><span>Notifications</span>
      <div class="seg" id="fNMode">
        ${Object.entries(NOTIFY_LABEL).map(([k, v]) => `<button type="button" data-n="${k}" class="${k === nmode ? "on" : ""}">${v}</button>`).join("")}
      </div>
      <div class="npanel ${nmode === "default" ? "" : "hidden"}" data-np="default"><div class="muted nhint" id="fNDefHint"></div></div>
      <div class="npanel ${nmode === "hourly" ? "" : "hidden"}" data-np="hourly">
        <div class="muted nhint" id="fHrHint">Every hour, on the hour, until the task is due.</div>
        <div class="row" id="fHrRow" style="margin-top:6px"><label class="field" style="margin-top:0"><span>Starting</span><input id="fHrFrom" type="datetime-local" value="${toLocalInput(t.notify_from)}"></label>
          <button type="button" class="btn small" id="fHrNow" style="flex:0 0 auto;align-self:flex-end;margin-bottom:4px">Now</button></div>
      </div>
      <div class="npanel ${nmode === "specific" ? "" : "hidden"}" data-np="specific">
        <div class="muted nhint">One notification at each date & time you add.</div>
        <div id="fTimes">${(t.notify_times && t.notify_times.length ? t.notify_times : [null]).map((x) => timeRowHtml(x)).join("")}</div>
        <button type="button" class="btn small" id="fAddTime" style="margin-top:6px">＋ Add date/time</button>
      </div>
      <div class="npanel ${nmode === "range" ? "" : "hidden"}" data-np="range">
        <div class="muted nhint">Every hour, on the hour, between these two times.</div>
        <div class="row"><label class="field" style="margin-top:6px"><span>From</span><input id="fNFrom" type="datetime-local" value="${toLocalInput(t.notify_from)}"></label>
          <label class="field" style="margin-top:6px"><span>To</span><input id="fNTo" type="datetime-local" value="${toLocalInput(t.notify_to)}"></label></div>
      </div>
      <div class="npanel ${nmode === "off" ? "" : "hidden"}" data-np="off"><div class="muted nhint">No reminders for this task. Penalty and threshold alerts still come.</div></div>
      <div class="muted nhint" id="fNRepeatNote"></div>
      <div class="muted nhint">Quiet time 2am–7am: hourly reminders pause (specific times still come).</div>
    </div>
    <div class="muted ${mode === "range" ? "" : "hidden"}" id="fRangeHint" style="font-size:12.5px;margin-top:6px">Reminder at 12pm every day in the range, then hourly 7pm–11pm on the due day. Tick it off any day in the range.</div>
    <label class="field"><span>Penalty points if missed</span><input id="fPts" type="number" inputmode="numeric" min="0" value="${t.penalty_points}"></label>
    ${isEdit ? (t.series_id ? `<div class="note">🔁 Repeats: ${esc(repeatText(t))}. Changes here apply to this day only.</div>` : "") : `<div class="field ${mode === "range" ? "hidden" : ""}" id="fRepeatWrap"><span>Repeat</span><div class="seg" id="fRepeat">
      ${Object.entries(REPEAT_LABEL).map(([k, v]) => `<button type="button" data-r="${k}" class="${k === repeat ? "on" : ""}">${v}</button>`).join("")}
    </div>
    <div class="seg hidden" id="fDays" style="margin-top:8px">
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-d="${d}" class="${days.includes(d) ? "on" : ""}">${DOW_SHORT[d]}</button>`).join("")}
    </div>
    <div class="muted" style="font-size:12.5px;margin-top:6px" id="fRepeatHint"></div></div>`}
    <label class="field"><span>Notes (optional)</span><textarea id="fNotes" placeholder="Details…">${esc(t.notes || "")}</textarea></label>
    ${isEdit && imagesFor(t.id, "task").length ? `<div class="sub-h">Current photos</div><div id="fCurImgs">${galleryHtml(imagesFor(t.id, "task"), true)}</div>` : ""}
    ${photoPickerHtml("fPhotos")}
    <button type="button" class="btn primary block" id="fSave">${isEdit ? "Save changes" : "Add task"}</button>
    ${isEdit ? `<button type="button" class="btn ghost block" id="fManage" style="color:var(--danger)">Archive or delete…</button>` : ""}
  `, (el) => {
    const hint = () => {
      const h = $("#fRepeatHint", el); if (!h) return;
      $("#fDays", el).classList.toggle("hidden", repeat !== "days");
      const start = $("#fDate", el).value || sgDateStr();
      const msg = {
        none: "",
        daily: "Appears every day from the start date.",
        weekly: `Appears every ${DOW_SHORT[dow(start)]}.`,
        monthly: `Appears on day ${Number(start.slice(8))} of every month.`,
        days: days.length ? `Appears every ${days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW_SHORT[d]).join(", ")}.` : "Pick at least one day.",
      }[repeat];
      h.textContent = msg + (repeat !== "none" ? " Keeps going until you delete the repeats." : "");
    };
    hint();
    $("#fDate", el).addEventListener("change", hint);
    $("#fWhen", el)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-w]"); if (!b) return;
      mode = b.dataset.w;
      el.querySelectorAll("#fWhen button").forEach((x) => x.classList.toggle("on", x === b));
      $("#fStartWrap", el).classList.toggle("hidden", mode !== "range");
      $("#fRangeHint", el).classList.toggle("hidden", mode !== "range");
      $("#fRepeatWrap", el)?.classList.toggle("hidden", mode === "range");
      nHint();
      $("#fDateLbl", el).textContent = mode === "range" ? "To (due day)" : "Due date";
      if (mode === "range") {
        repeat = "none";
        el.querySelectorAll("#fRepeat button").forEach((x) => x.classList.toggle("on", x.dataset.r === "none")); hint();
        if ($("#fStart", el).value >= $("#fDate", el).value) $("#fDate", el).value = addDays($("#fStart", el).value, 6);
      }
    });
    $("#fRepeat", el)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      repeat = b.dataset.r;
      el.querySelectorAll("#fRepeat button").forEach((x) => x.classList.toggle("on", x === b)); hint();
    });
    $("#fDays", el)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-d]"); if (!b) return;
      const d = Number(b.dataset.d);
      days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
      b.classList.toggle("on", days.includes(d)); hint();
    });
    el.querySelector(".quick")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]"); if (!b) return;
      const c = state.catalogue.find((x) => x.id === b.dataset.pick);
      $("#fTitle", el).value = c.item; $("#fPts", el).value = c.points;
    });
    const nHint = () => {
      const rep = !isEdit && repeat !== "none";
      $("#fNDefHint", el).textContent = mode === "range"
        ? "12pm every day in the range, then hourly 7pm–11pm on the due day."
        : "Hourly while unchecked: weekdays 9pm–12am, weekends 12pm–12am.";
      // specific dates / from–to don't make sense for repeating tasks
      el.querySelectorAll('#fNMode [data-n="specific"], #fNMode [data-n="range"]').forEach((b) => (b.disabled = rep || !!t.series_id));
      if ((rep || t.series_id) && (nmode === "specific" || nmode === "range")) setN("default");
      $("#fHrRow", el).classList.toggle("hidden", rep || !!t.series_id);
      $("#fHrHint", el).textContent = rep || t.series_id ? "Every hour, on the hour, on each repeat day until it's due." : "Every hour, on the hour, until the task is due.";
      $("#fNRepeatNote", el).textContent = rep || t.series_id ? "Repeating tasks: Default, Hourly or Off." : "";
    };
    const setN = (n) => {
      nmode = n;
      el.querySelectorAll("#fNMode button").forEach((x) => x.classList.toggle("on", x.dataset.n === n));
      el.querySelectorAll(".npanel").forEach((p) => p.classList.toggle("hidden", p.dataset.np !== n));
      if (n === "hourly" && !$("#fHrFrom", el).value) $("#fHrFrom", el).value = toLocalInput(new Date().toISOString());
      if (n === "range" && !$("#fNFrom", el).value) $("#fNFrom", el).value = toLocalInput(new Date().toISOString());
    };
    $("#fNMode", el).addEventListener("click", (e) => { const b = e.target.closest("[data-n]"); if (b && !b.disabled) setN(b.dataset.n); });
    $("#fHrNow", el).onclick = () => ($("#fHrFrom", el).value = toLocalInput(new Date().toISOString()));
    $("#fAddTime", el).onclick = () => $("#fTimes", el).insertAdjacentHTML("beforeend", timeRowHtml(null));
    $("#fTimes", el).addEventListener("click", (e) => { const b = e.target.closest("[data-rmtime]"); if (b) b.closest(".time-row").remove(); });
    $("#fRepeat", el)?.addEventListener("click", () => setTimeout(nHint));
    nHint();
    let newFiles = [];
    bindPhotoPicker(el, "fPhotos", (f) => (newFiles = f));
    $("#fCurImgs", el)?.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-rmimg]"); if (!b) return;
      e.preventDefault();
      const img = state.images.find((i) => i.id === b.dataset.rmimg);
      if (img) { await deleteImages([img]); b.closest(".thumb").remove(); renderAll(); toast("Photo removed"); }
    });
    if (!isEdit) setTimeout(() => $("#fTitle", el).focus(), 250);
    $("#fSave", el).onclick = async () => {
      const title = $("#fTitle", el).value.trim();
      if (!title) return toast("Give the task a name");
      const dueVal = $("#fDate", el).value || sgDateStr();
      let start_date = null;
      if (mode === "range") {
        start_date = $("#fStart", el).value || sgDateStr();
        if (start_date >= dueVal) return toast("The 'To' date must be after the 'From' date");
      }
      const iso = (v) => (v ? new Date(v + ":00+08:00").toISOString() : null);
      let notify_times = [], notify_from = null, notify_to = null;
      const isRep = (!isEdit && repeat !== "none") || !!t.series_id;
      if (nmode === "hourly" && !isRep) notify_from = iso($("#fHrFrom", el).value);
      if (nmode === "specific") {
        notify_times = [...el.querySelectorAll("#fTimes input")].map((i) => iso(i.value)).filter(Boolean).sort();
        if (!notify_times.length) return toast("Add at least one date & time, or pick another notification option");
      }
      if (nmode === "range") {
        notify_from = iso($("#fNFrom", el).value); notify_to = iso($("#fNTo", el).value);
        if (!notify_from || !notify_to) return toast("Pick both From and To for notifications");
        if (notify_from >= notify_to) return toast("Notification 'To' must be after 'From'");
      }
      const base = {
        title,
        remind_from: null,
        notify_mode: nmode, notify_times, notify_from, notify_to,
        ...(t.series_id ? {} : { start_date }),
        due_date: dueVal,
        due_time: $("#fTime", el).value || null,
        penalty_points: Math.max(0, parseInt($("#fPts", el).value || "0", 10)),
        notes: $("#fNotes", el).value.trim() || null,
      };
      $("#fSave", el).disabled = true;
      if (isEdit) {
        // moving a charged task to a future date doesn't refund; keep penalized flag as-is
        const { error } = await sb.from("tasks").update(base).eq("id", t.id);
        if (error) { $("#fSave", el).disabled = false; return toast(error.message); }
        Object.assign(task, base);
        if (newFiles.length) { $("#fSave", el).textContent = "Uploading photos…"; await uploadImages(t.id, newFiles, "task"); }
        toast("Task updated");
      } else {
        let rows;
        if (repeat === "none") rows = [{ ...base, repeat: "none" }];
        else {
          if (repeat === "days" && !days.length) { $("#fSave", el).disabled = false; return toast("Pick at least one day"); }
          const until = addDays(base.due_date > sgDateStr() ? base.due_date : sgDateStr(), HORIZON_DAYS);
          const { data: s, error: se } = await sb.from("task_series").insert({
            title: base.title, notes: base.notes, due_time: base.due_time, penalty_points: base.penalty_points,
            repeat, days: repeat === "days" ? days : [], anchor: base.due_date, generated_until: until,
            notify_mode: ["default", "hourly", "off"].includes(nmode) ? nmode : "default",
          }).select().single();
          if (se) { $("#fSave", el).disabled = false; return toast(se.message); }
          state.series.push(s);
          rows = seriesRows(s, seriesDates(s, base.due_date, until));
          if (!rows.length) { closeSheet(); renderAll(); return toast("No matching days in range"); }
        }
        const { data, error } = await sb.from("tasks").insert(rows).select();
        if (error) { $("#fSave", el).disabled = false; return toast(error.message); }
        state.tasks.push(...data);
        state.tasks.sort((a, b) => a.due_date.localeCompare(b.due_date));
        // photos are stored once (on the first day) and shown on every repeat
        if (newFiles.length) { $("#fSave", el).textContent = "Uploading photos…"; await uploadImages(data[0].id, newFiles, "task"); }
        toast(rows.length > 1 ? `${rows.length} tasks added` : "Task added");
        pingThreshold(); // also sends the "new task" notification
      }
      closeSheet(); renderAll();
    };
    $("#fManage", el) && ($("#fManage", el).onclick = () => openManageSheet(t));
  });
}

/* ---------- Archive / delete ---------- */
function seriesFuture(t) { return state.tasks.filter((x) => x.series_id === t.series_id && x.due_date >= t.due_date); }
function openManageSheet(t) {
  const future = t.series_id ? seriesFuture(t) : [t];
  openSheet(`<h3 class="serif">Archive or delete</h3>
    <p class="muted" style="margin:0 0 6px">${esc(t.title)} · ${isRange(t) ? rangeText(t) : relDay(t.due_date)}</p>
    <p class="muted" style="font-size:13.5px;margin:0 0 4px"><b>Archive</b> hides the task — no reminders, no penalty — and you can restore it from ⚙︎ → Archived tasks. <b>Delete</b> removes it and its photos for good.</p>
    <button type="button" class="btn block" id="mArch">🗄️ Archive this task</button>
    ${t.series_id && future.length > 1 ? `<button type="button" class="btn block" id="mArchAll">🗄️ Archive this and all future repeats (${future.length})</button>` : ""}
    <button type="button" class="btn block" id="mDel" style="color:var(--danger)">🗑️ Delete this task</button>
    ${t.series_id && future.length > 1 ? `<button type="button" class="btn block" id="mDelAll" style="color:var(--danger)">🗑️ Delete this and all future repeats (${future.length})</button>` : ""}
    <button type="button" class="btn ghost block" data-close>Cancel</button>`, (el) => {
    const confirmTap = (btn, fn) => {
      btn.onclick = () => {
        if (btn.dataset.armed) return fn();
        btn.dataset.armed = "1"; btn.textContent = "Tap again to confirm delete"; btn.classList.add("danger");
      };
    };
    $("#mArch", el).onclick = () => archiveTasks([t]);
    $("#mArchAll", el) && ($("#mArchAll", el).onclick = () => archiveTasks(future, t.series_id));
    confirmTap($("#mDel", el), () => deleteTasks([t]));
    $("#mDelAll", el) && confirmTap($("#mDelAll", el), () => deleteTasks(future, t.series_id));
  });
}
function confirmDelete(t) {
  if (!t) return;
  const future = t.series_id ? seriesFuture(t) : [t];
  const nImg = state.images.filter((i) => future.some((x) => x.id === i.task_id)).length;
  openSheet(`<h3 class="serif">Delete this task?</h3>
    <p style="margin:4px 0 2px"><b>${esc(t.title)}</b></p>
    <p class="muted" style="margin:0 0 10px">${isRange(t) ? rangeText(t) : relDay(t.due_date)}${t.series_id ? " · 🔁 " + esc(repeatText(t)) : ""}</p>
    <div class="note" style="background:var(--danger-soft);color:var(--danger)">This can't be undone. The task${imagesFor(t.id).length || nImg ? " and its photos" : ""} will be removed for good. Penalty points already charged stay in your total.</div>
    <button type="button" class="btn danger block" id="cdOne">Yes, delete ${t.series_id && future.length > 1 ? "this day only" : "task"}</button>
    ${t.series_id && future.length > 1 ? `<button type="button" class="btn block" id="cdAll" style="color:var(--danger)">Delete this and all future repeats (${future.length})</button>` : ""}
    <button type="button" class="btn ghost block" id="cdArch">Archive instead</button>
    <button type="button" class="btn ghost block" data-close>Cancel</button>`, (el) => {
    $("#cdOne", el).onclick = () => deleteTasks([t]);
    $("#cdAll", el) && ($("#cdAll", el).onclick = () => deleteTasks(future, t.series_id));
    $("#cdArch", el).onclick = () => archiveTasks([t]);
  });
}
async function stopSeries(seriesId) {
  if (!seriesId) return;
  await sb.from("task_series").update({ active: false }).eq("id", seriesId);
  const s = state.series.find((x) => x.id === seriesId); if (s) s.active = false;
}
async function archiveTasks(list, stopSeriesId) {
  const ids = list.map((x) => x.id);
  const archived_at = new Date().toISOString();
  const { error } = await sb.from("tasks").update({ archived: true, archived_at }).in("id", ids);
  if (error) return toast(error.message);
  await stopSeries(stopSeriesId);
  const set = new Set(ids);
  state.archived.unshift(...state.tasks.filter((x) => set.has(x.id)).map((x) => ({ ...x, archived: true, archived_at })));
  state.tasks = state.tasks.filter((x) => !set.has(x.id));
  closeSheet(); renderAll(); toast(ids.length > 1 ? `${ids.length} tasks archived` : "Task archived");
}
async function deleteTasks(list, stopSeriesId) {
  const set = new Set(list.map((x) => x.id));
  await deleteImages(state.images.filter((i) => set.has(i.task_id)));
  const { error } = await sb.from("tasks").delete().in("id", [...set]);
  if (error) return toast(error.message);
  await stopSeries(stopSeriesId);
  state.tasks = state.tasks.filter((x) => !set.has(x.id));
  state.archived = state.archived.filter((x) => !set.has(x.id));
  closeSheet(); renderAll(); toast(set.size > 1 ? `${set.size} tasks deleted` : "Task deleted");
}
function openArchivedSheet() {
  const list = state.archived;
  // group repeating tasks so a long series is one row
  const groups = [];
  const bySeries = new Map();
  for (const x of list) {
    if (x.series_id) {
      if (!bySeries.has(x.series_id)) { const g = { key: x.series_id, items: [] }; bySeries.set(x.series_id, g); groups.push(g); }
      bySeries.get(x.series_id).items.push(x);
    } else groups.push({ key: x.id, items: [x] });
  }
  openSheet(`<h3 class="serif">Archived tasks</h3>
    ${groups.length ? groups.map((g) => {
      const x = g.items[0];
      const when = g.items.length > 1 ? `${g.items.length} days · 🔁 ${esc(repeatText(x) || "repeating")}` : isRange(x) ? rangeText(x) : fmtDate(x.due_date);
      return `<div class="hist-item"><div class="h-main"><div>${esc(x.title)}</div><div class="h-date">${when}</div></div>
        ${state.isAdmin ? `<button type="button" class="btn small" data-restore="${g.key}">Restore</button>
        <button type="button" class="x-btn" data-purge="${g.key}" aria-label="Delete for good">🗑️</button>` : ""}</div>`;
    }).join("") : `<div class="empty">Nothing archived.</div>`}
    <button type="button" class="btn ghost block" data-close>Close</button>`, (el) => {
    const itemsOf = (key) => (bySeries.get(key) || groups.find((g) => g.key === key)).items;
    el.addEventListener("click", async (e) => {
      const r = e.target.closest("[data-restore]"), p = e.target.closest("[data-purge]");
      if (r) {
        const items = itemsOf(r.dataset.restore), ids = items.map((x) => x.id);
        const { error } = await sb.from("tasks").update({ archived: false, archived_at: null }).in("id", ids);
        if (error) return toast(error.message);
        const set = new Set(ids);
        state.tasks.push(...items.map((x) => ({ ...x, archived: false, archived_at: null })));
        state.tasks.sort((a, b) => a.due_date.localeCompare(b.due_date));
        state.archived = state.archived.filter((x) => !set.has(x.id));
        renderAll(); openArchivedSheet(); toast("Restored");
      } else if (p) {
        if (!p.dataset.armed) { p.dataset.armed = "1"; p.textContent = "Sure?"; p.style.width = "auto"; return; }
        await deleteTasks(itemsOf(p.dataset.purge));
        openArchivedSheet();
      }
    });
  });
}

/* ---------- Penalties ---------- */
function openPenaltySheet() {
  openSheet(`<h3 class="serif">Add penalty points</h3>
    <p class="muted" style="margin:0 0 4px;font-size:14px">Pick from your catalogue or type your own.</p>
    ${quickPicks()}
    <label class="field"><span>Item description</span><input id="pDesc" type="text" placeholder="e.g. Late for class" maxlength="120"></label>
    <label class="field"><span>Points</span><input id="pPts" type="number" inputmode="numeric" min="1" value="5"></label>
    <button type="button" class="btn danger block" id="pSave">Add penalty</button>`, (el) => {
    el.querySelector(".quick")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]"); if (!b) return;
      const c = state.catalogue.find((x) => x.id === b.dataset.pick);
      $("#pDesc", el).value = c.item; $("#pPts", el).value = c.points;
    });
    setTimeout(() => $("#pDesc", el).focus(), 250);
    $("#pSave", el).onclick = async () => {
      const description = $("#pDesc", el).value.trim();
      const points = parseInt($("#pPts", el).value || "0", 10);
      if (!description) return toast("Add a description");
      if (!(points > 0)) return toast("Points must be more than 0");
      $("#pSave", el).disabled = true;
      const before = reachedThreshold();
      const { data, error } = await sb.from("penalty_entries").insert({ description, points, source: "manual" }).select().single();
      if (error) { $("#pSave", el).disabled = false; return toast(error.message); }
      state.entries.unshift(data);
      closeSheet(); renderAll();
      const after = reachedThreshold();
      if (after && (!before || after.points > before.points)) {
        state.bannerHiddenFor = null; lsSet("tt_bannerHidden", null); renderBanner();
        toast(`🚨 Threshold reached: ${after.punishment}`);
      } else toast(`+${points} penalty points`);
      pingThreshold();
    };
  });
}
async function deleteEntry(id) {
  const { error } = await sb.from("penalty_entries").delete().eq("id", id);
  if (error) return toast(error.message);
  state.entries = state.entries.filter((e) => e.id !== id);
  renderAll(); pingThreshold(); toast("Removed");
}
function confirmServed() {
  const r = reachedThreshold();
  openSheet(`<h3 class="serif">Reset penalty points?</h3>
    <p class="muted">${r ? `Confirm the punishment <b>${esc(r.punishment)}</b> has been served. ` : ""}Your total goes back to 0. Past entries are kept in the database but no longer count.</p>
    <button type="button" class="btn danger block" id="srv">Yes, reset to 0</button>
    <button type="button" class="btn ghost block" data-close>Cancel</button>`, (el) => {
    $("#srv", el).onclick = async () => {
      const ids = state.entries.map((e) => e.id);
      const { error } = await sb.from("penalty_entries").update({ cleared: true }).in("id", ids);
      if (error) return toast(error.message);
      state.entries = [];
      closeSheet(); renderAll(); pingThreshold(); toast("Points reset — fresh start");
    };
  });
}

/* ---------- Chart rows ---------- */
async function addChartRow(table, key, row) {
  const { data, error } = await sb.from(table).insert(row).select().single();
  if (error) return toast(error.message);
  state[key].push(data);
  if (key === "thresholds") state.thresholds.sort((a, b) => a.points - b.points);
  renderAll();
  const sel = key === "catalogue" ? `[data-cat="${data.id}"] input[data-field="item"]` : `[data-th="${data.id}"] input[data-field="punishment"]`;
  $(sel)?.focus();
}
async function deleteRow(table, key, id) {
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) return toast(error.message);
  state[key] = state[key].filter((r) => r.id !== id);
  renderAll();
  if (key === "thresholds") pingThreshold();
}

/* ---------- Update check ---------- */
let updateShown = false;
async function checkForUpdate() {
  if (updateShown) return;
  try {
    const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const { version, notes } = await r.json();
    if (!version || String(version) === APP_VERSION) return;
    updateShown = true;
    const bar = document.createElement("div");
    bar.className = "update-pop";
    bar.innerHTML = `<div class="up-card" role="alertdialog" aria-live="polite">
      <div class="up-icon">✨</div>
      <div class="up-text"><b>New version available</b><small>${esc(notes || "Update to get the latest features and fixes.")}</small></div>
      <div class="up-actions"><button type="button" class="btn small ghost" id="upLater">Later</button>
      <button type="button" class="btn small primary" id="upNow">Update now</button></div></div>`;
    document.body.appendChild(bar);
    $("#upNow").onclick = () => { const u = new URL(location.href); u.searchParams.set("v", version); location.replace(u.toString()); };
    $("#upLater").onclick = () => { bar.remove(); setTimeout(() => { updateShown = false; }, 30 * 60e3); };
  } catch {}
}
setInterval(checkForUpdate, 5 * 60e3);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

/* ---------- Admin ---------- */
function RO() { return state.isAdmin ? "" : "readonly"; }
async function checkAdmin() {
  const { data: { session } } = await sb.auth.getSession();
  state.adminAuthed = false; state.adminEmail = "";
  if (session?.user) {
    const { data } = await sb.rpc("is_admin");
    state.adminAuthed = !!data;
    state.adminEmail = session.user.email || "";
  }
  if (!state.adminAuthed) state.editMode = false;
  applyMode();
}
// Admin sees the visitor view by default; the small ✎ Edit button switches to editing
function applyMode() {
  state.isAdmin = state.adminAuthed && state.editMode;
  if (!state.isAdmin && state.arranging) { state.arranging = false; $("#arrangeBar").classList.add("hidden"); }
  document.body.classList.toggle("is-admin", state.isAdmin);
  document.body.classList.toggle("admin-authed", state.adminAuthed);
  $("#modeLabel").textContent = state.adminAuthed ? (state.editMode ? "Editing" : "") : "View only";
  $("#modeLabel").classList.toggle("editing", state.isAdmin);
  const b = $("#btnEdit");
  b.textContent = state.editMode ? "✓ Done" : "✎ Edit";
  b.classList.toggle("on", state.editMode);
}
$("#btnEdit").onclick = () => { state.editMode = !state.editMode; applyMode(); renderAll(); toast(state.editMode ? "Edit mode on" : "Back to view mode"); };
function openAdminLogin() {
  openSheet(`<h3 class="serif">Admin sign in</h3>
    <p class="muted" style="margin:0;font-size:14px">Only the admin can add, tick or change things.</p>
    <label class="field"><span>Email</span><input id="aEmail" type="email" autocomplete="email" inputmode="email"></label>
    <label class="field"><span>Password</span><input id="aPass" type="password" autocomplete="current-password"></label>
    <button type="button" class="btn primary block" id="aGo">Sign in</button>
    <button type="button" class="link" id="aForgot">Forgot password?</button>
    <p class="muted" id="aMsg" style="font-size:14px;min-height:20px"></p>`, (el) => {
    const msg = (m) => ($("#aMsg", el).textContent = m);
    $("#aGo", el).onclick = async () => {
      msg("Signing in…");
      const { error } = await sb.auth.signInWithPassword({ email: $("#aEmail", el).value.trim(), password: $("#aPass", el).value });
      if (error) return msg(error.message);
      await checkAdmin();
      if (!state.adminAuthed) { await sb.auth.signOut(); await checkAdmin(); return msg("This account isn't the admin."); }
      state.editMode = true; applyMode();
      closeSheet(); renderAll(); toast("Signed in — edit mode on. Tap ✓ Done to see the visitor view.");
    };
    $("#aForgot", el).onclick = async () => {
      const email = $("#aEmail", el).value.trim();
      if (!email) return msg("Type your email above first.");
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      msg(error ? error.message : "Password reset email sent.");
    };
  });
}
sb.auth.onAuthStateChange((ev) => {
  if (ev === "PASSWORD_RECOVERY") {
    openSheet(`<h3 class="serif">Set a new password</h3>
      <label class="field"><span>New password</span><input id="np" type="password" autocomplete="new-password"></label>
      <button type="button" class="btn primary block" id="npSave">Save password</button>`, (el) => {
      $("#npSave", el).onclick = async () => {
        const { error } = await sb.auth.updateUser({ password: $("#np", el).value });
        if (error) return toast(error.message);
        closeSheet(); await checkAdmin(); renderAll(); toast("Password updated");
      };
    });
  }
});

/* ---------- FAB ---------- */
$("#fab").onclick = () => {
  const open = $("#fabMenu").classList.toggle("hidden");
  $("#fab").classList.toggle("open", !open);
};
function closeFab() { $("#fabMenu").classList.add("hidden"); $("#fab").classList.remove("open"); }
$("#fabTask").onclick = () => { closeFab(); openTaskSheet(null, state.calSel && state.calSel >= sgDateStr() ? state.calSel : sgDateStr()); };
$("#fabPenalty").onclick = () => { closeFab(); openPenaltySheet(); };
document.addEventListener("click", (e) => { if (!e.target.closest("#fab,#fabMenu")) closeFab(); });

/* ---------- Settings / notifications ---------- */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let swReg = null;
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register("sw.js");
    // keep the server copy of this device's subscription fresh
    if (pushSupported && Notification.permission === "granted") {
      const sub = await swReg.pushManager.getSubscription();
      if (sub) await saveSub(sub);
    }
  } catch (e) { console.warn("SW", e); }
}
function urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function saveSub(sub) {
  await sb.functions.invoke("notify", { body: { mode: "subscribe", subscription: sub.toJSON() } });
}
async function enablePush() {
  if (!pushSupported) {
    if (isIOS && !isStandalone) return toast("First add this app to your Home Screen (see steps below)");
    return toast("This browser doesn't support notifications");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Notifications were not allowed");
  swReg = swReg || (await navigator.serviceWorker.register("sw.js"));
  await navigator.serviceWorker.ready;
  let sub = await swReg.pushManager.getSubscription();
  if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
  await saveSub(sub);
  await sb.functions.invoke("notify", { body: { mode: "test" } });
  toast("Notifications on — check for a test alert");
  openSettings();
}
async function disablePush() {
  const sub = swReg && (await swReg.pushManager.getSubscription());
  if (sub) {
    await sb.functions.invoke("notify", { body: { mode: "unsubscribe", subscription: sub.toJSON() } });
    await sub.unsubscribe();
  }
  toast("Notifications off on this device");
  openSettings();
}

async function openSettings() {
  let subscribed = false;
  if (pushSupported && swReg) subscribed = !!(await swReg.pushManager.getSubscription()) && Notification.permission === "granted";
  const iosHelp = isIOS && !isStandalone ? `<div class="note"><b>iPhone / iPad:</b> notifications only work from the Home Screen app. Tap the <b>Share</b> button in Safari → <b>Add to Home Screen</b>, open the app from your Home Screen, then turn notifications on here.</div>` : "";
  openSheet(`<h3 class="serif">Settings</h3>
    <div class="setting"><div><b>Phone notifications</b><small>${subscribed ? "On for this device" : "Off for this device"}</small></div>
      ${subscribed ? `<button type="button" class="btn small" id="sOff">Turn off</button>` : `<button type="button" class="btn small primary" id="sOn">Turn on</button>`}</div>
    ${iosHelp}
    <div class="setting"><div><b>Archived tasks</b><small>${state.archived.length ? `${state.archived.length} archived` : "None"}</small></div><button type="button" class="btn small" id="sArch">View</button></div>
    <div class="setting"><div><b>Photo storage</b><small>${fmtMB(usedBytes())} of 100 MB used</small></div></div>
    <div class="setting"><div><b>Reminder schedule</b><small>Each task can use its own notifications (Hourly, Specific time(s), From – to or Off) — set it when adding/editing. <b>Default</b> — <b>one due date:</b> hourly while unchecked — weekdays 9pm–12am, weekends 12pm–12am.<br><b>Time range:</b> 12pm every day in the range, then hourly 7pm–11pm on the due day.<br><b>Quiet time 2am–7am:</b> no notifications. Penalty and threshold alerts from that time arrive at 7am.<br>Singapore time. Threshold alerts are otherwise sent straight away.</small></div></div>
    ${subscribed ? `<div class="setting"><div><b>Send a reminder now</b><small>Test what the hourly reminder looks like</small></div><button type="button" class="btn small" id="sTest">Send</button></div>` : ""}
    <div class="setting"><div><b>How penalties work</b><small>A task still unchecked when it's due adds its penalty points automatically — right after its due time if it has one, otherwise after midnight. You get a phone notification whenever points are added.</small></div></div>
    ${state.adminAuthed
      ? `<div class="setting"><div><b>Admin</b><small>Signed in as ${esc(state.adminEmail)}. Use the ✎ Edit button at the top to make changes.</small></div><button type="button" class="btn small" id="sOut">Sign out</button></div>`
      : `<div class="setting"><div><b>View only</b><small>Anyone with the link can view. Only the admin can make changes.</small></div><button type="button" class="btn small primary" id="sIn">Admin sign in</button></div>`}
    <button type="button" class="btn ghost block" data-close>Close</button>`, (el) => {
    $("#sOn", el) && ($("#sOn", el).onclick = enablePush);
    $("#sIn", el) && ($("#sIn", el).onclick = openAdminLogin);
    $("#sArch", el).onclick = openArchivedSheet;
    $("#sOut", el) && ($("#sOut", el).onclick = async () => { await sb.auth.signOut(); await checkAdmin(); closeSheet(); renderAll(); toast("Signed out — view only"); });
    $("#sOff", el) && ($("#sOff", el).onclick = disablePush);
    $("#sTest", el) && ($("#sTest", el).onclick = async () => {
      const { data } = await sb.functions.invoke("notify", { body: { mode: "remind" } });
      toast(data?.sent ? "Reminder sent" : "No unchecked tasks to remind about");
    });
  });
}
$("#btnMenu").onclick = openSettings;

boot();
