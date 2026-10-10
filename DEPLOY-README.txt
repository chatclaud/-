ChatClaud — WORKING BUILD (GitHub Pages + Render)

Frontend: index.html + icons + manifest.json + sw.js
Backend: server.js on Render

Required/optional Render environment variables:
- GROQ_KEY (or GROQ_API_KEY): primary chat provider; GROQ_MODEL defaults to openai/gpt-oss-120b
- MISTRAL_API_KEY: fallback chat provider and image analysis
- MISTRAL_MODEL defaults to mistral-small-latest; MISTRAL_VISION_MODEL may override vision separately
- GROQ_TRANSCRIBE_MODEL defaults to whisper-large-v3-turbo; second candidate whisper-large-v3; JSON upload body limit effectively caps audio around 10 MB
- NOVA_URL, NOVA_API_TOKEN (or existing supported token aliases): current search/social integration
- PLUS_BOT_SECRET or ADMIN_SECRET: guarded Plus/admin actions
- NETLIFY_DEPLOY_TOKEN / NETLIFY_TOKEN only if the separate Netlify feature is used
- PORT is supplied by Render

Provider behavior in Stage B:
- Main chat: Groq first, then Mistral fallback
- Image analysis: Mistral Vision via /api/vision and uploaded-image chat flow
- Audio transcription: Groq Whisper via /api/transcribe
- Prompt enhancement: Mistral; if it fails, original prompt is retained
- Image/video generation: existing Runway service; this change does not add a new generator
- Hugging Face credentials are no longer required by server code

Intelligence safety switches:
- INTEL_ORCHESTRATOR and INTEL_DEEP_RESEARCH remain OFF by default
- Enable only after staging/API-key verification; no deployment was performed as part of Stage B work

Before deployment: run `npm run check:deploy` and `npm test`; verify Render keys and run manual text/image/audio/research smoke tests in staging.


Critical package layout note:
- Extract this ZIP so that server.js, package.json, and modules/ are all directly in the service root.
- Do NOT commit only index.html and server.js. The modules/ directory is required at runtime.
- Run `npm run check:deploy` before deployment. This checks the intelligence module and required local files.
- The explicit server.js entry point checks for modules/intelligence.js using an absolute path and prints the expected deployed location if missing.
