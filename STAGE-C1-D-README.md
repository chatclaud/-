# ChatClaud — Stage C.1 hardening + Stage D research packet

This archive is a local working-copy update of the uploaded `ChatClaud-ALE-stageC-intel(1).zip`. It is not a production deployment.

## Safety defaults

- `INTEL_ORCHESTRATOR` defaults to OFF.
- `INTEL_DEEP_RESEARCH` defaults to OFF and only takes effect when `INTEL_ORCHESTRATOR=1` as well.
- No API keys are included.
- No user data is included in `data/` (the directory is empty in this snapshot).
- No upstream agent repository has been copied wholesale or installed as a new runtime dependency.
- GitHub, GitHub Pages and Render were not modified.

## What changed

### Stage C.1

- Added URL validation, public-address DNS checks/pinning, controlled redirects, response-size caps and abortable timeouts.
- Prevented arbitrary page URLs from being forwarded to the external Nova fetch service.
- Added stricter URL parsing for YouTube and oEmbed, and exact social-host allowlisting for Nova social extraction.
- Made tool timeouts/cancellation and task statuses more accurate.
- Treated keyword overlap as a retrieval hint, not proof that a claim is true.
- Added per-client request and active-task bounds for experimental intelligence routes.
- Removed stored email from the public username-only Plus-check response; current UI-compatible Plus status and expiration fields remain. See remaining limitations in `docs/intelligence/STAGE-C1-D-REVIEW.md`.

### Stage D

- Added `POST /api/intel/research` as a separately gated, bounded source/evidence-packet endpoint over the existing search pipeline.
- It does not currently synthesize a final natural-language answer with an LLM and does not claim factual verification.
- Sources/snippets and lexical comparisons remain leads for checking, not proof.

## Verify locally

Requires Node.js >= 18, matching the existing project declaration.

```bash
node --check server.js
node --check modules/intelligence/deep-research.js
node --check modules/intelligence/safe-fetch.js
node --test tests/*.test.js
```

Last local result for this snapshot: **162 tests passed, 0 failed**.

The suite uses mocks for external providers. It does not verify live credentials, external service availability, real production egress restrictions, or deployment behavior.

## Local-only feature test

The ordinary chat does not need the new flags. The test suite includes HTTP smoke tests with temporary local data. If deliberately testing the new endpoint by hand, do so only in a local environment and understand that research mode may call configured external search providers and use their quotas.

Core endpoint: `POST /api/intel/run` (`INTEL_ORCHESTRATOR=1`)

Research packet: `POST /api/intel/research` (requires both `INTEL_ORCHESTRATOR=1` and `INTEL_DEEP_RESEARCH=1`)

## Reference projects

See `docs/intelligence/01-deepagents-analysis.md` through `06-hermes-analysis.md`, plus `CHATCLAUD-INTELLIGENCE-PLAN.md`. These were inspected as architectural references. Their complete upstream test/build suites were not run, and their runtimes were not installed into ChatClaud.

## Rollback

Restore the original `ChatClaud-ALE-stageC-intel(1).zip` snapshot or revert the local working-copy diff. Keep both feature flags off until separate review and local/provider validation. Do not overwrite a production environment with this archive without additional validation.
