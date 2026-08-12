import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, getHealth, getMe } from "../src/api/client";

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
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
