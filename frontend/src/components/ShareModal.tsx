/**
 * Share modal for a file (T044): expiry select, the generated presigned
 * link in a readonly input, and a copy button. Links are fire-and-forget
 * (FR-012): generated on demand, never stored, and regenerated whenever
 * the chosen expiry changes (US4 scenario 2). The storage provider
 * expires the link naturally - JiveDrive cannot revoke it early.
 *
 * Rebuilt on daisyUI primitives (T013): `modal modal-open` overlay,
 * `modal-box` panel and `modal-backdrop` close button (research R5),
 * `select`, `input`, `btn` and `alert`. The dialog keeps
 * `role="alertdialog"` and its accessible label.
 */
import { useEffect, useState } from "react";
import { postShareUrl } from "../api/client";
import type { ApiClientError, FileEntry } from "../api/client";

/** Expiry choices per the contract's expiresIn enum. */
const EXPIRY_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days (default)" },
  // The nominal 30d choice cannot be signed: SigV4 presigned GET URLs are
  // capped at 7 days, so the route signs it at the provider maximum. The
  // label says so and the dialog shows the real expiry date.
  { value: "30d", label: "30 days (7-day maximum)" },
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
    /** The expiry the link was actually signed for (ISO 8601). */
    expiresAt: string;
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
            {copied ? "Copied" : "Copy link"}
          </button>
          <button className="btn btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        </div>

        <p className="text-xs opacity-70">
          Presigned URL. Not stored by JiveDrive; cannot be revoked early - it
          expires on its own.
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
