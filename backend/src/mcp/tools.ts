/**
 * The MCP drive tools: `list_spaces`, `list_folder`, `search`,
 * `read_file`, `create_folder`, `write_file` and `move_file`, exposing the
 * signed-in user's own space and the folders shared with them.
 *
 * Every tool addresses storage as a `space` (`"own"` or
 * `"shared:<shareId>"`, resolved through the same resolver as
 * `/api/files`) plus a path relative to that space's root, validated by
 * `mcp/paths.ts` before any key is composed (constitution IV). Listing,
 * search, folder creation and moves run the shared implementations in
 * `fileOps.ts`. Failures are tool results with `isError: true` and a
 * message the model can act on.
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config";
import type { User } from "../db/repository";
import { getUserById, listSharesByRecipient } from "../db/repository";
import {
  createFolder,
  listFolder,
  moveFile,
  resolveSpaceValue,
  searchFiles,
} from "../fileOps";
import { folderExists, getObject, headObject, putObject } from "../s3/client";
import type { ResolvedScope } from "../scope";
import { resolveSpace } from "../scope";
import { extensionOf, extractText, extractable } from "../search/extract";
import {
  folderPrefix,
  parseFilePath,
  parseFolderPath,
  splitPath,
} from "./paths";
import type { ToolDefinition, ToolResult } from "./protocol";

/** Everything a tool call needs: the caller and the server's resources. */
export interface ToolContext {
  db: Database;
  s3Client: S3Client;
  config: AppConfig;
  /** The signed-in user the access token belongs to. */
  user: User;
}

/** Characters of text returned per `read_file` call. */
export const READ_PAGE_CHARS = 100_000;

/** Maximum UTF-8 size of `write_file` content in bytes (10 MiB). */
export const WRITE_MAX_BYTES = 10 * 1024 * 1024;

/** Folder listing page size (the S3 protocol limit). */
const LIST_PAGE_SIZE = 1000;

/** Instructions returned by `initialize`. */
export const SERVER_INSTRUCTIONS =
  "JiveDrive gives you access to the signed-in user's file storage. " +
  'Storage is divided into spaces: "own" is the user\'s own drive, and ' +
  '"shared:<shareId>" is a folder another user shared with them; call ' +
  "list_spaces to discover them. Every tool that takes a space defaults " +
  'to "own". Paths are relative to the space root, use "/" separators, ' +
  'never start with "/", and use "" for the root folder. Use list_folder ' +
  "to browse and search to find files by name or content, then read_file " +
  "to read them. You can create folders, write text files (refused if " +
  "the file exists unless overwrite is true) and move files between " +
  "folders of the same space. You cannot delete files or create share links.";

/** The `space` argument schema shared by most tools. */
const SPACE_SCHEMA = {
  type: "string",
  description:
    'Space to operate in: "own" (default) or "shared:<shareId>" from list_spaces.',
};

/** Annotations for tools that only read. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Every tool's definition, in listing order. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "list_spaces",
    title: "List spaces",
    description:
      "List the spaces you can access: your own drive and every folder shared with you (with who shared it).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_folder",
    title: "List folder",
    description:
      "List the subfolders and files directly inside a folder. Returns at most 1000 entries per call; pass nextCursor back as cursor for the next page.",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        path: {
          type: "string",
          description:
            'Folder path relative to the space root; "" (default) is the root.',
        },
        cursor: {
          type: "string",
          description:
            "nextCursor from a previous call, to continue the listing.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "search",
    title: "Search files",
    description:
      "Search your drive and every folder shared with you for folders and files by name, and for files by indexed text content (queries of 3+ characters). Returns at most 50 results; newly written files appear after the next background index scan.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for (1–200 characters).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "read_file",
    title: "Read file",
    description: `Read a file. Text files, PDFs and Word (.docx) documents are returned as text, ${READ_PAGE_CHARS} characters per call; when truncated, call again with the offset given at the end. PNG, JPEG, GIF and WebP images are returned as images. Other binary files cannot be read.`,
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        path: {
          type: "string",
          description: "File path relative to the space root.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Character offset to start reading text from (default 0).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "create_folder",
    title: "Create folder",
    description:
      "Create a new, empty folder. Its parent folder must already exist; an existing folder is never replaced.",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        path: {
          type: "string",
          description:
            "Path of the folder to create, relative to the space root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "write_file",
    title: "Write file",
    description:
      "Write a UTF-8 text file (at most 10 MiB). The parent folder must already exist. An existing file is refused unless overwrite is true, in which case it is replaced.",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        path: {
          type: "string",
          description: "File path relative to the space root.",
        },
        content: { type: "string", description: "The file's text content." },
        overwrite: {
          type: "boolean",
          description: "Replace an existing file (default false).",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "move_file",
    title: "Move file",
    description:
      "Move a file into another existing folder of the same space, keeping its name. Refused if a file with that name already exists there. Share links and search entries follow the file.",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        path: {
          type: "string",
          description: "Path of the file to move, relative to the space root.",
        },
        toFolder: {
          type: "string",
          description:
            'Destination folder relative to the space root; "" is the root.',
        },
      },
      required: ["path", "toFolder"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

/** A tool failure the model can act on. */
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** A structured tool success, also rendered as pretty JSON text. */
function toolSuccess(result: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

/**
 * Resolve the `space` argument for the caller.
 *
 * @param ctx - tool context
 * @param raw - the argument value (undefined means "own")
 * @returns the scope, or a tool error
 */
function resolveSpaceArg(
  ctx: ToolContext,
  raw: unknown,
): ResolvedScope | ToolResult {
  if (raw !== undefined && typeof raw !== "string") {
    return toolError('space must be a string: "own" or "shared:<shareId>"');
  }
  const resolved = resolveSpaceValue(ctx.db, ctx.user, raw);
  return resolved.ok ? resolved.value : toolError(resolved.message);
}

/**
 * Whether a folder exists in a scope; the root always does.
 *
 * @param ctx - tool context
 * @param scope - effective scope
 * @param folder - validated folder path ("" for the root)
 * @returns true when the folder exists
 */
async function scopeFolderExists(
  ctx: ToolContext,
  scope: ResolvedScope,
  folder: string,
): Promise<boolean> {
  if (folder === "") return true;
  return folderExists(
    ctx.s3Client,
    scope.bucket,
    scope.prefix,
    scope.prefix + folder + "/",
  );
}

/** `list_spaces`: the own space plus every resolvable incoming share. */
function listSpaces(ctx: ToolContext): ToolResult {
  const spaces: Array<Record<string, string>> = [
    { space: "own", name: "My drive" },
  ];
  for (const share of listSharesByRecipient(ctx.db, ctx.user.id)) {
    if (
      resolveSpace(ctx.db, ctx.user, { kind: "shared", shareId: share.id }) ===
      null
    ) {
      continue;
    }
    const owner = getUserById(ctx.db, share.ownerUserId);
    if (owner === null) continue;
    spaces.push({
      space: `shared:${share.id}`,
      name: splitPath(share.folder.replace(/\/$/, "")).name,
      sharedBy: owner.username,
    });
  }
  return toolSuccess({ spaces });
}

/** `list_folder`: one page of a folder, with space-relative paths. */
async function listFolderTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const folder = parseFolderPath(args.path);
  if (!folder.ok) return toolError(folder.error);
  if (args.cursor !== undefined && typeof args.cursor !== "string") {
    return toolError("cursor must be a string");
  }
  const scope = resolveSpaceArg(ctx, args.space);
  if ("content" in scope) return scope;
  const prefix = folderPrefix(folder.path);
  const listed = await listFolder(ctx.s3Client, scope, prefix, {
    cursor: args.cursor,
    pageSize: LIST_PAGE_SIZE,
  });
  if (!listed.ok) return toolError(listed.message);
  const page = listed.value;
  if (
    args.cursor === undefined &&
    page.folders.length === 0 &&
    page.files.length === 0 &&
    !(await scopeFolderExists(ctx, scope, folder.path))
  ) {
    return toolError(`Folder not found: "${folder.path}"`);
  }
  return toolSuccess({
    path: prefix,
    folders: page.folders.map((name) => ({ name, path: prefix + name + "/" })),
    files: page.files.map((file) => ({
      name: file.name,
      path: file.key.slice(scope.prefix.length),
      size: file.size,
      lastModified: file.lastModified,
    })),
    ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
  });
}

/**
 * `search`: the `/api/files/search` results, each carrying a
 * space-relative `path` usable with the other tools (folders end in "/")
 * and its parent `folder`.
 */
function searchTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): ToolResult {
  if (typeof args.query !== "string") {
    return toolError("query is required and must be a string");
  }
  const searched = searchFiles(ctx.db, ctx.user, args.query);
  if (!searched.ok) return toolError(searched.message);
  const results = searched.value.results.map((result) => ({
    name: result.name,
    path:
      result.space === "own" && result.match !== "folder"
        ? result.key.slice(ctx.user.prefix.length)
        : result.key,
    folder: result.path,
    space: result.space,
    ...(result.sharedBy === undefined ? {} : { sharedBy: result.sharedBy }),
    match: result.match,
    ...(result.snippet === undefined ? {} : { snippet: result.snippet }),
  }));
  return toolSuccess({ results, capped: searched.value.capped });
}

/** Image MIME types returned as image content, by extension. */
const IMAGE_TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * The image MIME type of an object, from its stored content type or,
 * failing that, its extension; null when it is not a supported image.
 *
 * @param contentType - stored Content-Type, if any
 * @param ext - lowercased file extension
 * @returns the image MIME type, or null
 */
function imageMimeType(contentType: string | null, ext: string): string | null {
  const stored = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (Object.values(IMAGE_TYPES_BY_EXTENSION).includes(stored)) return stored;
  return IMAGE_TYPES_BY_EXTENSION[ext] ?? null;
}

/**
 * Decode bytes as text only if they are valid UTF-8 without NUL bytes;
 * null for anything that looks binary.
 *
 * @param bytes - object body
 * @returns the text, or null
 */
function decodeStrictText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One page of text from `offset`, with the truncation footer when more
 * remains. A page never ends between the halves of a surrogate pair.
 *
 * @param text - the whole text
 * @param offset - validated start offset (≤ text length)
 * @returns the page text
 */
function textPage(text: string, offset: number): string {
  const total = text.length;
  let end = Math.min(offset + READ_PAGE_CHARS, total);
  const last = text.charCodeAt(end - 1);
  if (end < total && end - 1 > offset && last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  const page = text.slice(offset, end);
  if (end >= total) return page;
  return `${page}\n\n[Truncated: showing characters ${offset}–${end} of ${total}. Call read_file with offset=${end} to continue.]`;
}

/** `read_file`: text (paged), extracted PDF/DOCX text, or an image. */
async function readFileTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const file = parseFilePath(args.path);
  if (!file.ok) return toolError(file.error);
  const offset = args.offset ?? 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    return toolError("offset must be a non-negative integer");
  }
  const scope = resolveSpaceArg(ctx, args.space);
  if ("content" in scope) return scope;
  const path = file.path;
  const key = scope.prefix + path;
  const max = ctx.config.searchIndexMaxBytes;

  const head = await headObject(ctx.s3Client, scope.bucket, scope.prefix, key);
  if (head === null) {
    if (await scopeFolderExists(ctx, scope, path)) {
      return toolError(
        `"${path}" is a folder; use list_folder to see its contents`,
      );
    }
    return toolError(`File not found: "${path}"`);
  }
  const tooLarge = (size: number) =>
    toolError(
      `"${path}" is too large to read (${size} bytes; the limit is ${max} bytes)`,
    );
  if (head.size > max) return tooLarge(head.size);

  const { bytes, contentType } = await getObject(
    ctx.s3Client,
    scope.bucket,
    scope.prefix,
    key,
  );
  if (bytes.length > max) return tooLarge(bytes.length);
  const { name } = splitPath(path);
  const ext = extensionOf(name);

  const mimeType = imageMimeType(contentType, ext);
  if (mimeType !== null) {
    return {
      content: [
        {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType,
        },
      ],
    };
  }

  let text: string | null;
  if (ext === "pdf" || ext === "docx") {
    text = await extractText(bytes, name);
    if (text === null) {
      return toolError(
        `Could not extract text from "${path}" (the document may be corrupt or password-protected)`,
      );
    }
  } else if (extractable(name)) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } else {
    text = decodeStrictText(bytes);
    if (text === null) {
      return toolError(
        `"${path}" is a binary file (${contentType ?? "unknown type"}) and cannot be read; only text, PDF, DOCX and PNG/JPEG/GIF/WebP images are supported`,
      );
    }
  }
  if (offset > text.length) {
    return toolError(
      `offset ${offset} is beyond the end of the text (${text.length} characters)`,
    );
  }
  return { content: [{ type: "text", text: textPage(text, offset) }] };
}

/** `create_folder`: create a folder whose parent exists. */
async function createFolderTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const folder = parseFolderPath(args.path);
  if (!folder.ok) return toolError(folder.error);
  if (folder.path === "") {
    return toolError("path is required: the folder to create");
  }
  const scope = resolveSpaceArg(ctx, args.space);
  if ("content" in scope) return scope;
  const { parent, name } = splitPath(folder.path);
  if (!(await scopeFolderExists(ctx, scope, parent))) {
    return toolError(`The parent folder "${parent}" does not exist`);
  }
  const created = await createFolder(
    ctx.s3Client,
    scope,
    folderPrefix(parent),
    name,
  );
  if (!created.ok) return toolError(created.message);
  return toolSuccess({ name: created.value.name, path: created.value.prefix });
}

/** Content types guessed for written files, by extension. */
const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  svg: "image/svg+xml",
};

/** `write_file`: write UTF-8 text, refusing existing files unless asked. */
async function writeFileTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const file = parseFilePath(args.path);
  if (!file.ok) return toolError(file.error);
  if (typeof args.content !== "string") {
    return toolError("content is required and must be a string");
  }
  const overwrite = args.overwrite ?? false;
  if (typeof overwrite !== "boolean") {
    return toolError("overwrite must be a boolean");
  }
  const bytes = new TextEncoder().encode(args.content);
  if (bytes.length > WRITE_MAX_BYTES) {
    return toolError(
      `content is ${bytes.length} bytes of UTF-8; the limit is 10 MiB (${WRITE_MAX_BYTES} bytes)`,
    );
  }
  const scope = resolveSpaceArg(ctx, args.space);
  if ("content" in scope) return scope;
  const path = file.path;
  const { parent, name } = splitPath(path);
  if (!(await scopeFolderExists(ctx, scope, parent))) {
    return toolError(`The parent folder "${parent}" does not exist`);
  }
  const key = scope.prefix + path;
  const existing = await headObject(
    ctx.s3Client,
    scope.bucket,
    scope.prefix,
    key,
  );
  if (existing !== null && !overwrite) {
    return toolError(
      `A file named "${name}" already exists at "${path}"; pass overwrite: true to replace it`,
    );
  }
  const baseType =
    CONTENT_TYPES_BY_EXTENSION[extensionOf(name)] ?? "text/plain";
  await putObject(
    ctx.s3Client,
    scope.bucket,
    scope.prefix,
    key,
    bytes,
    `${baseType}; charset=utf-8`,
  );
  return toolSuccess({ path, size: bytes.length });
}

/** `move_file`: the `/api/files/move` semantics, into an existing folder. */
async function moveFileTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const file = parseFilePath(args.path);
  if (!file.ok) return toolError(file.error);
  if (args.toFolder === undefined) {
    return toolError('toFolder is required ("" for the space root)');
  }
  const toFolder = parseFolderPath(args.toFolder, "toFolder");
  if (!toFolder.ok) return toolError(toFolder.error);
  const scope = resolveSpaceArg(ctx, args.space);
  if ("content" in scope) return scope;
  if (!(await scopeFolderExists(ctx, scope, toFolder.path))) {
    return toolError(
      `The destination folder "${toFolder.path}" does not exist`,
    );
  }
  const moved = await moveFile(
    ctx.s3Client,
    ctx.db,
    scope,
    scope.prefix + file.path,
    folderPrefix(toFolder.path),
  );
  if (!moved.ok) return toolError(moved.message);
  return toolSuccess({ path: moved.value.toKey.slice(scope.prefix.length) });
}

/** Tool implementations by name. */
const HANDLERS: Record<
  string,
  (
    ctx: ToolContext,
    args: Record<string, unknown>,
  ) => ToolResult | Promise<ToolResult>
> = {
  list_spaces: listSpaces,
  list_folder: listFolderTool,
  search: searchTool,
  read_file: readFileTool,
  create_folder: createFolderTool,
  write_file: writeFileTool,
  move_file: moveFileTool,
};

/**
 * Run one tool for the signed-in user. Unknown names are the caller's
 * concern (the dispatcher rejects them as invalid params). Storage
 * failures become tool errors rather than protocol errors, so the model
 * can retry; scope violations (RangeError from the S3 scope assertion)
 * are reported as such and never reach S3.
 *
 * @param ctx - the caller and server resources
 * @param name - tool name (one of {@link TOOL_DEFINITIONS})
 * @param args - tool arguments object
 * @returns the tool result
 */
export async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (handler === undefined) return toolError(`Unknown tool: ${name}`);
  try {
    return await handler(ctx, args);
  } catch (error) {
    if (error instanceof RangeError) {
      return toolError("The path is outside the space");
    }
    console.error(`MCP tool ${name} failed`, error);
    return toolError("The storage request failed; try again later");
  }
}
