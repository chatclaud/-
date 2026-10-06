ChatClaud — GitHub Pages + Render

1) GitHub Pages = this ZIP (frontend only)
2) Render Web Service = server.js + package.json
   Start: node server.js
   ENV: see ENV-KEYS.txt

Frontend API base: https://chatclaud.onrender.com
(override: localStorage.setItem('cc_api_base','https://xxx.onrender.com'))

If error "не JSON":
- Open https://chatclaud.onrender.com/api/health in browser
- Must return JSON { ok: true, ... }
- If HTML or 502 → Render sleeping/crashed → redeploy server.js

UI labels: normal Russian (no fancy small-caps)
Images: Pollination 1280x1920
Commands: type / in input
