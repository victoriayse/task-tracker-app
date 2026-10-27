/* Task Tracker – single-page app (no build step) */
const SUPABASE_URL = "https://ypyxzrmmyqptoduzzazp.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlweXh6cm1teXFwdG9kdXp6YXpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxMTM0NjQsImV4cCI6MjEwODY4OTQ2NH0.jmvbrDabOvvHgCFRvNdBhM6Q63ZYPR-HHl5cdZfEtJo";
const VAPID_PUBLIC = "BJd0pVUgBPkI3t2OEexmrDiuDdxLtn6BavlNkpm8lBhuepe3vP9u4LUCXb4Bx0o2bSP6-PQkFoXUbTsKAofy56c";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const OWNER = "00000000-0000-0000-0000-000000000001"; // one shared, public tracker
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
  entries: [],
  catalogue: [],
  thresholds: [],
  layout: DEFAULT_LAYOUT.slice(),
  collapsed: {},
  chartTab: "catalogue",
  isAdmin: false,
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
  const [t, e, c, th, st, se] = await Promise.all([
    sb.from("tasks").select("*").order("due_date").order("due_time", { nullsFirst: true }).order("created_at"),
    sb.from("penalty_entries").select("*").eq("cleared", false).order("created_at", { ascending: false }),
    sb.from("catalogue_items").select("*").order("sort").order("created_at"),
    sb.from("thresholds").select("*").order("points"),
    sb.from("user_settings").select("*").maybeSingle(),
    sb.from("task_series").select("*"),
  ]);
  const err = [t, e, c, th, st, se].find((r) => r.error);
  if (err) toast("Couldn't load: " + err.error.message);
  state.tasks = t.data || [];
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
  state.chartTab = lsGet("tt_chartTab", "catalogue");
  state.bannerHiddenFor = lsGet("tt_bannerHidden", null);
  state.calMonth = sgDateStr().slice(0, 7);
  state.calSel = sgDateStr();
  $("#todayLabel").textContent = fmtDate(sgDateStr(), { weekday: "long", day: "numeric", month: "long" });
  renderAll();
  await loadAll();
  renderAll();
  registerSW();
  subscribeRealtime();
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
    const list = state.tasks.filter((x) => x.due_date === t);
    return list.length ? `<span class="count">${list.filter((x) => x.completed).length}/${list.length}</span>` : "";
  }
  if (k === "due") {
    const n = state.tasks.filter((x) => !x.completed && x.due_date < t).length;
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
  if (showDate) meta.push(`<span class="${late ? "late" : ""}">${late ? "Overdue · " : ""}${relDay(t.due_date)}</span>`);
  if (t.due_time) meta.push(`<span>🕒 ${fmtTime(t.due_time)}</span>`);
  const rt = repeatText(t);
  if (rt) meta.push(`<span>🔁 ${esc(rt)}</span>`);
  if (t.penalized) meta.push(`<span class="late">Penalty charged</span>`);
  if (t.notes) meta.push(`<span>📎 ${esc(t.notes.slice(0, 40))}${t.notes.length > 40 ? "…" : ""}</span>`);
  return `<div class="task${t.completed ? " done" : ""}" data-task="${t.id}">
    <button type="button" class="check${t.completed ? " on" : ""}" data-check="${t.id}" ${state.isAdmin ? "" : "disabled"} aria-label="${t.completed ? "Mark not done" : "Mark done"}">${t.completed ? "✓" : ""}</button>
    <div class="task-main"${state.isAdmin ? ` data-edit="${t.id}"` : ""}>
      <div class="task-title">${esc(t.title)}</div>
      ${meta.length ? `<div class="task-meta">${meta.join("")}</div>` : ""}
    </div>
    ${t.penalty_points ? `<span class="pts">−${t.penalty_points}</span>` : ""}
  </div>`;
}

function renderToday() {
  const t = sgDateStr();
  const list = state.tasks.filter((x) => x.due_date === t)
    .sort((a, b) => (a.completed - b.completed));
  if (!list.length) return `<div class="empty">Nothing scheduled for today.${state.isAdmin ? " Tap ＋ to add a task." : ""}</div>`;
  const done = list.filter((x) => x.completed).length;
  const atStake = list.filter((x) => !x.completed).reduce((a, x) => a + x.penalty_points, 0);
  return `<div class="progress-line">${done} of ${list.length} done${atStake ? ` · <b style="color:var(--danger)">${atStake} pts at stake</b> by midnight` : " · all clear 🎉"}</div>
    ${list.map((x) => taskRow(x, false)).join("")}`;
}

function renderDue() {
  const t = sgDateStr();
  const overdue = state.tasks.filter((x) => !x.completed && x.due_date < t).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const upcoming = state.tasks.filter((x) => !x.completed && x.due_date > t && x.due_date <= addDays(t, 7));
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
  state.tasks.forEach((t) => (byDay[t.due_date] = byDay[t.due_date] || []).push(t));
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i === 35 && d.slice(0, 7) !== state.calMonth) break;
    const list = byDay[d] || [];
    const chips = list.slice(0, 2).map((t) => {
      const cls = t.completed ? "done" : d < today ? "missed" : "";
      return `<span class="chip ${cls}">${esc(t.title)}</span>`;
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
  const tabs = `<div class="tabs"><button type="button" data-tab="catalogue" class="${tab === "catalogue" ? "on" : ""}">Catalogue</button><button type="button" data-tab="threshold" class="${tab === "threshold" ? "on" : ""}">Threshold</button></div>`;
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
  const el = e.target.closest("button,[data-edit]");
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
  const WRITE = d.check || d.edit || d.addon || d.delcat || d.delth || d.delentry || d.move || ["addCat", "addTh", "addPenalty", "served"].includes(d.act);
  if (WRITE && !state.isAdmin) return toast("View only — admin sign-in needed to make changes");
  if (d.check) return toggleTask(d.check);
  if (d.edit) return openTaskSheet(state.tasks.find((t) => t.id === d.edit));
  if (d.day) { state.calSel = d.day; renderAll(); return; }
  if (d.cal) {
    const [y, m] = state.calMonth.split("-").map(Number);
    const nd = new Date(Date.UTC(y, m - 1 + Number(d.cal), 1));
    state.calMonth = nd.toISOString().slice(0, 7);
    state.calSel = state.calMonth === sgDateStr().slice(0, 7) ? sgDateStr() : state.calMonth + "-01";
    renderAll(); return;
  }
  if (d.addon) return openTaskSheet(null, d.addon);
  if (d.tab) { state.chartTab = d.tab; lsSet("tt_chartTab", d.tab); renderAll(); return; }
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
async function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const completed = !t.completed;
  Object.assign(t, { completed, completed_at: completed ? new Date().toISOString() : null });
  renderAll();
  if (completed && navigator.vibrate) navigator.vibrate(15);
  const { error } = await sb.from("tasks").update({ completed, completed_at: t.completed_at }).eq("id", id);
  if (error) { t.completed = !completed; renderAll(); toast(error.message); }
  else if (completed && t.penalized) toast("Done — but the penalty for missing it still stands");
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
  return dates.map((d) => ({ title: s.title, notes: s.notes, due_time: s.due_time, penalty_points: s.penalty_points, due_date: d, repeat: s.repeat, series_id: s.id }));
}
// keep active repeating tasks topped up so they never run out
async function topUpSeries() {
  const today = sgDateStr();
  const target = addDays(today, HORIZON_DAYS);
  for (const s of state.series) {
    if (!s.active || s.generated_until >= addDays(today, TOPUP_DAYS)) continue;
    const rows = seriesRows(s, seriesDates(s, addDays(s.generated_until, 1), target));
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
  openSheet(`<h3 class="serif">${isEdit ? "Edit task" : "New task"}</h3>
    <label class="field"><span>Task</span><input id="fTitle" type="text" value="${esc(t.title)}" placeholder="e.g. Submit report" maxlength="120"></label>
    ${quickPicks()}
    <div class="row">
      <label class="field"><span>Date</span><input id="fDate" type="date" value="${t.due_date}"></label>
      <label class="field"><span>Time (optional)</span><input id="fTime" type="time" value="${t.due_time ? t.due_time.slice(0, 5) : ""}"></label>
    </div>
    <label class="field"><span>Penalty points if missed</span><input id="fPts" type="number" inputmode="numeric" min="0" value="${t.penalty_points}"></label>
    ${isEdit ? (t.series_id ? `<div class="note">🔁 Repeats: ${esc(repeatText(t))}. Changes here apply to this day only.</div>` : "") : `<div class="field"><span>Repeat</span><div class="seg" id="fRepeat">
      ${Object.entries(REPEAT_LABEL).map(([k, v]) => `<button type="button" data-r="${k}" class="${k === repeat ? "on" : ""}">${v}</button>`).join("")}
    </div>
    <div class="seg hidden" id="fDays" style="margin-top:8px">
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-d="${d}" class="${days.includes(d) ? "on" : ""}">${DOW_SHORT[d]}</button>`).join("")}
    </div>
    <div class="muted" style="font-size:12.5px;margin-top:6px" id="fRepeatHint"></div></div>`}
    <label class="field"><span>Notes (optional)</span><textarea id="fNotes" placeholder="Details…">${esc(t.notes || "")}</textarea></label>
    <button type="button" class="btn primary block" id="fSave">${isEdit ? "Save changes" : "Add task"}</button>
    ${isEdit ? `<button type="button" class="btn ghost block" id="fDelete" style="color:var(--danger)">Delete task</button>
      ${t.series_id ? `<button type="button" class="link" id="fDeleteSeries" style="color:var(--danger);display:block;margin:6px auto 0">Delete this and all future repeats</button>` : ""}` : ""}
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
    if (!isEdit) setTimeout(() => $("#fTitle", el).focus(), 250);
    $("#fSave", el).onclick = async () => {
      const title = $("#fTitle", el).value.trim();
      if (!title) return toast("Give the task a name");
      const base = {
        title,
        due_date: $("#fDate", el).value || sgDateStr(),
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
        toast(rows.length > 1 ? `${rows.length} tasks added` : "Task added");
      }
      closeSheet(); renderAll();
    };
    $("#fDelete", el) && ($("#fDelete", el).onclick = async () => {
      const { error } = await sb.from("tasks").delete().eq("id", t.id);
      if (error) return toast(error.message);
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      closeSheet(); renderAll(); toast("Task deleted");
    });
    $("#fDeleteSeries", el) && ($("#fDeleteSeries", el).onclick = async () => {
      const { error } = await sb.from("tasks").delete().eq("series_id", t.series_id).gte("due_date", t.due_date);
      if (error) return toast(error.message);
      await sb.from("task_series").update({ active: false }).eq("id", t.series_id);
      const s = state.series.find((x) => x.id === t.series_id); if (s) s.active = false;
      state.tasks = state.tasks.filter((x) => !(x.series_id === t.series_id && x.due_date >= t.due_date));
      closeSheet(); renderAll(); toast("Repeats deleted");
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

/* ---------- Admin ---------- */
function RO() { return state.isAdmin ? "" : "readonly"; }
async function checkAdmin() {
  const { data: { session } } = await sb.auth.getSession();
  state.isAdmin = false; state.adminEmail = "";
  if (session?.user) {
    const { data } = await sb.rpc("is_admin");
    state.isAdmin = !!data;
    state.adminEmail = session.user.email || "";
  }
  document.body.classList.toggle("is-admin", state.isAdmin);
  $("#modeLabel").textContent = state.isAdmin ? "" : "View only";
}
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
      if (!state.isAdmin) { await sb.auth.signOut(); await checkAdmin(); return msg("This account isn't the admin."); }
      closeSheet(); renderAll(); toast("Admin mode on");
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
    <div class="setting"><div><b>Reminder schedule</b><small>Hourly for unchecked tasks · Weekdays 9pm–12am · Weekends 12pm–12am (Singapore time). Threshold alerts are sent straight away.</small></div></div>
    ${subscribed ? `<div class="setting"><div><b>Send a reminder now</b><small>Test what the hourly reminder looks like</small></div><button type="button" class="btn small" id="sTest">Send</button></div>` : ""}
    <div class="setting"><div><b>How penalties work</b><small>A task still unchecked after midnight on its date adds its penalty points automatically. You can also add points by hand.</small></div></div>
    ${state.isAdmin
      ? `<div class="setting"><div><b>Admin mode</b><small>Signed in as ${esc(state.adminEmail)} — you can make changes</small></div><button type="button" class="btn small" id="sOut">Sign out</button></div>`
      : `<div class="setting"><div><b>View only</b><small>Anyone with the link can view. Only the admin can make changes.</small></div><button type="button" class="btn small primary" id="sIn">Admin sign in</button></div>`}
    <button type="button" class="btn ghost block" data-close>Close</button>`, (el) => {
    $("#sOn", el) && ($("#sOn", el).onclick = enablePush);
    $("#sIn", el) && ($("#sIn", el).onclick = openAdminLogin);
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
