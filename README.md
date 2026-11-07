# Home Team

A shared weekly board for two people. Workouts, dinners, a date and house projects, with a name on everything, checked off together, synced to the shared Google Calendar. Points for keeping your word, a weekly wager, a shared pot of rewards, a live ledger with nudges and high fives, and phone notifications. Installable on both phones.

```
server.js            Node 20 web service: passphrase cookie, JSON doc API, live updates (SSE), Postgres or JSON-file storage
calendar.js          Google Calendar sync via a service account (no OAuth screens)
push.js              phone notifications (Web Push / VAPID)
public/index.html    the app (single file)
public/ex/            exercise photos (free-exercise-db, public domain), start + finish frame per exercise
public/sw.js         service worker (installable, opens instantly, last copy offline)
public/manifest.json, icons, og.png
render.yaml          Render Blueprint
test/calendar.test.js
```

## 1. Deploy on Render

1. Push this folder to a GitHub repo (`home-team`).
2. Render → **New → Web Service** → pick the repo. Build `npm install`, start `node server.js`, health check `/healthz`. (Or **New → Blueprint** and let `render.yaml` fill that in.)
3. Environment variables:

| Variable | Required | What it is |
|---|---|---|
| `HOME_TEAM_KEY` | yes | The passphrase both phones enter once. Without it the board is open to anyone with the URL. |
| `DATABASE_URL` | one of these | Neon Postgres connection string. Creates its own `ht_docs` table. |
| `HOME_TEAM_DATA_FILE` | one of these | JSON file path instead of Postgres. On Render this only survives deploys with a disk mounted: Starter plan, disk at `/data`, value `/data/home-team.json`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for calendar | Contents of the service-account key file (paste the raw JSON, or base64 of it). |
| `GOOGLE_CALENDAR_ID` | for calendar | The shared calendar's ID, e.g. `abc123@group.calendar.google.com`. |
| `APP_URL` | no | Public URL, added to calendar event descriptions. |
| `TZ` | no | Default `America/New_York`. Used for timed events and "today". |
| `NODE_OPTIONS` | with Neon | `--dns-result-order=ipv4first` (skips Neon's dead IPv6 addresses). |
| `HT_VAPID_PUBLIC`, `HT_VAPID_PRIVATE`, `HT_PUSH_SUBJECT` | for notifications | Run `node server.js --vapid` once (locally or in the Render shell) and paste the three lines it prints. Subject is `mailto:` your email. |

Free plan note: the service sleeps after 15 minutes idle, so the first open of the day takes ~30–40 s. The app shows the last copy from the phone immediately and reconnects when the server wakes. Starter ($7/mo) removes that and allows the `/data` disk.

## 2. Connect the shared Google Calendar (about 10 minutes)

The server acts as its own Google "user" (a service account). You share the calendar with it once; no sign-in screens, no token refresh.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project (any name, e.g. `home-team`).
2. **APIs & Services → Library** → search **Google Calendar API** → Enable.
3. **IAM & Admin → Service Accounts → Create service account**. Name it `home-team`. No roles needed. Create.
4. Open the service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Its contents go in `GOOGLE_SERVICE_ACCOUNT_JSON` on Render (paste the whole file; the private key's `\n` line breaks are handled).
5. Copy the service account's email (`home-team@<project>.iam.gserviceaccount.com`).
6. In Google Calendar on the web, open the shared calendar's **Settings and sharing**:
   - **Share with specific people or groups → Add people** → paste that email → permission **Make changes to events**.
   - **Integrate calendar → Calendar ID** → that's `GOOGLE_CALENDAR_ID`.
7. Redeploy. The Render log shows `[calendar] connected to "<calendar name>"`. If it shows a probe failure, step 6 is the usual culprit.

### What syncs

- **Board → calendar.** Any item with a day becomes an event: all-day, or a one-hour timed event when the item has a time. Done items get a `✓` in the title; unscheduled, let-go or deleted items are removed. Which areas sync is a toggle in the app's Settings (default: workouts, house tasks and dates on; dinners off).
- **Calendar → board.** The calendar's other events show under each day on the Week tab, muted, with one tap to pull one onto the board.
- **Not synced:** moving or editing an event inside Google Calendar doesn't change the board item. Edit on the board; the calendar follows.

## 3. The built-in workout program

The Workouts tab carries a default program, **Full-body restart**, written for the equipment in the house: Peloton bike, dumbbells, resistance bands and the Marcy MWM-990 (press arms, high and low pulleys, leg developer, preacher curl pad). It starts the week you set the app up (week 1) and ramps:

| Weeks | Phase | Strength | Bike | Sets × reps · effort |
|---|---|---|---|---|
| 1–2 | Ease in | A, B (Mon, Wed) + two walks | 2 easy rides, 15 min | 2 × 10–12 · 5–6 of 10 |
| 3–4 | Build | A, B, C (Mon, Wed, Fri) | 20 min; week 4 adds 6 one-minute pushes | 3 × 10 · 6–7 |
| 5–6 | Settle in | A, B, C | 25 min + 8 pushes | 3 × 8–12 · 7 |
| 7+ | Keep it going | A, B, C | 30 min + 10 pushes | 3 × 8–12 · 7–8; every 4th week is lighter |

- **A** (Marcy + dumbbells): goblet squat, chest press, lat pulldown, leg curl, seated row, plank.
- **B** (dumbbells + bands): Romanian deadlift, overhead press, one-arm row, reverse lunge, band pull-apart, dead bug.
- **C** (Marcy + bands): step-up, leg extension, pec fly, band glute bridge, triceps pressdown, preacher curl, side plank.
- Saturday is a long walk together; Sunday is rest and planning the week.

Every exercise has a photo demo: the start and finish positions alternate in the session view, and tapping a photo opens them side by side. Photos come from free-exercise-db (public domain); gym machines in them stand in for the matching Marcy station.

"Plan the week" and the Workouts tab both put the week's sessions on the board. Tapping a workout on the board opens the session: warm-up, each exercise with sets, reps and a form cue, and a box per exercise for the weight you used, which shows as "Last time: …" the next time that session comes around. Each of you logs your own. Options on the Workouts tab: pause (falls back to a plan of your own), repeat the current week, or restart at week 1.

## 4. Points, the wager and the pot

**Points** reward keeping your word, not piling on tasks. Workout 10, house task 8, date 12, dinner 6. Full value on the planned day, ×0.75 if done later in the week, ×0.5 if carried over from last week. +2 before 9am, +2 for logging weights on a workout. Items you're both on pay both of you, so doing things together is the best play.

**The weekly wager.** During Plan the Week (or any time from the Team tab) you set a stake: "loser cooks Sunday dinner," "winner picks the next date." Sunday night it settles on the **percentage of your own board you kept**, so whoever had the bigger board doesn't win by volume. The Week tab shows the live tug-of-war; the Team tab shows the standings, the stake, and last week's review. Ties carry the stake forward.

**The pot.** Every point either of you earns also goes into a shared pot. Add rewards you both want (takeout night 150, a massage 200, trip fund 800) and claim them when the pot covers it. A normal week earns each of you roughly 60–100 points.

**The ledger** on the Team tab is both of you, live: check-offs with points, high fives (tap one on the other person's check-off), nudges (pick a line for something still open on their board today, it goes to their phone), stakes and settled wagers. **Badges** per person (clean week, iron pair, chef, fixer, three dates, early bird, every day, three wagers) and levels per person and for the team.

**Week in review**: from the Team tab, a card for any past week (winner, percentages, points, stake) that shares as an image.

## 5. Notifications

Each phone opts in with one tap once the three `HT_VAPID_*` envs are set: a "Turn on notifications" card sits at the top of the Week and Team tabs until the phone is set up, and the bell in the top bar shows the phone's status and turns them on or adjusts them any time. If the app isn't on the Home Screen yet, or the phone blocked notifications earlier, the card switches to step-by-step help for that. On iPhone the app must be on the Home Screen first (iOS 16.4+). What's sent, each switchable per person: the other person finished something (with points), nudges, high fives, a 7:00 pm "still open today" list, and a Sunday 6:00 pm "plan the week." Settings has a "send a test" button.

## 6. On the phones

Open the URL, enter the passphrase, add both names, mark whose phone it is. Then **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: menu → Install app). Both phones see each other's changes within a second while open; on reopen the app refreshes itself.

## Local run

```
HOME_TEAM_KEY=test node server.js      # http://localhost:3000, data in ./data/home-team.json
npm test                                # calendar.js unit test with a generated key and a mocked Google API
```
