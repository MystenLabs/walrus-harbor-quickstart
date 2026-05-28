# AGENTS.md

Repo: reference code for the Harbor REST API (testnet, alpha).

## Layout

- `README.md`, `QUICKSTART.md` — narrative docs. `QUICKSTART.md` §2 is the source of
  truth for endpoint shapes, SDK calls, package ids, and Seal config.
- `openapi.yaml`, `postman/` — curated API surface.
- `scripts/` — curl walkthrough + helper CLIs + automated round-trip.
- `app/` — minimal Hono backend exposing the same flow over local HTTP.

## Conventions

- Package manager: **pnpm**. Node **>=22** (see `.nvmrc`).
- TypeScript, `NodeNext`, `strict`. Rely on global `fetch`, `FormData`, `Blob`,
  `crypto.getRandomValues`. Load `.env` via Node's built-in `--env-file` flag
  (wired through the pnpm scripts) — no `dotenv` dep.
- `scripts/` and `app/` are standalone pnpm projects (no workspace).
- SDKs: `@mysten/sui` ^2.x, `@mysten/seal` ^1.x. Hono + `@hono/node-server` for `app/`.
- Secrets via `.env` only. Never log them. Service key stays on the backend.

## Integration model

Backend-proxy: frontend → participant backend → Harbor. Browsers cannot call Harbor
directly (CORS). Auth is `Authorization: Bearer hbr_…` plus a `suiprivkey1…` service
key that signs the reserve transaction and Seal decrypt sessions.

## Harbor specifics

- Reserve `bytes` is an Enoki-sponsored Sui transaction; sign with
  `keypair.signTransaction(fromBase64(bytes))`.
- Encrypt + `SessionKey` use `ORIGINAL_PACKAGE_ID` (canonical id — Seal pins identity
  derivation to it).
- `seal_approve` move-call target uses `LATEST_PACKAGE_ID::bucket_policy::seal_approve`.
- After Finalize the first upload may return `403 mirror_missing_grant` while the ACL
  indexer catches up. Retry ~3s, ≤20 attempts.
- Poll `…/files/{fileId}/status` until `state === "completed"` before download.

## Verify

Per project: `pnpm install && pnpm run typecheck`. Round-trip:
`pnpm run full-round-trip` in `scripts/` must end with **MATCH** and a successful
delete.

When in doubt, re-read `QUICKSTART.md` §2.
