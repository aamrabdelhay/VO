# VO — Self-hosted deployment platform

A production-oriented, self-hosted GitHub-to-deployment control plane. VO fetches an exact Git commit, builds it in an isolated workspace, starts a new runtime, verifies the real runtime with health checks, and only then promotes it. A failed or stale deployment cannot replace healthy production.

## Garvex AI

Garvex supports NVIDIA multimodal model routing for text, image, audio and video understanding, durable PostgreSQL chat history, OpenRouter media generation, and voice processing with provider fallback. NVIDIA model capabilities are cataloged in `src/lib/ai/nvidia-catalog.ts` and exposed through `/api/v1/admin/garvex/nvidia`.
