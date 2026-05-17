import { randomBytes } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/**
 * Object-storage wrapper (eng-review pass-1 Issue 2D + pass-2 D9 + T8-CSV.2c.3).
 *
 * Uses @aws-sdk/client-s3, which talks to both AWS S3 (prod) and MinIO (dev,
 * already in docker-compose) via path-style addressing. Reads S3_ENDPOINT,
 * S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY from env.
 *
 * Today's primary consumer is the CSV import controller, which spills files
 * larger than INLINE_UPLOAD_THRESHOLD_BYTES here instead of inlining bytes
 * in the pg-boss payload. Future consumers (ContactSource.rawPayload spill,
 * audit-log tool-result spill) reuse the same service.
 *
 * Construction is cheap: the S3 client is lazily-connecting, so the app
 * boots fine without MinIO running. Only put / get / delete actually hit
 * the wire. The service throws if env vars are missing only on first use,
 * not at startup.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private client?: S3Client;
  private bucket = '';
  private bucketReadyPromise?: Promise<void>;

  onModuleInit(): void {
    this.bucket = process.env.S3_BUCKET ?? 'getbeyond-blobs';
    const endpoint = process.env.S3_ENDPOINT;
    const region = process.env.S3_REGION ?? 'us-east-1';
    const accessKeyId = process.env.S3_ACCESS_KEY ?? '';
    const secretAccessKey = process.env.S3_SECRET_KEY ?? '';

    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      // MinIO requires path-style addressing. AWS supports both; path-style
      // is being deprecated by AWS but still works. We can flip this per-env
      // when we move to real AWS S3 in production.
      forcePathStyle: true,
      // AWS SDK v3.700+ defaults to adding SHA256 checksums on every request,
      // which the MinIO version in docker-compose doesn't parse correctly
      // (the response decoder throws inside deserializeResponse). Reverting
      // to "only when required" matches the previous default and works
      // against both MinIO and real AWS S3.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  onModuleDestroy(): void {
    this.client?.destroy();
    this.client = undefined;
    this.bucketReadyPromise = undefined;
  }

  /**
   * Lazily ensure the bucket exists. Cached as a promise so concurrent
   * callers wait on the same operation. Idempotent: HeadBucket short-circuits
   * if already present; CreateBucket swallows already-exists / already-owned.
   *
   * Useful for dev / test environments where docker-compose's minio-init
   * may not have run. In production the bucket is created out-of-band by infra.
   */
  private ensureBucket(): Promise<void> {
    if (this.bucketReadyPromise) return this.bucketReadyPromise;
    this.bucketReadyPromise = this.bootstrapBucket().catch((err) => {
      // Reset so a transient failure doesn't permanently poison the cache.
      this.bucketReadyPromise = undefined;
      throw err;
    });
    return this.bucketReadyPromise;
  }

  private async bootstrapBucket(): Promise<void> {
    const client = this.requireClient();
    try {
      await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return; // already exists, nothing to do
    } catch (err) {
      // 404 → bucket missing; fall through to create. Anything else (auth,
      // network) propagates so the caller sees a real failure.
      if (
        !(err instanceof S3ServiceException) ||
        err.$metadata.httpStatusCode !== 404
      ) {
        throw err;
      }
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`created bucket "${this.bucket}"`);
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (
        name === 'BucketAlreadyExists' ||
        name === 'BucketAlreadyOwnedByYou'
      ) {
        return; // raced with a concurrent create — that's fine
      }
      throw err;
    }
  }

  /**
   * Upload bytes to storage. Generates a random key under `prefix` and
   * returns it for later retrieval. The caller is responsible for
   * persisting the key wherever it's needed (job payload, DB column).
   */
  async put(
    body: Buffer,
    opts: { prefix?: string; contentType?: string } = {},
  ): Promise<string> {
    await this.ensureBucket();
    const client = this.requireClient();
    const prefix = (opts.prefix ?? 'blob').replace(/^\/+|\/+$/g, '');
    const key = `${prefix}/${randomBytes(16).toString('hex')}`;
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
      }),
    );
    return key;
  }

  /**
   * Fetch bytes by key. Throws on miss.
   */
  async get(key: string): Promise<Buffer> {
    const client = this.requireClient();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) {
      throw new Error(`S3 object ${key} returned no body`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Best-effort delete. Logs but does not throw on failure — orphan
   * objects from delete failures are caught by a periodic sweep.
   */
  async delete(key: string): Promise<void> {
    try {
      const client = this.requireClient();
      await client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(
        `failed to delete S3 object ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private requireClient(): S3Client {
    if (!this.client) {
      throw new Error(
        'StorageService not initialized — onModuleInit has not run (or the app is shutting down)',
      );
    }
    return this.client;
  }
}
