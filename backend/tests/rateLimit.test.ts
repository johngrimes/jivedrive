/**
 * Unit tests for the hand-rolled token-bucket rate limiter (US3).
 *
 * Covers the bucket semantics (T032: burst, refill, per-minute rate), the
 * family separation (T033), client identity extraction with and without a
 * trusted proxy (T034), and the store's lazy pruning and size cap (T036).
 * The middleware under test is `src/security/rateLimit.ts`; clocks are
 * injected so refill behaviour is deterministic.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { ServerEnv } from "../src/server";
import type { AppConfig } from "../src/config";
import {
  allowRequest,
  BUCKET_IDLE_MS,
  clientIdentity,
  createRateLimitMiddleware,
  createRateLimitStore,
  MAX_BUCKETS,
} from "../src/security/rateLimit";
import type { TokenBucket } from "../src/security/rateLimit";

/** A config whose rate limits are the production defaults. */
const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir: "migrations",
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  searchScanIntervalSeconds: 3600,
  searchIndexMaxBytes: 10485760,
  rateLimit: {
    authPerMinute: 20,
    authBurst: 10,
    filesPerMinute: 300,
    filesBurst: 100,
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
    trustProxy: false,
  },
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
  },
  bootstrapAdmin: {
    username: null,
    bucket: null,
    prefix: "",
    isAdmin: true,
    enrollmentToken: null,
  },
  webauthn: { rpId: "localhost", origin: "http://localhost:5173" },
  ovh: null,
};

/** A fake Bun.serve server env whose requestIP is deterministic. */
const fakeServer = {
  requestIP: () => ({ address: "9.9.9.9", family: "IPv4", port: 1 }),
};

describe("token bucket (T032)", () => {
  it("allows exactly capacity requests, then denies with the seconds to wait", () => {
    const bucket: TokenBucket = { tokens: 10, lastRefill: 0, lastAccess: 0 };
    for (let i = 0; i < 10; i++) {
      expect(allowRequest(bucket, 0, 20, 10)).toBeNull();
    }
    // Fully exhausted at 20/min: (1 - 0) / (20/60) = 3s, min 1.
    expect(allowRequest(bucket, 0, 20, 10)).toBe(3);
  });

  it("refills tokens over time at the per-minute rate", () => {
    const bucket: TokenBucket = { tokens: 0, lastRefill: 0, lastAccess: 0 };
    // 20/min refills exactly 1 token per 3 seconds.
    expect(allowRequest(bucket, 3_000, 20, 10)).toBeNull();
    expect(allowRequest(bucket, 3_000, 20, 10)).toBe(3);

    // 60/min refills 1 token per second.
    const fast: TokenBucket = { tokens: 0, lastRefill: 0, lastAccess: 0 };
    expect(allowRequest(fast, 1_000, 60, 10)).toBeNull();
    expect(allowRequest(fast, 1_000, 60, 10)).toBe(1);
  });

  it("never refills beyond the burst capacity", () => {
    const bucket: TokenBucket = { tokens: 10, lastRefill: 0, lastAccess: 0 };
    // An hour of refill clamps at the 10-token burst, then consumes one.
    expect(allowRequest(bucket, 3_600_000, 20, 10)).toBeNull();
    expect(bucket.tokens).toBe(9);
  });

  it("lets a burst of capacity requests through the middleware, then 429s", async () => {
    let clock = 0;
    const app = new Hono<ServerEnv>();
    app.use(
      "/auth/*",
      createRateLimitMiddleware(config, "auth", { now: () => clock }),
    );
    app.post("/auth/ping", (c) => c.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/auth/ping", { method: "POST" });
      expect(res.status).toBe(200);
    }

    const denied = await app.request("/auth/ping", { method: "POST" });
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({
      error: "Too many requests, try again later",
      code: "rate_limited",
    });
    expect(denied.headers.get("retry-after")).toBe("3");

    // After 3s the bucket has refilled one token: the next request passes.
    clock += 3_000;
    const recovered = await app.request("/auth/ping", { method: "POST" });
    expect(recovered.status).toBe(200);
  });
});

describe("family separation (T033)", () => {
  it("limits /auth/* and /api/files/* independently for the same identity", async () => {
    const clock = 0;
    const store = createRateLimitStore();
    const app = new Hono<ServerEnv>();
    // One shared store, keyed by family + identity, exactly as server.ts
    // wires it (T039).
    app.use(
      "/auth/*",
      createRateLimitMiddleware(config, "auth", {
        now: () => clock,
        store,
      }),
    );
    app.use(
      "/api/files/*",
      createRateLimitMiddleware(config, "files", {
        now: () => clock,
        store,
      }),
    );
    app.post("/auth/ping", (c) => c.json({ ok: true }));
    app.get("/api/files/ping", (c) => c.json({ ok: true }));

    // Exhaust the auth family (burst 10) from the same identity.
    for (let i = 0; i < 10; i++) {
      expect((await app.request("/auth/ping", { method: "POST" })).status).toBe(
        200,
      );
    }
    expect((await app.request("/auth/ping", { method: "POST" })).status).toBe(
      429,
    );

    // The files family is untouched: it keeps serving, and the store
    // carries exactly one bucket per family.
    expect((await app.request("/api/files/ping")).status).toBe(200);
    expect((await app.request("/api/files/ping")).status).toBe(200);
    expect(store.size()).toBe(2);
  });
});

describe("share-links family (T006)", () => {
  it("limits /s/* per identity and 429s with a Retry-After", async () => {
    const clock = 0;
    const app = new Hono<ServerEnv>();
    app.use(
      "/s/*",
      createRateLimitMiddleware(config, "shareLinks", { now: () => clock }),
    );
    app.get("/s/ping", (c) => c.json({ ok: true }));

    // The shareLinks burst (30) passes, then the endpoint is limited.
    for (let i = 0; i < 30; i++) {
      expect((await app.request("/s/ping")).status).toBe(200);
    }
    const denied = await app.request("/s/ping");
    expect(denied.status).toBe(429);
    // 60/min refills one token per second.
    expect(denied.headers.get("retry-after")).toBe("1");
  });

  it("limits /s/* without touching the auth or files buckets", async () => {
    const clock = 0;
    const store = createRateLimitStore();
    const app = new Hono<ServerEnv>();
    // One shared store, keyed by family + identity, exactly as server.ts
    // wires it.
    app.use(
      "/s/*",
      createRateLimitMiddleware(config, "shareLinks", {
        now: () => clock,
        store,
      }),
    );
    app.use(
      "/auth/*",
      createRateLimitMiddleware(config, "auth", { now: () => clock, store }),
    );
    app.use(
      "/api/files/*",
      createRateLimitMiddleware(config, "files", { now: () => clock, store }),
    );
    app.get("/s/ping", (c) => c.json({ ok: true }));
    app.post("/auth/ping", (c) => c.json({ ok: true }));
    app.get("/api/files/ping", (c) => c.json({ ok: true }));

    // Exhaust the share-links family: anonymous link traffic must not
    // consume the authenticated families' budgets (D6).
    for (let i = 0; i < 30; i++) {
      expect((await app.request("/s/ping")).status).toBe(200);
    }
    expect((await app.request("/s/ping")).status).toBe(429);
    expect((await app.request("/auth/ping", { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request("/api/files/ping")).status).toBe(200);
    expect(store.size()).toBe(3);
  });
});

describe("client identity (T034)", () => {
  /** A tiny app that echoes {@link clientIdentity} for the given mode. */
  function identityApp(trustProxy: boolean): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.get("/identity", (c) =>
      c.json({ identity: clientIdentity(c, trustProxy) }),
    );
    return app;
  }

  it("uses the leftmost X-Forwarded-For value when trustProxy is on", async () => {
    const app = identityApp(true);
    const res = await app.request("/identity", {
      headers: { "X-Forwarded-For": "1.2.3.4, 5.6.7.8" },
    });
    const body = (await res.json()) as { identity: string };
    expect(body.identity).toBe("1.2.3.4");
  });

  it("ignores X-Forwarded-For and uses the socket address when trustProxy is off", async () => {
    const app = identityApp(false);
    const res = await app.request(
      "/identity",
      { headers: { "X-Forwarded-For": "1.2.3.4, 5.6.7.8" } },
      { server: fakeServer },
    );
    const body = (await res.json()) as { identity: string };
    expect(body.identity).toBe("9.9.9.9");
  });

  it("falls back to the socket address when trustProxy is on but no XFF is present", async () => {
    const app = identityApp(true);
    const res = await app.request("/identity", {}, { server: fakeServer });
    const body = (await res.json()) as { identity: string };
    expect(body.identity).toBe("9.9.9.9");
  });

  it("falls back to local when no server env is available", async () => {
    const app = identityApp(false);
    const res = await app.request("/identity");
    const body = (await res.json()) as { identity: string };
    expect(body.identity).toBe("local");
  });

  it("gives spoofed X-Forwarded-For headers no power when trustProxy is off", async () => {
    const clock = 0;
    const app = new Hono<ServerEnv>();
    app.use(
      "/auth/*",
      createRateLimitMiddleware(config, "auth", { now: () => clock }),
    );
    app.post("/auth/ping", (c) => c.json({ ok: true }));

    // Every request spoofs a different XFF value, yet all share the socket
    // identity's bucket: the 11th is 429 even though each XFF is unique.
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        "/auth/ping",
        {
          method: "POST",
          headers: { "X-Forwarded-For": `10.0.0.${i}, 10.0.0.254` },
        },
        { server: fakeServer },
      );
      expect(res.status).toBe(200);
    }
    const denied = await app.request(
      "/auth/ping",
      {
        method: "POST",
        headers: { "X-Forwarded-For": "10.0.0.99, 10.0.0.254" },
      },
      { server: fakeServer },
    );
    expect(denied.status).toBe(429);
  });
});

describe("store pruning and size cap (T036)", () => {
  it("documents the defaults: 10-minute idle window, 10000-bucket cap", () => {
    expect(BUCKET_IDLE_MS).toBe(10 * 60 * 1000);
    expect(MAX_BUCKETS).toBe(10000);
  });

  it("prunes entries idle beyond the idle window on access", () => {
    const store = createRateLimitStore({ idleMs: 10 });
    store.get("auth:1", 0, 10);
    store.get("auth:2", 0, 10);
    expect(store.size()).toBe(2);

    // Accessing a new key well past the idle window drops the stale ones.
    store.get("auth:3", 100, 10);
    expect(store.size()).toBe(1);

    // auth:1 was pruned: re-reading it creates a fresh bucket.
    const fresh = store.get("auth:1", 101, 10);
    expect(fresh.lastRefill).toBe(101);
    expect(store.size()).toBe(2);
  });

  it("evicts least-recently-accessed entries when over the size cap", () => {
    const store = createRateLimitStore({ maxBuckets: 3 });
    let clock = 0;
    store.get("auth:1", clock, 10);
    clock += 1;
    store.get("auth:2", clock, 10);
    clock += 1;
    store.get("auth:3", clock, 10);
    clock += 1;
    store.get("auth:1", clock, 10); // refresh auth:1 so auth:2 is the LRU
    clock += 1;
    store.get("auth:4", clock, 10); // over the cap: evicts auth:2

    expect(store.size()).toBe(3);
    // auth:2 was evicted: re-reading it yields a brand-new bucket.
    expect(store.get("auth:2", clock, 10).lastRefill).toBe(clock);
    expect(store.size()).toBe(3);
  });

  it("keeps the store bounded when flooded with distinct identities", () => {
    const store = createRateLimitStore({ maxBuckets: 16 });
    for (let i = 0; i < 200; i++) {
      store.get(`auth:ip-${i}`, i, 10);
    }
    expect(store.size()).toBeLessThanOrEqual(16);
  });
});
