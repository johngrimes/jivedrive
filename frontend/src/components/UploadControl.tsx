/**
 * Upload control for the file browser toolbar (T040): a labelled
 * multi-select file input that uploads the picked files into the viewed
 * folder with visible progress, explicit success/failure feedback, and an
 * overwrite confirmation dialog.
 *
 * Rebuilt on daisyUI primitives (T012): the picker is a dashed-border
 * dropzone label, progress uses `progress progress-primary`, status
 * feedback uses alert variants, and the overwrite confirmation is a
 * `modal modal-open` + `modal-box` (research R5).
 *
 * Uploads go browser-to-storage: the backend hands out a short-lived
 * presigned PUT URL, and the file body is PUT directly with an XHR so
 * progress events are available (constitution V: visibility of system
 * status). File names are used verbatim, including spaces and special
 * characters.
 *
 * A pick of several files is uploaded as a batch (issue #12): one file at
 * a time in pick order, with the progress label counting through the
 * batch. A conflicting name pauses the batch on the confirmation dialog
 * (Skip or Replace, optionally applied to the batch's remaining
 * conflicts). A failed file does not stop the batch; an expired session
 * does. The batch ends with a single summary, and the listing refreshes
 * once if anything was uploaded.
 */
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { SkipIcon, SyncIcon, UploadIcon } from "@primer/octicons-react";
import { postUploadUrl } from "../api/client";
import type { ApiClientError, Space } from "../api/client";

/** Props for {@link UploadControl}. */
export interface UploadControlProps {
  /** Destination folder relative to the space root ("" for the root). */
  folder: string;
  /**
   * The space to upload into: `own` or `shared:<shareId>`. Keys are
   * mount-relative in a shared space (R2) and the server composes them
   * against the sharer's prefix; the control just passes the space
   * through. Defaults to the caller's own space.
   */
  space?: Space;
  /**
   * Called once after a batch in which at least one file uploaded, so the
   * listing can refresh.
   */
  onUploaded: () => void;
  /** Called when the session expires mid-upload (re-prompts sign-in). */
  onSessionExpired?: () => void;
}

/** What became of one file of a batch. */
type FileOutcome =
  | { kind: "uploaded" }
  | { kind: "skipped" }
  | { kind: "failed"; message: string };

/** The result of uploading one file: its outcome, or an expired session. */
type UploadResult = FileOutcome | { kind: "expired" };

/** The user's answer to an overwrite conflict. */
interface ConflictAnswer {
  replace: boolean;
  applyToRemaining: boolean;
}

/** The feedback shown once a batch has finished. */
interface BatchSummary {
  tone: "success" | "info" | "error";
  lines: string[];
}

/** The upload control's state machine. */
type UploadState =
  | { kind: "idle" }
  | {
      kind: "uploading";
      fileName: string;
      position: number;
      total: number;
      progress: number;
    }
  | {
      kind: "confirm";
      fileName: string;
      laterFiles: boolean;
      applyToRemaining: boolean;
    }
  | { kind: "done"; summary: BatchSummary };

const SESSION_EXPIRED_MESSAGE =
  "Your session has expired. Please sign in again.";

/** Alert variant per summary tone. */
const TONE_CLASS: Record<BatchSummary["tone"], string> = {
  success: "alert-success",
  info: "alert-info",
  error: "alert-error",
};

/**
 * Upload a file body to a presigned URL with progress reporting.
 *
 * @param url - the presigned PUT URL from the backend
 * @param file - the file to upload
 * @param onProgress - called with a 0-100 percent value during the upload
 * @returns a promise resolving on a 2xx response
 * @throws {Error} on network failure or a non-2xx response
 */
function putFile(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

/**
 * Upload one file: obtain a presigned URL and PUT its body there. When the
 * name already exists, `confirmOverwrite` decides between skipping the
 * file and retrying with overwrite consent.
 *
 * @param folder - destination folder relative to the space root
 * @param space - the space to upload into
 * @param file - the file to upload
 * @param overwrite - true to replace an existing object with the same name
 * @param confirmOverwrite - asked on a name conflict; resolves true to replace
 * @param onProgress - called with a 0-100 percent value, from 0 at the start
 * @returns `expired` on a 401, otherwise the file's outcome
 */
async function uploadFile(
  folder: string,
  space: Space,
  file: File,
  overwrite: boolean,
  confirmOverwrite: () => Promise<boolean>,
  onProgress: (percent: number) => void,
): Promise<UploadResult> {
  onProgress(0);
  let url: string;
  try {
    url = (await postUploadUrl(folder, file.name, overwrite, space)).url;
  } catch (error) {
    const apiError = error as Partial<ApiClientError>;
    if (apiError.status === 409 && !overwrite) {
      if (!(await confirmOverwrite())) return { kind: "skipped" };
      return uploadFile(
        folder,
        space,
        file,
        true,
        confirmOverwrite,
        onProgress,
      );
    }
    if (apiError.status === 401) return { kind: "expired" };
    return {
      kind: "failed",
      message: apiError.message || "Could not start the upload.",
    };
  }
  try {
    await putFile(url, file, onProgress);
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "Upload failed",
    };
  }
  return { kind: "uploaded" };
}

/**
 * Pluralise a file count, e.g. "1 file", "3 files".
 *
 * @param count - the number of files
 * @returns the count with its noun
 */
function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * Summarise a finished batch. A single-file batch names the file; a
 * larger batch reports counts, and on any failure lists each failed file
 * with its reason under an "Uploaded N of M files" headline.
 *
 * @param files - every file picked for the batch, in order
 * @param outcomes - the outcome of each attempted file, in order (shorter
 *   than `files` when the session expired)
 * @param expired - true when the session expired and stopped the batch
 * @returns the summary to show
 */
function summariseBatch(
  files: File[],
  outcomes: FileOutcome[],
  expired: boolean,
): BatchSummary {
  const uploaded = outcomes.filter((o) => o.kind === "uploaded").length;
  const skipped = outcomes.filter((o) => o.kind === "skipped").length;
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.kind === "failed"
      ? [`Could not upload "${files[index]?.name}". ${outcome.message}`]
      : [],
  );
  if (expired) failures.push(SESSION_EXPIRED_MESSAGE);

  if (files.length === 1) {
    const name = files[0]?.name;
    if (failures.length > 0) return { tone: "error", lines: failures };
    return uploaded === 1
      ? { tone: "success", lines: [`Uploaded ${name}`] }
      : { tone: "info", lines: [`Skipped ${name}`] };
  }

  const skippedSuffix = skipped > 0 ? `, skipped ${skipped}` : "";
  if (failures.length > 0) {
    return {
      tone: "error",
      lines: [
        `Uploaded ${uploaded} of ${fileCount(files.length)}${skippedSuffix}`,
        ...failures,
      ],
    };
  }
  return uploaded > 0
    ? {
        tone: "success",
        lines: [`Uploaded ${fileCount(uploaded)}${skippedSuffix}`],
      }
    : { tone: "info", lines: [`Skipped ${fileCount(skipped)}`] };
}

/**
 * Upload control: multi-select file picker, progress indicator,
 * success/error summary and the overwrite confirmation dialog.
 *
 * @param props - folder, space, refresh callback and optional session-expiry hook
 * @returns the upload control element
 */
export function UploadControl({
  folder,
  space = "own",
  onUploaded,
  onSessionExpired,
}: UploadControlProps) {
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  // Resolves the batch's pending conflict question; set while the
  // confirmation dialog is open.
  const answerConflict = useRef<((answer: ConflictAnswer) => void) | null>(
    null,
  );

  /**
   * Open the confirmation dialog and wait for the user's answer.
   *
   * @param fileName - the conflicting file's name
   * @param laterFiles - true when files remain after this one, so the
   *   answer can be applied to them
   * @returns the user's answer
   */
  function askConflict(
    fileName: string,
    laterFiles: boolean,
  ): Promise<ConflictAnswer> {
    const { promise, resolve } = Promise.withResolvers<ConflictAnswer>();
    answerConflict.current = resolve;
    setState({
      kind: "confirm",
      fileName,
      laterFiles,
      applyToRemaining: false,
    });
    return promise;
  }

  /**
   * Answer the open conflict question.
   *
   * @param replace - true to replace the existing file, false to skip it
   */
  function answer(replace: boolean): void {
    if (state.kind !== "confirm") return;
    const resolve = answerConflict.current;
    answerConflict.current = null;
    resolve?.({ replace, applyToRemaining: state.applyToRemaining });
  }

  /**
   * Upload the picked files one at a time, resolving conflicts with the
   * user, then show the summary and refresh the listing if anything was
   * uploaded.
   *
   * @param files - the picked files, in pick order
   */
  async function uploadBatch(files: File[]): Promise<void> {
    const outcomes: FileOutcome[] = [];
    // The answer applied to every remaining conflict once the user ticks
    // "Apply to remaining conflicts"; null means ask each time.
    let standingReplace: boolean | null = null;
    let expired = false;

    for (const [index, file] of files.entries()) {
      const showProgress = (progress: number): void =>
        setState({
          kind: "uploading",
          fileName: file.name,
          position: index + 1,
          total: files.length,
          progress,
        });
      // Ask about this file's conflict unless the user has already chosen
      // an answer for the rest of the batch.
      const confirmOverwrite = async (): Promise<boolean> => {
        if (standingReplace !== null) return standingReplace;
        const reply = await askConflict(file.name, index < files.length - 1);
        if (reply.applyToRemaining) standingReplace = reply.replace;
        return reply.replace;
      };
      const result = await uploadFile(
        folder,
        space,
        file,
        false,
        confirmOverwrite,
        showProgress,
      );
      if (result.kind === "expired") {
        expired = true;
        break;
      }
      outcomes.push(result);
    }

    if (expired) onSessionExpired?.();
    if (outcomes.some((outcome) => outcome.kind === "uploaded")) onUploaded();
    setState({
      kind: "done",
      summary: summariseBatch(files, outcomes, expired),
    });
  }

  /**
   * Start uploading the picked files. The input is cleared so the same
   * files can be chosen again (e.g. after skipping a conflict).
   *
   * @param event - the file input change event
   */
  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    void uploadBatch(files);
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-2">
      <label className="btn btn-primary cursor-pointer border-2 border-dashed rounded-lg">
        <UploadIcon aria-hidden="true" />
        Upload files
        <input
          className="sr-only"
          type="file"
          multiple
          onChange={handleFileChange}
          disabled={state.kind === "uploading" || state.kind === "confirm"}
        />
      </label>

      {state.kind === "uploading" && (
        <div className="w-full" role="status">
          <progress
            className="progress progress-primary w-full"
            max={100}
            value={state.progress}
            aria-label={`Uploading ${state.fileName}`}
          />
          <p className="mt-1 text-sm opacity-70 wrap-anywhere">
            Uploading {state.fileName}
            {state.total > 1 &&
              ` (${state.position} of ${state.total})`}... {state.progress}%
          </p>
        </div>
      )}

      {state.kind === "done" && (
        <div
          className={`alert ${TONE_CLASS[state.summary.tone]} w-full`}
          role={state.summary.tone === "error" ? "alert" : "status"}
        >
          <div className="min-w-0 wrap-anywhere">
            {state.summary.lines.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        </div>
      )}

      {state.kind === "confirm" && (
        <div className="modal modal-open">
          <div
            className="modal-box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="upload-confirm-title"
          >
            <h2 id="upload-confirm-title" className="text-lg font-semibold">
              Replace file?
            </h2>
            <p className="py-4 wrap-anywhere">
              A file named "{state.fileName}" already exists. Replace it?
            </p>
            {state.laterFiles && (
              <label className="label min-h-11 cursor-pointer gap-2">
                <input
                  className="checkbox checkbox-primary"
                  type="checkbox"
                  checked={state.applyToRemaining}
                  onChange={(event) => {
                    const applyToRemaining = event.target.checked;
                    setState((current) =>
                      current.kind === "confirm"
                        ? { ...current, applyToRemaining }
                        : current,
                    );
                  }}
                />
                Apply to remaining conflicts
              </label>
            )}
            <div className="modal-action">
              <button
                className="btn"
                type="button"
                onClick={() => answer(false)}
              >
                <SkipIcon aria-hidden="true" />
                Skip
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => answer(true)}
              >
                <SyncIcon aria-hidden="true" />
                Replace
              </button>
            </div>
          </div>
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => answer(false)}
          />
        </div>
      )}
    </div>
  );
}
