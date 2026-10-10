ChatClaud — diagnostic patch (2026-10-10)

Purpose
This is a separate candidate archive for diagnosing the case where the chat sends a message but the UI appears not to answer. It does NOT replace the live Render/GitHub deployment by itself.

Changes
1. index.html
   - Fixed ccPublicError(): it previously read an undeclared variable named `data` in a conditional. For some network/timeout errors this could make the error handler itself throw and hide the useful message.
   - Added clearer classification for client timeouts and network errors.
2. server.js
   - Added safe /api/chat request lifecycle logs: start, parsed request metadata, successful response, missing provider, unexpected exception, and client disconnect.
   - Logs do not include message text, image payload, IP, or API credentials. Mistral error logging no longer prints even a key suffix.
   - Limited each primary chat model attempt to 8 seconds and at most two attempts per provider, preserving both a second model/key candidate and Groq -> Mistral fallback. This bounds the normal text-provider phase below the browser's 55-second timeout. Other endpoints retain their existing provider settings.
3. tests/chat-diagnostics.test.js
   - Added 3 regression tests for the error handler, safe request logging, and bounded provider timeouts.

Verification performed locally
- `node --check server.js`: passed.
- `npm test`: 174 tests passed, 0 failed.
- Isolated local server test: /api/health worked; POST /api/chat reached the route and produced `[chat] start`, `[chat] parsed`, `[chat] no_provider` logs. That isolated test intentionally had no provider API keys, so its 503 response was expected and does NOT test a live model response.
- Live Render `/api/chat` and live Groq/Mistral response have NOT been verified in this session.

Important deployment note
Do not treat this as confirmed resolution until you deploy it to the correct backend service and send a test message to the published website. After deployment, check Render logs for `[chat] start id=...` and then either `[chat] success ...`, `[chat] no_provider ...`, or `[chat] fatal ...`. If there is no `[chat] start`, the POST is not reaching this server version (or the deployed service/archive differs).

All project files and existing modules/tests from ChatClaud-complete-tested.zip were retained. No API keys were added.
