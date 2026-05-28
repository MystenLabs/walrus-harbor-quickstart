import { bcs } from '@mysten/sui/bcs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, fromHex } from '@mysten/sui/utils';
import { EncryptedObject, SealClient, SessionKey } from '@mysten/seal';

import {
  FULLNODE_URL,
  LATEST_PACKAGE_ID,
  ORIGINAL_PACKAGE_ID,
  SEAL_KEY_SERVER_OBJECT_IDS,
  SEAL_THRESHOLD,
  SUI_NETWORK,
} from '../config.js';

// On-chain `seal_approve` expects `(vector<u8> id, &BucketGroup)` where `id` deserializes
// as this struct via BCS. Keep field order in sync with Harbor's Move definition.
const SealIdentity = bcs.struct('SealIdentity', {
  policyObjectId: bcs.Address,
  nonce: bcs.fixedArray(32, bcs.u8()),
});

export function loadKeypair(suiPrivkey: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(suiPrivkey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export function makeSuiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: SUI_NETWORK, baseUrl: FULLNODE_URL });
}

export function makeSealClient(suiClient: SuiGrpcClient): SealClient {
  return new SealClient({
    suiClient,
    serverConfigs: SEAL_KEY_SERVER_OBJECT_IDS.map((objectId) => ({ objectId, weight: 1 })),
    verifyKeyServers: false,
  });
}

export async function signReserveBytes(
  keypair: Ed25519Keypair,
  base64Bytes: string,
): Promise<string> {
  const { signature } = await keypair.signTransaction(fromBase64(base64Bytes));
  return signature;
}

export function buildIdentity(sealPolicyId: string): {
  id: string;
  nonce: number[];
} {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const id = SealIdentity.serialize({ policyObjectId: sealPolicyId, nonce }).toHex();
  return { id, nonce };
}

export async function encryptBytes(
  seal: SealClient,
  sealPolicyId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const { id } = buildIdentity(sealPolicyId);
  const { encryptedObject } = await seal.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: ORIGINAL_PACKAGE_ID,
    id,
    data: plaintext,
  });
  return encryptedObject;
}

export function buildSealApproveTxBytes(
  suiClient: SuiGrpcClient,
  sealPolicyId: string,
  idBytes: Uint8Array,
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${LATEST_PACKAGE_ID}::bucket_policy::seal_approve`,
    arguments: [tx.pure.vector('u8', Array.from(idBytes)), tx.object(sealPolicyId)],
  });
  return tx.build({ client: suiClient, onlyTransactionKind: true });
}

export async function createSessionKey(
  suiClient: SuiGrpcClient,
  keypair: Ed25519Keypair,
  ttlMin = 10,
): Promise<SessionKey> {
  return SessionKey.create({
    address: keypair.toSuiAddress(),
    packageId: ORIGINAL_PACKAGE_ID,
    ttlMin,
    suiClient,
    signer: keypair,
  });
}

export async function decryptBytes(
  seal: SealClient,
  suiClient: SuiGrpcClient,
  keypair: Ed25519Keypair,
  sealPolicyId: string,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = EncryptedObject.parse(ciphertext);
  const idBytes = fromHex(parsed.id.startsWith('0x') ? parsed.id : '0x' + parsed.id);
  const txBytes = await buildSealApproveTxBytes(suiClient, sealPolicyId, idBytes);
  const sessionKey = await createSessionKey(suiClient, keypair);
  const plaintext = await seal.decrypt({ data: ciphertext, sessionKey, txBytes });
  // Rewrap so the result is backed by a fresh ArrayBuffer (not SharedArrayBuffer),
  // which is what `Blob`, `c.body(...)`, and Node response writers expect.
  return new Uint8Array(plaintext);
}
