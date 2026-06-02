# app/ — Harbor reference integration

A single TypeScript project showing the Harbor REST integration end-to-end.
Same domain code drives **four** runnable surfaces:

1. **curl walkthrough** — drive the REST manually, dropping into helper scripts
   for the crypto that `curl` can't do.
2. **Helper CLIs** — `sign-reserve`, `encrypt-file`, `decrypt-file`.
3. **Automated round-trip** — single script that drives all 10 steps end-to-end.
4. **Hono backend** — tiny local HTTP server exposing the flow as proper
   REST routes (the integration model a frontend would call).

## Layout

```
app/
  src/
    config.ts             # API base, package ids, Seal config, requireEnv()
    lib/
      seal.ts             # Sui signing, Seal encrypt/decrypt, SessionKey
      harbor.ts           # Harbor REST client (used by scripts and server)
    scripts/
      sign-reserve.ts     # CLI: <base64 bytes> → signature
      encrypt-file.ts     # CLI: <plaintextPath> <sealPolicyId> → <…>.enc
      decrypt-file.ts     # CLI: <ciphertextPath> <sealPolicyId> [original] → <…>.dec + MATCH/MISMATCH
      full-round-trip.ts  # end-to-end: all 10 steps
    server/
      index.ts            # Hono backend
  sample.txt              # round-trip plaintext
  package.json            # one pnpm project; one install
  tsconfig.json
  .env.example
```

## Prereqs

- Node **>=22** (`.nvmrc` pins it). The code uses Node's built-in
  `--env-file=.env` flag, global `fetch` / `FormData` / `Blob`, and
  `node:timers/promises`.
- pnpm.
- `curl` and [`jq`](https://jqlang.org/) for the curl walkthrough.
- A Harbor API key with the **Read & Write** permission. The reveal screen
  shows two secrets — the `hbr_…` API key and a `suiprivkey1…` **service
  private key** — copy both.

```bash
cd app
pnpm install
cp .env.example .env   # fill HARBOR_API_KEY + HARBOR_SERVICE_PRIVKEY
pnpm run typecheck
```

The pnpm scripts auto-load `.env` via `tsx --env-file=.env …`.

---

## 1. Curl walkthrough

Run from `app/`, in one shell session, in order. `jq` extracts ids; `pnpm`
scripts run the helper CLIs. Source your `.env` first:

```bash
set -a; source .env; set +a
export BASE="https://api.testnet.harbor.walrus.xyz"
export AUTH="Authorization: Bearer $HARBOR_API_KEY"
```

### 1. List spaces

```bash
export SPACE_ID=$(curl -sS -H "$AUTH" "$BASE/api/v1/spaces" | jq -r '.data[0].id')
echo "SPACE_ID=$SPACE_ID"
```

### 2. Reserve **and sign immediately** (helper #1)

The reserve response carries an **Enoki-sponsored** Sui transaction in `bytes`.
The sponsor signature has a short TTL — stalling between reserve and finalize
returns `digest_expired`. So sign in the same snippet:

Bucket names must be unique per space, so the snippet appends a Unix timestamp.

```bash
RESERVE=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"round-trip-$(date +%s)\",\"scope\":\"private\"}" \
  "$BASE/api/v1/spaces/$SPACE_ID/buckets")

export BUCKET_ID=$(echo "$RESERVE" | jq -r '.bucket_id // empty')
[ -n "$BUCKET_ID" ] || { echo "Reserve failed: $RESERVE"; return 1 2>/dev/null || exit 1; }

export SIGNATURE=$(pnpm --silent sign-reserve "$(echo "$RESERVE" | jq -r '.bytes')")
echo "BUCKET_ID=$BUCKET_ID"
```

### 3. Finalize

```bash
export SEAL_POLICY_ID=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"signature\":\"$SIGNATURE\"}" \
  "$BASE/api/v1/buckets/$BUCKET_ID/finalize" | jq -r '.seal_policy_id')
echo "SEAL_POLICY_ID=$SEAL_POLICY_ID"
```

`SEAL_POLICY_ID=null`? Re-run the unpiped curl to see the body. Usually
`digest_expired` — repeat step 2 for fresh sponsor bytes.

### 4. Encrypt sample.txt (helper #2)

```bash
pnpm run encrypt-file sample.txt "$SEAL_POLICY_ID"
# → writes sample.txt.enc
```

### 5. Upload (retry on `mirror_missing_grant`)

Harbor's on-chain ACL grant from finalize needs a few seconds to land in its
indexer. Until then this returns `403 mirror_missing_grant`. Retry every ~3s:

```bash
for i in $(seq 1 20); do
  RES=$(curl -sS -o /tmp/upload.json -w '%{http_code}' \
    -X POST -H "$AUTH" \
    -F "file=@sample.txt.enc" -F "name=sample.txt" \
    "$BASE/api/v1/buckets/$BUCKET_ID/files")
  if [ "$RES" = "202" ]; then break; fi
  echo "attempt $i: HTTP $RES — $(cat /tmp/upload.json)"
  sleep 3
done
export FILE_ID=$(jq -r '.data.id' /tmp/upload.json)
echo "FILE_ID=$FILE_ID"
```

### 6. Poll status until completed

```bash
while :; do
  STATE=$(curl -sS -H "$AUTH" \
    "$BASE/api/v1/buckets/$BUCKET_ID/files/$FILE_ID/status" \
    | jq -r '.data.state')
  echo "state=$STATE"
  [ "$STATE" = "completed" ] && break
  [ "$STATE" = "failed" ] && { echo "upload failed"; break; }
  sleep 2
done
```

### 7. Download

```bash
curl -sS -H "$AUTH" -o downloaded.enc \
  "$BASE/api/v1/buckets/$BUCKET_ID/files/$FILE_ID/download"
```

### 8 + 9. Decrypt + verify (helper #3), then delete

```bash
pnpm run decrypt-file downloaded.enc "$SEAL_POLICY_ID" sample.txt
# → writes downloaded.enc.dec, prints MATCH

curl -sS -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code}\n' \
  "$BASE/api/v1/buckets/$BUCKET_ID/files/$FILE_ID"
# → 204
```

### Cleanup: stranded or accumulated buckets

Stranded `pending_policy` (reserve succeeded, finalize never landed):

```bash
curl -sS -H "$AUTH" "$BASE/api/v1/spaces/$SPACE_ID/buckets" \
  | jq -r '.buckets[] | select(.state=="pending_policy") | .id' \
  | xargs -I{} curl -sS -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code} {}\n' \
      "$BASE/api/v1/buckets/{}?confirm=true"
```

Nuke every bucket in the space (each 400s if it still has files, 204s if empty):

```bash
curl -sS -H "$AUTH" "$BASE/api/v1/spaces/$SPACE_ID/buckets" \
  | jq -r '.buckets[].id' \
  | xargs -I{} curl -sS -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code} {}\n' \
      "$BASE/api/v1/buckets/{}?confirm=true"
```

`?confirm=true` is required. Delete also 400s if the bucket still has files.

---

## 2. Automated round-trip

```bash
pnpm run full-round-trip
```

Logs each of the 10 steps and exits with `Round-trip OK.` after the **MATCH**
verification + file delete. Smoke test after any local edit.

---

## 3. Hono backend

Same domain code (`src/lib/{seal,harbor}.ts`) wrapped in a small HTTP surface a
frontend can call:

```bash
pnpm run dev    # tsx --watch, hot reload
# or
pnpm start
```

Default `http://127.0.0.1:3000` (loopback only). Override with `PORT` / `HOST`.

### Routes

| Method | Path                                   | Body                                 | Returns                       | Behind the scenes                                                          |
| ------ | -------------------------------------- | ------------------------------------ | ----------------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/spaces`                          | –                                    | spaces list                   | –                                                                          |
| GET    | `/api/spaces/:spaceId/buckets`         | –                                    | buckets list                  | –                                                                          |
| POST   | `/api/spaces/:spaceId/buckets`         | `{name}`                             | `{bucket_id, seal_policy_id}` | reserve → sign → finalize                                                  |
| GET    | `/api/buckets/:bucketId/files`         | –                                    | files list                    | –                                                                          |
| POST   | `/api/buckets/:bucketId/files`         | multipart `file` (+ optional `name`) | `{file_id}`                   | look up `seal_policy_id`, encrypt, upload-w/-retry, poll until `completed` |
| GET    | `/api/buckets/:bucketId/files/:fileId` | –                                    | raw plaintext                 | look up `seal_policy_id`, download, decrypt                                |
| DELETE | `/api/buckets/:bucketId/files/:fileId` | –                                    | 204                           | –                                                                          |
| DELETE | `/api/buckets/:bucketId`               | –                                    | 204                           | passes `?confirm=true`                                                     |

### Smoke test

```bash
pnpm start &
sleep 2
SPACE_ID=$(curl -sS http://127.0.0.1:3000/api/spaces | jq -r '.[0].id')
BUCKET=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"e2e-$(date +%s)\"}" \
  "http://127.0.0.1:3000/api/spaces/$SPACE_ID/buckets" | jq -r '.bucket_id')
FILE=$(curl -sS -X POST -F "file=@sample.txt" \
  "http://127.0.0.1:3000/api/buckets/$BUCKET/files" | jq -r '.file_id')
curl -sS -o /tmp/got.bin \
  "http://127.0.0.1:3000/api/buckets/$BUCKET/files/$FILE"
cmp -s sample.txt /tmp/got.bin && echo MATCH || echo MISMATCH
```

---

## Integration model

Backend-proxy: **frontend → this server → Harbor**. Browsers can't call Harbor
directly (CORS locks `/api` to Harbor's own origins, and the API key plus
service signer must stay server-side). The frontend is left to participants;
point it at this server's routes — same shape as any SaaS-backed app.

## Limitations & potential improvements

Deliberate "keep it simple" trade-offs in this reference, not recommendations
for production code:

- **Synchronous upload.** `POST /api/buckets/:id/files` holds the HTTP request
  open until Harbor reports `completed` (≤~1m on testnet today). Frontend UX
  is a single request, but the connection has to survive that long.
  _Improve:_ return `202 {file_id}` immediately and expose
  `GET /api/buckets/:id/files/:fileId/status` so the frontend polls.
- **Stateless `seal_policy_id` lookup.** Each upload/download re-fetches bucket
  metadata to find the policy id. One extra Harbor GET per file op, plus a
  retry loop on `mirror_missing_grant`.
  _Improve:_ cache `bucketId → seal_policy_id` in memory (or a small KV) after
  create / first lookup.
- **Server-side encrypt/decrypt of the full payload.** All bytes pass through
  this server and are buffered in memory — Seal currently operates on a whole
  `Uint8Array`, so the envelope cannot be streamed end-to-end. Easy to reason
  about; not friendly to multi-GB files.
  _Improve:_ split large payloads into independently-sealed chunks at the app
  layer and stream chunk uploads/downloads through `fetch`'s body stream,
  instead of buffering the whole file.
- **`DELETE /api/buckets/:id` can still return 400 from Harbor.** Even with
  `?confirm=true`, Harbor 400s if the bucket isn't empty — delete its files
  first. Cleanest target is `pending_policy` (no files possible).
- **`full-round-trip.ts` does not clean up its bucket.** Only the file is
  deleted; the bucket stays. Repeated runs accumulate and eventually trip the
  per-space bucket cap (`422 PLAN_LIMIT_EXCEEDED` on the next reserve). The
  script catches that specific error and prints the cleanup snippet; run it
  and retry.
  _Improve:_ delete the bucket too at the end (or `set -e` a cleanup trap),
  or pre-clean stale buckets on startup.
- **No auth on this server.** It binds to `127.0.0.1` and assumes the caller
  is the local frontend.
  _Improve:_ shared-secret header, mTLS, or session cookies before exposing
  beyond localhost.
- **CORS is permissive.** `cors()` with defaults so a local frontend on any
  port can call it during development.
  _Improve:_ lock to your frontend origin(s).
- **No request validation.** JSON / multipart payloads are taken as-is.
  _Improve:_ `@hono/zod-validator` + zod schemas per route.
- **No structured logging or tracing.** `hono/logger` only.
  _Improve:_ `pino`, request ids, OpenTelemetry, error-tracking SDK of choice.
- **Errors are best-effort.** `HarborError` codes pass through; everything
  else becomes `500 internal_error`.
  _Improve:_ finer-grained mapping + retry/backoff policies per error class.
