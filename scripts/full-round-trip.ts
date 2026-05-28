import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { API_BASE, requireEnv } from './config.js';
import {
  decryptBytes,
  encryptBytes,
  loadKeypair,
  makeSealClient,
  makeSuiClient,
  signReserveBytes,
} from './seal-helpers.js';

type SpaceListItem = { id: string; name?: string };
type ReserveResponse = { bucket_id: string; bytes: string; digest: string; state: string };
type FinalizeResponse = { bucket_id: string; seal_policy_id: string; state: string };
type UploadResponse = { data: { id: string } };
type StatusResponse = {
  data: { state: 'queued' | 'active' | 'completed' | 'failed'; error?: { code: string; message: string } };
};
type ErrorResponse = { code?: string; message?: string };

const HARBOR_API_KEY = requireEnv('HARBOR_API_KEY');
const HARBOR_SERVICE_PRIVKEY = requireEnv('HARBOR_SERVICE_PRIVKEY');

const authHeaders = { Authorization: `Bearer ${HARBOR_API_KEY}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

const SAMPLE_PATH = new URL('./sample.txt', import.meta.url);
const BUCKET_NAME = `round-trip-${Date.now()}`;
const UPLOAD_NAME = 'sample.txt.enc';
const UPLOAD_MAX_RETRIES = 20;
const UPLOAD_RETRY_DELAY_MS = 3_000;
const POLL_DELAY_MS = 1_500;
const POLL_MAX_ATTEMPTS = 60;

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${await readBody(res)}`);
  }
  return (await res.json()) as T;
}

function step(n: number, label: string): void {
  console.log(`\n[${n}/10] ${label}`);
}

step(1, 'GET /api/v1/spaces');
const spaces = await fetchJson<{ data: SpaceListItem[] }>(`${API_BASE}/api/v1/spaces`, {
  headers: authHeaders,
});
const space = spaces.data[0];
if (!space) throw new Error('No spaces found for this API key.');
console.log(`  space.id=${space.id}${space.name ? ` (${space.name})` : ''}`);

step(2, `POST /api/v1/spaces/${space.id}/buckets (reserve)`);
const reserved = await fetchJson<ReserveResponse>(
  `${API_BASE}/api/v1/spaces/${space.id}/buckets`,
  {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: BUCKET_NAME, scope: 'private' }),
  },
);
console.log(`  bucket_id=${reserved.bucket_id} digest=${reserved.digest}`);

step(3, 'Sign reserve bytes with service key');
const keypair = loadKeypair(HARBOR_SERVICE_PRIVKEY);
const signature = await signReserveBytes(keypair, reserved.bytes);
console.log(`  signature.length=${signature.length}`);

step(4, `POST /api/v1/buckets/${reserved.bucket_id}/finalize`);
const finalized = await fetchJson<FinalizeResponse>(
  `${API_BASE}/api/v1/buckets/${reserved.bucket_id}/finalize`,
  {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ signature }),
  },
);
console.log(`  seal_policy_id=${finalized.seal_policy_id} state=${finalized.state}`);

step(5, 'Encrypt sample.txt with Seal');
const plaintext = await readFile(SAMPLE_PATH);
const sui = makeSuiClient();
const seal = makeSealClient(sui);
const ciphertext = await encryptBytes(seal, finalized.seal_policy_id, plaintext);
console.log(`  plaintext=${plaintext.byteLength}B ciphertext=${ciphertext.byteLength}B`);

step(6, `POST /api/v1/buckets/${reserved.bucket_id}/files (multipart, retry on mirror_missing_grant)`);
const uploadUrl = `${API_BASE}/api/v1/buckets/${reserved.bucket_id}/files`;
let upload: UploadResponse | undefined;
for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
  const form = new FormData();
  form.set('file', new Blob([ciphertext], { type: 'application/octet-stream' }), UPLOAD_NAME);
  form.set('name', UPLOAD_NAME);
  const res = await fetch(uploadUrl, { method: 'POST', headers: authHeaders, body: form });
  if (res.ok) {
    upload = (await res.json()) as UploadResponse;
    console.log(`  uploaded file.id=${upload.data.id} (attempt ${attempt})`);
    break;
  }
  const body = await readBody(res);
  let parsed: ErrorResponse | undefined;
  try {
    parsed = JSON.parse(body) as ErrorResponse;
  } catch {
    /* not json */
  }
  if (res.status === 403 && parsed?.code === 'mirror_missing_grant') {
    console.log(`  attempt ${attempt}: mirror_missing_grant — retrying in ${UPLOAD_RETRY_DELAY_MS}ms`);
    await sleep(UPLOAD_RETRY_DELAY_MS);
    continue;
  }
  throw new Error(`Upload failed (${res.status}): ${body}`);
}
if (!upload) throw new Error(`Upload still 403 mirror_missing_grant after ${UPLOAD_MAX_RETRIES} attempts.`);
const fileId = upload.data.id;

step(7, `Poll /api/v1/buckets/${reserved.bucket_id}/files/${fileId}/status`);
let state: StatusResponse['data']['state'] = 'queued';
for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
  const status = await fetchJson<StatusResponse>(
    `${API_BASE}/api/v1/buckets/${reserved.bucket_id}/files/${fileId}/status`,
    { headers: authHeaders },
  );
  state = status.data.state;
  console.log(`  attempt ${attempt}: state=${state}`);
  if (state === 'completed') break;
  if (state === 'failed') {
    throw new Error(`Upload failed: ${JSON.stringify(status.data.error ?? {})}`);
  }
  await sleep(POLL_DELAY_MS);
}
if (state !== 'completed') {
  throw new Error(`File did not reach 'completed' within ${POLL_MAX_ATTEMPTS} polls.`);
}

step(8, `GET /api/v1/buckets/${reserved.bucket_id}/files/${fileId}/download`);
const dlRes = await fetch(
  `${API_BASE}/api/v1/buckets/${reserved.bucket_id}/files/${fileId}/download`,
  { headers: authHeaders },
);
if (!dlRes.ok) {
  throw new Error(`Download failed (${dlRes.status}): ${await readBody(dlRes)}`);
}
const downloaded = new Uint8Array(await dlRes.arrayBuffer());
console.log(`  downloaded ${downloaded.byteLength}B`);

step(9, 'Decrypt downloaded ciphertext with Seal');
const decrypted = await decryptBytes(seal, sui, keypair, finalized.seal_policy_id, downloaded);
console.log(`  decrypted ${decrypted.byteLength}B`);

step(10, 'Verify decrypted === sample.txt, then delete the file');
const matches =
  plaintext.byteLength === decrypted.byteLength && timingSafeEqual(plaintext, decrypted);
console.log(`  ${matches ? 'MATCH' : 'MISMATCH'}`);
if (!matches) {
  process.exitCode = 1;
}

const delRes = await fetch(
  `${API_BASE}/api/v1/buckets/${reserved.bucket_id}/files/${fileId}`,
  { method: 'DELETE', headers: authHeaders },
);
if (delRes.status !== 204) {
  throw new Error(`Delete expected 204, got ${delRes.status}: ${await readBody(delRes)}`);
}
console.log(`  deleted file.id=${fileId}`);

console.log('\nRound-trip OK.');
