# scripts/ — curl walkthrough + automated round-trip

Runnable companion to [`QUICKSTART.md`](../QUICKSTART.md) §2. Walks the encrypted
round-trip flow with `curl`, dropping into three tiny TypeScript helpers for the
crypto steps `curl` can't do, then automates the whole thing.

## Layout

```
scripts/
  config.ts             # API base, package ids, Seal config, requireEnv()
  seal-helpers.ts       # shared Seal + signing helpers (used by every script)
  sign-reserve.ts       # CLI: <base64 reserve bytes> → signature
  encrypt-file.ts       # CLI: <plaintextPath> <sealPolicyId> → <plaintextPath>.enc
  decrypt-file.ts       # CLI: <ciphertextPath> <sealPolicyId> [original=sample.txt] → <…>.dec + MATCH/MISMATCH
  full-round-trip.ts    # end-to-end automated: all 10 steps
  sample.txt            # round-trip plaintext
```

## Prereqs

- Node **>=22** (the scripts rely on Node's built-in `--env-file=.env` flag plus
  global `fetch` / `FormData` / `Blob`).
- pnpm.
- `curl` and [`jq`](https://jqlang.org/) on `$PATH` (the walkthrough pipes JSON
  responses through `jq` to extract ids — that's what makes the snippets
  copy-pasteable).
- A Harbor API key with role `read_write` **and** "Create" capability ticked. The
  reveal screen also exposes a `suiprivkey1…` **service private key** — copy both.

```bash
cd scripts
pnpm install
cp .env.example .env   # fill in HARBOR_API_KEY + HARBOR_SERVICE_PRIVKEY
pnpm run typecheck
```

The pnpm scripts auto-load `.env` via `tsx --env-file=.env …`.

## Curl walkthrough

Run these from `scripts/`, in one shell session, in order. The snippets are
self-contained — every value the next step needs is pulled out with `jq` and
exported. Source your `.env` first so `$HARBOR_API_KEY` is set:

```bash
set -a; source .env; set +a
export BASE="https://api.testnet.harbor.walrus.xyz"
export AUTH="Authorization: Bearer $HARBOR_API_KEY"
```

### 1. List spaces → pick the first one

```bash
export SPACE_ID=$(curl -sS -H "$AUTH" "$BASE/api/v1/spaces" | jq -r '.data[0].id')
echo "SPACE_ID=$SPACE_ID"
```

### 2. Reserve a private bucket **and sign immediately** (helper #1)

The reserve response carries an **Enoki-sponsored** Sui transaction in `bytes`.
The sponsor signature has a short TTL — if you wait too long between reserve and
finalize, the next step fails with `digest_expired`. So sign in the same snippet:

Bucket names must be unique within a space, so the snippet appends a Unix
timestamp — re-runs do not collide. (If you really want a fixed name, see
the cleanup snippet at the end of this section.)

```bash
RESERVE=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"round-trip-$(date +%s)\",\"scope\":\"private\"}" \
  "$BASE/api/v1/spaces/$SPACE_ID/buckets")
export BUCKET_ID=$(echo "$RESERVE" | jq -r '.bucket_id // empty')
[ -n "$BUCKET_ID" ] || { echo "Reserve failed: $RESERVE"; return 1 2>/dev/null || exit 1; }
export SIGNATURE=$(pnpm --silent sign-reserve "$(echo "$RESERVE" | jq -r '.bytes')")
echo "BUCKET_ID=$BUCKET_ID"
echo "SIGNATURE.length=${#SIGNATURE}"
```

### 3. Finalize (run right after step 2)

```bash
export SEAL_POLICY_ID=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"signature\":\"$SIGNATURE\"}" \
  "$BASE/api/v1/buckets/$BUCKET_ID/finalize" | jq -r '.seal_policy_id')
echo "SEAL_POLICY_ID=$SEAL_POLICY_ID"
```

If `SEAL_POLICY_ID=null`, re-run the unpiped curl to see the error body. The
usual culprit is `digest_expired` — repeat step 2 to get fresh sponsor bytes.

### 4. Encrypt sample.txt (helper #2)

```bash
pnpm run encrypt-file sample.txt "$SEAL_POLICY_ID"
# → writes sample.txt.enc
```

### 5. Upload (retry on `mirror_missing_grant`)

The on-chain bucket grant from Finalize needs a few seconds to land in Harbor's
ACL indexer. Until then this returns `403 mirror_missing_grant`. Retry every
~3s; ≤20 attempts is plenty:

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

### 7. Download the ciphertext

```bash
curl -sS -H "$AUTH" -o downloaded.enc \
  "$BASE/api/v1/buckets/$BUCKET_ID/files/$FILE_ID/download"
```

### 8 + 9. Decrypt + verify (helper #3), then delete

```bash
pnpm run decrypt-file downloaded.enc "$SEAL_POLICY_ID" sample.txt
# → writes downloaded.enc.dec, prints MATCH

curl -sS -X DELETE -H "$AUTH" \
  -o /dev/null -w '%{http_code}\n' \
  "$BASE/api/v1/buckets/$BUCKET_ID/files/$FILE_ID"
# → 204
```

### Stranded `pending_policy` buckets

If reserve succeeds but finalize never lands (digest expired, killed shell,
crash mid-walkthrough), the bucket sits in `pending_policy` forever and its
name is locked. List + delete every such bucket in the current space:

```bash
curl -sS -H "$AUTH" "$BASE/api/v1/spaces/$SPACE_ID/buckets" \
  | jq -r '.buckets[] | select(.state=="pending_policy") | .id' \
  | xargs -I{} curl -sS -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code} {}\n' \
      "$BASE/api/v1/buckets/{}"
```

## Automated round-trip

Once the curl walkthrough works once, run the whole thing in one shot:

```bash
pnpm run full-round-trip
```

Logs each of the 10 steps and exits with `Round-trip OK.` after the **MATCH**
verification + delete. Use it as the smoke test after any local edit.
