import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3Config } from "../config";

/** A file (object) in a listing. */
export interface FileEntry {
  /** Full object key within the bucket. */
  key: string;
  /** Base name of the object. */
  name: string;
  size: number;
  /** ISO 8601 timestamp. */
  lastModified: string;
}

/** One page of a folder listing. */
export interface ListResult {
  /** Base names of subfolders (common prefixes). */
  folders: string[];
  files: FileEntry[];
  /** Opaque continuation token for the next page, or null. */
  nextCursor: string | null;
}

/** Metadata about an object from a head request. */
export interface HeadResult {
  key: string;
  size: number;
  lastModified: string;
}

/** Options for {@link listObjects}. */
export interface ListOptions {
  /** Continuation token from a previous page. */
  cursor?: string;
  /** Page size; defaults to the S3 protocol limit of 1000. */
  pageSize?: number;
}

/** Default page size for listings, matching the S3 protocol limit. */
const MAX_KEYS = 1000;

/**
 * Build an S3 client configured for OVHcloud Object Storage.
 *
 * Path-style addressing is always used, which OVHcloud requires. Automatic
 * request checksums are disabled (when_required): the SDK otherwise signs
 * presigned PUT URLs with a CRC32 of the empty body, which the storage
 * provider would reject once the browser sends the real payload.
 *
 * @param s3 - S3 endpoint, region and credentials
 * @returns a configured S3 client
 */
export function createS3Client(s3: S3Config): S3Client {
  return new S3Client({
    region: s3.region,
    endpoint: s3.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
  });
}

/**
 * Assert that an object key falls within a user's prefix.
 *
 * @param prefix - the user's normalised prefix
 * @param key - the object key to check
 * @throws {RangeError} when the key is outside the prefix
 */
export function assertKeyInScope(prefix: string, key: string): void {
  if (!key.startsWith(prefix)) {
    throw new RangeError(
      `Key "${key}" is outside the user's prefix "${prefix}"`,
    );
  }
}

/**
 * Return the base name of a key relative to a listing prefix: the first
 * path segment after the prefix, dropping any trailing slash.
 *
 * @param key - full key
 * @param prefix - listing prefix
 * @returns the base name
 */
function baseName(key: string, prefix: string): string {
  return key.slice(prefix.length).split("/")[0] ?? "";
}

/**
 * List folders and files under a folder within a user's prefix.
 *
 * Folders come from S3 common prefixes (delimiter "/"); files are the
 * objects directly under the folder. Pages are capped at 1000 entries.
 *
 * @param client - S3 client
 * @param bucket - bucket name
 * @param userPrefix - the user's normalised prefix
 * @param folder - relative folder within the user's prefix ("" for the root)
 * @param options - pagination options
 * @returns one page of folders and files
 */
export async function listObjects(
  client: S3Client,
  bucket: string,
  userPrefix: string,
  folder: string,
  options?: ListOptions,
): Promise<ListResult> {
  // Normalise the relative folder so the listing prefix always ends with "/".
  const fullPrefix =
    userPrefix + (folder === "" ? "" : folder.replace(/\/+$/, "") + "/");
  const output = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: fullPrefix,
      Delimiter: "/",
      MaxKeys: options?.pageSize ?? MAX_KEYS,
      ContinuationToken: options?.cursor,
    }),
  );

  const folders = (output.CommonPrefixes ?? [])
    .map((commonPrefix) => baseName(commonPrefix.Prefix ?? "", fullPrefix))
    .filter((name) => name !== "");
  const files = (output.Contents ?? [])
    .map((object) => ({
      key: object.Key ?? "",
      name: baseName(object.Key ?? "", fullPrefix),
      size: object.Size ?? 0,
      lastModified: (object.LastModified ?? new Date(0)).toISOString(),
    }))
    .filter((file) => file.name !== "");

  return {
    folders,
    files,
    nextCursor: output.IsTruncated
      ? (output.NextContinuationToken ?? null)
      : null,
  };
}

/**
 * Fetch metadata for an object, or null when it does not exist.
 *
 * @param client - S3 client
 * @param bucket - bucket name
 * @param userPrefix - the user's normalised prefix
 * @param key - full object key
 * @returns object metadata or null
 * @throws {RangeError} when the key is outside the user's prefix
 */
export async function headObject(
  client: S3Client,
  bucket: string,
  userPrefix: string,
  key: string,
): Promise<HeadResult | null> {
  assertKeyInScope(userPrefix, key);
  try {
    const output = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      key,
      size: output.ContentLength ?? 0,
      lastModified: (output.LastModified ?? new Date(0)).toISOString(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "NotFound") return null;
    throw error;
  }
}

/**
 * Permanently delete an object.
 *
 * @param client - S3 client
 * @param bucket - bucket name
 * @param userPrefix - the user's normalised prefix
 * @param key - full object key
 * @throws {RangeError} when the key is outside the user's prefix
 */
export async function deleteObject(
  client: S3Client,
  bucket: string,
  userPrefix: string,
  key: string,
): Promise<void> {
  assertKeyInScope(userPrefix, key);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Generate a short-lived presigned GET URL for downloading an object.
 *
 * @param client - S3 client
 * @param bucket - bucket name
 * @param userPrefix - the user's normalised prefix
 * @param key - full object key
 * @param expiresInSeconds - URL lifetime in seconds
 * @returns a presigned URL
 * @throws {RangeError} when the key is outside the user's prefix
 */
export async function presignedGetUrl(
  client: S3Client,
  bucket: string,
  userPrefix: string,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  assertKeyInScope(userPrefix, key);
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    {
      expiresIn: expiresInSeconds,
    },
  );
}

/**
 * Generate a presigned PUT URL for uploading an object.
 *
 * @param client - S3 client
 * @param bucket - bucket name
 * @param userPrefix - the user's normalised prefix
 * @param key - full object key
 * @param expiresInSeconds - URL lifetime in seconds
 * @returns a presigned URL
 * @throws {RangeError} when the key is outside the user's prefix
 */
export async function presignedPutUrl(
  client: S3Client,
  bucket: string,
  userPrefix: string,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  assertKeyInScope(userPrefix, key);
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key }),
    {
      expiresIn: expiresInSeconds,
    },
  );
}
