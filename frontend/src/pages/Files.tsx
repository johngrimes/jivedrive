import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { SearchIcon } from "@primer/octicons-react";
import { getDownloadUrl, listFiles, listShares } from "../api/client";
import type {
  ApiClientError,
  FileEntry,
  ListFilesResponse,
  ListSharesResponse,
  SearchResult,
  Space,
} from "../api/client";
import { useSession } from "../auth/sessionContext";
import { DeleteDialog } from "../components/DeleteDialog";
import { Breadcrumbs, FileListing } from "../components/FileListing";
import type { MountRow } from "../components/FileListing";
import { SearchResults } from "../components/SearchResults";
import { ShareModal } from "../components/ShareModal";
import { NewFolderControl } from "../components/NewFolderControl";
import { UploadControl } from "../components/UploadControl";
import { ShareDialog } from "../components/ShareDialog";

/** Extract a readable message from an unknown error. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}
/**
 * Error shown when a shared space no longer resolves: the share was
 * revoked or deleted, so the mount is gone (US4, T030).
 */
const REVOKED_SPACE_MESSAGE =
  "This shared folder is no longer available: the share was revoked.";

/**
 * Parse the `space` query parameter into a {@link Space}. Absent and
 * malformed values fall back to the caller's own space (R12); the only
 * other shape the app writes is `shared:<shareId>`.
 *
 * @param value - raw query value, or null when the parameter is absent
 * @returns the parsed space
 */
function parseSpace(value: string | null): Space {
  if (value === "own" || value === null) return "own";
  return value.startsWith("shared:") ? (value as Space) : "own";
}

/**
 * Adapt a search result to the FileEntry shape the share and delete
 * dialogs expect: they only read `key` and `name` (FR-003 — the listing
 * row actions work unchanged on own-space results).
 *
 * @param result - the search result to adapt
 * @returns a FileEntry view over the result
 */
function asFileEntry(result: SearchResult): FileEntry {
  return { key: result.key, name: result.name, size: 0, lastModified: "" };
}

/**
 * File browser page: breadcrumbs, folder/file listing with load more, and
 * download actions for the signed-in user's spaces (T035).
 *
 * Rebuilt on daisyUI primitives (T015): the page title, toolbar (item
 * count + upload control), breadcrumbs and listing are daisyUI-styled,
 * and action errors surface as an `alert alert-error`. Navigation lives
 * in the AppShell drawer/sidebar (US1), so the page renders only its
 * content card.
 *
 * Navigation state is `{ space, prefix }` synced with the URL (R12): own
 * space keeps the existing `/files?prefix=` shape; shared spaces use
 * `/files?space=shared:<id>&prefix=<rel>` with the prefix relative to the
 * mount. Incoming shares mount at the own-space root (FR-008) and open
 * into their shared space; the upload control and delete actions pass
 * the space through (T027), so writes inside a mount are scoped to the
 * sharer's folder (FR-010/FR-011).
 *
 * Shown only when signed in; otherwise redirects to the sign-in page.
 */
export function FilesPage() {
  const { user, loading: sessionLoading, refresh } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const space = parseSpace(searchParams.get("space"));
  const prefix = searchParams.get("prefix") ?? "";
  const [listing, setListing] = useState<ListFilesResponse | null>(null);
  const [listingPrefix, setListingPrefix] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [shareFile, setShareFile] = useState<FileEntry | null>(null);
  const [deleteFile, setDeleteFile] = useState<FileEntry | null>(null);
  const [shares, setShares] = useState<ListSharesResponse | null>(null);
  /** The folder (base name) whose share dialog is open, or null. */
  const [shareFolder, setShareFolder] = useState<string | null>(null);
  /** The submitted search query, or null when browsing (not searching). */
  const [query, setQuery] = useState<string | null>(null);
  /** The live value of the search input (not yet submitted). */
  const [queryInput, setQueryInput] = useState("");
  /**
   * The space the open share/delete dialog acts on: the current space
   * for listing rows, the result's space for search rows (FR-003).
   */
  const [dialogSpace, setDialogSpace] = useState<Space>("own");

  // Adjust state during render when navigating to a different folder, so
  // the stale listing is cleared and the skeleton shows for the new one.
  // Both space and prefix are part of the location: own root -> shared
  // root keeps the same prefix but must still reset the listing.
  const [shown, setShown] = useState({ space, prefix });
  if (shown.space !== space || shown.prefix !== prefix) {
    setShown({ space, prefix });
    setQuery(null);
    setListing(null);
    setListingPrefix(null);
    setError(null);
  }
  /**
   * Re-fetch the shares list after an add or revoke in the share dialog.
   * Memoised so the listing effect's dependency stays stable across
   * renders (react-hooks/exhaustive-deps).
   */
  const refreshShares = useCallback(() => {
    listShares()
      .then((result) => setShares(result))
      .catch((err: unknown) => {
        if ((err as ApiClientError).status === 401) {
          void refresh();
        }
      });
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listFiles(prefix, space)
      .then((result) => {
        if (!cancelled) {
          setListing(result);
          setListingPrefix(prefix);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Session expired mid-browse (spec edge case): the next request
        // re-prompts for sign-in. Refresh the session, which flips the
        // user to null and redirects to the sign-in page.
        if ((err as ApiClientError).status === 401) {
          void refresh();
          return;
        }
        // A shared space that no longer resolves (US4, T030): the share
        // was revoked, so refresh the shares list — the revoked mount
        // disappears on the next root load — and say so explicitly.
        const apiError = err as ApiClientError;
        if (space !== "own" && apiError.status === 404) {
          refreshShares();
          setError(REVOKED_SPACE_MESSAGE);
        } else {
          setError(messageOf(err));
        }
        // Mark this folder's fetch as finished so the skeleton clears and
        // the error state (with Retry) is shown. Without this, fetching
        // (listingPrefix !== prefix) stays true forever and the listing
        // hangs on loading placeholders despite the explicit failure.
        setListingPrefix(prefix);
      });
    return () => {
      cancelled = true;
    };
  }, [user, prefix, space, retryKey, refresh, refreshShares]);
  // Fetch the shares list alongside the listing (T020): outgoing feeds
  // the share dialogs and the root "Shared" chips, incoming feeds the
  // mounts at the own-space root (T023). Refreshed after every add/revoke
  // via refreshShares so the dialog always shows live recipients.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listShares()
      .then((result) => {
        if (!cancelled) setShares(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as ApiClientError).status === 401) {
          void refresh();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, refresh]);

  /**
   * Navigate by updating the URL: `space=shared:<id>&prefix=<rel>` for a
   * shared space, the existing `/files?prefix=` shape for the own space
   * (R12). Pushes history so the back button walks the trail.
   *
   * @param nextSpace - the space to show
   * @param nextPrefix - prefix relative to that space ("" for its root)
   */
  function navigate(nextSpace: Space, nextPrefix: string): void {
    const params = new URLSearchParams();
    if (nextSpace !== "own") params.set("space", nextSpace);
    if (nextPrefix !== "") params.set("prefix", nextPrefix);
    setSearchParams(params, { replace: false });
  }

  /**
   * The incoming share behind the current shared space, used to render
   * the mount name and "Shared by" label in the breadcrumbs (R12).
   */
  const shareId = space.startsWith("shared:")
    ? space.slice("shared:".length)
    : null;
  const incomingShare = shareId
    ? (shares?.incoming ?? []).find((share) => share.id === shareId)
    : undefined;

  /**
   * Shared folders mounted at the own-space root (FR-008). Rendered only
   * there: mounts never appear nested inside own folders or a mount.
   */
  const mounts: MountRow[] =
    space === "own" && prefix === ""
      ? (shares?.incoming ?? []).map((share) => ({
          id: share.id,
          folderName: share.folderName,
          sharerUsername: share.sharer.username,
        }))
      : [];

  /** Breadcrumb trail: relative segments, or the mount name first (R12). */
  const relativeSegments =
    prefix === "" ? [] : prefix.split("/").filter((segment) => segment !== "");
  const segments =
    space === "own"
      ? relativeSegments
      : [incomingShare?.folderName ?? "Shared folder", ...relativeSegments];
  const sharerLabel =
    space !== "own" && incomingShare
      ? `Shared by ${incomingShare.sharer.username}`
      : undefined;

  /** True while the listing for the current folder is still loading. */
  const fetching = listingPrefix !== prefix;

  /**
   * Retry a failed initial listing load.
   */
  function retry(): void {
    setError(null);
    setListingPrefix(null);
    setRetryKey((key) => key + 1);
  }

  /**
   * Re-fetch the current folder so a newly uploaded file appears.
   */
  function refreshListing(): void {
    setListingPrefix(null);
    setRetryKey((key) => key + 1);
  }

  /**
   * Append the next page of the current folder to the listing.
   */
  async function loadMore(): Promise<void> {
    if (!listing?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await listFiles(prefix, space, listing.nextCursor);
      setListing((prev) =>
        prev
          ? {
              folders: [...prev.folders, ...next.folders],
              files: [...prev.files, ...next.files],
              nextCursor: next.nextCursor,
            }
          : next,
      );
    } catch (err) {
      if ((err as ApiClientError).status === 401) {
        void refresh();
        return;
      }
      // A revoked shared space (US4, T030) surfaces like the initial
      // listing: refresh the mounts and make the message explicit.
      const apiError = err as ApiClientError;
      if (space !== "own" && apiError.status === 404) {
        refreshShares();
        setError(REVOKED_SPACE_MESSAGE);
      } else {
        setError(messageOf(err));
      }
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Fetch a short-lived presigned URL for a file and download it.
   *
   * @param file - the file to download
   * @param fileSpace - the space the file lives in (the current space
   *   for listing rows, the result's space for search rows)
   */
  async function handleDownload(
    file: FileEntry,
    fileSpace: Space,
  ): Promise<void> {
    setActionError(null);
    try {
      const { url } = await getDownloadUrl(file.key, fileSpace);
      // Open in a new window so the browser renders the file (or, for
      // types it cannot display, downloads it) without losing the
      // user's place in the listing.
      window.open(url, "_blank");
    } catch (err) {
      const apiError = err as ApiClientError;
      setActionError(
        `Could not download "${file.name}". ${apiError?.message ?? messageOf(err)}`,
      );
    }
  }

  /**
   * Submit the search input: a non-empty trimmed query swaps the folder
   * listing for the results list (FR-001); an empty input does nothing.
   *
   * @param event - the form submit event
   */
  function submitSearch(event: FormEvent): void {
    event.preventDefault();
    const q = queryInput.trim();
    if (q === "") return;
    setQuery(q);
  }

  /**
   * Open a search result's containing folder: navigating clears the
   * query, which restores the folder listing (FR-003, US1 sc.4).
   *
   * @param result - the clicked result
   */
  function openResult(result: SearchResult): void {
    setQuery(null);
    navigate(result.space, result.path === "" ? "" : `${result.path}/`);
  }

  if (sessionLoading) {
    return (
      <p className="py-8 text-center opacity-70" role="status">
        Loading...
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }

  const itemCount =
    (listing?.folders.length ?? 0) + (listing?.files.length ?? 0);
  const sharedFolders: string[] = [];
  if (space === "own" && prefix === "") {
    const seen = new Set<string>();
    for (const share of shares?.outgoing ?? []) {
      // Only root-level shares mark root rows (FR-018): a share of a
      // nested folder (e.g. projects/docs) must not light up a same-named
      // root folder that has no share of its own.
      if (share.folder.split("/").filter(Boolean).length !== 1) continue;
      if (seen.has(share.folderName)) continue;
      seen.add(share.folderName);
      sharedFolders.push(share.folderName);
    }
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-4 pt-2">
      <main className="min-w-0 flex-1 rounded-box bg-base-200 p-4 pt-0 md:p-6 md:pt-0">
        <Breadcrumbs
          segments={segments}
          sharerLabel={sharerLabel}
          onNavigate={(target) => navigate(space, target)}
          onHome={() => navigate("own", "")}
        />

        {/* The search box lives in the page header (contract); a
            submitted query swaps the listing area for the results
            (FR-001), and any navigation restores the listing. */}
        <form
          className="mb-3 flex items-center gap-2"
          role="search"
          onSubmit={submitSearch}
        >
          <input
            type="search"
            className="input input-bordered grow min-h-11"
            aria-label="Search files"
            placeholder="Search files by name"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
          />
          {query !== null && (
            <button
              type="button"
              className="btn min-h-11"
              onClick={() => setQuery(null)}
            >
              Clear
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary min-h-11"
            aria-label="Search"
          >
            <SearchIcon aria-hidden="true" />
            <span className="hidden sm:inline">Search</span>
          </button>
        </form>

        {actionError && (
          <p className="alert alert-error mb-3" role="alert">
            {actionError}
          </p>
        )}

        {query === null ? (
          <>
            {/* One wrapping row: the count, then the actions pushed to
                the right; feedback lines wrap below at full width. */}
            <div className="mb-3 flex flex-wrap items-start justify-end gap-2">
              <span className="mr-auto min-h-10 content-center whitespace-nowrap text-sm opacity-70">
                {itemCount} {itemCount === 1 ? "item" : "items"}
              </span>
              <NewFolderControl
                folder={prefix}
                space={space}
                onCreated={refreshListing}
                onSessionExpired={() => void refresh()}
              />
              <UploadControl
                folder={prefix}
                space={space}
                onUploaded={refreshListing}
                onSessionExpired={() => void refresh()}
              />
            </div>

            <FileListing
              folders={listing?.folders ?? []}
              files={listing?.files ?? []}
              loading={fetching}
              loadingMore={loadingMore}
              nextCursor={listing?.nextCursor ?? null}
              error={error}
              hasParent={prefix !== "" || space !== "own"}
              onOpenFolder={(folder) => navigate(space, prefix + folder + "/")}
              onDownload={(file) => void handleDownload(file, space)}
              onShare={(file) => {
                setDialogSpace(space);
                setShareFile(file);
              }}
              onDelete={(file) => {
                setDialogSpace(space);
                setDeleteFile(file);
              }}
              onLoadMore={() => void loadMore()}
              onRetry={retry}
              onShareFolder={
                space === "own"
                  ? (folder) => setShareFolder(prefix + folder + "/")
                  : undefined
              }
              sharedFolders={sharedFolders}
              mounts={mounts}
              onOpenMount={(mountId) => navigate(`shared:${mountId}`, "")}
            />
          </>
        ) : (
          <SearchResults
            query={query}
            onOpenResult={openResult}
            onDownload={(result) =>
              void handleDownload(asFileEntry(result), result.space)
            }
            onShare={(result) => {
              setDialogSpace(result.space);
              setShareFile(asFileEntry(result));
            }}
            onDelete={(result) => {
              setDialogSpace(result.space);
              setDeleteFile(asFileEntry(result));
            }}
            onSessionExpired={() => void refresh()}
          />
        )}
      </main>

      {shareFile && (
        <ShareModal
          file={shareFile}
          space={dialogSpace}
          onClose={() => setShareFile(null)}
        />
      )}
      {shareFolder !== null && (
        <ShareDialog
          folder={shareFolder}
          folderName={
            shareFolder.replace(/\/+$/, "").split("/").pop() ?? shareFolder
          }
          shares={shares?.outgoing ?? []}
          onClose={() => setShareFolder(null)}
          onSharesChanged={refreshShares}
        />
      )}
      {deleteFile && (
        <DeleteDialog
          file={deleteFile}
          space={dialogSpace}
          onDeleted={() => {
            setDeleteFile(null);
            refreshListing();
          }}
          onClose={() => setDeleteFile(null)}
        />
      )}
    </div>
  );
}
