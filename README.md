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

See `ARCHITECTURE.md` for push/hosting research.  
Preview: `preview_phone.png`.  
**Not published.** No pushes sent.
