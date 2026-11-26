# Charlie Calls — Web Push

Opt-in background Web Push for the installed app (iPhone home screen on iOS 16.4+, and other browsers that support Push). This is **not live**. GitHub Pages can only host the static app. The phone will say the push server is not set until the steps below are done on a machine you control.

Nothing in this folder sends a broker order. Entry, TP, and SL describe the call simulation stored in `calls.json`.

## What the phone can expect

Notifications are not tick prices and not an in-page alert.

| Category | When it can arrive |
| --- | --- |
| Call baru | After the full analysis publishes a new BUY or SELL. That job stays about every **30 minutes**. Lag can be ~30 minutes plus send time. |
| Entry tersentuh | After the score job sees the zone touched in `calls.json`. |
| TP | After the score job writes status TP. R is copied from `r_result` only. |
| SL | After the score job writes status SL. R is copied from `r_result` only. |

The score job monitors active calls **every 10 minutes, 08:00–21:50 MYT**, daily. Outside that window it does not run. A status that changes overnight is reported on the next score, usually 08:00 MYT, so the delay can be longer than 10 minutes. WAIT / no-fit rows are not sent as new calls.

A new subscription does **not** replay old calls. The first successful dispatch records the current file and sends nothing.

## What is still missing before any phone can receive push

No push host, VAPID key, or dispatch token was created for this repo. GitHub Actions here only builds Pages. Do not put the secrets in the public repo, in Pages files, or in logs.

1. A small always-on **Node 20+** process with a **persistent disk** and a public **HTTPS** URL. This repo does not provision that host. Bind it yourself (the default listen address is `127.0.0.1`). Put TLS in front of it. Ephemeral disk is not enough: a wiped data directory baselines again and forgets phones.
2. Generate a VAPID key pair **on that server** and keep the private key there only:

   ```bash
   npx web-push generate-vapid-keys
   ```

3. Generate a dispatch token and store it only in the server environment and in the publisher's secret store:

   ```bash
   openssl rand -hex 32
   ```

4. Environment on the push server (`push-server/.env.example` lists the names):

   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (`mailto:` or an `https:` URL you control)
   - `DISPATCH_TOKEN`
   - `ALLOWED_ORIGINS=https://iqbalsidek1101-hub.github.io` (exact scheme and host, no path, no `*`)
   - `DATA_DIR` on the persistent disk
   - `HOST` / `PORT` as your proxy expects

5. Start it from `push-server/`:

   ```bash
   npm install
   npm start
   ```

   `GET /v1/health` must return `"configured": true` before the routine starts posting. The boot log prints only `configured` true/false. It does not print keys or the token.

6. Baseline the current file **before** a publish you want announced. The first `POST /v1/dispatch` on an empty store records history and sends zero notifications. If that first body already contains a new TP, that TP is swallowed. Either:

   ```bash
   DATA_DIR=/persistent/charlie-push node src/cli.js baseline /path/to/current/calls.json
   ```

   or POST the already-published file once and check `"baselined": true` and `"events": []`.

7. Point the phone at the server. `push-config.js` ships with an empty `apiBase` on purpose. After the HTTPS origin exists, either paste it into **Tetapan → Server push** on the phone (saved only in that phone's localStorage) or set `apiBase` in a later commit. Do not commit the private key or the dispatch token with that change.

## Routine integration

Run the existing score job on this schedule (Asia/Kuala_Lumpur). It hits 08:00, 08:10, …, 21:50 and does not hit 22:00:

```cron
CRON_TZ=Asia/Kuala_Lumpur
0,10,20,30,40,50 8-21 * * *  /path/to/score-then-dispatch
```

Keep the full new-call analysis on its current **~30 minute** schedule. After **each** successful `calls.json` publish — the 10-minute score and the ~30-minute analysis — POST that file once:

```bash
CHARLIE_PUSH_ORIGIN='https://YOUR-PUSH-ORIGIN' \
CHARLIE_DISPATCH_TOKEN="$DISPATCH_TOKEN" \
node /path/to/gold-calls/push-server/scripts/dispatch-calls.js /path/to/calls.json
```

The token is an environment variable. Do not pass it as an argument (it would show up in the process list). Do not `echo` it, and do not run the script under `set -x`. The script refuses a non-local `http://` URL so the token is not sent in clear text to a public host.

- Exit 0: the server accepted the file (baseline or a real diff).
- Exit 1: HTTP status was not 200. `503` with `push_not_configured` means events are held until keys exist; fix the server and post again, or POST `/v1/baseline` if you want to drop that queue without notifying.
- Exit 2: the origin, token, or file was missing.

Posting the same bytes again is safe. The server remembers call status and will not send the same transition twice. Do not post an old archive to “catch up” a new phone. Subscribe does not replay.

`409 too_many_events` means the jump was too large to send (more than 30 new transitions). POST `/v1/baseline` with the current file to re-anchor **without** notifying, then continue the schedule. Do not loop on 409.

Log the JSON fields `baselined`, `events`, `delivered`, `pending`. Do not log the `Authorization` header. `realtime` is always false.

`calls.json` can be the raw file or `{"calls": <file>}`. `{"replay": true}` is rejected. A `callsUrl` is accepted only for the exact Pages URL (`https://iqbalsidek1101-hub.github.io/gold-calls/calls.json`). Prefer the file body so a stale Pages cache is not what you diff.

There is no separate webhook secret on this path. The phone's existing webhook key stays in localStorage and is not sent to the push server.

## Phone API (no dispatch token)

Browser `Origin` must be exactly `https://iqbalsidek1101-hub.github.io`.

- `GET /v1/config` — public VAPID key, the four categories, and the cadence. No private key.
- `POST /v1/subscriptions` — `{ subscription, categories }`. Returns `subToken` once. Default categories are all four on.
- `POST /v1/preferences` and `POST /v1/unsubscribe` and `POST /v1/test` — header `X-Charlie-Sub-Token`. Unknown phones get the same 401 as a bad token.
- Test pushes only go to a stored subscription. Endpoints must be Apple, Mozilla, FCM, or Windows push hosts. `404` / `410` from the push service deletes that phone.

Subscription records live in `DATA_DIR/state.json` (mode 600). That file is gitignored. Do not publish it.

## iPhone

1. iOS 16.4 or newer.
2. Open the Pages URL in Safari.
3. Share → Add to Home Screen.
4. Open Charlie Calls from the home-screen icon, not from a Safari tab.
5. Settings → Benarkan notifikasi → Allow.
6. All four categories start selected. Turn off any you do not want.
7. Hantar ujian. A real push is the only success signal. If the server is not up, the page will say so and will not invent a local alert.

If permission was denied: iPhone Settings → Notifications → Charlie Calls → Allow.

Android and desktop Chrome, Edge, and Firefox can allow push without installing. iPhone cannot.

## Local checks

```bash
cd push-server
npm install
npm test
```

Tests use temporary files and fake push sends. They do not need live secrets and they do not edit `calls.json`.
