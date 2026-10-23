/**
 * New-folder control for the file browser toolbar (issue #11): a "New
 * folder" button opening a daisyUI modal (`modal modal-open` +
 * `modal-box`, as DeleteDialog) with a name field. Creating sends one
 * request; while it is in flight the dialog shows a pending state, a
 * failure (e.g. the name is taken) is shown inside the dialog with the
 * name kept for correction, and success closes the dialog, reports the
 * created folder and asks the parent to refresh the listing
 * (constitution V: visibility of system status).
 *
 * The server trims the name and validates it; the control only requires
 * a non-blank name before enabling Create.
 *
 * The control renders as a fragment so its parts join the toolbar's
 * wrapping flex row: the button sits beside the other toolbar actions and
 * the success message (`order-last w-full`) takes a full-width line below
 * them instead of wedging between buttons on a narrow viewport.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { FileDirectoryIcon, PlusIcon, XIcon } from "@primer/octicons-react";
import { createFolder } from "../api/client";
import type { ApiClientError, Space } from "../api/client";

/** Props for {@link NewFolderControl}. */
export interface NewFolderControlProps {
  /** Parent folder relative to the space root ("" for the root). */
  folder: string;
  /**
   * The space to create in: `own` or `shared:<shareId>`. The server
   * composes the parent folder against the space's scope. Defaults to
   * the caller's own space.
   */
  space?: Space;
  /** Called after a successful create so the listing can refresh. */
  onCreated: () => void;
  /** Called when the session has expired (re-prompts sign-in). */
  onSessionExpired?: () => void;
}

/** The control's state machine. */
type NewFolderState =
  | { kind: "idle" }
  | { kind: "open"; name: string; pending: boolean; error: string | null }
  | { kind: "created"; name: string };

/**
 * New-folder control: toolbar button, name dialog, and success feedback.
 *
 * @param props - parent folder, space, refresh callback and optional
 *   session-expiry hook
 * @returns the new-folder control element
 */
export function NewFolderControl({
  folder,
  space = "own",
  onCreated,
  onSessionExpired,
}: NewFolderControlProps) {
  const [state, setState] = useState<NewFolderState>({ kind: "idle" });

  /**
   * Submit the dialog: create the folder, then close and report success,
   * or keep the dialog open with the server's error.
   *
   * @param event - the form submit event
   */
  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind !== "open" || state.pending || state.name.trim() === "") {
      return;
    }
    const { name } = state;
    setState({ kind: "open", name, pending: true, error: null });
    try {
      const created = await createFolder(folder, name, space);
      setState({ kind: "created", name: created.name });
      onCreated();
    } catch (err) {
      const apiError = err as ApiClientError;
      if (apiError.status === 401) onSessionExpired?.();
      setState({
        kind: "open",
        name,
        pending: false,
        error:
          apiError.status === 401
            ? "Your session has expired. Please sign in again."
            : apiError.message || "Could not create the folder.",
      });
    }
  }

  const pending = state.kind === "open" && state.pending;
  const close = () => {
    if (!pending) setState({ kind: "idle" });
  };

  return (
    <>
      <button
        className="btn"
        type="button"
        onClick={() =>
          setState({ kind: "open", name: "", pending: false, error: null })
        }
      >
        <PlusIcon aria-hidden="true" />
        New folder
      </button>

      {state.kind === "created" && (
        <p
          className="alert alert-success order-last w-full break-all"
          role="status"
        >
          Created folder "{state.name}"
        </p>
      )}

      {state.kind === "open" && (
        <div className="modal modal-open">
          <form
            className="modal-box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-folder-title"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <h2 id="new-folder-title" className="text-lg font-semibold">
              New folder
            </h2>
            <label className="input input-bordered mt-4 flex w-full items-center gap-2 min-h-11">
              <FileDirectoryIcon aria-hidden="true" />
              <input
                className="grow"
                type="text"
                aria-label="Folder name"
                placeholder="Folder name"
                autoFocus
                value={state.name}
                disabled={state.pending}
                onChange={(event) =>
                  setState({ ...state, name: event.target.value })
                }
              />
            </label>

            {state.error && (
              <p className="alert alert-error mt-4 break-all" role="alert">
                {state.error}
              </p>
            )}

            <div className="modal-action">
              <button
                className="btn"
                type="button"
                onClick={close}
                disabled={state.pending}
              >
                <XIcon aria-hidden="true" />
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={state.pending || state.name.trim() === ""}
              >
                <FileDirectoryIcon aria-hidden="true" />
                {state.pending ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={close}
          />
        </div>
      )}
    </>
  );
}
