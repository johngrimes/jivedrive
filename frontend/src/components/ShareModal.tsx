/**
 * Share modal for a file (T044): expiry select, the generated short link
 * in a readonly input, and a copy button. The link points at the app's
 * own `/s/<token>` endpoint and hides where the file is stored. The
 * token record is stored only until the link expires: links are never
 * listed and cannot be revoked early — they expire on their own.
 *
 * Rebuilt on daisyUI primitives (T013): `modal modal-open` overlay,
 * `modal-box` panel and `modal-backdrop` close button (research R5),
 * `select`, `input`, `btn` and `alert`. The dialog keeps
 * `role="alertdialog"` and its accessible label.
 */
import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { postShareUrl } from "../api/client";
import type { ApiClientError, FileEntry, Space } from "../api/client";

/** Expiry choices per the contract's expiresIn enum. */
const EXPIRY_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days (default)" },
  { value: "30d", label: "30 days" },
] as const;

/** A valid share expiry value. */
export type ShareExpiresIn = (typeof EXPIRY_OPTIONS)[number]["value"];

/** Props for {@link ShareModal}. */
export interface ShareModalProps {
  /** The file being shared. */
  file: FileEntry;
  /**
   * The space the file lives in (R9). Defaults to the caller's own space;
   * in a shared space the key is mount-relative and the generated link is
   * a timed anonymous grant of content the recipient can already download.
   */
  space?: Space;
  /** Close the modal without further action. */
  onClose: () => void;
}

/**
 * Share modal: expiry select, generated link and copy button.
 *
 * @param props - the file being shared and a close callback
 * @returns the share dialog element
 */
export function ShareModal({ file, space = "own", onClose }: ShareModalProps) {
  const [expiresIn, setExpiresIn] = useState<ShareExpiresIn>("7d");
  /** The generated link and the expiry it was signed for. */
  const [link, setLink] = useState<{
    url: string;
    expiresIn: ShareExpiresIn;
    /** The expiry the link was actually signed for (ISO 8601). */
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The link is shown only when it matches the current selection, so
  // changing the expiry immediately shows the generating state and the
  // effect below fetches the link for the new lifetime.
  const loading = link?.expiresIn !== expiresIn;

  useEffect(() => {
    let cancelled = false;
    postShareUrl(file.key, expiresIn, space)
      .then(({ url, expiresAt }) => {
        if (!cancelled) setLink({ url, expiresIn, expiresAt });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const apiError = err as ApiClientError;
          setError(
            apiError?.message ??
              `Could not generate a link for "${file.name}".`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file.key, expiresIn, space, file.name]);

  /**
   * Copy the generated link to the clipboard.
   */
  async function handleCopy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setError("Could not copy the link. Select it and copy it manually.");
    }
  }

  return (
    <div className="modal modal-open">
      <div
        className="modal-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
      >
        <h2 id="share-dialog-title" className="text-lg font-semibold break-all">
          Share {file.name}
        </h2>

        <div className="mt-4">
          <label className="label" htmlFor="share-expiry">
            <span className="label-text">Link expires in</span>
          </label>
          <select
            id="share-expiry"
            className="select w-full"
            value={expiresIn}
            onChange={(event) => {
              setExpiresIn(event.target.value as ShareExpiresIn);
              setError(null);
              setCopied(false);
            }}
            disabled={loading}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="share-link">
            <span className="label-text">Share link</span>
          </label>
          {loading ? (
            <p className="alert alert-info" role="status">
              Generating link...
            </p>
          ) : (
            <input
              id="share-link"
              className="input w-full text-sm"
              type="text"
              readOnly
              value={link?.url ?? ""}
            />
          )}
        </div>

        {link && !loading && (
          <p className="mt-3 text-sm opacity-70" role="status">
            Link expires {new Date(link.expiresAt).toLocaleString()}
          </p>
        )}

        {error && (
          <p className="alert alert-error mt-3" role="alert">
            {error}
          </p>
        )}
        {copied && (
          <p className="alert alert-info mt-3" role="status">
            Link copied to clipboard
          </p>
        )}

        <div className="modal-action">
          <button
            className="btn"
            type="button"
            onClick={() => void handleCopy()}
            disabled={!link || loading}
          >
            <CopyIcon aria-hidden="true" />
            {copied ? "Copied" : "Copy link"}
          </button>
          <button className="btn btn-primary" type="button" onClick={onClose}>
            <CheckIcon aria-hidden="true" />
            Done
          </button>
        </div>

        <p className="text-xs opacity-70">
          Anyone with this link can download the file until it expires. Links
          cannot be listed or revoked early - they expire on their own.
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
