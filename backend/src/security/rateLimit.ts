/**
 * Hand-rolled token-bucket rate limiting (US3, FR-007/FR-008).
 *
 * No dependency (Constitution II): a token bucket holds up to `burst`
 * tokens, refills at `perMinute/60` tokens per second, and each request
 * consumes one token. A request that finds fewer than one token is refused
 * with 429 + `Retry-After` (in seconds) + a JSON body carrying
 * `code: "rate_limited"`.
 *
 * Buckets are tracked in memory per `(family, identity)` — family is
 * `/auth/*` or `/api/files/*` — so the two API families limit
 * independently (T033). State is in-memory and single-replica (the
 * deployment uses a Recreate strategy), so a restart resets buckets, which
 * is acceptable for advisory hardening (spec edge case "Rate-limit state").
 *
 * Identity (FR-008): the leftmost `X-Forwarded-For` value when
 * `JIVEDRIVE_TRUST_PROXY=true` and the header is present; otherwise the
 * socket remote address via `Bun.serve`'s `server.requestIP`. When no
 * server env is available (e.g. `app.request` in tests) the identity falls
 * back to "local". `X-Forwarded-For` is completely ignored when
 * trust-proxy is off, so clients cannot spoof their way to a fresh bucket.
 *
 * The store is a `Map` pruned lazily on access (entries idle longer than
 * {@link BUCKET_IDLE_MS} are dropped) and bounded by a size cap
 * ({@link MAX_BUCKETS}) that evicts the least-recently-accessed entries
 * (T036).
 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";

/** Idle window after which a tracked bucket is pruned (10 minutes). */
export const BUCKET_IDLE_MS = 10 * 60 * 1000;

/** Maximum number of tracked buckets across all families. */
export const MAX_BUCKETS = 10000;

/** A route family with its own rate limit. */
export type RateLimitFamily = "auth" | "files" | "shareLinks";

/** Per-family rate limit values. */
export interface RateLimitLimits {
  /** Tokens added per minute (refill rate). */
  perMinute: number;
  /** Maximum token count (burst capacity); a bucket starts full. */
  burst: number;
}

/** A single token bucket. */
export interface TokenBucket {
  /** Current token count; may be fractional. */
  tokens: number;
  /** Epoch ms of the last refill computation. */
  lastRefill: number;
  /** Epoch ms of the last access, used for lazy pruning and LRU eviction. */
  lastAccess: number;
}

/** Options for {@link createRateLimitStore}. */
export interface RateLimitStoreOptions {
  /** Maximum tracked buckets; defaults to {@link MAX_BUCKETS}. */
  maxBuckets?: number;
  /** Idle window in ms; defaults to {@link BUCKET_IDLE_MS}. */
  idleMs?: number;
}

/** A bounded in-memory store of token buckets keyed by `family:identity`. */
export interface RateLimitStore {
  /**
   * Fetch the bucket for a key, creating it full when absent. Prunes
   * idle entries and evicts the least-recently-accessed entries when the
   * size cap would be exceeded.
   *
   * @param key - `family:identity` key
   * @param now - current time in epoch ms
   * @param burst - burst capacity of a freshly created bucket
   * @returns the bucket for the key
   */
  get(key: string, now: number, burst: number): TokenBucket;
  /** Number of tracked buckets (tests). */
  size(): number;
}

/** Options for {@link createRateLimitMiddleware}. */
export interface RateLimitMiddlewareOptions {
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Shared store; defaults to a fresh store. server.ts passes one store so
   * both families are tracked in one bounded map.
   */
  store?: RateLimitStore;
}

/**
 * Evaluate a request against a token bucket: refill by elapsed time, then
 * consume one token when available.
 *
 * @param bucket - the bucket to evaluate (mutated in place)
 * @param now - current time in epoch ms
 * @param perMinute - refill rate in tokens per minute
 * @param burst - bucket capacity; refills clamp to this
 * @returns the number of seconds the client must wait before retrying
 *   (at least 1), or null when the request is allowed
 */
export function allowRequest(
  bucket: TokenBucket,
  now: number,
  perMinute: number,
  burst: number,
): number | null {
  const rate = perMinute / 60; // tokens per second
  const elapsed = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.lastRefill = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return null;
  }
  return Math.max(1, Math.ceil((1 - bucket.tokens) / rate));
}

/**
 * Create a bounded token-bucket store with lazy pruning and LRU eviction.
 *
 * @param options - cap and idle-window overrides (tests)
 * @returns the store
 */
export function createRateLimitStore(
  options: RateLimitStoreOptions = {},
): RateLimitStore {
  const maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
  const idleMs = options.idleMs ?? BUCKET_IDLE_MS;
  const buckets = new Map<string, TokenBucket>();

  return {
    get(key, now, burst) {
      // Lazy pruning: drop every entry idle beyond the idle window before
      // any access so stale identities never accumulate. Deleting the
      // current entry during Map iteration is safe.
      for (const [k, bucket] of buckets) {
        if (now - bucket.lastAccess > idleMs) buckets.delete(k);
      }
      let bucket = buckets.get(key);
      if (!bucket) {
        // Enforce the size cap: evict the least-recently-accessed entries
        // until the map fits, then add the new bucket.
        while (buckets.size >= maxBuckets) {
          let lruKey: string | undefined;
          let lruTime = Number.POSITIVE_INFINITY;
          for (const [k, b] of buckets) {
            if (b.lastAccess < lruTime) {
              lruTime = b.lastAccess;
              lruKey = k;
            }
          }
          if (lruKey === undefined) break;
          buckets.delete(lruKey);
        }
        // A fresh bucket starts full: the first request of a burst is
        // never refused.
        bucket = { tokens: burst, lastRefill: now, lastAccess: now };
        buckets.set(key, bucket);
      }
      bucket.lastAccess = now;
      return bucket;
    },
    size() {
      return buckets.size;
    },
  };
}

/**
 * Resolve the client identity for rate limiting (FR-008).
 *
 * @param c - Hono context
 * @param trustProxy - when true, a non-empty `X-Forwarded-For` header
 *   yields its leftmost value; otherwise the header is ignored entirely
 * @returns the identity string: the leftmost XFF value, the socket remote
 *   address, or "local" when no server env is available
 */
export function clientIdentity(
  c: Context<ServerEnv>,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff !== undefined && xff.trim() !== "") {
      const first = xff.split(",")[0]?.trim();
      if (first !== undefined && first !== "") return first;
    }
  }
  try {
    const info = getConnInfo(c);
    const address = info.remote.address;
    if (address) return address;
  } catch {
    // No Bun server env (e.g. app.request without env in tests).
  }
  return "local";
}

/**
 * Create a rate-limiting middleware for one route family.
 *
 * A 429 response never calls `next()`, so the route handler — and any
 * challenge consumption or state mutation it performs — is skipped (spec
 * edge case "429 vs challenge state").
 *
 * @param config - application configuration carrying the per-family limits
 *   and the trust-proxy flag
 * @param family - the route family being limited
 * @param options - clock and store injection (tests)
 * @returns a Hono middleware handler
 */
export function createRateLimitMiddleware(
  config: AppConfig,
  family: RateLimitFamily,
  options: RateLimitMiddlewareOptions = {},
): MiddlewareHandler<ServerEnv> {
  const now = options.now ?? (() => Date.now());
  const store = options.store ?? createRateLimitStore();
  const limits: RateLimitLimits =
    family === "auth"
      ? {
          perMinute: config.rateLimit.authPerMinute,
          burst: config.rateLimit.authBurst,
        }
      : family === "shareLinks"
        ? {
            perMinute: config.rateLimit.shareLinksPerMinute,
            burst: config.rateLimit.shareLinksBurst,
          }
        : {
            perMinute: config.rateLimit.filesPerMinute,
            burst: config.rateLimit.filesBurst,
          };

  return async (c, next) => {
    const identity = clientIdentity(c, config.rateLimit.trustProxy);
    const t = now();
    const bucket = store.get(`${family}:${identity}`, t, limits.burst);
    const retryAfter = allowRequest(bucket, t, limits.perMinute, limits.burst);
    if (retryAfter !== null) {
      return c.json(
        { error: "Too many requests, try again later", code: "rate_limited" },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }
    await next();
  };
}
