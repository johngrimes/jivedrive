/**
 * Path validation for the MCP tools. Tool paths are relative to a
 * space's root and `/`-separated; they never start with `/`, and every
 * segment is non-empty and not `.` or `..`. Backslashes and control
 * characters are refused outright, so no client-side path convention can
 * smuggle a traversal past the check. A validated path composed with the
 * scope prefix therefore always stays inside the scope (constitution IV);
 * the S3 helpers assert it again before any call.
 */

/** A validated path, or the reason it was refused. */
export type PathResult =
  { ok: true; path: string } | { ok: false; error: string };

/**
 * Validate the segments of a path that is known to be non-empty and to
 * carry no trailing "/".
 *
 * @param path - candidate path
 * @param label - argument name for error messages
 * @returns the path, or the reason it was refused
 */
function checkSegments(path: string, label: string): PathResult {
  if (path.startsWith("/")) {
    return {
      ok: false,
      error: `${label} must be relative to the space root and must not start with "/" (use "" for the root)`,
    };
  }
  if (path.includes("\\")) {
    return { ok: false, error: `${label} must use "/" separators, not "\\"` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return { ok: false, error: `${label} must not contain control characters` };
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return {
        ok: false,
        error: `${label} must not contain empty, "." or ".." segments`,
      };
    }
  }
  return { ok: true, path };
}

/**
 * Validate a folder path. "" is the space root; one trailing "/" is
 * accepted and dropped.
 *
 * @param raw - the argument value (undefined means the root)
 * @param label - argument name for error messages
 * @returns the folder path without a trailing "/" ("" for the root)
 */
export function parseFolderPath(raw: unknown, label = "path"): PathResult {
  if (raw === undefined) return { ok: true, path: "" };
  if (typeof raw !== "string") {
    return { ok: false, error: `${label} must be a string` };
  }
  if (raw === "") return { ok: true, path: "" };
  return checkSegments(raw.endsWith("/") ? raw.slice(0, -1) : raw, label);
}

/**
 * Validate a file path: non-empty, with no trailing "/".
 *
 * @param raw - the argument value
 * @param label - argument name for error messages
 * @returns the file path
 */
export function parseFilePath(raw: unknown, label = "path"): PathResult {
  if (typeof raw !== "string" || raw === "") {
    return {
      ok: false,
      error: `${label} is required and must be a non-empty string`,
    };
  }
  if (raw.endsWith("/")) {
    return { ok: false, error: `${label} must name a file, not a folder` };
  }
  return checkSegments(raw, label);
}

/**
 * The scope-relative prefix of a validated folder path: "" for the root,
 * otherwise the path plus a trailing "/".
 *
 * @param folder - validated folder path (no trailing "/")
 * @returns the folder prefix
 */
export function folderPrefix(folder: string): string {
  return folder === "" ? "" : folder + "/";
}

/**
 * Split a validated path into its parent folder ("" at the root) and
 * base name.
 *
 * @param path - validated file or folder path (no trailing "/")
 * @returns parent folder and base name
 */
export function splitPath(path: string): { parent: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { parent: "", name: path }
    : { parent: path.slice(0, slash), name: path.slice(slash + 1) };
}
