import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  cancelAdminInvite,
  createAdminInvite,
  deleteFile,
  getDownloadUrl,
  getHealth,
  getMe,
  listAdminInvites,
  listAdminUsers,
  listFiles,
  postLoginOptions,
  postLoginVerify,
  postLogout,
  postRegisterOptions,
  postRegisterVerify,
  postShareUrl,
  postUploadUrl,
  removeAdminUser,
  resendAdminInvite,
  resetUserPasskeys,
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
  it("sends no body and returns the requestId and options (T021)", async () => {
    const body = { requestId: "abc-123", options: { challenge: "def" } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postLoginOptions();

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/login/options",
      expect.objectContaining({ method: "POST" }),
    );
    // The username-less flow sends no body (FR-002).
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
  });
});

describe("postLoginVerify", () => {
  it("posts requestId and credential (T021)", async () => {
    const credential = { id: "cred" };
    const requestId = "abc-123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ user: { username: "alice" } }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postLoginVerify(requestId, credential as never);

    expect(result.user.username).toBe("alice");
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/login/verify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ requestId, credential }),
      }),
    );
  });
});

describe("postRegisterOptions", () => {
  it("posts the token and returns registration details (T015)", async () => {
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
  it("posts token and credential (T015)", async () => {
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

describe("listFiles", () => {
  it("lists the space root when no prefix or cursor is given", async () => {
    const body = { folders: [], files: [], nextCursor: null };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await listFiles("");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends the relative prefix as a query parameter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ folders: [], files: [], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await listFiles("docs/reports");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files?prefix=docs%2Freports",
      expect.anything(),
    );
  });

  it("sends the cursor for the next page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ folders: [], files: [], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await listFiles("", "token-2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files?cursor=token-2",
      expect.anything(),
    );
  });
});

describe("postUploadUrl", () => {
  it("posts the folder, file name and overwrite flag", async () => {
    const body = {
      url: "https://s3.example/jivedrive-prod/users/alice/docs/a.txt?X-Amz-Signature=abc",
      key: "users/alice/docs/a.txt",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postUploadUrl("docs", "a.txt", false);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/upload-url",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          folder: "docs",
          fileName: "a.txt",
          overwrite: false,
        }),
      }),
    );
  });
});

describe("postShareUrl", () => {
  it("posts the key and the chosen expiry and returns the link", async () => {
    const body = {
      url: "https://s3.example/jivedrive-prod/users/alice/a.txt?X-Amz-Expires=3600&X-Amz-Signature=abc",
      expiresAt: "2026-08-13T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await postShareUrl("users/alice/a.txt", "1h");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/share-url",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key: "users/alice/a.txt", expiresIn: "1h" }),
      }),
    );
  });

  it("defaults to the 7-day expiry when none is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ url: "https://s3.example/x", expiresAt: "now" }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await postShareUrl("users/alice/a.txt");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/share-url",
      expect.objectContaining({
        body: JSON.stringify({ key: "users/alice/a.txt", expiresIn: "7d" }),
      }),
    );
  });
});

describe("deleteFile", () => {
  it("sends a DELETE request for the encoded key without parsing a body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await deleteFile("users/alice/my file #1?.txt");

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/files?key=${encodeURIComponent("users/alice/my file #1?.txt")}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("getDownloadUrl", () => {
  it("requests a presigned URL for the key with proper encoding", async () => {
    const url =
      "https://s3.example/jivedrive-prod/users/alice/a.txt?X-Amz-Signature=abc";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ url }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await getDownloadUrl("users/alice/my file #1?.txt");

    expect(result.url).toBe(url);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/files/download-url?key=${encodeURIComponent(
        "users/alice/my file #1?.txt",
      )}`,
      expect.anything(),
    );
  });
});

describe("admin API", () => {
  it("listAdminUsers fetches the admin user list", async () => {
    const body = { users: [{ username: "admin", isAdmin: true }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await listAdminUsers();

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("listAdminInvites fetches the invite list", async () => {
    const body = { invites: [{ username: "carol", status: "pending" }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await listAdminInvites();

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/invites",
      expect.anything(),
    );
  });

  it("createAdminInvite posts username, bucket, prefix and admin flag", async () => {
    const body = {
      invite: { username: "carol", status: "pending" },
      link: "http://localhost:5173/register?token=abc",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, 201));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await createAdminInvite({
      username: "carol",
      bucket: "jivedrive-prod",
      prefix: "users/carol/",
      isAdmin: true,
    });

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/invites",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          username: "carol",
          bucket: "jivedrive-prod",
          prefix: "users/carol/",
          isAdmin: true,
        }),
      }),
    );
  });

  it("resendAdminInvite posts to the invite's resend endpoint", async () => {
    const body = {
      invite: { username: "carol", status: "pending" },
      link: "http://localhost:5173/register?token=new",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await resendAdminInvite("invite-1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/invites/invite-1/resend",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancelAdminInvite sends a DELETE without parsing a body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await cancelAdminInvite("invite-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/invites/invite-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("removeAdminUser sends a DELETE with the encoded user id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    await removeAdminUser("user id/with slashes");

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/users?id=${encodeURIComponent("user id/with slashes")}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("resetUserPasskeys sends a DELETE and returns the re-enrollment invite and link (T028)", async () => {
    const body = {
      invite: { username: "kate", status: "pending" },
      link: "http://localhost:5173/register?token=reset-link",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock as unknown as FetchMock);

    const result = await resetUserPasskeys("user-1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/user-1/passkeys",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
