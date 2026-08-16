/**
 * Delete confirmation dialog (T048, User Story 5): shows the file name, a
 * clear warning that deletion is permanent and cannot be undone, and
 * Cancel/Delete actions. Cancelling closes the dialog without any request;
 * confirming sends the DELETE request and reports the outcome. While the
 * request is in flight the buttons are disabled and a pending state is
 * shown (constitution V: visibility of system status).
 *
 * Rebuilt on daisyUI primitives (T014): `modal modal-open` overlay,
 * `modal-box` panel and `modal-backdrop` close button (research R5), with
 * a `btn-error` Delete action. The dialog keeps `role="alertdialog"`.
 */
import { useState } from "react";
import { deleteFile } from "../api/client";
import type { ApiClientError, FileEntry } from "../api/client";

/** Props for {@link DeleteDialog}. */
export interface DeleteDialogProps {
  /** The file being deleted. */
  file: FileEntry;
  /** Called after a successful delete so the listing can refresh. */
  onDeleted: () => void;
  /** Close the dialog without further action. */
  onClose: () => void;
}

/**
 * Delete confirmation dialog.
 *
 * @param props - the file, plus deleted and close callbacks
 * @returns the delete dialog element
 */
export function DeleteDialog({ file, onDeleted, onClose }: DeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Confirm the delete: send the DELETE request, then report the outcome.
   * On success the parent refreshes the listing (removing the row) and
   * closes the dialog; on failure a clear error is shown and the listing
   * stays unchanged.
   */
  async function handleDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteFile(file.key);
      onDeleted();
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? `Could not delete "${file.name}".`);
      setDeleting(false);
    }
  }

  return (
    <div className="modal modal-open">
      <div
        className="modal-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
      >
        <h2 id="delete-dialog-title" className="text-lg font-semibold break-all">
          Delete {file.name}?
        </h2>
        <p className="py-4">
          "{file.name}" will be permanently deleted from your space. This cannot
          be undone.
        </p>

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-action">
          <button
            className="btn"
            type="button"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            className="btn btn-error"
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close"
        onClick={onClose}
      />
    </div>
  );
}
