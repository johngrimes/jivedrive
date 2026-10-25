import type { OvhFetch } from "../src/ovh";

/**
 * An in-memory fake of the OVHcloud v1 API endpoints JiveDrive uses for
 * rclone sync credentials, exposed as an injectable `fetch`. It records
 * every call so tests can assert exactly which OVH requests happened.
 */

/** One request the fake received. */
export interface FakeOvhCall {
  method: string;
  /** Path relative to the API base URL, e.g. "/cloud/project/pid/user". */
  path: string;
  /** Raw request body ("" when none). */
  body: string;
}

/** An OVH Object Storage user held by the fake. */
export interface FakeOvhUser {
  id: number;
  description: string;
  status: "creating" | "ok";
  /** The policy JSON string last set on the user, or null. */
  policy: string | null;
}

/** A failure the fake injects for matching requests. */
export interface FakeOvhFailure {
  method: string;
  /** Matched against the relative request path. */
  path: RegExp;
  status: number;
  /** Fail only this many times; unlimited when omitted. */
  times?: number;
}

/** The fake's state, controls and fetch function. */
export interface FakeOvh {
  fetch: OvhFetch;
  calls: FakeOvhCall[];
  users: Map<number, FakeOvhUser>;
  /** Issued S3 keys by access key id. */
  keys: Map<string, { userId: number; secret: string }>;
  failures: FakeOvhFailure[];
}

/** The base URL the fake serves under. */
export const FAKE_OVH_ENDPOINT = "https://ovh.test/1.0";

/** The project id the fake serves. */
export const FAKE_OVH_PROJECT_ID = "pid";

/**
 * Create a fake OVH API. New users start in status "creating" and report
 * "ok" from their first GET on, as the real API does after a few seconds.
 *
 * @returns the fake's state, controls and fetch function
 */
export function createFakeOvh(): FakeOvh {
  const calls: FakeOvhCall[] = [];
  const users = new Map<number, FakeOvhUser>();
  const keys = new Map<string, { userId: number; secret: string }>();
  const failures: FakeOvhFailure[] = [];
  let nextUserId = 100;
  let nextKey = 1;

  const error = (status: number, message: string) =>
    Response.json({ class: "Client::Error", message }, { status });

  const fetch: OvhFetch = async (url, init) => {
    const request = new Request(url, init);
    const body = await request.text();
    const path = request.url.slice(FAKE_OVH_ENDPOINT.length);
    calls.push({ method: request.method, path, body });
    // Yield so concurrent route handlers genuinely interleave.
    await Bun.sleep(1);

    const failure = failures.find(
      (f) =>
        f.method === request.method &&
        f.path.test(path) &&
        (f.times === undefined || f.times > 0),
    );
    if (failure) {
      if (failure.times !== undefined) failure.times -= 1;
      return error(failure.status, "injected failure");
    }

    const base = `/cloud/project/${FAKE_OVH_PROJECT_ID}/user`;
    if (!path.startsWith(base)) return error(404, "unknown path");
    const segments = path.slice(base.length).split("/").filter(Boolean);
    const user =
      segments[0] !== undefined ? users.get(Number(segments[0])) : undefined;

    if (segments.length === 0 && request.method === "POST") {
      const parsed = JSON.parse(body) as { description: string };
      const created: FakeOvhUser = {
        id: nextUserId++,
        description: parsed.description,
        status: "creating",
        policy: null,
      };
      users.set(created.id, created);
      return Response.json({
        id: created.id,
        username: `user-${created.id}`,
        status: created.status,
      });
    }
    if (!user) return error(404, "user not found");
    if (segments.length === 1 && request.method === "GET") {
      user.status = "ok";
      return Response.json({ id: user.id, status: user.status });
    }
    if (segments.length === 1 && request.method === "DELETE") {
      users.delete(user.id);
      for (const [access, key] of keys) {
        if (key.userId === user.id) keys.delete(access);
      }
      return new Response(null, { status: 200 });
    }
    if (segments[1] === "policy" && request.method === "POST") {
      user.policy = (JSON.parse(body) as { policy: string }).policy;
      return new Response(null, { status: 200 });
    }
    if (segments[1] === "s3Credentials" && request.method === "POST") {
      const access = `AK${String(nextKey).padStart(4, "0")}`;
      const secret = `SECRET${nextKey++}`;
      keys.set(access, { userId: user.id, secret });
      return Response.json({
        userId: String(user.id),
        tenantId: "tenant",
        access,
        secret,
      });
    }
    if (segments[1] === "s3Credentials" && request.method === "DELETE") {
      const access = segments[2] ?? "";
      if (!keys.has(access)) return error(404, "credential not found");
      keys.delete(access);
      return new Response(null, { status: 200 });
    }
    return error(404, "unknown path");
  };

  return { fetch, calls, users, keys, failures };
}
