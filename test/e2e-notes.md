# e2e notes
`npm run e2e` boots real TrueForge (port 8795, `OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]`), three mock OpenAI-compatible endpoints
(good / always-401 / unreachable port 59999) and clones pallets/flask @ 22d92470 into /tmp/forge-e2e (venv, pytest==9.0.2).
Needs network for git clone + pip + npx. Env: `E2E_ONLY=A,B` to select scenarios, `E2E_DEBUG=1`, `E2E_KEEP=1`.
The model is scripted, so it proves the loop/tools/diff/fallback machinery, not model quality.
