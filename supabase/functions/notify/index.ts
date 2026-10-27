// Task Tracker – push notifications
// Called hourly by pg_cron (header x-cron-secret) and by the app (user JWT) after points change.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

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

async function remindUser(userId: string, refDate: string, lastCall: boolean) {
  const { data: tasks } = await admin
    .from("tasks")
    .select("title,due_date,penalty_points")
    .eq("user_id", userId)
    .eq("completed", false)
    .lte("due_date", refDate)
    .order("due_date");
  if (!tasks || tasks.length === 0) return 0;
  const pts = tasks.reduce((a, t) => a + (t.penalty_points || 0), 0);
  const names = tasks.slice(0, 4).map((t) => "• " + t.title).join("\n");
  const more = tasks.length > 4 ? `\n+${tasks.length - 4} more` : "";
  return sendToUser(userId, {
    title: lastCall ? `⏰ Last call: ${tasks.length} unchecked task${tasks.length > 1 ? "s" : ""}` : `📝 ${tasks.length} task${tasks.length > 1 ? "s" : ""} still unchecked`,
    body: `${names}${more}\n${pts} penalty pts at stake`,
    tag: "reminder",
    url: "./",
  });
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

    // ---- Hourly cron ----
    if (req.headers.get("x-cron-secret")) {
      if (req.headers.get("x-cron-secret") !== cronSecret) return json({ error: "forbidden" }, 403);
      const now = sgNow();
      // 12am belongs to the evening that just ended
      const lastCall = now.hour === 0;
      const refDate = lastCall ? addDays(now.date, -1) : now.date;
      const refDow = lastCall ? (now.dow + 6) % 7 : now.dow;
      const weekend = refDow === 0 || refDow === 6;
      const inWindow = lastCall || (weekend ? now.hour >= 12 : now.hour >= 21);

      const { data: users } = await admin.from("user_settings").select("user_id");
      let reminders = 0;
      if (inWindow || body.force) {
        for (const u of users || []) reminders += await remindUser(u.user_id, refDate, lastCall);
      }
      // After midnight: charge points for tasks whose day has passed unchecked
      let charged = 0;
      if (lastCall || body.force) {
        const { data } = await admin.rpc("apply_missed_penalties", { p_user: null });
        charged = data || 0;
      }
      for (const u of users || []) await checkThreshold(u.user_id);
      return json({ ok: true, sg: now, inWindow, reminders, charged });
    }

    // ---- Called from the app by the signed-in user ----
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "unauthorized" }, 401);

    if (body.mode === "test") {
      const sent = await sendToUser(user.id, { title: "🔔 Notifications are on", body: "You'll get task reminders and threshold alerts here.", tag: "test", url: "./" });
      return json({ ok: true, sent });
    }
    if (body.mode === "remind") {
      const sent = await remindUser(user.id, sgNow().date, false);
      return json({ ok: true, sent });
    }
    const r = await checkThreshold(user.id);
    return json({ ok: true, ...r });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
