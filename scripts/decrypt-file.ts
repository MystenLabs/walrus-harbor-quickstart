import { readFile, writeFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { requireEnv } from './config.js';
import {
  decryptBytes,
  loadKeypair,
  makeSealClient,
  makeSuiClient,
} from './seal-helpers.js';

const [, , ciphertextPath, sealPolicyId, originalPath = 'sample.txt'] = process.argv;
if (!ciphertextPath || !sealPolicyId) {
  throw new Error(
    'Usage: pnpm decrypt-file <ciphertextPath> <sealPolicyId> [originalPath=sample.txt]',
  );
}

const suiClient = makeSuiClient();
const seal = makeSealClient(suiClient);
const keypair = loadKeypair(requireEnv('HARBOR_SERVICE_PRIVKEY'));

const ciphertext = await readFile(ciphertextPath);
const plaintext = await decryptBytes(seal, suiClient, keypair, sealPolicyId, ciphertext);

const outPath = `${ciphertextPath}.dec`;
await writeFile(outPath, plaintext);

const original = await readFile(originalPath);
const matches =
  original.byteLength === plaintext.byteLength && timingSafeEqual(original, plaintext);

console.log(`Decrypted ${ciphertext.byteLength} → ${plaintext.byteLength} bytes → ${outPath}`);
console.log(matches ? `MATCH (vs ${originalPath})` : `MISMATCH (vs ${originalPath})`);
if (!matches) {
  process.exitCode = 1;
}
