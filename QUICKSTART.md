# Harbor API Quickstart

> **Alpha.** Testnet only. Endpoint shapes may change before mainnet GA.

A "hello world" tour of the Harbor API: sign up, create a Seal-encrypted
bucket, then upload + download a file. In alpha, all bucket creation goes
through the private (Seal-encrypted) flow — public bucket creation is
disabled at the API boundary.

> **Hosted versions.** This guide is also served live from the API:
> - Rendered HTML: [`/docs/quickstart`](https://api.testnet.harbor.walrus.xyz/docs/quickstart)
> - Raw markdown (LLM/`curl`-friendly): [`/docs/quickstart.md`](https://api.testnet.harbor.walrus.xyz/docs/quickstart.md)
> - OpenAPI viewer (Scalar): [`/docs/openapi`](https://api.testnet.harbor.walrus.xyz/docs/openapi)
> - OpenAPI spec (raw): [`/openapi.yaml`](https://api.testnet.harbor.walrus.xyz/openapi.yaml) · [`/openapi.json`](https://api.testnet.harbor.walrus.xyz/openapi.json)
> - Docs index: [`/docs`](https://api.testnet.harbor.walrus.xyz/docs)

---

## 1. Hello world — sign up via zkLogin

1. Visit [testnet.harbor.walrus.xyz/](https://testnet.harbor.walrus.xyz/) and sign in with Google (via zkLogin) — or a Sui wallet, if you prefer.
   Your account and a **Personal Space** are provisioned automatically.
2. Open **Settings → API Keys → New API key**, give it a name, pick a
   **role**, submit.
   - **`read_write`** — required for any state change: create/delete
     buckets, upload/rename/delete files, finalize private buckets.
   - **`read_only`** — listing, status, download only. Every write
     endpoint returns `403 read_only_api_key` for these keys; pick this
     scope when handing a key to a downstream consumer that should not
     mutate your data.

   Pick `read_write` if you intend to follow §2 end-to-end; pick
   `read_only` only for read-side integrations.
3. On the reveal screen, copy the `hbr_…` Harbor API key. It is shown
   **once** — Harbor cannot recover it afterwards. Store it like an AWS
   secret access key.
4. (Optional) Import the curated Postman pair into Postman Desktop:
   - `postman/harbor.postman_collection.json`
   - `postman/harbor.postman_environment.json`

   Paste your `hbr_…` key into the `bearerToken` env variable. `baseUrl`
   defaults to `https://api.testnet.harbor.walrus.xyz`.

Every request below carries `Authorization: Bearer hbr_…`.

---

## 2. Create an encrypted bucket and upload a file

```
service key setup → get space → reserve → sign → finalize →
encrypt → upload → poll → download → decrypt
```

Buckets are Seal-encrypted client-side — Harbor stores ciphertext only
and never sees plaintext or decryption material. Creation goes through a
**reserve → sign → finalize** handshake, with a one-time service-key
setup beforehand and a local decrypt step on download.

> **You will end §2.1 holding two secrets:** an `hbr_…` Harbor API key
> (sent as `Authorization: Bearer …` on every request) **and** a
> `suiprivkey1…` service private key (kept locally; used to sign the
> finalize transaction and to authenticate decrypt sessions with Seal).
> Both are shown **once** on the reveal screen — store them like AWS
> access keys.


### 1. One-time setup — encrypted-capable API key

In **Settings → API Keys → New API key**, pick role **`read_write`**
(private-bucket creation, finalize, and uploads are all writes — the
toggle is hidden on `read_only` keys) and tick **"Create"**. The reveal screen now exposes two secrets:

- `hbr_…` — the Harbor API key (same as section 1).
- `suiprivkey1…` — the **service private key**, an Ed25519 Base64 secret
  in Sui keytool format. Bound to this API key; Harbor stores only the
  derived public address. **Does not need any SUI balance** — gas is
  sponsored by Harbor via Enoki.

Both are shown **once**. Paste them into Postman as `bearerToken` and
`harborServicePrivateKey`, or stash them in your `.env`.


### 2. Get your space id

```http
GET /api/v1/spaces
```

The response's `data[]` array contains your spaces; copy the `id` of the
Personal Space created during sign-up. (Postman: `alpha (bearer) / spaces
(read) / List spaces`.)

### 3. Reserve the bucket

```http
POST /api/v1/spaces/{spaceId}/buckets
Content-Type: application/json

{ "name": "secrets", "scope": "private" }
```

Response (`201`):

```json
{
  "bucket_id": "…",
  "bytes": "<base64 Enoki-sponsored Sui tx>",
  "digest": "…",
  "state": "pending_policy"
}
```

`bytes` is the **Enoki-sponsored** Sui transaction that creates the
bucket's Seal access policy, with your service key's address set as the
sender. Harbor cannot sign it for you — that is the whole point of
client-side encryption — but it has already attached the gas sponsor's
signature, so your service key just needs to add its own signature.
`digest` is the Enoki sponsor digest; Harbor uses it server-side at
finalize to look up the sponsored tx. The bucket row stays in
`pending_policy` until the Finalize call below succeeds — until then no
files can be uploaded to it.

> **Sponsor signatures expire fast.** Treat **reserve → sign → finalize**
> as a single tight sequence. If you stall between reserve and finalize,
> finalize returns `{"code":"digest_expired"}`. Re-run reserve to get
> fresh `bytes` and try again. The Postman collection handles this by
> auto-signing in the Reserve request's post-response script.

> **Bucket names are unique per space.** A 409 on reserve means the name
> is taken — either by a live bucket or by one stuck in `pending_policy`
> from a previous aborted reserve. Pick a new name (e.g. append a Unix
> timestamp), or clean up the stale bucket: list with
> `GET /api/v1/spaces/{id}/buckets`, filter `state == "pending_policy"`,
> then `DELETE /api/v1/buckets/{id}?confirm=true` on each (the
> `confirm=true` query param is required; delete also 400s if the bucket
> still has files).

### 4. Sign `bytes` with the service key

Use `@mysten/sui` — it handles the Bech32 decode and the Sui signature
envelope (`0x00 || sig || pubKey`) for you:

```ts
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';

const { secretKey } = decodeSuiPrivateKey(process.env.HARBOR_SERVICE_PRIVKEY);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const { signature } = await keypair.signTransaction(fromBase64(bytes));
```

### 5. Finalize

```http
POST /api/v1/buckets/{bucketId}/finalize
Content-Type: application/json

{ "signature": "<base64 signature from step 4>" }
```

Harbor combines your signature with Enoki's gas-sponsor signature and
broadcasts the transaction. Response (`200`):

```json
{ "bucket_id": "…", "seal_policy_id": "…", "state": "active" }
```

`seal_policy_id` is the on-chain bucket-group object id used by Seal for
access checks. The bucket is now usable.

### 6. Encrypt the file with Seal

Private buckets store **Seal ciphertext only** — Harbor never sees plaintext.
Encrypt locally with [`@mysten/seal`](https://www.npmjs.com/package/@mysten/seal)
against the `seal_policy_id` returned by Finalize:

```ts
import { SealClient } from '@mysten/seal';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';

// Harbor's bucket-policy package + Seal's three testnet key servers (threshold 2).
// `ORIGINAL` here means the *original-id* of the upgradeable package
// (its original/canonical published id). Seal pins identity
// derivation to the original/canonical package id, so encrypt MUST use this
// value even after the package has been upgraded — otherwise an upgrade would
// invalidate every previously-encrypted blob's DEK.
const HARBOR_ORIGINAL_PACKAGE_ID =
  '0x8b2429358e9b0f005b69fe8ad3cbd1268ad87f35047a21612e082c64824faf8d';
const SEAL_KEY_SERVER_OBJECT_IDS = [
  '0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2',
  '0x164ac3d2b3b8694b8181c13f671950004765c23f270321a45fdd04d40cccf0f2',
  '0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105',
];

const sui = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});
const seal = new SealClient({
  suiClient: sui,
  serverConfigs: SEAL_KEY_SERVER_OBJECT_IDS.map((objectId) => ({ objectId, weight: 1 })),
  verifyKeyServers: false,
});

// Each file's Seal id = (bucket policy id, 32 random bytes). The bcs serializer
// matches Harbor's on-chain `seal_approve` check.
const SealIdentity = bcs.struct('SealIdentity', {
  policyObjectId: bcs.Address,
  nonce: bcs.fixedArray(32, bcs.u8()),
});
const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)));
const id = SealIdentity.serialize({ policyObjectId: sealPolicyId, nonce }).toHex();

const { encryptedObject } = await seal.encrypt({
  threshold: 2,
  packageId: HARBOR_ORIGINAL_PACKAGE_ID,
  id,
  data: plaintextBytes, // Uint8Array
});
```

`encryptedObject` is the byte stream you upload next.

### 7. Upload — retry on `mirror_missing_grant`

```http
POST /api/v1/buckets/{bucketId}/files
Content-Type: multipart/form-data

file=@<encryptedObject>
```

Standard multipart upload, but the on-chain `BucketAdmin` grant from
Finalize needs a few seconds to land in Harbor's ACL indexer. Until then
this endpoint returns `403` with `code: "mirror_missing_grant"`. Retry
every ~3 seconds; ≤20 attempts is plenty in practice. Once the grant
mirrors, the response is `202` with `data.id`.

### 8. Poll status

```http
GET /api/v1/buckets/{bucketId}/files/{fileId}/status
```

Returns `{ "data": { "state": "queued" | "active" | "completed" | "failed" } }`.
Poll every second or two until `state === "completed"`. Typical completion is
under 30 seconds on testnet.

### 9. Download → decrypt locally

```http
GET /api/v1/buckets/{bucketId}/files/{fileId}/download
```

Returns the raw **Seal ciphertext**. Decrypt with `@mysten/seal` by
building the bucket's `seal_approve` access-check PTB (signed by your
service key via a `SessionKey`) and feeding both the ciphertext and the
PTB to `SealClient.decrypt`:

```ts
import { EncryptedObject, SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';

// Latest Harbor bucket-policy package — host of the `seal_approve` move call.
const HARBOR_LATEST_PACKAGE_ID =
  '0xc11d875481544e9b6c616f7d6704266e1633b4034eab7ed76626dc25ebfcd506';

const { secretKey } = decodeSuiPrivateKey(process.env.HARBOR_SERVICE_PRIVKEY);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

// ciphertext = bytes from GET /download
const parsed = EncryptedObject.parse(ciphertext);
const idBytes = fromHex(parsed.id.startsWith('0x') ? parsed.id : '0x' + parsed.id);

// 1. Build the access-check PTB (TransactionKind only — never broadcast).
const tx = new Transaction();
tx.moveCall({
  target: `${HARBOR_LATEST_PACKAGE_ID}::bucket_policy::seal_approve`,
  arguments: [tx.pure.vector('u8', idBytes), tx.object(sealPolicyId)],
});
const txBytes = await tx.build({ client: sui, onlyTransactionKind: true });

// 2. SessionKey lets Seal key servers verify the caller without re-signing per request.
const sessionKey = await SessionKey.create({
  address: keypair.toSuiAddress(),
  packageId: HARBOR_ORIGINAL_PACKAGE_ID,
  ttlMin: 10,
  suiClient: sui,
  signer: keypair,
});

// 3. Decrypt — SealClient fetches threshold key shares and reconstructs the DEK locally.
const plaintext = await seal.decrypt({ data: ciphertext, sessionKey, txBytes });
```

Harbor's API surface stops at the ciphertext byte stream — decryption is
fully client-side and never touches Harbor's backend.


---

## 3. Filing issues

Open an issue at
**[github.com/MystenLabs/walrus-harbor-quickstart/issues](https://github.com/MystenLabs/walrus-harbor-quickstart/issues)**
with the label **`developer-docs`**.

Please include:

- The endpoint and HTTP method
- The HTTP status and the `code` field from the error response (if any)
- Postman collection version (visible in the collection's **Info** tab)

For the full machine-readable surface, see
[`openapi.yaml`](openapi.yaml) (curated, Bearer-only,
11 endpoints).
