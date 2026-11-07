/**
 * Tool tests for the MCP endpoint: the eight drive tools over the
 * signed-in user's own space and folders shared with them, with scope
 * containment (constitution IV) proven against an in-memory fake S3
 * bucket that records every command.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createShare,
  createShareLink,
  deleteShare,
  getSearchDoc,
  getShareLinkByToken,
  syncSearchFolders,
  upsertSearchDoc,
} from "../src/db/repository";
import type { Database } from "bun:sqlite";
import {
  callTool,
  closeMcpTestDatabases,
  createMcpTestEnv,
  putFake,
  textOf,
} from "./mcp-test-helpers";
import type { McpTestEnv } from "./mcp-test-helpers";

afterEach(closeMcpTestDatabases);

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const PHRASE = "quarterly budget review zephyrquill";

/**
 * Environment with alice's folder `team/` shared with bob, plus a share
 * of alice's `secret/` with carol (which bob must never reach).
 */
function sharedEnv(): McpTestEnv & {
  teamShareId: string;
  carolShareId: string;
} {
  const env = createMcpTestEnv();
  const team = createShare(env.db, {
    ownerUserId: env.alice.id,
    recipientUserId: env.bob.id,
    folder: "team/",
  });
  const carolShare = createShare(env.db, {
    ownerUserId: env.alice.id,
    recipientUserId: env.carol.id,
    folder: "secret/",
  });
  return { ...env, teamShareId: team.id, carolShareId: carolShare.id };
}

/** Seed one index row. */
function seedDoc(db: Database, userId: string, key: string, body = ""): void {
  upsertSearchDoc(db, {
    userId,
    key,
    etag: '"e"',
    size: body.length,
    fileName: key.slice(key.lastIndexOf("/") + 1),
    body,
  });
}

describe("list_spaces", () => {
  it("lists the own space and every folder shared with the caller", async () => {
    const env = sharedEnv();
    const result = await callTool(env.app, "list_spaces", {}, "bob");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      spaces: [
        { space: "own", name: "My drive" },
        { space: `shared:${env.teamShareId}`, name: "team", sharedBy: "alice" },
      ],
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent!);
  });
});

describe("scope containment", () => {
  const badPaths = [
    "..",
    "../bob",
    "docs/../../bob/x.txt",
    "/users/bob/x.txt",
    "/",
    "a//b.txt",
    "./a.txt",
    "a/./b.txt",
    "..\\bob\\x.txt",
    "a\\..\\..\\b.txt",
    "\\x.txt",
    "a\u0000b.txt",
  ];

  it("refuses traversal, absolute, empty-segment and backslash paths before any S3 call", async () => {
    const env = sharedEnv();
    for (const path of badPaths) {
      for (const [tool, args] of [
        ["list_folder", { path }],
        ["read_file", { path }],
        ["create_folder", { path }],
        ["write_file", { path, content: "x" }],
        ["move_file", { path, toFolder: "" }],
        ["move_file", { path: "a.txt", toFolder: path }],
        ["create_share_link", { path }],
      ] as const) {
        const result = await callTool(env.app, tool, args, "bob");
        expect(result.isError).toBe(true);
      }
    }
    expect(env.calls).toEqual([]);
  });

  it("refuses another user's share id, a revoked share and malformed spaces", async () => {
    const env = sharedEnv();
    const results = [
      await callTool(
        env.app,
        "list_folder",
        { space: `shared:${env.carolShareId}` },
        "bob",
      ),
      await callTool(
        env.app,
        "read_file",
        { space: `shared:${env.carolShareId}`, path: "x.txt" },
        "bob",
      ),
      await callTool(
        env.app,
        "write_file",
        { space: `shared:${env.carolShareId}`, path: "x.txt", content: "x" },
        "bob",
      ),
      await callTool(
        env.app,
        "create_share_link",
        { space: `shared:${env.carolShareId}`, path: "x.txt" },
        "bob",
      ),
      // The owner cannot use their own share id as a space either.
      await callTool(
        env.app,
        "list_folder",
        { space: `shared:${env.teamShareId}` },
        "alice",
      ),
      await callTool(env.app, "list_folder", { space: "shared:" }, "bob"),
      await callTool(env.app, "list_folder", { space: "shared:../x" }, "bob"),
      await callTool(env.app, "list_folder", { space: "bob" }, "bob"),
    ];
    deleteShare(env.db, env.teamShareId);
    results.push(
      await callTool(
        env.app,
        "list_folder",
        { space: `shared:${env.teamShareId}` },
        "bob",
      ),
    );
    for (const result of results) expect(result.isError).toBe(true);
    expect(textOf(results[0]!)).toContain("does not exist or has been revoked");
    expect(env.calls).toEqual([]);
  });

  it("refuses non-string arguments with a tool error", async () => {
    const env = createMcpTestEnv();
    const result = await callTool(env.app, "read_file", { path: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("path");
  });
});

describe("list_folder", () => {
  it("lists folders and files in the own root with space-relative paths", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/docs/", "");
    putFake(env.store, "users/alice/docs/a.txt", "hello");
    putFake(env.store, "users/alice/readme.md", "hi there");
    putFake(env.store, "users/bob/private.txt", "nope");
    const result = await callTool(env.app, "list_folder", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      path: "",
      folders: [{ name: "docs", path: "docs/" }],
      files: [
        {
          name: "readme.md",
          path: "readme.md",
          size: 8,
          lastModified: "2026-01-02T03:04:05.000Z",
        },
      ],
    });
    const nested = await callTool(env.app, "list_folder", { path: "docs" });
    expect(nested.structuredContent).toMatchObject({
      path: "docs/",
      folders: [],
      files: [{ name: "a.txt", path: "docs/a.txt", size: 5 }],
    });
  });

  it("lists a shared folder mount-relative", async () => {
    const env = sharedEnv();
    putFake(env.store, "users/alice/team/plan.txt", "plan");
    putFake(env.store, "users/alice/team/sub/x.txt", "x");
    const result = await callTool(
      env.app,
      "list_folder",
      { space: `shared:${env.teamShareId}` },
      "bob",
    );
    expect(result.structuredContent).toMatchObject({
      path: "",
      folders: [{ name: "sub", path: "sub/" }],
      files: [{ name: "plan.txt", path: "plan.txt" }],
    });
    for (const call of env.calls) {
      expect(String(call.input.Prefix)).toStartWith("users/alice/team/");
    }
  });

  it("pages with a cursor", async () => {
    const env = createMcpTestEnv();
    for (let i = 0; i < 1001; i++) {
      putFake(
        env.store,
        `users/alice/big/f${String(i).padStart(4, "0")}.txt`,
        "x",
      );
    }
    const first = await callTool(env.app, "list_folder", { path: "big/" });
    const page1 = first.structuredContent as {
      files: unknown[];
      nextCursor?: string;
    };
    expect(page1.files).toHaveLength(1000);
    expect(typeof page1.nextCursor).toBe("string");
    const second = await callTool(env.app, "list_folder", {
      path: "big/",
      cursor: page1.nextCursor,
    });
    const page2 = second.structuredContent as {
      files: Array<{ name: string }>;
      nextCursor?: string;
    };
    expect(page2.files.map((f) => f.name)).toEqual(["f1000.txt"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("refuses a folder that does not exist", async () => {
    const env = createMcpTestEnv();
    const result = await callTool(env.app, "list_folder", { path: "nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });
});

describe("search", () => {
  it("finds files by name and by content across own and shared spaces", async () => {
    const env = sharedEnv();
    seedDoc(env.db, env.bob.id, "users/bob/zephyr-notes.txt");
    seedDoc(env.db, env.alice.id, "users/alice/team/budget.pdf", PHRASE);
    seedDoc(env.db, env.alice.id, "users/alice/secret/zephyr.txt", PHRASE);
    seedDoc(env.db, env.carol.id, "users/carol/zephyr.txt", PHRASE);
    syncSearchFolders(env.db, env.alice.id, ["users/alice/team/zephyr-dir/"]);

    const result = await callTool(
      env.app,
      "search",
      { query: "zephyr" },
      "bob",
    );
    expect(result.isError).toBeUndefined();
    const { results, capped } = result.structuredContent as {
      results: Array<Record<string, unknown>>;
      capped: boolean;
    };
    expect(capped).toBe(false);
    expect(results).toEqual([
      {
        name: "zephyr-dir",
        path: "zephyr-dir/",
        folder: "",
        space: `shared:${env.teamShareId}`,
        sharedBy: "alice",
        match: "folder",
      },
      {
        name: "zephyr-notes.txt",
        path: "zephyr-notes.txt",
        folder: "",
        space: "own",
        match: "name",
      },
      {
        name: "budget.pdf",
        path: "budget.pdf",
        folder: "",
        space: `shared:${env.teamShareId}`,
        sharedBy: "alice",
        match: "content",
        snippet: expect.any(String),
      },
    ]);
  });

  it("refuses an empty or over-long query", async () => {
    const env = createMcpTestEnv();
    expect((await callTool(env.app, "search", { query: "  " })).isError).toBe(
      true,
    );
    expect(
      (await callTool(env.app, "search", { query: "x".repeat(201) })).isError,
    ).toBe(true);
    expect((await callTool(env.app, "search", {})).isError).toBe(true);
  });
});

describe("read_file", () => {
  it("returns a text file", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/docs/note.md", "# Hello\nworld");
    const result = await callTool(env.app, "read_file", {
      path: "docs/note.md",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "# Hello\nworld" }]);
  });

  it("returns an extensionless UTF-8 file as text", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/Makefile", "all:\n\techo hi\n");
    const result = await callTool(env.app, "read_file", { path: "Makefile" });
    expect(result.content).toEqual([
      { type: "text", text: "all:\n\techo hi\n" },
    ]);
  });

  it("reads from a shared space", async () => {
    const env = sharedEnv();
    putFake(env.store, "users/alice/team/plan.txt", "the plan");
    const result = await callTool(
      env.app,
      "read_file",
      { space: `shared:${env.teamShareId}`, path: "plan.txt" },
      "bob",
    );
    expect(textOf(result)).toBe("the plan");
  });

  it("pages long text with offset and a truncation footer", async () => {
    const env = createMcpTestEnv();
    const text = "a".repeat(100_000) + "b".repeat(100_000) + "c".repeat(50);
    putFake(env.store, "users/alice/long.txt", text);

    const first = textOf(
      await callTool(env.app, "read_file", { path: "long.txt" }),
    );
    expect(first.startsWith("a".repeat(100_000))).toBe(true);
    expect(first).not.toContain("b");
    expect(first).toEndWith(
      "\n\n[Truncated: showing characters 0–100000 of 200050. Call read_file with offset=100000 to continue.]",
    );

    const second = textOf(
      await callTool(env.app, "read_file", {
        path: "long.txt",
        offset: 100_000,
      }),
    );
    expect(second.startsWith("b".repeat(100_000))).toBe(true);
    expect(second).toEndWith(
      "[Truncated: showing characters 100000–200000 of 200050. Call read_file with offset=200000 to continue.]",
    );

    const last = textOf(
      await callTool(env.app, "read_file", {
        path: "long.txt",
        offset: 200_000,
      }),
    );
    expect(last).toBe("c".repeat(50));

    for (const offset of [200_051, -1, 1.5]) {
      const bad = await callTool(env.app, "read_file", {
        path: "long.txt",
        offset,
      });
      expect(bad.isError).toBe(true);
    }
  });

  it("returns PDF and DOCX text through the extractor", async () => {
    const env = createMcpTestEnv();
    putFake(
      env.store,
      "users/alice/s.pdf",
      readFileSync(join(fixturesDir, "sample.pdf")),
    );
    putFake(
      env.store,
      "users/alice/s.docx",
      readFileSync(join(fixturesDir, "sample.docx")),
    );
    expect(
      textOf(await callTool(env.app, "read_file", { path: "s.pdf" })),
    ).toContain(PHRASE);
    expect(
      textOf(await callTool(env.app, "read_file", { path: "s.docx" })),
    ).toContain(PHRASE);
  });

  it("refuses a PDF whose text cannot be extracted", async () => {
    const env = createMcpTestEnv();
    putFake(
      env.store,
      "users/alice/bad.pdf",
      readFileSync(join(fixturesDir, "corrupt.pdf")),
    );
    const result = await callTool(env.app, "read_file", { path: "bad.pdf" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("extract");
  });

  it("returns images as image content", async () => {
    const env = createMcpTestEnv();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
    ]);
    putFake(env.store, "users/alice/pic.PNG", png);
    putFake(
      env.store,
      "users/alice/photo",
      new Uint8Array([0xff, 0xd8, 0xff, 0]),
      "image/jpeg",
    );
    const byExt = await callTool(env.app, "read_file", { path: "pic.PNG" });
    expect(byExt.content).toEqual([
      {
        type: "image",
        data: Buffer.from(png).toString("base64"),
        mimeType: "image/png",
      },
    ]);
    const byType = await callTool(env.app, "read_file", { path: "photo" });
    expect(byType.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
    });
  });

  it("refuses an unsupported binary", async () => {
    const env = createMcpTestEnv();
    putFake(
      env.store,
      "users/alice/a.zip",
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0xfe]),
    );
    const result = await callTool(env.app, "read_file", { path: "a.zip" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("binary");
  });

  it("refuses a file over the size limit without downloading it", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/huge.txt", new Uint8Array(1024 * 1024 + 1));
    const result = await callTool(env.app, "read_file", { path: "huge.txt" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large");
    expect(env.calls.some((c) => c.name === "GetObjectCommand")).toBe(false);
  });

  it("refuses a folder and a missing file", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/docs/a.txt", "x");
    const folder = await callTool(env.app, "read_file", { path: "docs" });
    expect(folder.isError).toBe(true);
    expect(textOf(folder)).toContain("folder");
    const missing = await callTool(env.app, "read_file", { path: "nope.txt" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("not found");
  });
});

describe("create_folder", () => {
  it("creates a folder marker in the own space and nested under an existing parent", async () => {
    const env = createMcpTestEnv();
    const result = await callTool(env.app, "create_folder", {
      path: "projects",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      name: "projects",
      path: "projects/",
    });
    expect(env.store.has("users/alice/projects/")).toBe(true);
    const nested = await callTool(env.app, "create_folder", {
      path: "projects/2026/",
    });
    expect(nested.structuredContent).toEqual({
      name: "2026",
      path: "projects/2026/",
    });
    expect(env.store.has("users/alice/projects/2026/")).toBe(true);
  });

  it("creates a folder in a shared space", async () => {
    const env = sharedEnv();
    putFake(env.store, "users/alice/team/", "");
    const result = await callTool(
      env.app,
      "create_folder",
      { space: `shared:${env.teamShareId}`, path: "minutes" },
      "bob",
    );
    expect(result.structuredContent).toEqual({
      name: "minutes",
      path: "minutes/",
    });
    expect(env.store.has("users/alice/team/minutes/")).toBe(true);
  });

  it("refuses a missing parent, an existing folder and invalid names", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/docs/", "");
    for (const path of ["missing/child", "docs", "", "x".repeat(256)]) {
      const result = await callTool(env.app, "create_folder", { path });
      expect(result.isError).toBe(true);
    }
    expect(
      textOf(await callTool(env.app, "create_folder", { path: "docs" })),
    ).toContain("already exists");
    expect([...env.store.keys()]).toEqual(["users/alice/docs/"]);
  });
});

describe("write_file", () => {
  it("writes a new file with a guessed content type", async () => {
    const env = createMcpTestEnv();
    const result = await callTool(env.app, "write_file", {
      path: "notes.txt",
      content: "héllo",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ path: "notes.txt", size: 6 });
    const stored = env.store.get("users/alice/notes.txt");
    expect(new TextDecoder().decode(stored?.body)).toBe("héllo");
    expect(stored?.contentType).toBe("text/plain; charset=utf-8");

    putFake(env.store, "users/alice/docs/", "");
    await callTool(env.app, "write_file", {
      path: "docs/a.md",
      content: "# A",
    });
    expect(env.store.get("users/alice/docs/a.md")?.contentType).toBe(
      "text/markdown; charset=utf-8",
    );
    await callTool(env.app, "write_file", {
      path: "docs/data.json",
      content: "{}",
    });
    expect(env.store.get("users/alice/docs/data.json")?.contentType).toBe(
      "application/json; charset=utf-8",
    );
    await callTool(env.app, "write_file", {
      path: "docs/unknown.xyz",
      content: "?",
    });
    expect(env.store.get("users/alice/docs/unknown.xyz")?.contentType).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("refuses an existing file unless overwrite is set", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/a.txt", "old");
    const refused = await callTool(env.app, "write_file", {
      path: "a.txt",
      content: "new",
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("already exists");
    expect(
      new TextDecoder().decode(env.store.get("users/alice/a.txt")?.body),
    ).toBe("old");

    const replaced = await callTool(env.app, "write_file", {
      path: "a.txt",
      content: "new",
      overwrite: true,
    });
    expect(replaced.isError).toBeUndefined();
    expect(
      new TextDecoder().decode(env.store.get("users/alice/a.txt")?.body),
    ).toBe("new");
  });

  it("writes into a shared folder", async () => {
    const env = sharedEnv();
    const result = await callTool(
      env.app,
      "write_file",
      {
        space: `shared:${env.teamShareId}`,
        path: "from-bob.txt",
        content: "hi",
      },
      "bob",
    );
    expect(result.structuredContent).toEqual({ path: "from-bob.txt", size: 2 });
    expect(env.store.has("users/alice/team/from-bob.txt")).toBe(true);
  });

  it("refuses a missing parent and oversized content", async () => {
    const env = createMcpTestEnv();
    const missing = await callTool(env.app, "write_file", {
      path: "nope/a.txt",
      content: "x",
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("does not exist");
    const big = await callTool(env.app, "write_file", {
      path: "big.txt",
      content: "a".repeat(10 * 1024 * 1024 + 1),
    });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("10 MiB");
    expect(env.store.size).toBe(0);
  });

  it("refuses non-string content", async () => {
    const env = createMcpTestEnv();
    const result = await callTool(env.app, "write_file", {
      path: "a.txt",
      content: 1,
    });
    expect(result.isError).toBe(true);
  });

  it("writes base64 content as exact bytes with a guessed binary type", async () => {
    const env = createMcpTestEnv();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);
    const result = await callTool(env.app, "write_file", {
      path: "pic.PNG",
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ path: "pic.PNG", size: 7 });
    const stored = env.store.get("users/alice/pic.PNG");
    expect(stored?.body).toEqual(bytes);
    expect(stored?.contentType).toBe("image/png");

    for (const [path, type] of [
      ["report.pdf", "application/pdf"],
      [
        "sheet.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      ["bundle.zip", "application/zip"],
      ["notes.md", "text/markdown"],
      ["blob.xyz", "application/octet-stream"],
      ["no-extension", "application/octet-stream"],
    ]) {
      const written = await callTool(env.app, "write_file", {
        path,
        content: "AAEC",
        encoding: "base64",
      });
      expect(written.isError).toBeUndefined();
      expect(env.store.get(`users/alice/${path}`)?.contentType).toBe(type);
    }
  });

  it("treats an explicit text encoding like the default", async () => {
    const env = createMcpTestEnv();
    await callTool(env.app, "write_file", {
      path: "a.csv",
      content: "AAEC",
      encoding: "text",
    });
    const stored = env.store.get("users/alice/a.csv");
    expect(new TextDecoder().decode(stored?.body)).toBe("AAEC");
    expect(stored?.contentType).toBe("text/csv; charset=utf-8");
  });

  it("stores an explicit contentType verbatim for either encoding", async () => {
    const env = createMcpTestEnv();
    await callTool(env.app, "write_file", {
      path: "data.bin",
      content: "AAEC",
      encoding: "base64",
      contentType: "image/x-custom",
    });
    expect(env.store.get("users/alice/data.bin")?.contentType).toBe(
      "image/x-custom",
    );
    await callTool(env.app, "write_file", {
      path: "page.txt",
      content: "<p>hi</p>",
      contentType: 'text/html; charset="utf-8"',
    });
    expect(env.store.get("users/alice/page.txt")?.contentType).toBe(
      'text/html; charset="utf-8"',
    );
  });

  it("refuses malformed base64, encodings and content types", async () => {
    const env = createMcpTestEnv();
    for (const [content, label] of [
      ["AAE", "missing padding"],
      ["AA=C", "padding in the middle"],
      ["AA\nEC", "whitespace"],
      ["AA-_", "base64url alphabet"],
      ["AAF=", "non-zero trailing bits"],
    ]) {
      const result = await callTool(env.app, "write_file", {
        path: "a.bin",
        content,
        encoding: "base64",
      });
      expect(result.isError, label).toBe(true);
      expect(textOf(result), label).toContain("base64");
    }
    for (const encoding of ["hex", 1, false]) {
      const result = await callTool(env.app, "write_file", {
        path: "a.bin",
        content: "AAEC",
        encoding,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("encoding");
    }
    for (const contentType of [
      "image",
      "image/png\r\nX-Evil: 1",
      "image/png; charset",
      "",
      1,
      `image/${"x".repeat(256)}`,
    ]) {
      const result = await callTool(env.app, "write_file", {
        path: "a.bin",
        content: "AAEC",
        encoding: "base64",
        contentType,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("contentType");
    }
    expect(env.store.size).toBe(0);
  });

  it("limits base64 content to 10 MiB of decoded bytes", async () => {
    const env = createMcpTestEnv();
    const max = 10 * 1024 * 1024;
    const atLimit = await callTool(env.app, "write_file", {
      path: "max.bin",
      content: Buffer.alloc(max, 7).toString("base64"),
      encoding: "base64",
    });
    expect(atLimit.structuredContent).toEqual({ path: "max.bin", size: max });
    const over = await callTool(env.app, "write_file", {
      path: "over.bin",
      content: Buffer.alloc(max + 1, 7).toString("base64"),
      encoding: "base64",
    });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("10 MiB");
    expect(env.store.has("users/alice/over.bin")).toBe(false);
  });
});

describe("move_file", () => {
  it("moves a file and carries its share link and search entry over", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/a.txt", "x");
    putFake(env.store, "users/alice/archive/", "");
    seedDoc(env.db, env.alice.id, "users/alice/a.txt", "body text");
    const link = createShareLink(env.db, {
      ownerUserId: env.alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/a.txt",
      expiresIn: "7d",
    });
    const result = await callTool(env.app, "move_file", {
      path: "a.txt",
      toFolder: "archive",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ path: "archive/a.txt" });
    expect(env.store.has("users/alice/a.txt")).toBe(false);
    expect(env.store.has("users/alice/archive/a.txt")).toBe(true);
    expect(getShareLinkByToken(env.db, link.token)?.objectKey).toBe(
      "users/alice/archive/a.txt",
    );
    expect(
      getSearchDoc(env.db, env.alice.id, "users/alice/archive/a.txt")?.body,
    ).toBe("body text");
  });

  it("moves within a shared space to its root", async () => {
    const env = sharedEnv();
    putFake(env.store, "users/alice/team/sub/a.txt", "x");
    const result = await callTool(
      env.app,
      "move_file",
      { space: `shared:${env.teamShareId}`, path: "sub/a.txt", toFolder: "" },
      "bob",
    );
    expect(result.structuredContent).toEqual({ path: "a.txt" });
    expect(env.store.has("users/alice/team/a.txt")).toBe(true);
  });

  it("refuses a name clash, a missing destination, a missing source and the same folder", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/a.txt", "x");
    putFake(env.store, "users/alice/archive/a.txt", "other");
    const clash = await callTool(env.app, "move_file", {
      path: "a.txt",
      toFolder: "archive",
    });
    expect(clash.isError).toBe(true);
    expect(textOf(clash)).toContain("already exists");
    const noDest = await callTool(env.app, "move_file", {
      path: "a.txt",
      toFolder: "nowhere",
    });
    expect(noDest.isError).toBe(true);
    expect(textOf(noDest)).toContain("does not exist");
    const noSource = await callTool(env.app, "move_file", {
      path: "b.txt",
      toFolder: "archive",
    });
    expect(noSource.isError).toBe(true);
    const same = await callTool(env.app, "move_file", {
      path: "a.txt",
      toFolder: "",
    });
    expect(same.isError).toBe(true);
    expect(
      new TextDecoder().decode(
        env.store.get("users/alice/archive/a.txt")?.body,
      ),
    ).toBe("other");
    expect(env.store.has("users/alice/a.txt")).toBe(true);
  });
});

describe("create_share_link", () => {
  /** The token of a `<origin>/s/<token>` link, asserting its shape. */
  function tokenOf(url: unknown): string {
    expect(url).toMatch(/^http:\/\/localhost:5173\/s\/[A-Za-z0-9]{12}$/);
    return (url as string).slice((url as string).lastIndexOf("/") + 1);
  }

  it("creates a 7-day link to an own file by default", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/docs/report.pdf", "%PDF");
    const before = Date.now();
    const result = await callTool(env.app, "create_share_link", {
      path: "docs/report.pdf",
    });
    expect(result.isError).toBeUndefined();
    const { url, expiresAt } = result.structuredContent as {
      url: string;
      expiresAt: string;
    };
    expect(Object.keys(result.structuredContent!).sort()).toEqual([
      "expiresAt",
      "url",
    ]);
    const row = getShareLinkByToken(env.db, tokenOf(url));
    expect(row).toMatchObject({
      ownerUserId: env.alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/docs/report.pdf",
      expiresIn: "7d",
      expiresAt,
    });
    const sevenDays = 7 * 24 * 3600 * 1000;
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(before + sevenDays);
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(Date.now() + sevenDays);
    // Nothing is written to storage; the file is only checked.
    expect(env.calls.filter((c) => c.name !== "HeadObjectCommand")).toEqual([]);
  });

  it("honours expiresIn and returns the same link for the same file and lifetime", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/a.txt", "x");
    const hour = await callTool(env.app, "create_share_link", {
      path: "a.txt",
      expiresIn: "1h",
    });
    const token = tokenOf(hour.structuredContent?.url);
    expect(getShareLinkByToken(env.db, token)?.expiresIn).toBe("1h");
    const again = await callTool(env.app, "create_share_link", {
      path: "a.txt",
      expiresIn: "1h",
    });
    expect(again.structuredContent).toEqual(hour.structuredContent!);
    const month = await callTool(env.app, "create_share_link", {
      path: "a.txt",
      expiresIn: "30d",
    });
    expect(tokenOf(month.structuredContent?.url)).not.toBe(token);
    expect(
      getShareLinkByToken(env.db, tokenOf(month.structuredContent?.url))
        ?.expiresIn,
    ).toBe("30d");
  });

  it("links a file inside a folder shared with the caller, owned by the caller", async () => {
    const env = sharedEnv();
    putFake(env.store, "users/alice/team/plan.md", "# Plan");
    const result = await callTool(
      env.app,
      "create_share_link",
      { space: `shared:${env.teamShareId}`, path: "plan.md", expiresIn: "24h" },
      "bob",
    );
    expect(result.isError).toBeUndefined();
    expect(
      getShareLinkByToken(env.db, tokenOf(result.structuredContent?.url)),
    ).toMatchObject({
      ownerUserId: env.bob.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/team/plan.md",
      expiresIn: "24h",
    });
  });

  it("refuses a missing file, a folder and an invalid lifetime without creating a link", async () => {
    const env = createMcpTestEnv();
    putFake(env.store, "users/alice/docs/a.txt", "x");
    const missing = await callTool(env.app, "create_share_link", {
      path: "nope.txt",
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('File not found: "nope.txt"');
    const folder = await callTool(env.app, "create_share_link", {
      path: "docs",
    });
    expect(folder.isError).toBe(true);
    expect(textOf(folder)).toContain('"docs" is a folder');
    for (const expiresIn of ["2d", "", 7, null]) {
      const bad = await callTool(env.app, "create_share_link", {
        path: "docs/a.txt",
        expiresIn,
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain(
        "expiresIn must be one of 1h, 24h, 7d, 30d",
      );
    }
    const count = env.db
      .query("SELECT COUNT(*) AS n FROM share_links")
      .get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
