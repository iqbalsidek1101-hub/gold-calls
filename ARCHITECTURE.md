# Charlie Gold phone app — Phase 1 architecture (research + prototype)

**Constraints:** box is not a public always-on server; MT5 PC needs approval per pull. Phase 1 = no accounts created, nothing published, no pushes sent.

## Recommended path (plain words)

**For zone-entry alerts (most reliable): MT5 mobile push.**  
Iqbal already has MT5 on phone. Indicator `XAU_Charlie` on his PC chart can call `SendNotification()` when price enters a call zone / bias flips. That goes through MetaQuotes to the MT5 app — no public server, no ntfy account, works while terminal is online. **This is the simplest reliable zone alert.**

**For viewing daily calls on phone: static PWA.**  
Host `gold_app/` on GitHub Pages / Cloudflare Pages / Netlify (free). App reads `calls.json` (generated from `calls_log.csv` when Charlie publishes a call). No login. Install to home screen.

**For “new call published” push without MT5:** private **ntfy.sh** topic (install ntfy app, subscribe to a long random topic name). Charlie’s bot POSTs one line when a call is logged. No account required for basic use. **Not done in Phase 1.**

**Live price without his PC:** free public feed e.g. **biquote.io** `XAUUSD` (no key). Measured ~**+$1.2** vs last JustMarkets `XAUUSD.m` bar in this session — fine for “are we near the zone?” but **not** for exact fill/SL vs his broker. Zone alerts that matter should use **JM ticks via MT5**.

## Options compared

| Need | Option | User must do | Pros | Cons |
|------|--------|--------------|------|------|
| Zone enter alert | **MT5 `SendNotification`** | Enable push in MT5 app; MetaQuotes ID in terminal; keep PC/MT5 running | Native, reliable, exact JM price | PC must be on; only MT5 app |
| Zone enter alert | ntfy / Telegram from a watcher | Install ntfy or make Telegram bot; host a tiny always-on poller | Works without MT5 app | Needs public quote + hosting; quote ≠ JM |
| New call card | Static PWA + refresh `calls.json` | Open/install PWA; optional ntfy for “new call” | Simple, free host | Not live until JSON redeployed |
| Live quote in PWA | biquote / similar | Nothing | No PC | Offset vs JM; third-party uptime |

## Hosting the PWA (when he wants Phase 2)

1. Create a GitHub / Cloudflare / Netlify account (his choice).
2. Upload `/workspace/gold_app` (or git push).
3. Enable Pages; get HTTPS URL.
4. On phone: open URL → Add to Home Screen.
5. When Charlie logs a call: regenerate `calls.json` + chart assets → redeploy (or webhook).

**Not done now** — Phase 1 keeps files only on the box.

## Push options (detail)

1. **MT5 native** — `SendNotification("...")` + MetaQuotes ID. Draft in `XAU_Charlie_v1.1.mq5`.
2. **ntfy.sh** — `curl -d "Call #002 BUY …" ntfy.sh/<secret-topic>`. User installs ntfy, subscribes. No signup for default server.
3. **Telegram bot** — needs bot token from @BotFather (account step) — skip until he asks.
4. **Web Push** — needs VAPID keys + service worker push handlers + a backend to store subscriptions — heaviest; not Phase 1.

## Prototype status

- `/workspace/gold_app/` — mobile-first Malay UI, latest call, chart, history, scoreboard (zeros honest).
- Live quote optional via biquote (browser-side).
- Service worker caches shell for offline **read** of last `calls.json`.
- **No** pushes sent, **no** public deploy.

## What Iqbal should do (when ready)

### A. MT5 zone alerts (recommended first)
1. Phone: install **MetaTrader 5**, log into same broker demo/live.
2. MT5 app → Settings → enable **Messages / Push**.
3. PC terminal: Tools → Options → Notifications → enable → paste **MetaQuotes ID** from phone.
4. Compile & attach `XAU_Charlie_v1.1.mq5` (when he accepts the draft); turn on `InpPushZoneEnter`.
5. Leave PC + MT5 running during session.

### B. Phone call viewer
1. Phase 2: host `gold_app` on Pages.
2. Add to Home Screen.
3. Optional: install **ntfy**, subscribe to a private topic Charlie will use for “call baru”.

### C. Don’t rely on
- Box as 24/7 alert server (not public / not always on).
- Public gold API for exact SL vs JustMarkets.
