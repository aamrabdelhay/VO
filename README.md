# VO — Self-hosted deployment platform

A production-oriented, self-hosted GitHub-to-deployment control plane. VO fetches an exact Git commit, builds it in an isolated workspace, starts a new runtime, verifies the real runtime with health checks, and only then promotes it. A failed or stale deployment cannot replace healthy production.

## Architecture

```text
GitHub → verified/deduplicated webhook → durable queue → build worker
       → immutable artifact → runtime → health check → desired-state check
       → atomic Traefik route promotion → monitoring → retention / cleanup
```

The system separates:

- **Control plane:** Next.js dashboard/API, authentication, RBAC, PostgreSQL state, durable jobs, deployment and AI orchestration.
- **Data plane:** isolated build workspaces, Docker/process runtime drivers, immutable artifacts, Traefik routing and TLS.

Traefik routes internet traffic directly to application runtimes. Existing applications keep serving if the control plane is temporarily unavailable.

## Implemented capabilities

- GitHub repository projects, configurable production branch and exact-commit deployments
- HMAC-SHA256 webhook verification and durable delivery deduplication
- Push deployments, pull-request/branch previews, preview expiration and PR comments
- Central deployment state machine and stale-generation protection
- Real install, test, build, runtime startup and health checks
- Zero-downtime promotion, retained rollback and bounded automatic rollback
- Platform and custom domains with DNS verification and Traefik ACME configuration
- Scoped, versioned environment variables using envelope encryption
- Live SSE logs, durable artifact/log storage and structured event/audit trails
- Runtime/resource metrics roll-ups, notifications, incidents and admin operations
- Reference-safe storage retention and idempotent garbage collection
- RBAC, secure sessions, CSRF protection, SSRF/path/command-injection guards
- AI provider abstraction, BYOK, controlled tool gateway and bounded sandboxed repair loop
- Host metadata and desired-state reconciliation for future multi-host scheduling

## Stack

- Next.js 16, React 19, TypeScript, App Router
- PostgreSQL and Drizzle ORM
- Durable PostgreSQL job queue with crash recovery and idempotency
- Docker hardened runtime driver with an isolated process-driver fallback
- Traefik, MinIO-compatible storage, OCI registry, Prometheus and Grafana configuration
- Tailwind CSS with a restrained, information-dense dark product interface

## Quick start

### Requirements

- Node.js 22+
- PostgreSQL 16+
- Docker and Docker Compose for the complete local data plane

### Setup

```bash
cp .env.example .env
# Set PLATFORM_ENCRYPTION_KEY and a strong PLATFORM_ADMIN_PASSWORD.

docker compose up -d postgres redis minio registry
npm install
npx drizzle-kit push
npm run dev
```

Open `http://localhost:3000`. On first start, the owner account is created from `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`.

For a full public installation, configure `PLATFORM_PUBLIC_URL`, `PLATFORM_DOMAIN`, wildcard DNS and the Traefik/ACME service in `docker-compose.yml`.

## GitHub App

Create a GitHub App and configure:

- Repository permissions: Contents, Metadata, Pull requests and Commit statuses
- Events: `push` and `pull_request`
- Webhook URL: `https://<platform>/api/v1/webhooks/github`
- Credentials: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`

After creating a project, use the per-project webhook secret displayed in its settings. Installation tokens are minted when required and cached only until shortly before expiration.

## Critical safety guarantees

- GitHub remains the source of truth; PostgreSQL stores platform state, not repository source.
- `currentHealthyDeploymentId` changes only after the new runtime passes readiness checks.
- Before start and promotion, the worker rechecks the desired commit and deployment generation.
- Duplicate webhook delivery IDs and duplicate job keys cannot create duplicate logical work.
- Cleanup protects current production, desired deployment, rollback retention, active previews, in-flight deployments and running runtimes.
- Workloads receive a scrubbed environment and cannot access platform/database/AI credentials.
- The AI agent has no Docker socket, raw database access, host filesystem access or unrestricted command tool.

## Documentation

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for environment variables, security boundaries, deployment internals, runbooks, backup/restore and disaster recovery guidance.

## Validation

```bash
npx next typegen
npm exec tsc -- --noEmit --pretty false
npm run build
```
