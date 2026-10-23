/**
 * Search results list (007-file-search US1, T011): a flat, single-column
 * result list for one submitted query, replacing the folder listing while
 * a search is active (FR-001). Built on the same daisyUI primitives as
 * the folder listing; mobile-first: each row is one column with large
 * (min-h-11) touch targets, the folder path renders as a second line
 * under the name (FR-015), and action labels collapse to icons below
 * `sm` exactly like the listing rows (FR-003). Folder matches (#13)
 * render like listing folder rows: a folder icon, and Share as the only
 * action, offered in the caller's own space only.
 */
import { useEffect, useRef, useState } from "react";
import {
  DownloadIcon,
  FileDirectoryFillIcon,
  FileIcon,
  PeopleIcon,
  ShareAndroidIcon,
  TrashIcon,
} from "@primer/octicons-react";
import { searchFiles } from "../api/client";
import type { ApiClientError, SearchResult } from "../api/client";
import { LoadingSkeleton } from "./FileListing";

/** Props for {@link SearchResults}. */
export interface SearchResultsProps {
  /** The submitted query (already trimmed and non-empty). */
  query: string;
  /** Open a result: a folder itself, or a file's containing folder. */
  onOpenResult: (result: SearchResult) => void;
  /** Start a download for a file result, issued against its space. */
  onDownload?: (result: SearchResult) => void;
  /** Open the share-link modal for a file result. */
  onShare?: (result: SearchResult) => void;
  /** Open the delete confirmation for a file result. */
  onDelete?: (result: SearchResult) => void;
  /**
   * Open the folder share dialog for an own-space folder result. Folders
   * from a shared mount never get the button: a recipient cannot
   * re-share (006 FR-015).
   */
  onShareFolder?: (result: SearchResult) => void;
  /** Called on 401 so the page can refresh the (expired) session. */
  onSessionExpired?: () => void;
}

/** What the results area is currently showing. Done and error states are
 * tagged with the query and retry key they belong to, so a newer query or
 * a retry renders as loading without a setState call inside the effect. */
type SearchState =
  | { status: "loading" }
  | {
      status: "done";
      query: string;
      retry: number;
      results: SearchResult[];
      capped: boolean;
    }
  | { status: "error"; query: string; retry: number; message: string };

/** Human-readable label per match type. */
const MATCH_LABELS: Record<SearchResult["match"], string> = {
  folder: "Folder",
  name: "Name match",
  content: "Content match",
};

/**
 * Render one content-match snippet (007-file-search US2, T017): the
 * server marks the matched text with literal `<mark>`/`</mark>` markers;
 * they are split out and re-emitted as real `<mark>` elements, while the
 * document text between them renders as plain text — never HTML — so a
 * hostile document cannot inject markup (FR-005).
 *
 * @param props - the server-provided snippet
 * @returns the snippet's inline elements
 */
function Snippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(/(<\/?mark>)/);
  const nodes = [];
  let marked = false;
  for (const part of parts) {
    if (part === "<mark>") {
      marked = true;
    } else if (part === "</mark>") {
      marked = false;
    } else if (part !== "") {
      nodes.push(
        marked ? (
          <mark key={nodes.length}>{part}</mark>
        ) : (
          <span key={nodes.length}>{part}</span>
        ),
      );
    }
  }
  return nodes;
}

/**
 * Fetch and render the results of one file search (FR-002, FR-006).
 * Shows a searching state, an explicit no-results empty state, an error
 * with Retry, and a refine hint when the server capped the list.
 *
 * @param props - the query, navigation callback and row actions
 * @returns the results area element
 */
export function SearchResults({
  query,
  onOpenResult,
  onDownload,
  onShare,
  onDelete,
  onSessionExpired,
  onShareFolder,
}: SearchResultsProps) {
  const [fetched, setFetched] = useState<SearchState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  // The session-expiry callback lives in a ref: a fresh inline callback
  // from the parent must never retrigger the effect (and a new request).
  const sessionExpiredRef = useRef(onSessionExpired);
  useEffect(() => {
    sessionExpiredRef.current = onSessionExpired;
  }, [onSessionExpired]);
  // What the area shows: the fetch result, or loading while it belongs
  // to an older query/retry than the one currently requested.
  const state =
    fetched.status !== "loading" &&
    (fetched.query !== query || fetched.retry !== retryKey)
      ? ({ status: "loading" } as const)
      : fetched;

  useEffect(() => {
    let cancelled = false;
    searchFiles(query)
      .then((body) => {
        if (!cancelled) {
          setFetched({
            status: "done",
            query,
            retry: retryKey,
            results: body.results,
            capped: body.capped,
          });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiError = err as ApiClientError;
        // Session expired mid-search: the next request re-prompts for
        // sign-in, mirroring the folder-listing behaviour.
        if (apiError.status === 401) {
          sessionExpiredRef.current?.();
          return;
        }
        setFetched({
          status: "error",
          query,
          retry: retryKey,
          message: apiError?.message ?? "Something went wrong. Try again.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [query, retryKey]);

  return (
    <div>
      <p className="mb-3 text-sm opacity-70" role="status">
        {state.status === "loading"
          ? `Searching for “${query}”...`
          : state.status === "error"
            ? ""
            : `${state.results.length} ${
                state.results.length === 1 ? "result" : "results"
              } for “${query}”`}
      </p>

      {state.status === "loading" && <LoadingSkeleton />}

      {state.status === "error" && (
        <div className="alert alert-error" role="alert">
          <span>{state.message}</span>
          <button
            className="btn"
            type="button"
            onClick={() => setRetryKey((key) => key + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {state.status === "done" && state.results.length === 0 && (
        <div className="py-10 text-center text-base-content/70">
          <p className="text-lg font-semibold text-base-content/80">
            No files or folders match “{query}”
          </p>
          <p className="mt-2 text-sm">
            Try a different name, or check the spelling.
          </p>
        </div>
      )}

      {state.status === "done" && state.results.length > 0 && (
        <>
          <ul className="list">
            {state.results.map((result) => (
              <li
                className="list-row flex flex-wrap justify-end md:justify-start md:flex-nowrap gap-3 items-center overflow-hidden"
                key={`${result.space}:${result.key}`}
              >
                <div className="flex grow gap-3 items-center min-w-0">
                  {result.match === "folder" ? (
                    <FileDirectoryFillIcon
                      aria-hidden="true"
                      className="shrink-0"
                    />
                  ) : (
                    <FileIcon aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <a
                      className="link inline-flex items-center gap-2 font-semibold no-underline"
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenResult(result);
                      }}
                    >
                      <span className="truncate">{result.name}</span>
                      <span className="badge badge-ghost badge-sm">
                        {MATCH_LABELS[result.match]}
                      </span>
                      {/* Shared mounts carry the sharer's label (US3,
                          FR-010); own-space rows show none. */}
                      {result.sharedBy && (
                        <span className="badge badge-secondary badge-sm">
                          Shared by {result.sharedBy}
                        </span>
                      )}
                    </a>
                    {/* The containing folder (FR-003): breadcrumb-style
                        path; "Home" at the space root. */}
                    <p className="text-sm opacity-70 truncate">
                      {result.path === ""
                        ? "Home"
                        : result.path.split("/").join(" / ")}
                    </p>
                    {/* Content match snippet (FR-005): the document
                        text around the match, matched text marked. */}
                    {result.match === "content" && result.snippet && (
                      <p className="text-sm break-words text-base-content/80">
                        <Snippet snippet={result.snippet} />
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-3">
                  {result.match === "folder" &&
                    result.space === "own" &&
                    onShareFolder && (
                      <button
                        type="button"
                        className="btn btn-accent btn-sm btn-soft min-h-11"
                        aria-label={`Share ${result.name}`}
                        onClick={() => onShareFolder(result)}
                      >
                        <PeopleIcon aria-hidden="true" />
                        <span className="hidden sm:inline">Share</span>
                      </button>
                    )}
                  {result.match !== "folder" && onDownload && (
                    <button
                      type="button"
                      className="btn btn-accent btn-sm btn-soft min-h-11"
                      aria-label={`Download ${result.name}`}
                      onClick={() => onDownload(result)}
                    >
                      <DownloadIcon aria-hidden="true" />
                      <span className="hidden sm:inline">Download</span>
                    </button>
                  )}
                  {result.match !== "folder" && onShare && (
                    <button
                      type="button"
                      className="btn btn-accent btn-sm btn-soft min-h-11"
                      aria-label={`Share ${result.name}`}
                      onClick={() => onShare(result)}
                    >
                      <ShareAndroidIcon aria-hidden="true" />
                      <span className="hidden sm:inline">Share</span>
                    </button>
                  )}
                  {result.match !== "folder" && onDelete && (
                    <button
                      type="button"
                      className="btn btn-accent btn-sm btn-soft min-h-11"
                      aria-label={`Delete ${result.name}`}
                      onClick={() => onDelete(result)}
                    >
                      <TrashIcon aria-hidden="true" />
                      <span className="hidden sm:inline">Delete</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {state.capped && (
            <p className="alert alert-warning mt-4" role="status">
              Showing the first 50 results — refine your query to narrow them
              down.
            </p>
          )}
        </>
      )}
    </div>
  );
}
