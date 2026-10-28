# Task Tracker

Mobile-first, public (no login) shared task tracker with penalty points. Hosted on GitHub Pages, data in Supabase.

- Today's tasks, tasks due (overdue + next 7 days), monthly calendar
- Penalty points per task — charged automatically if a task is still unchecked after midnight (Singapore time)
- Manual penalty points; editable penalty chart (catalogue + thresholds); threshold banner + phone notification
- Repeating tasks: every day / week / month / selected days
- Rearrangeable homepage sections
- Hourly push reminders for unchecked tasks: weekdays 9pm–12am, weekends 12pm–12am (SGT)

Backend: Supabase project `task-tracker-app` (ypyxzrmmyqptoduzzazp), edge function `notify` (supabase/functions/notify), pg_cron job `notify-hourly`.

## Releasing an update
Bump the same number in three places so open apps show the "New version available" pop-up:
1. `APP_VERSION` in `app.js`
2. `version.json` (`version`, plus a short `notes` line shown in the pop-up)
3. the `?v=` on `app.js` / `styles.css` in `index.html`
