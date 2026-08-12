/**
 * Share modal for a file (T044): expiry select, the generated presigned
 * link in a readonly input, and a copy button. Links are fire-and-forget
 * (FR-012): generated on demand, never stored, and regenerated whenever
 * the chosen expiry changes (US4 scenario 2). The storage provider
 * expires the link naturally - JiveDrive cannot revoke it early.
 */
import { useEffect, useState } from "react";
import { postShareUrl } from "../api/client";
import type { ApiClientError, FileEntry } from "../api/client";

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
  /** Close the modal without further action. */
  onClose: () => void;
}

/**
 * Share modal: expiry select, generated link and copy button.
 *
 * @param props - the file being shared and a close callback
 * @returns the share dialog element
 */
export function ShareModal({ file, onClose }: ShareModalProps) {
  const [expiresIn, setExpiresIn] = useState<ShareExpiresIn>("7d");
  /** The generated link and the expiry it was signed for. */
  const [link, setLink] = useState<{
    url: string;
    expiresIn: ShareExpiresIn;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The link is shown only when it matches the current selection, so
  // changing the expiry immediately shows the generating state and the
  // effect below fetches a fresh link (US4 scenario 2). The route
  // persists nothing (FR-012).
  const loading = link?.expiresIn !== expiresIn;

  useEffect(() => {
    let cancelled = false;
    postShareUrl(file.key, expiresIn)
      .then(({ url }) => {
        if (!cancelled) setLink({ url, expiresIn });
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
  }, [file.key, expiresIn, file.name]);

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
    <div className="modal-overlay">
      <div
        className="share-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
      >
        <h2 id="share-dialog-title" className="share-dialog-title">
          Share {file.name}
        </h2>

        <div className="share-field">
          <label className="share-label" htmlFor="share-expiry">
            Link expires in
          </label>
          <select
            id="share-expiry"
            className="share-select"
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

        <div className="share-field">
          <label className="share-label" htmlFor="share-link">
            Share link
          </label>
          {loading ? (
            <p className="share-status" role="status">
              Generating link...
            </p>
          ) : (
            <input
              id="share-link"
              className="share-link-input"
              type="text"
              readOnly
              value={link?.url ?? ""}
            />
          )}
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {copied && (
          <p className="share-copied" role="status">
            Link copied to clipboard
          </p>
        )}

        <div className="share-actions">
          <button
            className="button button-small"
            type="button"
            onClick={() => void handleCopy()}
            disabled={!link || loading}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            className="button button-small button-primary"
            type="button"
            onClick={onClose}
          >
            Done
          </button>
        </div>

        <p className="annotation">
          Presigned URL. Not stored by JiveDrive; cannot be revoked early - it
          expires on its own.
        </p>
      </div>
    </div>
  );
}
