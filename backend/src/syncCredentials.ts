/**
 * rclone sync credential helpers: the prefix-scoped OVH access policy,
 * the generated rclone.conf block, the per-user lock that serialises key
 * creation, and key revocation (shared by the revoke route and admin user
 * deletion).
 */
import type { Database } from "bun:sqlite";
import { deleteSyncCredential } from "./db/repository";
import type { SyncCredential } from "./db/repository";
import { isOvhNotFound } from "./ovh";
import type { OvhClient } from "./ovh";

/**
 * Replaces a revoked key's policy. Deleting a used key, or even its OVH
 * user, does not stop it working for tens of minutes; a deny-all policy
 * stops it within a few minutes.
 */
const DENY_ALL_POLICY = JSON.stringify({
  Statement: [
    { Sid: "DenyAll", Effect: "Deny", Action: ["s3:*"], Resource: ["*"] },
  ],
});

/** Await an OVH step, treating a 404 (already gone) as done. */
async function ignoreNotFound(step: Promise<void>): Promise<void> {
  try {
    await step;
  } catch (error) {
    if (!isOvhNotFound(error)) throw error;
  }
}

/**
 * Revoke a sync key: deny everything on its dedicated OVH user, delete the
 * S3 key, delete the OVH user, then delete the row. An OVH 404 at any step
 * counts as done, so a retry after a partial failure re-runs every step
 * idempotently.
 *
 * @param ovh - OVH API client
 * @param db - database
 * @param credential - the stored key to revoke
 * @throws {Error} on any other OVH failure; the row is then kept
 */
export async function revokeSyncCredential(
  ovh: OvhClient,
  db: Database,
  credential: SyncCredential,
): Promise<void> {
  await ignoreNotFound(
    ovh.setUserPolicy(credential.ovhUserId, DENY_ALL_POLICY),
  );
  await ignoreNotFound(
    ovh.deleteS3Credential(credential.ovhUserId, credential.accessKeyId),
  );
  await ignoreNotFound(ovh.deleteUser(credential.ovhUserId));
  deleteSyncCredential(db, credential.accessKeyId);
}

/**
 * Build the OVH Object Storage policy that confines a user's sync keys to
 * their own prefix: list only under the prefix, read/write/delete objects
 * only under it, and never list buckets. An empty prefix grants the whole
 * bucket.
 *
 * @param bucket - the user's bucket
 * @param prefix - the user's normalised prefix ("" or ending in "/")
 * @returns the policy as a JSON string, as OVH expects it
 * @throws {Error} when the prefix contains "*" or "?", which would widen
 *   the StringLike/ARN wildcard match beyond the user's own space
 */
export function buildSyncPolicy(bucket: string, prefix: string): string {
  if (/[*?]/.test(prefix)) {
    throw new Error(
      `Prefix "${prefix}" contains a wildcard character and cannot be scoped`,
    );
  }
  const listStatement =
    prefix === ""
      ? {
          Sid: "ListOwnPrefix",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [`arn:aws:s3:::${bucket}`],
        }
      : {
          Sid: "ListOwnPrefix",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [`arn:aws:s3:::${bucket}`],
          Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
        };
  return JSON.stringify({
    Statement: [
      listStatement,
      {
        Sid: "OwnObjects",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListMultipartUploadParts",
          "s3:AbortMultipartUpload",
        ],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
      },
      {
        Sid: "DenyListBuckets",
        Effect: "Deny",
        Action: ["s3:ListAllMyBuckets"],
        Resource: ["*"],
      },
    ],
  });
}

/** Input for {@link buildRcloneConfig}. */
export interface RcloneConfigInput {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Normalised prefix ("" or ending in "/"). */
  prefix: string;
}

/**
 * Build the rclone.conf block for a sync key: an S3 remote plus a
 * `jivedrive` alias pointing at the user's space. The alias path ends in
 * "/" so rclone never HEADs or lists the (forbidden) parent.
 *
 * @param input - S3 endpoint, region, key pair, bucket and prefix
 * @returns the config text, ending with a newline
 */
export function buildRcloneConfig(input: RcloneConfigInput): string {
  return [
    "[jivedrive-s3]",
    "type = s3",
    "provider = Other",
    `endpoint = ${input.endpoint}`,
    `region = ${input.region}`,
    `access_key_id = ${input.accessKeyId}`,
    `secret_access_key = ${input.secretAccessKey}`,
    "no_check_bucket = true",
    "",
    "[jivedrive]",
    "type = alias",
    `remote = jivedrive-s3:${input.bucket}${input.prefix === "" ? "" : `/${input.prefix}`}`,
    "",
  ].join("\n");
}

/** An in-process mutex keyed by string. */
export interface KeyedLock {
  /** Run `work` once every earlier `run` for the same key has settled. */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * Create an in-process lock keyed by string (e.g. user id). Valid because
 * JiveDrive runs as a single replica.
 *
 * @returns the lock
 */
export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      // Tails never reject, so `work` runs whatever the previous outcome.
      const result = previous.then(work);
      const tail = result.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
