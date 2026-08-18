/**
 * File listing components: breadcrumbs, the folder/file table, empty state
 * and loading skeletons, plus human-readable formatting helpers (T036).
 *
 * Rebuilt on daisyUI primitives (T011): breadcrumbs, table, link, btn,
 * skeleton, alert (US2). Folder rows are links (they navigate); file rows
 * carry button Download/Share/Delete actions with octicons — icon+text at
 * `sm` and up, icon-only below with the accessible name on the button
 * (FR-007). Size and Modified relocate below `sm` into a secondary line
 * under the file name (FR-005) and return to their own columns at `sm`+,
 * so the table fits 375px without horizontal scrolling (FR-009).
 */
import type { FileEntry } from "../api/client";
import {
  DownloadIcon,
  FileDirectoryFillIcon,
  FileIcon,
  HomeIcon,
  ShareAndroidIcon,
  TrashIcon,
} from "@primer/octicons-react";
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
      {/* flex-wrap: daisyUI's .breadcrumbs>ul defaults to nowrap with
          overflow-x:auto, which scrolls/clips a deep trail at 375px; the
          wrap utility makes the crumbs flow onto multiple lines instead
          (it only engages when the trail does not fit, so a shallow trail
          still renders on one line). */}
      <ul className="flex-wrap">
        <li>
          <a
            className="min-h-11 inline-flex items-center gap-1"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onNavigate("");
            }}
          >
            <HomeIcon aria-hidden="true" />
            Home
          </a>
        </li>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const target = segments.slice(0, index + 1).join("/") + "/";
          return isLast ? (
            <li key={`${segment}-${index}`}>
              <strong aria-current="page">{segment}</strong>
            </li>
          ) : (
            <li key={`${segment}-${index}`}>
              <a
                className="min-h-11 inline-flex items-center"
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(target);
                }}
              >
                {segment}
              </a>
            </li>
          );
        })}
      </ul>
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
    <div className="py-10 text-center text-base-content/70">
      <p className="text-lg font-semibold text-base-content/80">
        {hasParent ? "This folder is empty" : "Your space is empty"}
      </p>
      <p className="mt-2 text-sm">
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
    <div
      className="flex flex-col gap-4 py-4"
      role="status"
      aria-label="Loading files"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div className="flex items-center gap-4" key={index}>
          <div className="skeleton h-6 w-3/4" />
          <div className="skeleton h-6 w-1/4 hidden sm:block" />
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
      <div className="alert alert-error" role="alert">
        <span>{error}</span>
        <button className="btn" type="button" onClick={onRetry}>
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
      <ul className="list">
        {folders.map((folder) => (
          <li className="list-row" key={`folder:${folder}`}>
            <a
              className="link inline-flex items-center gap-3 font-semibold no-underline"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                onOpenFolder(folder);
              }}
            >
              <FileDirectoryFillIcon aria-hidden="true" className="shrink-0" />
              {folder}
            </a>
          </li>
        ))}
        {files.map((file) => (
          <li className="list-row" key={file.key}>
            <div className="flex items-center gap-3">
              <FileIcon aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">{file.name}</span>
            </div>
            <span className="block text-xs opacity-60 sm:hidden">
              {formatSize(file.size)} · {formatDate(file.lastModified)}
            </span>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                className="btn btn-accent btn-sm btn-soft min-h-11"
                aria-label="Download"
                onClick={() => onDownload(file)}
              >
                <DownloadIcon aria-hidden="true" />
                <span className="hidden sm:inline">Download</span>
              </button>
              <button
                type="button"
                className="btn btn-accent btn-sm btn-soft min-h-11"
                aria-label="Share"
                onClick={() => onShare(file)}
              >
                <ShareAndroidIcon aria-hidden="true" />
                <span className="hidden sm:inline">Share</span>
              </button>
              <button
                type="button"
                className="btn btn-accent btn-sm btn-soft min-h-11"
                aria-label="Delete"
                onClick={() => onDelete(file)}
              >
                <TrashIcon aria-hidden="true" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <button
            className="btn"
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
