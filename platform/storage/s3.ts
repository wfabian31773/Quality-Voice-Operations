import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ObjectNotFoundError, StorageNotConfiguredError } from './errors';
import {
  isEntityObjectPath,
  joinObjectPath,
  parseAbsoluteObjectPath,
  stripLeadingSlashes,
} from './paths';
import type {
  PutObjectOptions,
  SignedUploadUrl,
  StorageAdapter,
  StoredObjectMetadata,
} from './types';

export const S3_REQUIRED_ENV = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export function isS3StorageConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return S3_REQUIRED_ENV.every((name) => !!env[name]?.trim());
}

export function readS3StorageConfig(env: Record<string, string | undefined> = process.env): S3StorageConfig {
  const bucket = env.S3_BUCKET?.trim() ?? '';
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? '';
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new StorageNotConfiguredError(
      'S3 object storage requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY',
    );
  }
  const prefix = stripLeadingSlashes(env.S3_PREFIX?.trim() ?? '').replace(/\/+$/, '');
  return {
    bucket,
    region: env.S3_REGION?.trim() || 'us-east-1',
    endpoint: env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    accessKeyId,
    secretAccessKey,
    prefix,
  };
}

function isS3NotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string } | null;
  const status = e?.$metadata?.httpStatusCode;
  const name = e?.name ?? e?.Code;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey' || name === 'NotFoundError';
}

export class S3CompatibleStorage implements StorageAdapter {
  readonly provider = 's3' as const;

  constructor(
    private readonly client: S3Client,
    private readonly config: S3StorageConfig,
    private readonly presignClient: S3Client = client,
  ) {}

  private withPrefix(relativeKey: string): string {
    const clean = stripLeadingSlashes(relativeKey);
    return this.config.prefix ? `${this.config.prefix}/${clean}` : clean;
  }

  private toObjectKey(key: string): string {
    if (isEntityObjectPath(key)) {
      return this.withPrefix(key.slice('/objects/'.length));
    }
    if (key.startsWith('/')) {
      const { bucketName, objectName } = parseAbsoluteObjectPath(key);
      if (bucketName === this.config.bucket) return objectName;
      return this.withPrefix(`${bucketName}/${objectName}`);
    }
    return this.withPrefix(key);
  }

  private withoutPrefix(objectKey: string): string {
    const { prefix } = this.config;
    return prefix && objectKey.startsWith(`${prefix}/`) ? objectKey.slice(prefix.length + 1) : objectKey;
  }

  private persistablePath(objectKey: string): string {
    // `/objects/...` always reads back as an entity path, which gets the prefix
    // added, so a bucket named "objects" has to persist the unprefixed key.
    if (this.config.bucket === 'objects') return `/objects/${this.withoutPrefix(objectKey)}`;
    return joinObjectPath(this.config.bucket, objectKey);
  }

  async put(key: string, body: Buffer | string, options?: PutObjectOptions): Promise<string> {
    const objectKey = this.toObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: typeof body === 'string' ? Buffer.from(body) : body,
        ContentType: options?.contentType,
        CacheControl: options?.cacheControl,
      }),
    );
    return this.persistablePath(objectKey);
  }

  async get(key: string): Promise<Buffer> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.toObjectKey(key) }),
      );
      if (!out.Body) throw new ObjectNotFoundError();
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw err;
      if (isS3NotFound(err)) throw new ObjectNotFoundError();
      throw err;
    }
  }

  async getMetadata(key: string): Promise<StoredObjectMetadata> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.toObjectKey(key) }),
      );
      return {
        contentType: out.ContentType || 'application/octet-stream',
        size: out.ContentLength,
      };
    } catch (err) {
      if (isS3NotFound(err)) throw new ObjectNotFoundError();
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.toObjectKey(key) }),
      );
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const present = await this.exists(key);
    if (!present) return false;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.toObjectKey(key) }),
    );
    return true;
  }

  async createReadStream(key: string): Promise<Readable> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.toObjectKey(key) }),
      );
      const body = out.Body;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        throw new ObjectNotFoundError();
      }
      return body as Readable;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw err;
      if (isS3NotFound(err)) throw new ObjectNotFoundError();
      throw err;
    }
  }

  async getSignedUploadUrl(key: string, ttlSec: number): Promise<SignedUploadUrl> {
    const objectKey = this.toObjectKey(key);
    const url = await getSignedUrl(
      this.presignClient,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      { expiresIn: ttlSec },
    );
    return {
      url,
      objectPath: `/objects/${this.withoutPrefix(objectKey)}`,
    };
  }

  normalizeObjectPath(rawPath: string): string {
    if (!/^https?:\/\//i.test(rawPath)) return rawPath;
    let url: URL;
    try {
      url = new URL(rawPath);
    } catch {
      return rawPath;
    }
    const pathname = decodeURIComponent(url.pathname);
    const endpoint = this.config.endpoint ? new URL(this.config.endpoint) : undefined;
    const endpointPath = endpoint ? endpoint.pathname.replace(/\/+$/, '') : '';
    let remainder = pathname;
    if (endpointPath && remainder.startsWith(endpointPath)) {
      remainder = remainder.slice(endpointPath.length);
    }
    remainder = remainder.replace(/^\/+/, '');
    // On a virtual-hosted URL the bucket is in the host and the whole path is the
    // key, so a leading segment that matches the bucket name belongs to the key.
    // The SDK can still emit path-style with forcePathStyle off (IP endpoints,
    // non-DNS bucket names, dotted buckets over https), so check the host rather
    // than only the flag. Path-style stays on the endpoint's own host, even when
    // that host happens to start with the bucket name.
    const isVirtualHosted =
      !this.config.forcePathStyle &&
      url.hostname.startsWith(`${this.config.bucket}.`) &&
      url.hostname !== endpoint?.hostname &&
      !(this.config.bucket.includes('.') && url.protocol === 'https:');
    const bucketPrefix = `${this.config.bucket}/`;
    if (!isVirtualHosted && remainder.startsWith(bucketPrefix)) {
      remainder = remainder.slice(bucketPrefix.length);
    }
    if (this.config.prefix && remainder.startsWith(`${this.config.prefix}/`)) {
      remainder = remainder.slice(this.config.prefix.length + 1);
    }
    if (!remainder) return rawPath;
    return `/objects/${remainder}`;
  }
}

export function createS3StorageAdapter(
  env: Record<string, string | undefined> = process.env,
  client?: S3Client,
): S3CompatibleStorage {
  const config = readS3StorageConfig(env);
  if (client) return new S3CompatibleStorage(client, config);
  const clientConfig = {
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  // The SDK's default checksum would sign the empty body's CRC32 into the URL,
  // and S3 would then reject the real file the client PUTs to it.
  const presignClient = new S3Client({ ...clientConfig, requestChecksumCalculation: 'WHEN_REQUIRED' });
  return new S3CompatibleStorage(new S3Client(clientConfig), config, presignClient);
}
