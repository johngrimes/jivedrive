/**
 * Delete confirmation dialog (T048, User Story 5): shows the file name, a
 * clear warning that deletion is permanent and cannot be undone, and
 * Cancel/Delete actions. Cancelling closes the dialog without any request;
 * confirming sends the DELETE request and reports the outcome. While the
 * request is in flight the buttons are disabled and a pending state is
 * shown (constitution V: visibility of system status).
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
    <div className="modal-overlay">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
      >
        <h2 id="delete-dialog-title" className="confirm-dialog-title">
          Delete {file.name}?
        </h2>
        <p className="confirm-dialog-text">
          "{file.name}" will be permanently deleted from your space. This cannot
          be undone.
        </p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="confirm-dialog-actions">
          <button
            className="button button-small"
            type="button"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            className="button button-small button-danger"
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
