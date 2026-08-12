import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { getDownloadUrl, listFiles } from "../api/client";
import type {
  ApiClientError,
  FileEntry,
  ListFilesResponse,
} from "../api/client";
import { useSession } from "../auth/sessionContext";
import { DeleteDialog } from "../components/DeleteDialog";
import { Breadcrumbs, FileListing } from "../components/FileListing";
import { ShareModal } from "../components/ShareModal";
import { UploadControl } from "../components/UploadControl";

/** Extract a readable message from an unknown error. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}

/**
 * File browser page: breadcrumbs, folder/file listing with load more, and
 * download actions for the signed-in user's space (T035).
 *
 * Shown only when signed in; otherwise redirects to the sign-in page.
 */
export function FilesPage() {
  const { user, loading: sessionLoading, refresh } = useSession();
  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState<ListFilesResponse | null>(null);
  const [listingPrefix, setListingPrefix] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [shareFile, setShareFile] = useState<FileEntry | null>(null);
  const [deleteFile, setDeleteFile] = useState<FileEntry | null>(null);

  // Adjust state during render when navigating to a different folder, so
  // the stale listing is cleared and the skeleton shows for the new one.
  const [shownPrefix, setShownPrefix] = useState(prefix);
  if (shownPrefix !== prefix) {
    setShownPrefix(prefix);
    setListing(null);
    setListingPrefix(null);
    setError(null);
  }

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listFiles(prefix)
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
        setError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, [user, prefix, retryKey]);

  /** Relative path segments for the breadcrumbs ("" root => empty). */
  const segments =
    prefix === "" ? [] : prefix.split("/").filter((segment) => segment !== "");

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
      const next = await listFiles(prefix, listing.nextCursor);
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
      setError(messageOf(err));
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Fetch a short-lived presigned URL for a file and download it.
   *
   * @param file - the file to download
   */
  async function handleDownload(file: FileEntry): Promise<void> {
    setActionError(null);
    try {
      const { url } = await getDownloadUrl(file.key);
      window.location.assign(url);
    } catch (err) {
      const apiError = err as ApiClientError;
      setActionError(
        `Could not download "${file.name}". ${apiError?.message ?? messageOf(err)}`,
      );
    }
  }

  if (sessionLoading) {
    return (
      <p className="status" role="status">
        Loading...
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }

  const itemCount =
    (listing?.folders.length ?? 0) + (listing?.files.length ?? 0);

  return (
    <div className="files-layout">
      <aside className="files-sidebar">
        <p className="files-sidebar-title">Files</p>
        <p className="files-sidebar-meta">Bucket: {user.bucket}</p>
        <p className="files-sidebar-meta">Space: {user.prefix}</p>
        {user.isAdmin && (
          <Link className="files-sidebar-link" to="/admin">
            Manage users (admin)
          </Link>
        )}
      </aside>

      <main className="files-main">
        <h1 className="files-title">Files</h1>
        <Breadcrumbs segments={segments} onNavigate={setPrefix} />

        <div className="files-toolbar">
          <span className="files-count">
            {itemCount} {itemCount === 1 ? "item" : "items"}
          </span>
          <UploadControl
            folder={prefix}
            onUploaded={refreshListing}
            onSessionExpired={() => void refresh()}
          />
        </div>

        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}

        <FileListing
          folders={listing?.folders ?? []}
          files={listing?.files ?? []}
          loading={fetching}
          loadingMore={loadingMore}
          nextCursor={listing?.nextCursor ?? null}
          error={error}
          hasParent={prefix !== ""}
          onOpenFolder={(folder) => setPrefix(prefix + folder + "/")}
          onDownload={(file) => void handleDownload(file)}
          onShare={setShareFile}
          onDelete={setDeleteFile}
          onLoadMore={() => void loadMore()}
          onRetry={retry}
        />
      </main>

      {shareFile && (
        <ShareModal file={shareFile} onClose={() => setShareFile(null)} />
      )}
      {deleteFile && (
        <DeleteDialog
          file={deleteFile}
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
