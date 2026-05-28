import { fromBase64 } from '@mysten/sui/utils';
import { requireEnv } from './config.js';
import { loadKeypair, signReserveBytes } from './seal-helpers.js';

const [, , base64Bytes] = process.argv;
if (!base64Bytes) {
  throw new Error('Usage: pnpm sign-reserve <base64-reserve-bytes>');
}
if (base64Bytes === 'null' || base64Bytes === 'undefined') {
  throw new Error(
    `sign-reserve received "${base64Bytes}". The reserve response was probably an ` +
      `error body — inspect the raw response before piping its .bytes here.`,
  );
}
try {
  fromBase64(base64Bytes);
} catch (err) {
  throw new Error(`sign-reserve: argument is not valid base64 (${(err as Error).message})`);
}

const keypair = loadKeypair(requireEnv('HARBOR_SERVICE_PRIVKEY'));
const signature = await signReserveBytes(keypair, base64Bytes);
console.log(signature);
