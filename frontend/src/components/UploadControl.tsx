/**
 * Upload control for the file browser toolbar (T040): a labelled file input
 * that uploads a single file into the viewed folder with visible progress,
 * explicit success/failure feedback, and an overwrite confirmation dialog.
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
 */
import { useState } from "react";
import type { ChangeEvent } from "react";
import { SyncIcon, UploadIcon, XIcon } from "@primer/octicons-react";
import { postUploadUrl } from "../api/client";
import type { ApiClientError } from "../api/client";

/** Props for {@link UploadControl}. */
export interface UploadControlProps {
  /** Destination folder relative to the user's prefix ("" for the root). */
  folder: string;
  /** Called after a successful upload so the listing can refresh. */
  onUploaded: () => void;
  /** Called when the session expires mid-upload (re-prompts sign-in). */
  onSessionExpired?: () => void;
}

/** The upload control's state machine. */
type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string; progress: number }
  | { kind: "success"; fileName: string }
  | { kind: "error"; fileName: string; message: string }
  | { kind: "confirm"; fileName: string; file: File };

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
 * Upload control: file picker, progress indicator, success/error feedback
 * and the overwrite confirmation dialog.
 *
 * @param props - folder, refresh callback and optional session-expiry hook
 * @returns the upload control element
 */
export function UploadControl({
  folder,
  onUploaded,
  onSessionExpired,
}: UploadControlProps) {
  const [state, setState] = useState<UploadState>({ kind: "idle" });

  /**
   * Obtain a presigned URL and PUT the file to it, driving the state
   * machine. Returns true only when the upload completed.
   *
   * @param file - the file to upload
   * @param overwrite - true to replace an existing object with the same key
   * @returns true when the upload succeeded
   */
  async function performUpload(
    file: File,
    overwrite: boolean,
  ): Promise<boolean> {
    setState({ kind: "uploading", fileName: file.name, progress: 0 });
    let url: string;
    try {
      const response = await postUploadUrl(folder, file.name, overwrite);
      url = response.url;
    } catch (error) {
      const apiError = error as ApiClientError;
      if (apiError.status === 409) {
        // The object exists and overwrite was not requested: ask first.
        setState({ kind: "confirm", fileName: file.name, file });
        return false;
      }
      if (apiError.status === 401) {
        onSessionExpired?.();
        setState({
          kind: "error",
          fileName: file.name,
          message: "Your session has expired. Please sign in again.",
        });
        return false;
      }
      setState({
        kind: "error",
        fileName: file.name,
        message: apiError?.message ?? "Could not start the upload.",
      });
      return false;
    }
    try {
      await putFile(url, file, (percent) =>
        setState({ kind: "uploading", fileName: file.name, progress: percent }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Upload failed";
      setState({
        kind: "error",
        fileName: file.name,
        message: `Could not upload "${file.name}". ${detail}`,
      });
      return false;
    }
    return true;
  }

  /**
   * Start uploading the selected file. The input is cleared so the same
   * file can be chosen again (e.g. for a confirmed overwrite).
   *
   * @param event - the file input change event
   */
  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void (async () => {
      const uploaded = await performUpload(file, false);
      if (uploaded) {
        setState({ kind: "success", fileName: file.name });
        onUploaded();
      }
    })();
  }

  /**
   * Confirm the overwrite: retry the upload with the overwrite flag set.
   */
  async function handleReplace(): Promise<void> {
    if (state.kind !== "confirm") return;
    const file = state.file;
    const uploaded = await performUpload(file, true);
    if (uploaded) {
      setState({ kind: "success", fileName: file.name });
      onUploaded();
    }
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-2">
      <label className="btn cursor-pointer border-2 border-dashed rounded-lg">
        <UploadIcon aria-hidden="true" />
        Upload file
        <input
          className="sr-only"
          type="file"
          onChange={handleFileChange}
          disabled={state.kind === "uploading"}
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
          <p className="mt-1 text-sm opacity-70">
            Uploading {state.fileName}... {state.progress}%
          </p>
        </div>
      )}

      {state.kind === "success" && (
        <p className="alert alert-success w-full" role="status">
          Uploaded {state.fileName}
        </p>
      )}

      {state.kind === "error" && (
        <p className="alert alert-error w-full" role="alert">
          {state.message}
        </p>
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
            <p className="py-4">
              A file named "{state.fileName}" already exists. Replace it?
            </p>
            <div className="modal-action">
              <button
                className="btn"
                type="button"
                onClick={() => setState({ kind: "idle" })}
              >
                <XIcon aria-hidden="true" />
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void handleReplace()}
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
            onClick={() => setState({ kind: "idle" })}
          />
        </div>
      )}
    </div>
  );
}
