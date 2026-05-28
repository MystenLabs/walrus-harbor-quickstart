import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

import { requireEnv } from '../config.js';
import { HarborClient, HarborError } from '../lib/harbor.js';
import {
  decryptBytes,
  encryptBytes,
  loadKeypair,
  makeSealClient,
  makeSuiClient,
  signReserveBytes,
} from '../lib/seal.js';

const SAMPLE_PATH = new URL('../../sample.txt', import.meta.url);
const BUCKET_NAME = `round-trip-${Date.now()}`;
const UPLOAD_NAME = 'sample.txt.enc';

const harbor = new HarborClient({ apiKey: requireEnv('HARBOR_API_KEY') });
const keypair = loadKeypair(requireEnv('HARBOR_SERVICE_PRIVKEY'));
const sui = makeSuiClient();
const seal = makeSealClient(sui);

function step(n: number, label: string): void {
  console.log(`\n[${n}/10] ${label}`);
}

step(1, 'List spaces');
const spaces = await harbor.listSpaces();
const space = spaces[0];
if (!space) throw new Error('No spaces found for this API key.');
console.log(`  space.id=${space.id}${space.name ? ` (${space.name})` : ''}`);

step(2, 'Reserve a private bucket');
let reserved;
try {
  reserved = await harbor.reserveBucket(space.id, BUCKET_NAME);
} catch (err) {
  if (err instanceof HarborError && err.parsed?.code === 'PLAN_LIMIT_EXCEEDED') {
    console.error(
      `\nBucket cap reached for space ${space.id}. This script leaves each ` +
        `created bucket behind (only the file is deleted), so cleanup is on you. ` +
        `Delete empty buckets in the space and retry:\n\n` +
        `  set -a; source .env; set +a\n` +
        `  export BASE="https://api.testnet.harbor.walrus.xyz"\n` +
        `  export AUTH="Authorization: Bearer $HARBOR_API_KEY"\n` +
        `  curl -sS -H "$AUTH" "$BASE/api/v1/spaces/${space.id}/buckets" \\\n` +
        `    | jq -r '.buckets[].id' \\\n` +
        `    | xargs -I{} curl -sS -X DELETE -H "$AUTH" -o /dev/null \\\n` +
        `        -w '%{http_code} {}\\n' "$BASE/api/v1/buckets/{}?confirm=true"\n`,
    );
    process.exit(1);
  }
  throw err;
}
console.log(`  bucket_id=${reserved.bucket_id} digest=${reserved.digest}`);

step(3, 'Sign reserve bytes with service key');
const signature = await signReserveBytes(keypair, reserved.bytes);
console.log(`  signature.length=${signature.length}`);

step(4, 'Finalize');
const finalized = await harbor.finalizeBucket(reserved.bucket_id, signature);
console.log(`  seal_policy_id=${finalized.seal_policy_id} state=${finalized.state}`);

step(5, 'Encrypt sample.txt with Seal');
const plaintext = await readFile(SAMPLE_PATH);
const ciphertext = await encryptBytes(seal, finalized.seal_policy_id, plaintext);
console.log(`  plaintext=${plaintext.byteLength}B ciphertext=${ciphertext.byteLength}B`);

step(6, 'Upload (retry on mirror_missing_grant)');
const upload = await harbor.uploadFile(
  reserved.bucket_id,
  UPLOAD_NAME,
  ciphertext,
  (attempt, body) => console.log(`  attempt ${attempt}: mirror_missing_grant — ${body}`),
);
console.log(`  uploaded file.id=${upload.data.id}`);

step(7, 'Poll status until completed');
await harbor.pollUntilCompleted(reserved.bucket_id, upload.data.id, (attempt, state) =>
  console.log(`  attempt ${attempt}: state=${state}`),
);

step(8, 'Download ciphertext');
const downloaded = await harbor.downloadFile(reserved.bucket_id, upload.data.id);
console.log(`  downloaded ${downloaded.byteLength}B`);

step(9, 'Decrypt with Seal');
const decrypted = await decryptBytes(seal, sui, keypair, finalized.seal_policy_id, downloaded);
console.log(`  decrypted ${decrypted.byteLength}B`);

step(10, 'Verify + delete');
const matches =
  plaintext.byteLength === decrypted.byteLength && timingSafeEqual(plaintext, decrypted);
console.log(`  ${matches ? 'MATCH' : 'MISMATCH'}`);
if (!matches) process.exitCode = 1;

await harbor.deleteFile(reserved.bucket_id, upload.data.id);
console.log(`  deleted file.id=${upload.data.id}`);

console.log('\nRound-trip OK.');
