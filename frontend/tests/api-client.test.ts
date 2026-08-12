import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  getHealth,
  getMe,
  postLoginOptions,
  postLoginVerify,
  postLogout,
  postRegisterOptions,
  postRegisterVerify,
} from "../src/api/client";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("sends the request with cookie credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch<{ ok: boolean }>("/healthcheck");

    expect(fetchMock).toHaveBeenCalledWith(
      "/healthcheck",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("parses the JSON response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ status: "ok" })),
    );

    const body = await apiFetch<{ status: string }>("/healthcheck");
    expect(body).toEqual({ status: "ok" });
  });

  it("throws an error carrying the server error code for non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "Not signed in", code: "unauthorized" }, 401),
        ),
    );

    const error = await apiFetch<never>("/api/files").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const err = error as Error & { code: string; status: number };
    expect(err.message).toContain("Not signed in");
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
  });

  it("propagates network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    await expect(apiFetch("/healthcheck")).rejects.toThrow("fetch failed");
  });
});

describe("getHealth", () => {
  it("returns the healthcheck body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ status: "ok" })),
    );

    expect(await getHealth()).toEqual({ status: "ok" });
  });
});

describe("getMe", () => {
  it("returns the signed-in user", async () => {
    const user = {
      id: "abc",
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
      isAdmin: false,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ user })));

    expect(await getMe()).toEqual({ user });
  });

  it("returns null when signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ user: null })),
    );

    expect(await getMe()).toEqual({ user: null });
  });

  it("requests cookie credentials from the auth endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: null }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await getMe();
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("postLoginOptions", () => {
  it("posts the username and returns the options response", async () => {
    const body = {
      options: { challenge: "abc" },
      needsRegistration: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postLoginOptions("alice");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/login/options",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "alice" }),
      }),
    );
  });
});

describe("postLoginVerify", () => {
  it("posts username and credential", async () => {
    const credential = { id: "cred" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ user: { username: "alice" } }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postLoginVerify("alice", credential as never);

    expect(result.user.username).toBe("alice");
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/login/verify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "alice", credential }),
      }),
    );
  });
});

describe("postRegisterOptions", () => {
  it("posts the invite token and returns invite details", async () => {
    const body = {
      options: { challenge: "abc" },
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postRegisterOptions("token-1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/register/options",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "token-1" }),
      }),
    );
  });
});

describe("postRegisterVerify", () => {
  it("posts token and credential for invite registration", async () => {
    const credential = { id: "cred" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ user: { username: "alice" } }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postRegisterVerify({
      token: "token-1",
      credential: credential as never,
    });

    expect(result.user.username).toBe("alice");
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/register/verify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "token-1", credential }),
      }),
    );
  });

  it("posts username and credential for first-passkey registration", async () => {
    const credential = { id: "cred" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ user: { username: "admin" } }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postRegisterVerify({
      username: "admin",
      credential: credential as never,
    });

    expect(result.user.username).toBe("admin");
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/register/verify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "admin", credential }),
      }),
    );
  });
});

describe("postLogout", () => {
  it("posts to logout without parsing the empty body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await postLogout();

    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
