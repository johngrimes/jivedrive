/**
 * File listing components: breadcrumbs, the folder/file table, empty state
 * and loading skeletons, plus human-readable formatting helpers (T036).
 */
import type { FileEntry } from "../api/client";
import { formatDate, formatSize } from "../lib/format";

/** Props for {@link Breadcrumbs}. */
export interface BreadcrumbsProps {
  /** Relative path segments of the current folder (empty at the root). */
  segments: string[];
  /** Called with the prefix to navigate to ("" for the space root). */
  onNavigate: (prefix: string) => void;
}

/**
 * Breadcrumb trail for the current folder. The space root is always shown
 * first; every crumb except the current folder navigates up.
 *
 * @param props - segments and navigation callback
 * @returns a breadcrumb navigation element
 */
export function Breadcrumbs({ segments, onNavigate }: BreadcrumbsProps) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <a
        className="breadcrumb"
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onNavigate("");
        }}
      >
        Home
      </a>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const target = segments.slice(0, index + 1).join("/") + "/";
        return (
          <span className="breadcrumb-group" key={`${segment}-${index}`}>
            <span className="breadcrumb-sep" aria-hidden="true">
              /
            </span>
            {isLast ? (
              <strong className="breadcrumb-current" aria-current="page">
                {segment}
              </strong>
            ) : (
              <a
                className="breadcrumb"
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(target);
                }}
              >
                {segment}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Props for {@link EmptyState}. */
export interface EmptyStateProps {
  /** True when viewing a subfolder rather than the space root. */
  hasParent: boolean;
}

/**
 * Friendly empty state shown when a folder has no folders or files.
 *
 * @param props - whether the current folder has a parent
 * @returns the empty state element
 */
export function EmptyState({ hasParent }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">
        {hasParent ? "This folder is empty" : "Your space is empty"}
      </p>
      <p className="empty-state-hint">
        Files and folders you add here will appear in this list.
      </p>
    </div>
  );
}

/**
 * Skeleton rows shown while the first page of a listing is loading.
 *
 * @returns a loading placeholder element
 */
export function LoadingSkeleton() {
  return (
    <div className="file-skeleton" role="status" aria-label="Loading files">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <div className="skeleton-block skeleton-name" />
          <div className="skeleton-block skeleton-size" />
        </div>
      ))}
    </div>
  );
}

/** Props for {@link FileListing}. */
export interface FileListingProps {
  /** Base names of subfolders in the current folder. */
  folders: string[];
  files: FileEntry[];
  /** True while the first page is loading (show skeletons). */
  loading: boolean;
  /** True while the next page is being appended. */
  loadingMore: boolean;
  /** Opaque continuation token, or null when the listing is complete. */
  nextCursor: string | null;
  /** Listing error message, or null. */
  error: string | null;
  /** True when viewing a subfolder (affects the empty state wording). */
  hasParent: boolean;
  /** Open a folder by its base name. */
  onOpenFolder: (folder: string) => void;
  /** Start a download for a file. */
  onDownload: (file: FileEntry) => void;
  /** Open the share modal for a file. */
  onShare: (file: FileEntry) => void;
  /** Open the delete confirmation dialog for a file. */
  onDelete: (file: FileEntry) => void;
  /** Load the next page. */
  onLoadMore: () => void;
  /** Retry the failed initial load. */
  onRetry: () => void;
}

/**
 * The folder/file listing: folders first (clickable), then files with
 * human-readable sizes and local timestamps, plus a load-more control.
 *
 * @param props - listing data and callbacks
 * @returns the listing table or its placeholder states
 */
export function FileListing({
  folders,
  files,
  loading,
  loadingMore,
  nextCursor,
  error,
  hasParent,
  onOpenFolder,
  onDownload,
  onShare,
  onDelete,
  onLoadMore,
  onRetry,
}: FileListingProps) {
  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="error" role="alert">
        <p>{error}</p>
        <button className="button button-small" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (folders.length === 0 && files.length === 0) {
    return <EmptyState hasParent={hasParent} />;
  }

  return (
    <>
      <table className="file-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Size</th>
            <th scope="col">Modified</th>
            <th scope="col" className="file-actions">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((folder) => (
            <tr key={`folder:${folder}`}>
              <td className="file-name">
                <button
                  className="folder-link"
                  type="button"
                  onClick={() => onOpenFolder(folder)}
                >
                  <span aria-hidden="true">📁</span> {folder}
                </button>
              </td>
              <td className="file-size">—</td>
              <td className="file-modified">—</td>
              <td className="file-actions" />
            </tr>
          ))}
          {files.map((file) => (
            <tr key={file.key}>
              <td className="file-name">
                <span aria-hidden="true">📄</span> {file.name}
              </td>
              <td className="file-size">{formatSize(file.size)}</td>
              <td className="file-modified">{formatDate(file.lastModified)}</td>
              <td className="file-actions">
                <a
                  className="file-action"
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onDownload(file);
                  }}
                >
                  Download
                </a>
                <span className="file-action-sep" aria-hidden="true">
                  ·
                </span>
                <a
                  className="file-action"
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onShare(file);
                  }}
                >
                  Share
                </a>
                <span className="file-action-sep" aria-hidden="true">
                  ·
                </span>
                <a
                  className="file-action"
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onDelete(file);
                  }}
                >
                  Delete
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {nextCursor && (
        <div className="load-more">
          <button
            className="button"
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
