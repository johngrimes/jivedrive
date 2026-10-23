/**
 * Move dialog (issue #14): a modal folder browser for moving one file to
 * another folder of the same space. It opens at the file's current
 * folder, shows a breadcrumb of the destination and its subfolders, and
 * moves on "Move here". Destinations are existing folders (plus the
 * space root) only; "Move here" is disabled while the destination is the
 * file's own folder. A refused move (e.g. a name collision) is shown in
 * the dialog, which stays open (constitution V).
 *
 * Built on the same daisyUI modal primitives as DeleteDialog: `modal
 * modal-open` overlay, `modal-box` panel and `modal-backdrop` close
 * button. Mobile-first: every control is a min-h-11 touch target and long
 * folder names truncate instead of widening the dialog.
 */
import { useEffect, useState } from "react";
import {
  FileDirectoryFillIcon,
  FileMovedIcon,
  HomeIcon,
  XIcon,
} from "@primer/octicons-react";
import { listFiles, moveFile } from "../api/client";
import type { ApiClientError, FileEntry, Space } from "../api/client";

/** Props for {@link MoveDialog}. */
export interface MoveDialogProps {
  /** The file being moved. */
  file: FileEntry;
  /**
   * The space the file lives in: `own` or `shared:<shareId>`. Moves stay
   * within this space. Defaults to the caller's own space.
   */
  space?: Space;
  /**
   * The file's current folder relative to the space root ("" for the
   * root). The picker starts here.
   */
  folder: string;
  /** Label of the space root crumb ("Home", or the shared mount's name). */
  rootLabel: string;
  /**
   * Called after a successful move with the destination folder relative
   * to the space root ("" for the root, otherwise with a trailing slash).
   */
  onMoved: (folder: string) => void;
  /** Close the dialog without further action. */
  onClose: () => void;
}

/**
 * What the folder list is showing. Done and error states are tagged with
 * the folder and retry key they belong to, so navigating or retrying
 * renders as loading without a setState call inside the effect.
 */
type FolderState =
  | { status: "loading" }
  | {
      status: "done";
      folder: string;
      retry: number;
      folders: string[];
      nextCursor: string | null;
    }
  | { status: "error"; folder: string; retry: number; message: string };

/**
 * Normalise a folder path to the listing form: "" for the root, else
 * exactly one trailing slash.
 *
 * @param folder - a folder path, with or without a trailing slash
 * @returns the normalised folder
 */
function normaliseFolder(folder: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

/**
 * Extract a readable message from an unknown error.
 *
 * @param err - the caught error
 * @param fallback - message used when the error carries none
 * @returns the message to show
 */
function messageOf(err: unknown, fallback: string): string {
  return (err as ApiClientError | undefined)?.message || fallback;
}

/**
 * Modal folder picker that moves a file within its space.
 *
 * @param props - the file, its space and folder, plus callbacks
 * @returns the move dialog element
 */
export function MoveDialog({
  file,
  space = "own",
  folder,
  rootLabel,
  onMoved,
  onClose,
}: MoveDialogProps) {
  const sourceFolder = normaliseFolder(folder);
  const [destination, setDestination] = useState(sourceFolder);
  const [retryKey, setRetryKey] = useState(0);
  const [fetched, setFetched] = useState<FolderState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list shows loading while the fetched page belongs to an older
  // destination or retry than the one currently requested.
  const state =
    fetched.status !== "loading" &&
    (fetched.folder !== destination || fetched.retry !== retryKey)
      ? ({ status: "loading" } as const)
      : fetched;

  useEffect(() => {
    let cancelled = false;
    listFiles(destination, space)
      .then((page) => {
        if (cancelled) return;
        setFetched({
          status: "done",
          folder: destination,
          retry: retryKey,
          folders: page.folders,
          nextCursor: page.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetched({
          status: "error",
          folder: destination,
          retry: retryKey,
          message: messageOf(err, "Could not load folders."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [destination, space, retryKey]);

  /**
   * Show another folder's subfolders as the destination.
   *
   * @param next - the folder relative to the space root ("" for the root)
   */
  function browse(next: string): void {
    setError(null);
    setDestination(next);
  }

  /**
   * Append the next page of subfolders of the current destination. A
   * failure turns the list into its error state, whose Retry reloads it.
   * A page or failure that lands after the user navigated elsewhere (or
   * retried) is dropped, so it never clobbers the newer listing.
   */
  async function loadMore(): Promise<void> {
    if (state.status !== "done" || !state.nextCursor || loadingMore) return;
    const { folder: pageFolder, retry, nextCursor } = state;
    const isSamePage = (prev: FolderState): boolean =>
      prev.status === "done" &&
      prev.folder === pageFolder &&
      prev.retry === retry &&
      prev.nextCursor === nextCursor;
    setLoadingMore(true);
    try {
      const page = await listFiles(pageFolder, space, nextCursor);
      setFetched((prev) =>
        prev.status === "done" && isSamePage(prev)
          ? {
              ...prev,
              folders: [...prev.folders, ...page.folders],
              nextCursor: page.nextCursor,
            }
          : prev,
      );
    } catch (err) {
      setFetched((prev) =>
        isSamePage(prev)
          ? {
              status: "error",
              folder: pageFolder,
              retry,
              message: messageOf(err, "Could not load folders."),
            }
          : prev,
      );
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Confirm the move into the current destination. On success the parent
   * closes the dialog and refreshes; on failure the server's error is
   * shown and the dialog stays open.
   */
  async function handleMove(): Promise<void> {
    if (moving || destination === sourceFolder) return;
    setMoving(true);
    setError(null);
    try {
      await moveFile(file.key, destination, space);
      onMoved(destination);
    } catch (err) {
      setError(messageOf(err, `Could not move "${file.name}".`));
      setMoving(false);
    }
  }

  /** Close unless a move is in flight. */
  function close(): void {
    if (!moving) onClose();
  }

  const segments = destination.split("/").filter((segment) => segment !== "");
  const crumbClass =
    "link inline-flex min-h-11 items-center gap-1 no-underline disabled:pointer-events-none";

  return (
    <div className="modal modal-open">
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-dialog-title"
      >
        <h2 id="move-dialog-title" className="text-lg font-semibold break-all">
          Move {file.name}
        </h2>
        <p className="py-2 text-sm opacity-70">Choose a destination folder.</p>

        <nav className="breadcrumbs" aria-label="Destination folder">
          <ul className="flex-wrap">
            <li>
              {segments.length === 0 ? (
                <strong
                  className="inline-flex min-h-11 items-center gap-1 break-all"
                  aria-current="location"
                >
                  {space === "own" && <HomeIcon aria-hidden="true" />}
                  {rootLabel}
                </strong>
              ) : (
                <button
                  type="button"
                  className={crumbClass}
                  onClick={() => browse("")}
                  disabled={moving}
                >
                  {space === "own" && <HomeIcon aria-hidden="true" />}
                  {rootLabel}
                </button>
              )}
            </li>
            {segments.map((segment, index) => {
              const target = segments.slice(0, index + 1).join("/") + "/";
              return (
                <li key={target}>
                  {index === segments.length - 1 ? (
                    <strong
                      className="inline-flex min-h-11 items-center break-all"
                      aria-current="location"
                    >
                      {segment}
                    </strong>
                  ) : (
                    <button
                      type="button"
                      className={crumbClass}
                      onClick={() => browse(target)}
                      disabled={moving}
                    >
                      {segment}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        {state.status === "loading" && (
          <p
            className="flex min-h-11 items-center gap-2 text-sm opacity-70"
            role="status"
          >
            <span className="loading loading-spinner loading-sm" />
            Loading folders...
          </p>
        )}

        {state.status === "error" && (
          <div className="alert alert-error" role="alert">
            <span>{state.message}</span>
            <button
              className="btn min-h-11"
              type="button"
              onClick={() => setRetryKey((key) => key + 1)}
            >
              Retry
            </button>
          </div>
        )}

        {state.status === "done" &&
          state.folders.length === 0 &&
          !state.nextCursor && (
            <p className="flex min-h-11 items-center text-sm opacity-70">
              No subfolders here.
            </p>
          )}

        {state.status === "done" && state.folders.length > 0 && (
          <ul
            className="max-h-64 overflow-y-auto rounded-box bg-base-200"
            aria-label="Folders"
          >
            {state.folders.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 w-full justify-start font-normal"
                  onClick={() => browse(`${destination}${name}/`)}
                  disabled={moving}
                >
                  <FileDirectoryFillIcon
                    aria-hidden="true"
                    className="shrink-0"
                  />
                  <span className="min-w-0 truncate">{name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {state.status === "done" && state.nextCursor && (
          <div className="mt-2 flex justify-center">
            <button
              className="btn btn-sm min-h-11"
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore || moving}
            >
              {loadingMore ? "Loading..." : "Load more folders"}
            </button>
          </div>
        )}

        {error && (
          <p className="alert alert-error mt-4 break-all" role="alert">
            {error}
          </p>
        )}

        <div className="modal-action flex-wrap">
          <button
            className="btn min-h-11"
            type="button"
            onClick={close}
            disabled={moving}
          >
            <XIcon aria-hidden="true" />
            Cancel
          </button>
          <button
            className="btn btn-primary min-h-11"
            type="button"
            onClick={() => void handleMove()}
            disabled={moving || destination === sourceFolder}
          >
            <FileMovedIcon aria-hidden="true" />
            {moving ? "Moving..." : "Move here"}
          </button>
        </div>
      </div>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close"
        onClick={close}
      />
    </div>
  );
}
