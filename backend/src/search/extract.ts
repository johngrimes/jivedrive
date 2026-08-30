/**
 * Text extraction for the search index (007-file-search): turns an
 * object's bytes plus its name into indexable text. Plain text-like
 * files are UTF-8-decoded lossily; PDFs go through `unpdf` (serverless
 * pdf.js) and DOCX files through `mammoth`. Everything else — and any
 * extraction failure (corrupt or password-protected documents) — yields
 * null so the scan degrades the file to name-only indexing without
 * surfacing errors (FR-008).
 */
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { extractRawText } from "mammoth";

/**
 * Upper bound on the extracted text kept per document, in characters.
 * A size-capped input can still expand pathologically in some PDFs, so
 * truncation bounds each index row's size (data-model.md validation
 * rules).
 */
export const MAX_EXTRACTED_TEXT_CHARS = 1024 * 1024;

/**
 * Extensions extracted as plain UTF-8 text (FR-008 "plain text"):
 * documents (txt, md, csv, json, …), configuration, logs, and the common
 * source-code extensions. Extension-less names (Dockerfile, Makefile)
 * are not matched — the extension table is the whole contract.
 */
const TEXT_EXTENSIONS = new Set([
  // Documents and data
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "log",
  // Web
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "graphql",
  "proto",
  // Source code
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "swift",
  "kt",
  "kts",
  "scala",
  "php",
  "pl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "r",
  "lua",
  "dart",
  "vue",
  "svelte",
]);

/** The lowercased extension of a file name ("" when it has none). */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Strip NUL bytes and cap the text at {@link MAX_EXTRACTED_TEXT_CHARS}.
 *
 * @param text - raw extracted text
 * @returns the normalised text
 */
function normalize(text: string): string {
  const stripped = text.replace(/\0/g, "");
  return stripped.length > MAX_EXTRACTED_TEXT_CHARS
    ? stripped.slice(0, MAX_EXTRACTED_TEXT_CHARS)
    : stripped;
}

/**
 * Decode bytes as UTF-8 lossily: invalid sequences become U+FFFD
 * replacement characters instead of throwing (R: "plain text" means
 * UTF-8-decodable text files; near-miss binaries still yield text).
 *
 * @param bytes - the object body
 * @returns the decoded string
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Extract indexable text from an object body based on its file name.
 *
 * Returns null for unsupported types (anything that is not text-like,
 * PDF or DOCX) and for any extraction failure — corrupt,
 * password-protected, or malformed documents never break the caller
 * (FR-008, spec edge cases). Text is always NUL-stripped and truncated
 * to {@link MAX_EXTRACTED_TEXT_CHARS}. The size cap itself is the
 * caller's decision (the scan skips oversized downloads); this function
 * only bounds the text it returns.
 *
 * @param buffer - the object body
 * @param fileName - the object's name; the extension selects the handler
 * @returns the extracted text, or null when nothing can be extracted
 */
export async function extractText(
  buffer: Uint8Array,
  fileName: string,
): Promise<string | null> {
  const ext = extensionOf(fileName);
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      return normalize(decodeUtf8(buffer));
    }
    if (ext === "pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractPdfText(pdf, { mergePages: true });
      return normalize(text);
    }
    if (ext === "docx") {
      const { value } = await extractRawText({ buffer: Buffer.from(buffer) });
      return normalize(value);
    }
    return null;
  } catch {
    return null;
  }
}
