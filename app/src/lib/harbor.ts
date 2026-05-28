import { setTimeout as sleep } from 'node:timers/promises';
import { API_BASE } from '../config.js';

export type SpaceListItem = { id: string; name?: string };
export type BucketSummary = {
  id: string;
  name: string;
  visibility: string;
  state: string;
  seal_policy_id: string | null;
};
export type FileSummary = {
  id: string;
  name?: string;
  size?: number;
  created_at?: string;
};
export type ReserveResponse = {
  bucket_id: string;
  bytes: string;
  digest: string;
  state: string;
};
export type FinalizeResponse = {
  bucket_id: string;
  seal_policy_id: string;
  state: string;
};
export type UploadResponse = { data: { id: string } };
export type FileState = 'queued' | 'active' | 'completed' | 'failed';
export type StatusResponse = {
  data: { state: FileState; error?: { code: string; message: string } };
};

export type HarborErrorBody = { code?: string; error?: string; message?: string };

export class HarborError extends Error {
  constructor(
    public status: number,
    public body: string,
    public parsed?: HarborErrorBody,
  ) {
    super(`Harbor ${status}: ${parsed?.code ?? parsed?.error ?? body.slice(0, 200)}`);
    this.name = 'HarborError';
  }
}

export interface HarborClientOptions {
  apiKey: string;
  baseUrl?: string;
  uploadMaxRetries?: number;
  uploadRetryDelayMs?: number;
  pollDelayMs?: number;
  pollMaxAttempts?: number;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function tryParseJson(body: string): HarborErrorBody | undefined {
  try {
    return JSON.parse(body) as HarborErrorBody;
  } catch {
    return undefined;
  }
}

async function expect<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await readBody(res);
    throw new HarborError(res.status, body, tryParseJson(body));
  }
  return (await res.json()) as T;
}

export class HarborClient {
  private readonly baseUrl: string;
  private readonly authHeader: Record<string, string>;
  private readonly jsonHeaders: Record<string, string>;
  private readonly uploadMaxRetries: number;
  private readonly uploadRetryDelayMs: number;
  private readonly pollDelayMs: number;
  private readonly pollMaxAttempts: number;

  constructor(opts: HarborClientOptions) {
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.authHeader = { Authorization: `Bearer ${opts.apiKey}` };
    this.jsonHeaders = { ...this.authHeader, 'Content-Type': 'application/json' };
    this.uploadMaxRetries = opts.uploadMaxRetries ?? 20;
    this.uploadRetryDelayMs = opts.uploadRetryDelayMs ?? 3_000;
    this.pollDelayMs = opts.pollDelayMs ?? 1_500;
    this.pollMaxAttempts = opts.pollMaxAttempts ?? 60;
  }

  async listSpaces(): Promise<SpaceListItem[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/spaces`, { headers: this.authHeader });
    const body = await expect<{ data: SpaceListItem[] }>(res);
    return body.data;
  }

  async listBuckets(spaceId: string): Promise<BucketSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/spaces/${spaceId}/buckets`, {
      headers: this.authHeader,
    });
    const body = await expect<{ buckets: BucketSummary[] }>(res);
    return body.buckets;
  }

  async getBucket(bucketId: string): Promise<BucketSummary> {
    const res = await fetch(`${this.baseUrl}/api/v1/buckets/${bucketId}`, {
      headers: this.authHeader,
    });
    const body = await expect<{ data: BucketSummary }>(res);
    return body.data;
  }

  async reserveBucket(spaceId: string, name: string): Promise<ReserveResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/spaces/${spaceId}/buckets`, {
      method: 'POST',
      headers: this.jsonHeaders,
      body: JSON.stringify({ name, scope: 'private' }),
    });
    return expect<ReserveResponse>(res);
  }

  async finalizeBucket(bucketId: string, signature: string): Promise<FinalizeResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/buckets/${bucketId}/finalize`, {
      method: 'POST',
      headers: this.jsonHeaders,
      body: JSON.stringify({ signature }),
    });
    return expect<FinalizeResponse>(res);
  }

  // Harbor requires `?confirm=true` on bucket delete, and 400s if the bucket
  // is not empty (files still present or storage in use).
  async deleteBucket(bucketId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/buckets/${bucketId}?confirm=true`, {
      method: 'DELETE',
      headers: this.authHeader,
    });
    if (res.status !== 204) {
      const body = await readBody(res);
      throw new HarborError(res.status, body, tryParseJson(body));
    }
  }

  async listFiles(bucketId: string): Promise<FileSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/buckets/${bucketId}/files`, {
      headers: this.authHeader,
    });
    const body = await expect<{ data: FileSummary[] }>(res);
    return body.data;
  }

  // Retries on 403 mirror_missing_grant — Harbor's on-chain ACL grant from finalize
  // takes a few seconds to land in the indexer. Other 4xx/5xx errors propagate.
  async uploadFile(
    bucketId: string,
    fileName: string,
    ciphertext: Uint8Array<ArrayBuffer>,
    onRetry?: (attempt: number, body: string) => void,
  ): Promise<UploadResponse> {
    const url = `${this.baseUrl}/api/v1/buckets/${bucketId}/files`;
    for (let attempt = 1; attempt <= this.uploadMaxRetries; attempt++) {
      const form = new FormData();
      form.set('file', new Blob([ciphertext], { type: 'application/octet-stream' }), fileName);
      form.set('name', fileName);
      const res = await fetch(url, { method: 'POST', headers: this.authHeader, body: form });
      if (res.ok) return (await res.json()) as UploadResponse;
      const body = await readBody(res);
      const parsed = tryParseJson(body);
      if (res.status === 403 && parsed?.code === 'mirror_missing_grant') {
        onRetry?.(attempt, body);
        await sleep(this.uploadRetryDelayMs);
        continue;
      }
      throw new HarborError(res.status, body, parsed);
    }
    throw new Error(
      `Upload still 403 mirror_missing_grant after ${this.uploadMaxRetries} attempts.`,
    );
  }

  async getFileStatus(bucketId: string, fileId: string): Promise<StatusResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/buckets/${bucketId}/files/${fileId}/status`,
      { headers: this.authHeader },
    );
    return expect<StatusResponse>(res);
  }

  async pollUntilCompleted(
    bucketId: string,
    fileId: string,
    onTick?: (attempt: number, state: FileState) => void,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.pollMaxAttempts; attempt++) {
      const status = await this.getFileStatus(bucketId, fileId);
      onTick?.(attempt, status.data.state);
      if (status.data.state === 'completed') return;
      if (status.data.state === 'failed') {
        throw new Error(`Upload failed: ${JSON.stringify(status.data.error ?? {})}`);
      }
      await sleep(this.pollDelayMs);
    }
    throw new Error(`File did not reach 'completed' within ${this.pollMaxAttempts} polls.`);
  }

  async downloadFile(bucketId: string, fileId: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/buckets/${bucketId}/files/${fileId}/download`,
      { headers: this.authHeader },
    );
    if (!res.ok) {
      const body = await readBody(res);
      throw new HarborError(res.status, body, tryParseJson(body));
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteFile(bucketId: string, fileId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/buckets/${bucketId}/files/${fileId}`,
      { method: 'DELETE', headers: this.authHeader },
    );
    if (res.status !== 204) {
      const body = await readBody(res);
      throw new HarborError(res.status, body, tryParseJson(body));
    }
  }
}
