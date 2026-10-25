/**
 * Minimal OVHcloud v1 API client for rclone sync credentials: signed
 * requests that manage one Public Cloud Object Storage user per JiveDrive
 * user, its access policy and its S3 keys.
 */
import { createHash } from "node:crypto";
import type { OvhConfig } from "./config";

/** The subset of `fetch` the client needs; injectable for tests. */
export type OvhFetch = (url: string, init: RequestInit) => Promise<Response>;

/** An error returned by the OVH API, carrying its HTTP status. */
export type OvhApiError = Error & { status: number };

/** An S3 key minted for an OVH user. */
export interface OvhS3Credential {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The OVH operations rclone sync uses. */
export interface OvhClient {
  /** Create an Object Storage operator user; returns its id. */
  createUser(description: string): Promise<{ id: string }>;
  /** Poll until the user is "ok"; rejects on timeout. */
  waitForUserReady(userId: string): Promise<void>;
  /** Replace the user's access policy with the given policy JSON. */
  setUserPolicy(userId: string, policy: string): Promise<void>;
  /** Mint a new S3 key for the user. */
  createS3Credential(userId: string): Promise<OvhS3Credential>;
  /** Revoke one of the user's S3 keys. */
  deleteS3Credential(userId: string, accessKeyId: string): Promise<void>;
  /** Delete the user (and with it every key). */
  deleteUser(userId: string): Promise<void>;
}

/** Injection seams for {@link createOvhClient}. */
export interface OvhClientOptions {
  /** Defaults to the global fetch. */
  fetch?: OvhFetch;
  /** Clock in milliseconds; defaults to Date.now. */
  now?: () => number;
  /** Delay between readiness polls; defaults to 1000 ms. */
  pollIntervalMs?: number;
  /** Give up waiting for a user to be ready after this; defaults to 60 s. */
  pollTimeoutMs?: number;
}

/** Input for {@link signOvhRequest}. */
export interface OvhSignatureInput {
  applicationSecret: string;
  consumerKey: string;
  method: string;
  /** Full request URL including the API base. */
  url: string;
  /** The exact body sent, or "" when there is none. */
  body: string;
  /** Unix time in seconds, as sent in X-Ovh-Timestamp. */
  timestamp: number;
}

/**
 * Compute the X-Ovh-Signature header value:
 * `"$1$" + sha1hex(secret+consumer+method+url+body+timestamp)` joined by "+".
 *
 * @param input - request fields and credentials
 * @returns the signature header value
 */
export function signOvhRequest(input: OvhSignatureInput): string {
  const payload = [
    input.applicationSecret,
    input.consumerKey,
    input.method,
    input.url,
    input.body,
    String(input.timestamp),
  ].join("+");
  return "$1$" + createHash("sha1").update(payload).digest("hex");
}

/**
 * Whether an error is an OVH API 404 (the resource is already gone).
 *
 * @param error - any thrown value
 * @returns true for an {@link OvhApiError} with status 404
 */
export function isOvhNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

/**
 * Read a string field from a parsed JSON object, or throw.
 *
 * @param data - parsed JSON value
 * @param field - field name
 * @returns the field as a string (numbers are converted)
 * @throws {Error} when the field is missing
 */
function readField(data: unknown, field: string): string {
  if (typeof data === "object" && data !== null) {
    const value: unknown = Reflect.get(data, field);
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  throw new Error(`Unexpected OVH API response: missing "${field}"`);
}

/**
 * Create an OVH API client bound to one project.
 *
 * @param config - OVH API credentials, endpoint and project
 * @param options - injectable fetch, clock and polling bounds
 * @returns the client operations
 */
export function createOvhClient(
  config: OvhConfig,
  options: OvhClientOptions = {},
): OvhClient {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
  const usersPath = `/cloud/project/${encodeURIComponent(config.projectId)}/user`;

  const request = async (
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<unknown> => {
    const url = config.endpoint + path;
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = Math.floor(now() / 1000);
    const headers: Record<string, string> = {
      "X-Ovh-Application": config.applicationKey,
      "X-Ovh-Consumer": config.consumerKey,
      "X-Ovh-Timestamp": String(timestamp),
      "X-Ovh-Signature": signOvhRequest({
        applicationSecret: config.applicationSecret,
        consumerKey: config.consumerKey,
        method,
        url,
        body,
        timestamp,
      }),
    };
    if (body !== "") headers["Content-Type"] = "application/json";
    const res = await fetchFn(url, {
      method,
      headers,
      body: body === "" ? undefined : body,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || res.statusText;
      try {
        message = readField(JSON.parse(text), "message");
      } catch {
        // Not an OVH JSON error body: keep the raw text.
      }
      const error: OvhApiError = Object.assign(
        new Error(
          `OVH API ${method} ${path} failed (${res.status}): ${message}`,
        ),
        { status: res.status },
      );
      throw error;
    }
    return text === "" ? null : (JSON.parse(text) as unknown);
  };

  const userPath = (userId: string) =>
    `${usersPath}/${encodeURIComponent(userId)}`;

  return {
    async createUser(description) {
      const data = await request("POST", usersPath, {
        description,
        role: "objectstore_operator",
      });
      return { id: readField(data, "id") };
    },
    async waitForUserReady(userId) {
      const deadline = now() + pollTimeoutMs;
      for (;;) {
        const status = readField(
          await request("GET", userPath(userId)),
          "status",
        );
        if (status === "ok") return;
        if (now() >= deadline) {
          throw new Error(
            `OVH user ${userId} was not ready after ${pollTimeoutMs} ms (status "${status}")`,
          );
        }
        await Bun.sleep(pollIntervalMs);
      }
    },
    async setUserPolicy(userId, policy) {
      await request("POST", `${userPath(userId)}/policy`, { policy });
    },
    async createS3Credential(userId) {
      const data = await request("POST", `${userPath(userId)}/s3Credentials`);
      return {
        accessKeyId: readField(data, "access"),
        secretAccessKey: readField(data, "secret"),
      };
    },
    async deleteS3Credential(userId, accessKeyId) {
      await request(
        "DELETE",
        `${userPath(userId)}/s3Credentials/${encodeURIComponent(accessKeyId)}`,
      );
    },
    async deleteUser(userId) {
      await request("DELETE", userPath(userId));
    },
  };
}
