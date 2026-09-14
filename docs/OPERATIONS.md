# Self-hosted deployment platform — operations guide

GitHub is the source of truth for application source code. PostgreSQL stores
platform state only: projects, configuration, deployment state, artifact
metadata, audit records and operational data.

## Planes

| Plane | Responsibility | Components |
| --- | --- | --- |
| Control plane | dashboard, API, auth, webhooks, queue, orchestration, AI gateway | Next.js app, PostgreSQL, durable job queue |
| Data plane | builds, runtimes, routing, TLS, artifacts | build workspaces, runtime driver (Docker or process), Traefik, object storage |

Production traffic path is `Internet → Traefik → application container`. The
dashboard is never in the request path; if the control plane stops, running
applications keep serving. Routing is published to
`infrastructure/traefik/dynamic/platform.json`, which Traefik watches.

## Deployment lifecycle

```
push → webhook (verified + deduplicated) → desired state update → queue
→ fetch exact commit → framework detection → install → test → build
→ immutable artifact → start runtime → health check → re-check desired state
→ atomic promotion → post-promotion monitoring → drain old runtime → retention
```

Guarantees enforced in code:

* A failed build or failed health check never replaces the current healthy
  production deployment (`currentHealthyDeploymentId` is only updated in
  `promoteDeployment`, after a passing readiness probe).
* Older builds cannot overtake newer desired commits: every deployment carries
  a `generation` and the pipeline calls `assertStillDesired()` before start and
  again before promotion. Superseded work becomes `OBSOLETE`.
* Duplicate GitHub deliveries are rejected by the unique index on
  `github_webhook_deliveries.delivery_id`.
* Jobs are idempotent through `jobs.dedupe_key`; stale `RUNNING` jobs are
  recovered after a worker restart.
* Cleanup never deletes an artifact referenced by production, the rollback
  retention window, an active preview or a running container
  (`protectedDeploymentIds()`).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `PLATFORM_ENCRYPTION_KEY` | KEK for envelope-encrypted secrets (set in production) |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | First-run owner account |
| `PLATFORM_DOMAIN` | Wildcard domain for generated app hostnames |
| `PLATFORM_PUBLIC_URL` | Public control-plane URL used in webhook instructions |
| `PLATFORM_RUNTIME_DRIVER` | `docker` (default when available) or `process` |
| `PLATFORM_STORAGE_ROOT` / `PLATFORM_WORKSPACE_ROOT` | Data plane paths |
| `TRAEFIK_DYNAMIC_DIR`, `TRAEFIK_CERT_RESOLVER` | Routing publication |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | GitHub App credentials (installation tokens) |
| `GITHUB_TOKEN` | Fallback PAT for private repositories |
| `GITHUB_WEBHOOK_SECRET` | Optional global webhook secret (per-project secrets preferred) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `AI_API_KEY` | AI provider fallback keys (BYOK per org is preferred) |
| `PLATFORM_DISABLE_WORKER` | Set to `1` for API-only replicas |

## Local development

```bash
docker compose up -d postgres redis minio registry traefik
npx drizzle-kit push
npm run dev
```

Sign in with the bootstrap owner account, create a project pointing at a GitHub
repository, add the webhook shown in project settings, then deploy.

## GitHub App setup

1. Create a GitHub App with repository permissions: Contents (read/write for AI
   pull requests), Metadata (read), Pull requests (write), Commit statuses
   (write). Nothing else is requested.
2. Subscribe to `push` and `pull_request` events.
3. Point the webhook at `https://<platform>/api/v1/webhooks/github` and use the
   per-project secret shown in the settings tab.
4. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; installation tokens are
   minted on demand and cached until shortly before expiry.

## Vercel deployment integration — known limitation

The repository's Vercel project is connected to GitHub repository
`aamrabdelhay/VO`, and the observed Vercel deployment metadata shows the
production Git ref as `main`. The repository also contains a GitHub Actions
verification workflow that runs on pushes and pull requests targeting `main`.

The current ChatGPT Vercel connector exposes deployment inspection and a
`deploy_to_vercel` action, but the action currently has a schema mismatch in
this environment: its visible callable schema accepts no parameters while the
underlying deployment path rejects the call as missing `target`, `name`, and
`files`. There is no generic authenticated HTTP POST/webhook tool available in
this environment that can be used as a substitute for the Vercel REST
`/v13/deployments` endpoint.

**Known limitation:** do not retry the same connector call or claim that a
Vercel deployment was created when this mismatch occurs. Verify the deployment
from the Vercel Dashboard instead. A successful GitHub push/commit is not proof
that the Vercel build succeeded.

For incident records, capture:

* Git commit SHA and branch.
* Vercel deployment ID, target, state and build logs.
* Whether the deployment was created by Git integration or manual/API deploy.
* If the connector is blocked by the schema mismatch, record it as a tooling
  limitation rather than treating it as an application failure.

## Security model

* Secrets use envelope encryption (random DEK per secret, wrapped with the KEK).
  Values are never returned by the API and are redacted from logs and AI prompts.
* Build and runtime processes receive a scrubbed environment allowlist; they
  never inherit `DATABASE_URL`, encryption keys, registry or provider keys.
* Docker runtimes run with `--cap-drop ALL`, `no-new-privileges`, read-only root
  filesystem, tmpfs `/tmp`, pids/memory/cpu limits and loopback-bound ports. The
  Docker socket is never exposed to workloads.
* All user-influenced URLs pass the SSRF guard (`src/lib/net-guard.ts`), which
  blocks loopback, link-local (169.254.169.254), private ranges and CGNAT.
* User-configured commands are parsed argv-style and rejected if they contain
  shell metacharacters; AI sandbox commands additionally use an allowlist.
* RBAC (OWNER/ADMIN/DEVELOPER/VIEWER) is enforced server-side on every project
  endpoint; mutations require the double-submit CSRF token.

## AI engineering agent

* Providers are abstracted (Anthropic, OpenAI, Gemini, OpenAI-compatible, and
  local Ollama) with per-organisation BYOK keys stored encrypted.
* Permission levels: `READ_ONLY`, `DEVELOPER`, `AUTO_FIX`, `AUTO_DEPLOY`. There
  is deliberately no unrestricted mode.
* Every capability goes through the tool gateway, which enforces permission,
  project scoping, workspace path containment and audit logging. A generic
  `run_command` tool does not exist.
* Fixes happen in an isolated workspace containing only the failing commit; the
  loop is bounded by attempts, wall-clock time and daily budget. Validated fixes
  are published as a branch + pull request, never pushed to the production
  branch directly.

## Verified self-practice repair loop

Self-practice is a bounded verification loop, not an autonomous training job.
It harvests genuine failures from failed deployments and previously failed AI
repair attempts. It can also create deterministic synthetic failures on a known-
passing commit using fixed mutation functions; no mutation is generated by an
AI model.

Attempt generation prefers local Ollama through `OLLAMA_BASE_URL` and
`OLLAMA_MODEL`. `OLLAMA_API_KEY` is accepted when the configured Ollama endpoint
requires one. When no local endpoint is configured, self-practice may fall back
to the existing configured cloud provider, but it logs an explicit warning that
this run is not provider-independent and the cloud call is charged against the
same per-organisation daily AI budget used elsewhere.

The correctness judge is only executable evidence: the existing Gateway
`apply_patch`, `run_install`, `run_tests`, and `run_build` tools are used inside
`AI_WORKSPACE_ROOT`, and a problem is stored only when the relevant exit codes
all pass. There is no LLM-as-judge step and no provider output is treated as a
training label. Workspace cleanup runs in `finally` regardless of outcome.

Controls:

* `SELF_PRACTICE_ENABLED=1` enables scheduling.
* `SELF_PRACTICE_DAILY_LIMIT` caps daily attempts (default `3`).
* `SELF_PRACTICE_MAX_CONCURRENT` caps running self-practice jobs (default `1`).
* Scheduler enqueues at most one deduplicated self-practice job per 15-minute
  bucket; the existing queue/worker and Gateway remain the execution path.

The Garvex admin dashboard reports attempts today, pass rate, verified-example
total, and whether generation is running with local Ollama or cloud fallback.
The UI wording intentionally does not claim that the model is "learning in real
time".

## Manual model-improvement step

`self_practice_examples` is a verified dataset, not an automatically trained
model. To turn accumulated examples into a better local model, the operator
runs:

```bash
node scripts/export-training-set.mjs
```

The command exports verified rows only to `training/self-practice.jsonl` using
an outer `{"messages":[...]}` JSONL structure. Upload that file to the
operator-controlled Colab/GPU environment, run the manual Unsloth/LoRA
fine-tuning workflow, then push the resulting model to Ollama. This process is
periodic and manual by design; unattended fine-tuning is not implemented inside
the Vercel-hosted application because the serverless worker is not a reliable
place for long-running GPU/CPU training jobs.

## Runbooks

* **Failed deployment** — production is unchanged. Inspect the deployment page
  (events, logs, health probes), then redeploy or run AI diagnosis.
* **Unhealthy after promotion** — the post-promotion monitor rolls back to the
  last retained healthy deployment, records an incident and notifies.
* **Worker restart** — `recoverStaleJobs()` requeues jobs whose lock is stale;
  the reconciler restarts missing production runtimes from their artifacts.
* **Storage pressure** — the storage page shows usage, reclaimable bytes and
  protected objects; cleanup runs every 30 minutes and can be triggered manually.
* **Backups** — `pg_dump` the platform database plus the object storage root
  (`PLATFORM_STORAGE_ROOT`) and the encryption key. Restore by recreating the
  database, restoring storage and restarting the platform; the reconciler brings
  runtimes back from retained artifacts. A backup is only considered verified
  after a restore test.

## Disaster recovery targets

| Scenario | RPO | RTO | Procedure |
| --- | --- | --- | --- |
| Control-plane process loss | 0 | minutes | Restart app; running apps unaffected |
| Database loss | last backup | < 1h | Restore dump, restart, reconcile |
| Object storage loss | last backup | < 1h | Restore dump, restart, reconcile |
| Object storage loss | last backup | < 1h | Restore bundles, or redeploy from GitHub commits |
| Host loss | last backup | hours | Re-provision host, restore, redeploy desired commits |
