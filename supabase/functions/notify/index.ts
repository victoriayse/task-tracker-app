// Task Tracker – push notifications
// Called every 5 minutes by pg_cron (header x-cron-secret) and by the app after points change.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const OWNER = "00000000-0000-0000-0000-000000000001";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

let configLoaded = false;
let cronSecret = "";
async function loadConfig() {
  if (configLoaded) return;
  const { data } = await admin.from("app_config").select("key,value");
  const c: Record<string, string> = {};
  (data || []).forEach((r) => (c[r.key] = r.value));
  webpush.setVapidDetails("mailto:noreply@task-tracker.app", c.vapid_public, c.vapid_private);
  cronSecret = c.cron_secret;
  configLoaded = true;
}

// Singapore time helpers
function sgNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // shift, then read UTC fields
  return { hour: d.getUTCHours(), dow: d.getUTCDay(), date: d.toISOString().slice(0, 10) };
}
// Quiet time 2am–7am (Singapore): nothing is sent; penalty/threshold alerts wait until 7am
const QUIET_FROM = 2, QUIET_TO = 7;
function isQuiet(hour = sgNow().hour) { return hour >= QUIET_FROM && hour < QUIET_TO; }
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function sendToUser(userId: string, payload: Record<string, unknown>) {
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push failed", code, (e as Error).message);
    }
  }
  return sent;
}

// Which unchecked tasks to mention on this run (the job runs every 5 minutes).
// Per task notify_mode:
//  • default  – one-date tasks: hourly, weekdays 9pm–12am / weekends 12pm–12am; time-range tasks: 12pm daily, then 7–11pm on the due day
//  • hourly   – every hour on the hour from notify_from (or now) until the task is due
//  • specific – at each chosen date/time (also during quiet time — you picked it)
//  • range    – every hour on the hour between notify_from and notify_to
//  • off      – never
type T = { title: string; due_date: string; due_time: string | null; start_date: string | null; penalty_points: number;
  notify_mode: string; notify_times: string[] | null; notify_from: string | null; notify_to: string | null };
async function remindUser(userId: string, o: { refDate: string; lastCall: boolean; inWindow: boolean; hour: number; today: string;
  topOfHour: boolean; quiet: boolean; slotEnd: number; force?: boolean }) {
  const { data: all } = await admin
    .from("tasks")
    .select("title,due_date,due_time,start_date,penalty_points,notify_mode,notify_times,notify_from,notify_to")
    .eq("user_id", userId)
    .eq("completed", false)
    .eq("archived", false)
    .lte("due_date", addDays(o.today, 400))
    .order("due_date");
  const isRange = (t: T) => !!t.start_date && t.start_date < t.due_date;
  const deadline = (t: T) =>
    t.due_time ? Date.parse(`${t.due_date}T${t.due_time.slice(0, 8)}+08:00`) : Date.parse(`${addDays(t.due_date, 1)}T00:00:00+08:00`);
  const slotStart = o.slotEnd - 5 * 60_000;
  const pick = ((all || []) as T[]).filter((t) => {
    const mode = t.notify_mode || "default";
    if (mode === "off") return false;
    if (mode === "specific") {
      return (t.notify_times || []).some((x) => { const ms = Date.parse(x); return ms > slotStart && ms <= o.slotEnd; });
    }
    if (o.quiet || !o.topOfHour) return false; // everything below is hourly, outside quiet time
    if (o.force) return t.due_date <= o.today || (isRange(t) && t.start_date! <= o.today);
    if (mode === "hourly") {
      const from = t.notify_from ? Date.parse(t.notify_from) : 0;
      return from <= o.slotEnd + 60_000 && o.slotEnd < deadline(t);
    }
    if (mode === "range") {
      if (!t.notify_from || !t.notify_to) return false;
      return Date.parse(t.notify_from) <= o.slotEnd + 60_000 && o.slotEnd <= Date.parse(t.notify_to);
    }
    // default schedule
    if (!isRange(t)) return o.inWindow && t.due_date <= o.refDate;
    if (t.due_date < o.refDate) return o.inWindow;                                  // overdue range task
    if (t.due_date === o.today && o.hour >= 19 && o.hour <= 23) return true;        // due day: hourly 7pm–11pm
    if (o.hour === 12 && t.start_date! <= o.today && o.today < t.due_date) return true; // daily 12pm during range
    return false;
  });
  if (!pick.length) return 0;
  const today = o.today;
  const atStake = pick.filter((t) => t.due_date <= o.refDate).reduce((a, t) => a + (t.penalty_points || 0), 0);
  const label = (t: T) => "• " + t.title + (t.due_date > today ? ` (due ${t.due_date.slice(8)}/${t.due_date.slice(5, 7)}${t.due_time ? " " + t.due_time.slice(0, 5) : ""})`
    : t.due_time ? ` (due ${t.due_time.slice(0, 5)})` : "");
  const names = pick.slice(0, 4).map(label).join("\n");
  const more = pick.length > 4 ? `\n+${pick.length - 4} more` : "";
  return sendToUser(userId, {
    title: o.lastCall ? `⏰ Last call: ${pick.length} unchecked task${pick.length > 1 ? "s" : ""}` : `📝 ${pick.length} task${pick.length > 1 ? "s" : ""} still unchecked`,
    body: `${names}${more}${atStake ? `\n${atStake} penalty pts at stake` : ""}`,
    tag: "reminder",
    url: "./",
  });
}
// Tell the user about any newly added penalty points (missed tasks or manual)
async function notifyPenalties(userId: string) {
  const { data: fresh } = await admin.from("penalty_entries").select("id,description,points")
    .eq("user_id", userId).eq("notified", false).eq("cleared", false).order("created_at");
  if (!fresh || !fresh.length) return 0;
  await admin.from("penalty_entries").update({ notified: true }).in("id", fresh.map((e) => e.id));
  const { data: all } = await admin.from("penalty_entries").select("points").eq("user_id", userId).eq("cleared", false);
  const total = (all || []).reduce((a, e) => a + e.points, 0);
  const added = fresh.reduce((a, e) => a + e.points, 0);
  const lines = fresh.slice(0, 4).map((e) => `• ${e.description} (+${e.points})`).join("\n");
  await sendToUser(userId, {
    title: `⚠️ +${added} penalty point${added === 1 ? "" : "s"}`,
    body: `${lines}${fresh.length > 4 ? `\n+${fresh.length - 4} more` : ""}\nTotal now: ${total} pts`,
    tag: "penalty-" + fresh[0].id,
    url: "./",
  });
  return fresh.length;
}

async function checkThreshold(userId: string) {
  const [{ data: entries }, { data: ths }, { data: st }] = await Promise.all([
    admin.from("penalty_entries").select("points").eq("user_id", userId).eq("cleared", false),
    admin.from("thresholds").select("points,punishment").eq("user_id", userId).order("points", { ascending: false }),
    admin.from("user_settings").select("last_threshold_notified").eq("user_id", userId).maybeSingle(),
  ]);
  const total = (entries || []).reduce((a, e) => a + e.points, 0);
  const reached = (ths || []).find((t) => t.points > 0 && total >= t.points);
  const reachedPts = reached ? reached.points : 0;
  const last = st?.last_threshold_notified ?? 0;
  let notified = false;
  if (reached && reachedPts > last) {
    await sendToUser(userId, {
      title: `🚨 Penalty threshold reached: ${total} pts`,
      body: `${reached.points} pts = ${reached.punishment}`,
      tag: "threshold",
      url: "./",
      requireInteraction: true,
    });
    notified = true;
  }
  if (reachedPts !== last) {
    await admin.from("user_settings").upsert({ user_id: userId, last_threshold_notified: reachedPts, updated_at: new Date().toISOString() });
  }
  return { total, reached, notified };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    await loadConfig();
    const body = await req.json().catch(() => ({}));

    // ---- Scheduled run (every 5 minutes) ----
    if (req.headers.get("x-cron-secret")) {
      if (req.headers.get("x-cron-secret") !== cronSecret) return json({ error: "forbidden" }, 403);
      const now = sgNow();
      const minute = new Date().getUTCMinutes();
      const topOfHour = minute < 5;            // hourly rules only on the first run of each hour
      const slotEnd = Math.floor(Date.now() / 300_000) * 300_000; // this 5-minute slot
      // 12am belongs to the evening that just ended
      const lastCall = now.hour === 0;
      const refDate = lastCall ? addDays(now.date, -1) : now.date;
      const refDow = lastCall ? (now.dow + 6) % 7 : now.dow;
      const weekend = refDow === 0 || refDow === 6;
      const inWindow = lastCall || (weekend ? now.hour >= 12 : now.hour >= 21);

      const { data: users } = await admin.from("user_settings").select("user_id");
      const quiet = isQuiet(now.hour);
      let reminders = 0;
      for (const u of users || []) reminders += await remindUser(u.user_id, { refDate, lastCall, inWindow, hour: now.hour, today: now.date, topOfHour, quiet, slotEnd, force: !!body.force });
      // Charge points for missed tasks (untimed: after midnight; timed: once the due time passes) — even in quiet time
      const { data: chargedN } = await admin.rpc("apply_missed_penalties", { p_user: null });
      const charged = chargedN || 0;
      // alerts for points / thresholds are held during quiet time and go out at 7am
      if (!quiet) for (const u of users || []) { await notifyPenalties(u.user_id); await checkThreshold(u.user_id); }
      return json({ ok: true, sg: now, quiet, topOfHour, inWindow, reminders, charged });
    }

    // ---- Called from the app (public, shared tracker — no login) ----
    const user = { id: OWNER };

    if (body.mode === "subscribe" || body.mode === "unsubscribe") {
      const s = body.subscription || {};
      if (!s.endpoint || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint)) return json({ error: "bad subscription" }, 400);
      if (body.mode === "unsubscribe") {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        return json({ ok: true });
      }
      if (!s.keys?.p256dh || !s.keys?.auth) return json({ error: "bad subscription" }, 400);
      const { error } = await admin.from("push_subscriptions").upsert(
        { user_id: OWNER, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth },
        { onConflict: "endpoint" },
      );
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.mode === "test") {
      const sent = await sendToUser(user.id, { title: "🔔 Notifications are on", body: "You'll get task reminders and threshold alerts here.", tag: "test", url: "./" });
      return json({ ok: true, sent });
    }
    if (body.mode === "remind") {
      const n = sgNow();
      const sent = await remindUser(user.id, { refDate: n.date, lastCall: false, inWindow: true, hour: n.hour, today: n.date, topOfHour: true, quiet: false, slotEnd: Date.now(), force: true });
      return json({ ok: true, sent });
    }
    if (isQuiet()) return json({ ok: true, quiet: true }); // held until 7am
    await notifyPenalties(user.id);
    const r = await checkThreshold(user.id);
    return json({ ok: true, ...r });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
