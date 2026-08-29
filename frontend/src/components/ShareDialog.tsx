/**
 * Share dialog for a folder (R13, T019): a searchable recipient picker
 * (debounced GET /api/users), an add-recipient submit (createShare), and
 * the folder's live recipient list (outgoing shares filtered by folder)
 * with per-recipient share dates and a Revoke action (revokeShare via the
 * client, followed by a list refresh; the full revoke error-surfacing
 * e2e lands with User Story 4 in Phase 6, so the button is never dead).
 *
 * Duplicate shares (409 `already_shared`) and self-shares (400
 * `cannot_share_with_self`) surface visibly (constitution V). The modal
 * follows the ShareModal pattern: `modal modal-open`, `modal-box`,
 * `role="alertdialog"`, `modal-backdrop` and labelled controls.
 */
import { useEffect, useState } from "react";
import { PersonAddIcon, PersonIcon, TrashIcon } from "@primer/octicons-react";
import { createShare, revokeShare, searchUsers } from "../api/client";
import type { ApiClientError, ShareOutgoing, UserSummary } from "../api/client";

/** Debounce delay for the recipient search input, in milliseconds. */
const SEARCH_DEBOUNCE_MS = 300;

/** Props for {@link ShareDialog}. */
export interface ShareDialogProps {
  /** The folder being shared, normalised with a trailing slash ("projects/"). */
  folder: string;
  /** Base name shown in the title ("projects"). */
  folderName: string;
  /** All of the caller's outgoing shares; filtered to {@link folder}. */
  shares: ShareOutgoing[];
  /** Close the dialog. */
  onClose: () => void;
  /** Re-fetch the shares list after a successful add or revoke. */
  onSharesChanged: () => void;
}

/** Extract a readable message from an unknown error. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}

/**
 * Share dialog: pick a recipient by username, add them, and manage the
 * folder's current recipients.
 *
 * @param props - folder, its outgoing shares, and close/refresh callbacks
 * @returns the share dialog element
 */
export function ShareDialog({
  folder,
  folderName,
  shares,
  onClose,
  onSharesChanged,
}: ShareDialogProps) {
  const [query, setQuery] = useState("");
  /** Search results; null when no search is pending or shown. */
  const [results, setResults] = useState<UserSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** The recipient picked from the search results (the Add target). */
  const [selected, setSelected] = useState<UserSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  /** The share id whose revoke is in flight, or null. */
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  /**
   * The query whose search state (results/searching/error) is shown. When
   * the input changes, the old state no longer applies and is cleared
   * during render (the adjust-during-render pattern Files.tsx uses for
   * listing state), so a stale result list never lingers while the new
   * search is pending.
   */
  const [shownQuery, setShownQuery] = useState("");
  if (shownQuery !== query) {
    setShownQuery(query);
    setResults(null);
    setSearching(false);
    setSearchError(null);
  }

  // Debounced user search (R13): 300ms after the last keystroke, query
  // /api/users. An empty query, or one that still matches the selected
  // recipient, shows no results (the input holds the picked username).
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "" || selected?.username === trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      setResults(null);
      searchUsers(trimmed)
        .then(({ users }) => {
          if (!cancelled) setResults(users);
        })
        .catch((err: unknown) => {
          if (!cancelled) setSearchError(messageOf(err));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, selected]);

  /** The recipient list shown for this folder (R5/R13). */
  const folderShares = shares.filter((share) => share.folder === folder);

  /** Pick a search result: fill the input and clear the results. */
  function selectUser(user: UserSummary): void {
    setSelected(user);
    setQuery(user.username);
    setResults(null);
    setAddError(null);
  }

  /** Share the folder with the selected recipient (createShare). */
  async function handleAdd(): Promise<void> {
    if (!selected || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await createShare(folder, selected.username);
      // The parent re-fetches the shares list; this dialog re-renders
      // with the new recipient (visibility of system status).
      setSelected(null);
      setQuery("");
      onSharesChanged();
    } catch (err) {
      const apiError = err as ApiClientError;
      setAddError(
        apiError?.message ??
          `Could not share "${folderName}" with ${selected.username}.`,
      );
    } finally {
      setAdding(false);
    }
  }

  /** Revoke the share with the given id (owner-only, via the client). */
  async function handleRevoke(id: string): Promise<void> {
    if (revokingId !== null) return;
    setRevokingId(id);
    setRevokeError(null);
    try {
      await revokeShare(id);
      onSharesChanged();
    } catch (err) {
      setRevokeError(messageOf(err));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="modal modal-open">
      <div
        className="modal-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="share-folder-dialog-title"
      >
        <h2
          id="share-folder-dialog-title"
          className="text-lg font-semibold break-all"
        >
          Share {folderName}
        </h2>

        <div className="mt-4">
          <label className="label mb-2" htmlFor="share-recipient-search">
            <span className="label-text">Search users</span>
          </label>
          <input
            id="share-recipient-search"
            className="input w-full"
            type="text"
            value={query}
            placeholder="Type a username..."
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
              setAddError(null);
            }}
          />
          {searching && (
            <p className="mt-2 text-sm opacity-70" role="status">
              Searching...
            </p>
          )}
          {searchError && (
            <p className="alert alert-error mt-2" role="alert">
              {searchError}
            </p>
          )}
          {results !== null && results.length > 0 && (
            <ul
              className="menu bg-base-200 rounded-box mt-2"
              aria-label="Search results"
            >
              {results.map((user) => (
                <li key={user.id}>
                  <button
                    className="flex items-center gap-2"
                    type="button"
                    onClick={() => selectUser(user)}
                  >
                    <PersonIcon aria-hidden="true" />
                    {user.username}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {results !== null && results.length === 0 && (
            <p className="mt-2 text-sm opacity-70" role="status">
              No users found
            </p>
          )}
        </div>

        <div className="mt-4">
          <h3 className="label-text font-semibold mb-2">Recipients</h3>
          {folderShares.length === 0 ? (
            <p className="text-sm opacity-70" role="status">
              No recipients yet. Search for a user above to share this folder.
            </p>
          ) : (
            <ul className="list" aria-label={`Recipients of ${folderName}`}>
              {folderShares.map((share) => (
                <li
                  className="list-row flex flex-wrap items-center gap-3"
                  key={share.id}
                >
                  <div className="flex grow flex-col">
                    <span className="font-semibold">
                      {share.recipient.username}
                    </span>
                    <span className="text-xs opacity-70">
                      Shared {new Date(share.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-accent btn-sm btn-soft min-h-11"
                    aria-label={`Revoke share for ${share.recipient.username}`}
                    disabled={revokingId === share.id}
                    onClick={() => void handleRevoke(share.id)}
                  >
                    <TrashIcon aria-hidden="true" />
                    <span className="hidden sm:inline">Revoke</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {revokeError && (
            <p className="alert alert-error mt-3" role="alert">
              {revokeError}
            </p>
          )}
        </div>

        {addError && (
          <p className="alert alert-error mt-3" role="alert">
            {addError}
          </p>
        )}

        <div className="modal-action">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void handleAdd()}
            disabled={selected === null || adding}
          >
            <PersonAddIcon aria-hidden="true" />
            {adding ? "Adding..." : "Add"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Done
          </button>
        </div>

        <p className="text-xs opacity-70 mt-4">
          Recipients get full read/write access to this folder until you revoke
          it.
        </p>
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
