/**
 * "Connected apps" settings section: the apps (e.g. Claude) the signed-in
 * user has allowed to access their drive through the MCP server, each with
 * when it was connected and last used, and a confirmed Revoke that cuts its
 * access immediately. Every action reports success or failure
 * (constitution V).
 */
import { useEffect, useState } from "react";
import { TrashIcon, XIcon } from "@primer/octicons-react";
import { listConnectedApps, revokeConnectedApp } from "../api/client";
import type { ApiClientError, ConnectedApp } from "../api/client";
import { formatDate } from "../lib/format";

/** Message shown when a request never reached the server. */
const NETWORK_ERROR =
  "Could not reach the server. Check your connection and try again.";

/** Class for the section headings, matching the other settings sections. */
const HEADING_CLASS =
  "mb-3 text-sm font-semibold uppercase tracking-wider opacity-60";

/**
 * Turn an API or network failure into a readable message.
 *
 * @param err - the thrown error
 * @param fallback - the message when the server gave none
 * @returns the message to show
 */
function errorMessage(err: unknown, fallback: string): string {
  const apiError = err as Partial<ApiClientError> | null;
  if (typeof apiError?.status !== "number") return NETWORK_ERROR;
  return apiError.message || fallback;
}

/**
 * The Connected apps settings section.
 *
 * @returns the section element
 */
export function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<ConnectedApp | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConnectedApps()
      .then((body) => {
        if (!cancelled) setApps(body.grants);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(errorMessage(err, "Could not load your connected apps."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Remove an app from the list and close the confirmation.
   *
   * @param app - the app to drop
   * @param message - the success notice to show
   */
  function dropApp(app: ConnectedApp, message: string): void {
    setApps((current) => current.filter((a) => a.id !== app.id));
    setNotice(message);
    setRevoking(null);
  }

  /** Confirm the pending revocation. */
  async function handleRevokeConfirm(): Promise<void> {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    setNotice(null);
    try {
      await revokeConnectedApp(revoking.id);
      dropApp(
        revoking,
        `Revoked "${revoking.clientName}". It can no longer access your drive.`,
      );
    } catch (err) {
      if ((err as Partial<ApiClientError>)?.code === "not_found") {
        // Already gone (revoked elsewhere): the outcome the user wanted.
        dropApp(revoking, `"${revoking.clientName}" was already disconnected.`);
      } else {
        setRevokeError(errorMessage(err, "Could not revoke the app."));
      }
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <section className="mt-6">
      <h2 className={HEADING_CLASS}>Connected apps</h2>

      {error && (
        <p className="alert alert-error mb-4" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="alert alert-success mb-4" role="status">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="py-4 text-center text-sm opacity-70" role="status">
          Loading connected apps...
        </p>
      ) : (
        !error && (
          <div className="card bg-base-100 shadow-xl p-3">
            {apps.length > 0 ? (
              <ul className="flex flex-col" aria-label="Connected apps">
                {apps.map((app) => (
                  <li
                    key={app.id}
                    className="flex items-center gap-3 border-b border-base-200 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block font-semibold break-words">
                        {app.clientName}
                      </span>
                      <span className="block text-xs opacity-60">
                        Connected {formatDate(app.createdAt)}
                      </span>
                      <span className="block text-xs opacity-60">
                        Last used{" "}
                        {app.lastUsedAt ? formatDate(app.lastUsedAt) : "Never"}
                      </span>
                    </div>
                    <button
                      className="btn btn-error min-h-11 shrink-0"
                      type="button"
                      aria-label={`Revoke ${app.clientName}`}
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(app);
                      }}
                      disabled={revokeBusy}
                    >
                      <TrashIcon aria-hidden="true" />
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="card-body">
                <p className="py-4 text-center text-sm opacity-70 break-words">
                  No apps are connected. Add JiveDrive as a connector in Claude
                  using {window.location.origin}/mcp.
                </p>
              </div>
            )}
          </div>
        )
      )}

      {revoking && (
        <div className="modal modal-open">
          <div
            className="modal-box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-app-dialog-title"
          >
            <h2
              id="revoke-app-dialog-title"
              className="text-lg font-semibold break-words"
            >
              Revoke {revoking.clientName}?
            </h2>
            <p className="py-4">
              It loses access to your drive immediately and must be connected
              again to use it. Your files are not touched.
            </p>

            {revokeError && (
              <p className="alert alert-error" role="alert">
                {revokeError}
              </p>
            )}

            <div className="modal-action">
              <button
                className="btn min-h-11"
                type="button"
                onClick={() => setRevoking(null)}
                disabled={revokeBusy}
              >
                <XIcon aria-hidden="true" />
                Cancel
              </button>
              <button
                className="btn btn-error min-h-11"
                type="button"
                onClick={() => void handleRevokeConfirm()}
                disabled={revokeBusy}
              >
                <TrashIcon aria-hidden="true" />
                {revokeBusy ? "Revoking..." : "Revoke access"}
              </button>
            </div>
          </div>
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => {
              if (!revokeBusy) setRevoking(null);
            }}
          />
        </div>
      )}
    </section>
  );
}
