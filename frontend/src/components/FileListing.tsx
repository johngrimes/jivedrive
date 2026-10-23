/**
 * File listing components: breadcrumbs, the folder/file table, empty state
 * and loading skeletons, plus human-readable formatting helpers (T036).
 *
 * Rebuilt on daisyUI primitives (T011): breadcrumbs, list, link, skeleton,
 * alert (US2). Folder names are links that open the folder; file names are
 * links that download the file. Each row's actions (file Download/Share/
 * Move/Delete, own-folder Share) sit behind one "⋯" RowActionsMenu, so a
 * row stays a single line that fits 375px without horizontal scrolling
 * (FR-007, FR-009).
 */
import type { FileEntry } from "../api/client";
import {
  FileDirectoryFillIcon,
  FileIcon,
  HomeIcon,
  PeopleIcon,
} from "@primer/octicons-react";
import { RowActionsMenu } from "./RowActionsMenu";
import { fileRowActions } from "./fileRowActions";

/** Props for {@link Breadcrumbs}. */
export interface BreadcrumbsProps {
  /** Relative path segments of the current folder (empty at the root). */
  segments: string[];
  /**
   * When set, the trail is a shared-space view: the first segment is the
   * mount name, Home returns to the caller's own root, and this label
   * ("Shared by <username>") is shown beside the mount crumb (R12).
   */
  sharerLabel?: string;
  /** Called with the prefix to navigate to ("" for the space root). */
  onNavigate: (prefix: string) => void;
  /** Navigate back to the caller's own space root (Home). */
  onHome: () => void;
}

/**
 * Breadcrumb trail for the current folder. The space root is always shown
 * first; every crumb except the current folder navigates up. In a shared
 * view the trail starts at the mount name (the first segment) and Home
 * leaves the mount entirely.
 *
 * @param props - segments, optional sharer label and navigation callbacks
 * @returns a breadcrumb navigation element
 */
export function Breadcrumbs({
  segments,
  sharerLabel,
  onNavigate,
  onHome,
}: BreadcrumbsProps) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      {/* flex-wrap: daisyUI's .breadcrumbs>ul defaults to nowrap with
          overflow-x:auto, which scrolls/clips a deep trail at 375px; the
          wrap utility makes the crumbs flow onto multiple lines instead
          (it only engages when the trail does not fit, so a shallow trail
          still renders on one line). */}
      <ul className="flex-wrap min-h-11">
        <li>
          <a
            className="inline-flex items-center gap-1"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onHome();
            }}
          >
            <HomeIcon aria-hidden="true" />
            Home
          </a>
        </li>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const isMountRoot = index === 0 && sharerLabel !== undefined;
          const target = segments.slice(0, index + 1).join("/") + "/";
          return (
            <li key={`${segment}-${index}`}>
              {isMountRoot ? (
                <>
                  {isLast ? (
                    <strong aria-current="page">{segment}</strong>
                  ) : (
                    <a
                      className="inline-flex items-center"
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate("");
                      }}
                    >
                      {segment}
                    </a>
                  )}
                  <span className="badge badge-ghost badge-sm ml-1">
                    {sharerLabel}
                  </span>
                </>
              ) : isLast ? (
                <strong aria-current="page">{segment}</strong>
              ) : (
                <a
                  className="inline-flex items-center"
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(target);
                  }}
                >
                  {segment}
                </a>
              )}
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

/** A shared folder mounted at the recipient's space root (FR-008). */
export interface MountRow {
  /** The share id, used as `shared:<id>` in the URL. */
  id: string;
  /** Base name of the shared folder, shown as the mount row. */
  folderName: string;
  /** Username of the sharer, shown in the "Shared by" label. */
  sharerUsername: string;
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
  /** Start a download for a file (its name link and menu item). */
  onDownload: (file: FileEntry) => void;
  /** Open the share modal for a file. */
  onShare: (file: FileEntry) => void;
  /**
   * Open the delete confirmation dialog for a file. Optional: without a
   * handler the row's menu offers no Delete.
   */
  onDelete?: (file: FileEntry) => void;
  /**
   * Open the move dialog for a file. Optional: without a handler the
   * row's menu offers no Move.
   */
  onMove?: (file: FileEntry) => void;
  /** Load the next page. */
  onLoadMore: () => void;
  /** Retry the failed initial load. */
  onRetry: () => void;
  /**
   * Open the share dialog for a folder (R13). Optional: received folder
   * rows pass no handler, so they render no actions menu (FR-015: a
   * recipient cannot re-share).
   */
  onShareFolder?: (folder: string) => void;
  /**
   * Base names of folders with outgoing shares at the space root; those
   * rows show a visible "Shared" chip (FR-018).
   */
  sharedFolders?: string[];
  /**
   * Shared folders mounted at the own-space root (FR-008). Each renders
   * as a folder row labelled "Shared by <username>"; mounts render only
   * at the own-space root and never carry an actions menu or "Shared"
   * chip.
   */
  mounts?: MountRow[];
  /** Open a mounted shared folder at its root (space + "" prefix). */
  onOpenMount?: (mountId: string) => void;
}

/**
 * The folder/file listing: folders first (clickable), then mounted shared
 * folders (at the own root), then files with human-readable sizes and
 * local timestamps, plus a load-more control.
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
  onMove,
  onShare,
  onDelete,
  onLoadMore,
  onRetry,
  onShareFolder,
  sharedFolders,
  mounts,
  onOpenMount,
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

  if (
    folders.length === 0 &&
    files.length === 0 &&
    (mounts?.length ?? 0) === 0
  ) {
    return <EmptyState hasParent={hasParent} />;
  }

  return (
    <>
      <ul className="list">
        {folders.map((folder) => (
          <li
            className="list-row flex items-center gap-3"
            key={`folder:${folder}`}
          >
            <a
              className="link inline-flex min-w-0 grow items-center gap-3 font-semibold no-underline"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                onOpenFolder(folder);
              }}
            >
              <FileDirectoryFillIcon aria-hidden="true" className="shrink-0" />
              <span className="truncate">{folder}</span>
              {sharedFolders?.includes(folder) && (
                <span className="badge badge-neutral badge-sm">Shared</span>
              )}
            </a>
            <RowActionsMenu
              name={folder}
              actions={
                onShareFolder
                  ? [
                      {
                        label: "Share",
                        icon: <PeopleIcon aria-hidden="true" />,
                        onSelect: () => onShareFolder(folder),
                      },
                    ]
                  : []
              }
            />
          </li>
        ))}
        {mounts?.map((mount) => (
          <li
            className="list-row flex items-center gap-3"
            key={`mount:${mount.id}`}
          >
            <a
              className="link inline-flex min-w-0 grow items-center gap-3 font-semibold no-underline"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                onOpenMount?.(mount.id);
              }}
            >
              <FileDirectoryFillIcon aria-hidden="true" className="shrink-0" />
              <span className="truncate">{mount.folderName}</span>
              {/* FR-008: the label disambiguates a mount from a
                  same-named own folder; no actions menu (FR-015) and
                  no "Shared" chip on received rows. Name and label both
                  shrink with an ellipsis, so a long sharer name never
                  crowds the folder name out at narrow widths. */}
              <span className="badge badge-ghost badge-sm min-w-0">
                <span className="truncate">
                  Shared by {mount.sharerUsername}
                </span>
              </span>
            </a>
          </li>
        ))}
        {files.map((file) => (
          <li className="list-row flex items-center gap-3" key={file.key}>
            <a
              className="link inline-flex min-w-0 grow items-center gap-3 no-underline"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                onDownload(file);
              }}
            >
              <FileIcon aria-hidden="true" className="shrink-0" />
              <span className="truncate">{file.name}</span>
            </a>
            <RowActionsMenu
              name={file.name}
              actions={fileRowActions({
                onDownload: () => onDownload(file),
                onShare: () => onShare(file),
                onMove: onMove && (() => onMove(file)),
                onDelete: onDelete && (() => onDelete(file)),
              })}
            />
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
