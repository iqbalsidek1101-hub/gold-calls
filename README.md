# Charlie Gold Calls — PWA prototype (Phase 1)

Mobile-first Malay UI. Reads `calls.json` (from `live_calls/calls_log.csv`).

```bash
# regenerate data after a new call
python3 - <<'PY'
# see prior generator in session / re-run export from calls_log
PY
# local preview
python3 -m http.server 8765 -d /workspace/gold_app
```

See `ARCHITECTURE.md` for the original hosting notes.  
Preview: `preview_phone.png`.  

The static app is published on GitHub Pages. Opt-in Web Push code lives in this repo (`PUSH.md`) but **no push server is deployed and no notifications are sent** until that server is set up separately. Status checks are every 10 minutes, 08:00–21:50 MYT. New-call analysis stays about every 30 minutes. Neither is live price.
