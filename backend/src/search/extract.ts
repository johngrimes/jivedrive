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
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Whether {@link extractText} can produce text for this file name: the
 * plain-text extension table plus PDF and DOCX. The scan uses this to
 * skip downloading objects it could only discard — their content never
 * reaches the index, so they are indexed name-only without a GET.
 *
 * @param fileName - the object's base name
 * @returns true when an extraction handler exists for the extension
 */
export function extractable(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return TEXT_EXTENSIONS.has(ext) || ext === "pdf" || ext === "docx";
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
  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      return normalize(decodeUtf8(buffer));
    } catch {
      return null;
    }
  }
  if (ext !== "pdf" && ext !== "docx") {
    return null;
  }
  try {
    const text = await runExtractionWorker(buffer, fileName);
    return text === null ? null : normalize(text);
  } catch {
    return null;
  }
}

/**
 * Extract without any threading concerns: the pure, in-thread handler
 * the extraction worker runs, and the fallback shape every caller of
 * {@link extractText} relies on (null on any failure, FR-008). Kept
 * separate from {@link extractText} so the worker entry can import it
 * without a runtime cycle.
 *
 * @param buffer - the object body
 * @param fileName - the object's name; the extension selects the handler
 * @returns the extracted, normalised text, or null on any failure
 */
export async function extractTextPure(
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
      // unpdf's PDFDocumentProxy exposes teardown only via its loading
      // task (the proxy itself has no destroy in the bundled build).
      const pdfjsTask = (
        pdf as unknown as {
          loadingTask: { destroy(): Promise<void> };
        }
      ).loadingTask;
      try {
        const { text } = await extractPdfText(pdf, { mergePages: true });
        return normalize(text);
      } finally {
        // Release pdf.js's parsed page structures now instead of at
        // some future GC: a scan over many PDFs retained every parsed
        // document until then and breached the container's memory
        // limit (prod OOMKill, 2026-08-30).
        void pdfjsTask.destroy();
      }
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

/**
 * Per-job timeout for the extraction worker. Generous: a capped 10 MB
 * PDF parses in a few seconds; the timeout only exists so a wedged
 * parse cannot stall the scan forever (the job degrades to name-only
 * indexing, FR-008).
 */
const EXTRACTION_TIMEOUT_MS = 120_000;

/**
 * Worker recycle interval: pdf.js retains per-document structures
 * even after destroy() until GC runs; recycling the worker after a
 * bounded number of heavy jobs makes the worst-case retained heap a
 * constant instead of a function of the space's PDF count.
 */
const WORKER_RECYCLE_JOBS = 50;

let worker: Worker | null = null;
let jobsSinceRecycle = 0;
let nextJobId = 1;
const pending = new Map<
  number,
  { resolve: (text: string | null) => void; reject: (err: unknown) => void }
>();

interface WorkerResult {
  id: number;
  text: string | null;
  error: string | null;
}

function failAllPending(reason: string): void {
  const jobs = [...pending.values()];
  pending.clear();
  for (const job of jobs) {
    job.reject(new Error(reason));
  }
}

function getWorker(): Worker {
  if (worker === null) {
    jobsSinceRecycle = 0;
    worker = new Worker(new URL("./extract-worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      const job = pending.get(event.data.id);
      if (job === undefined) {
        return;
      }
      pending.delete(event.data.id);
      if (event.data.error !== null) {
        job.reject(new Error(event.data.error));
      } else {
        job.resolve(event.data.text);
      }
    };
    worker.onerror = () => {
      failAllPending("extraction worker crashed");
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/**
 * Run one heavy (PDF/DOCX) extraction in the worker. The buffer is
 * copied by structured clone (never transferred), so the caller keeps
 * ownership. Jobs queue inside the worker and run one at a time.
 *
 * @param buffer - the object body
 * @param fileName - the object's name; the extension selects the handler
 * @returns the extracted, normalised text, or null on any failure
 */
async function runExtractionWorker(
  buffer: Uint8Array,
  fileName: string,
): Promise<string | null> {
  const id = nextJobId++;
  const w = getWorker();
  const result = new Promise<string | null>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, buffer, fileName });
  });
  const timeout = setTimeout(() => {
    // delete-first guarantees the timed-out job settles exactly once,
    // while failAllPending fast-fails its queued siblings instead of
    // leaving them to hang until their own timeouts.
    if (pending.delete(id)) {
      // A wedged parse is indistinguishable from a slow one; recycle
      // the worker so later jobs are not queued behind it.
      worker?.terminate();
      worker = null;
      failAllPending("extraction timed out");
    }
  }, EXTRACTION_TIMEOUT_MS);
  try {
    return await result;
  } finally {
    clearTimeout(timeout);
    jobsSinceRecycle += 1;
    if (jobsSinceRecycle >= WORKER_RECYCLE_JOBS && pending.size === 0) {
      worker?.terminate();
      worker = null;
    }
  }
}
