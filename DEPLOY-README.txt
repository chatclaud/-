ChatClaud package — Oct 2026

DEPLOY
1) GitHub Pages: upload index.html, manifest.json, sw.js, icons
2) Render: server.js + package.json, set Environment from ENV-KEYS.txt

SEARCH (priority)
1. Nova (NOVA_URL + NOVA_AIP_TOKEN or NOVA_API_TOKEN)
2. Tavily (fallback)
3. Serper (optional)

IMAGINE
- Photos: HuggingFace FLUX (HF_KEY / HF_KEY2), optional Runway
- Videos: Runway if RUNWAYML_API_SECRET set; prompt enhanced via HF
- Free limits: 5 photos / 2 videos per day per IP

NEVER put API keys in index.html or GitHub.
