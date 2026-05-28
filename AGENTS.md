# AGENTS.md

Repo: reference code for the Harbor REST API (testnet, alpha).

## Layout

- `README.md`, `QUICKSTART.md` — narrative docs. `QUICKSTART.md` §2 is the source
  of truth for SDK call shapes, package ids, and Seal config.
- `openapi.yaml`, `postman/` — curated API surface. `openapi.yaml` is authoritative
  for endpoint shapes, status codes, and required query/body params.
- `app/` — single pnpm project covering all four runnable surfaces:
  - `app/src/lib/{seal,harbor}.ts` — shared Seal + Harbor REST helpers.
  - `app/src/scripts/` — three helper CLIs (`sign-reserve`, `encrypt-file`,
    `decrypt-file`) + `full-round-trip.ts`.
  - `app/src/server/index.ts` — Hono backend exposing the flow over local HTTP.
  - `app/sample.txt` — round-trip plaintext.

## Conventions

- Package manager: **pnpm**. Node **>=22** (see `.nvmrc`).
- TypeScript, `NodeNext`, `strict`. Rely on global `fetch`, `FormData`, `Blob`,
  `crypto.getRandomValues`. Load `.env` via Node's built-in `--env-file` flag
  (wired through the pnpm scripts) — no `dotenv` dep.
- `app/` is a single pnpm project — scripts and server share `lib/`. The
  `pnpm-workspace.yaml` is config-only (sets `allowBuilds: esbuild: false`
  for pnpm v11); there are no workspace packages.
- SDKs: `@mysten/sui` ^2.x, `@mysten/seal` ^1.x. Hono + `@hono/node-server` for the server.
- Secrets via `.env` only. Never log them. Service key stays on the backend.

## Integration model

Backend-proxy: frontend → your backend → Harbor. Browsers cannot call Harbor
directly (CORS). Auth is `Authorization: Bearer hbr_…` plus a `suiprivkey1…` service
key that signs the reserve transaction and Seal decrypt sessions.

## Harbor specifics

- Reserve `bytes` is an Enoki-sponsored Sui transaction; sign with
  `keypair.signTransaction(fromBase64(bytes))`.
- Encrypt + `SessionKey` use `ORIGINAL_PACKAGE_ID` (canonical id — Seal pins identity
  derivation to it).
- `seal_approve` move-call target uses `LATEST_PACKAGE_ID::bucket_policy::seal_approve`.
- After Finalize the first upload (and the first `GET /buckets/{id}` metadata
  read) may return `403 mirror_missing_grant` while the ACL indexer catches up.
  Retry ~3s, ≤20 attempts.
- Poll `…/files/{fileId}/status` until `state === "completed"` before download.
- `DELETE /api/v1/buckets/{id}` requires `?confirm=true`; also 400s if the bucket
  still has files.

## Verify

From `app/`: `pnpm install && pnpm run typecheck`. Round-trip:
`pnpm run full-round-trip` must end with **MATCH**, file delete, and
`Round-trip OK.`. Server smoke test: `pnpm start`, then POST/GET/DELETE
through the routes table in `app/README.md`.

When in doubt, re-read `QUICKSTART.md` §2.
