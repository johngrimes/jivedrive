/**
 * "Sync with rclone" settings section: the signed-in user issues, lists and
 * revokes S3 keys scoped to their own space, for syncing with rclone.
 *
 * A new key's secret is shown once, in a panel with a ready-to-paste
 * rclone config, example commands and the raw values, each copyable. Once
 * the panel is dismissed the secret is gone for good: the server never
 * stores it. Every action reports success or failure (constitution V).
 */
import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  KeyIcon,
  TrashIcon,
  XIcon,
} from "@primer/octicons-react";
import {
  createSyncCredential,
  listSyncCredentials,
  revokeSyncCredential,
} from "../api/client";
import type {
  ApiClientError,
  CreateSyncCredentialResponse,
  SyncCredential,
} from "../api/client";
import { formatDate } from "../lib/format";

/** The longest label the server accepts, after trimming. */
const MAX_LABEL_LENGTH = 64;

/** One-way sync example command. */
const SYNC_COMMAND = "rclone sync jivedrive: ~/JiveDrive";

/**
 * Two-way sync example command, first run. bisync refuses to start when
 * the local folder is missing, so the command creates it first.
 */
const BISYNC_COMMAND =
  "mkdir -p ~/JiveDrive && rclone bisync jivedrive: ~/JiveDrive --resync";

/** Message shown when a request never reached the server. */
const NETWORK_ERROR =
  "Could not reach the server. Check your connection and try again.";

/** Class for the section headings, matching the admin page. */
const HEADING_CLASS =
  "mb-3 text-sm font-semibold uppercase tracking-wider opacity-60";

/**
 * Turn an API or network failure into a readable message.
 *
 * @param err - the thrown error
 * @param limit - the per-user key limit, for the limit message
 * @param fallback - the message when the server gave none
 * @returns the message to show
 */
function syncErrorMessage(
  err: unknown,
  limit: number,
  fallback: string,
): string {
  const apiError = err as Partial<ApiClientError> | null;
  if (typeof apiError?.status !== "number") return NETWORK_ERROR;
  switch (apiError.code) {
    case "credential_limit":
      return `You already have the maximum of ${limit} sync keys. Revoke one to create another.`;
    case "unsupported_prefix":
      return "Sync keys can't be issued for your storage location because its prefix contains * or ?. Ask an admin for help.";
    case "sync_disabled":
      return "rclone sync is not enabled on this server.";
    default:
      return apiError.message || fallback;
  }
}

/** Props of {@link CopyButton}. */
interface CopyButtonProps {
  /** Accessible name, e.g. "Copy region". */
  name: string;
  /** Whether this value was the last one copied. */
  copied: boolean;
  /** Copies the value. */
  onCopy: () => void;
}

/** A 44px copy button that reads "Copied" after a successful copy. */
function CopyButton({ name, copied, onCopy }: CopyButtonProps) {
  return (
    <button
      className="btn btn-sm min-h-11 shrink-0"
      type="button"
      aria-label={name}
      onClick={onCopy}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The rclone sync settings section.
 *
 * @returns the section element
 */
export function SyncCredentials() {
  // Server data.
  const [enabled, setEnabled] = useState(false);
  const [credentials, setCredentials] = useState<SyncCredential[]>([]);
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(true);

  // Feedback.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Creation.
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateSyncCredentialResponse | null>(
    null,
  );
  const [copiedName, setCopiedName] = useState<string | null>(null);

  // Revocation.
  const [revoking, setRevoking] = useState<SyncCredential | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  /** The one-time panel's heading, focused when the panel opens. */
  const createdHeadingRef = useRef<HTMLHeadingElement>(null);

  // The panel opens below the form, often below the fold on a phone:
  // bring it into view and move focus to it so the new key is noticed.
  useEffect(() => {
    const heading = createdHeadingRef.current;
    if (!created || !heading) return;
    heading.scrollIntoView({ block: "start", behavior: "smooth" });
    heading.focus({ preventScroll: true });
  }, [created]);

  useEffect(() => {
    let cancelled = false;
    listSyncCredentials()
      .then((body) => {
        if (cancelled) return;
        setEnabled(body.enabled);
        setCredentials(body.credentials);
        setLimit(body.limit);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(syncErrorMessage(err, 10, "Could not load your sync keys."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const atLimit = credentials.length >= limit;

  /**
   * Validate the label and issue a new key.
   *
   * @param event - the form submit event
   */
  async function handleCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (creating || atLimit) return;
    setError(null);
    setNotice(null);
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      setError("Enter a label for the key, e.g. the computer's name.");
      return;
    }
    if (trimmed.length > MAX_LABEL_LENGTH) {
      setError(`Labels can be at most ${MAX_LABEL_LENGTH} characters.`);
      return;
    }
    setCreating(true);
    try {
      const body = await createSyncCredential(trimmed);
      setCreated(body);
      setCopiedName(null);
      setCredentials((current) => [body.credential, ...current]);
      setLabel("");
    } catch (err) {
      setError(syncErrorMessage(err, limit, "Could not create the key."));
    } finally {
      setCreating(false);
    }
  }

  /**
   * Copy a value to the clipboard and mark its button.
   *
   * @param name - the copy button's name
   * @param value - the text to copy
   */
  async function handleCopy(name: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedName(name);
    } catch {
      setError("Could not copy. Select the text and copy it manually.");
    }
  }

  /** Confirm the pending revocation. */
  async function handleRevokeConfirm(): Promise<void> {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await revokeSyncCredential(revoking.accessKeyId);
      setCredentials((current) =>
        current.filter((c) => c.accessKeyId !== revoking.accessKeyId),
      );
      if (created?.credential.accessKeyId === revoking.accessKeyId) {
        setCreated(null);
      }
      setNotice(
        `Revoked key "${revoking.label}". It will stop working within a few minutes.`,
      );
      setRevoking(null);
    } catch (err) {
      setRevokeError(syncErrorMessage(err, limit, "Could not revoke the key."));
    } finally {
      setRevokeBusy(false);
    }
  }

  /**
   * Render one raw value with its copy button.
   *
   * @param name - the value's name, e.g. "access key ID"
   * @param value - the value
   * @returns the row element
   */
  function rawValue(name: string, value: string) {
    const copyName = `Copy ${name}`;
    return (
      <div key={name} className="flex items-center gap-2">
        <dl className="min-w-0 flex-1">
          <dt className="text-xs opacity-60">
            {name.charAt(0).toUpperCase() + name.slice(1)}
          </dt>
          <dd className="break-all font-mono text-sm">
            {value === "" ? "(none)" : value}
          </dd>
        </dl>
        <CopyButton
          name={copyName}
          copied={copiedName === copyName}
          onCopy={() => void handleCopy(copyName, value)}
        />
      </div>
    );
  }

  /**
   * Render a copyable command line.
   *
   * @param copyName - the copy button's name
   * @param command - the command
   * @returns the row element
   */
  function commandLine(copyName: string, command: string) {
    return (
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-base-200 p-2 text-sm">
          {command}
        </code>
        <CopyButton
          name={copyName}
          copied={copiedName === copyName}
          onCopy={() => void handleCopy(copyName, command)}
        />
      </div>
    );
  }

  return (
    <section className="mt-6">
      <h2 className={HEADING_CLASS}>Sync with rclone</h2>

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
          Loading sync keys...
        </p>
      ) : !enabled ? (
        <p className="py-4 text-sm opacity-70">
          rclone sync is not enabled on this server.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body gap-3">
              <p className="text-sm">
                Use{" "}
                <a
                  className="link"
                  href="https://rclone.org/"
                  target="_blank"
                  rel="noreferrer"
                >
                  rclone
                </a>{" "}
                to sync your files with a folder on your computer. Create a key
                for each computer and paste its config into rclone.
              </p>
              <ul className="list-disc pl-5 text-sm opacity-80">
                <li>Folders shared with you are not included.</li>
                <li>
                  Changes made through rclone appear in search after the next
                  background scan.
                </li>
                <li>
                  Moving or deleting files through rclone breaks share links to
                  them.
                </li>
              </ul>
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(e) => void handleCreate(e)}
              >
                <label
                  className="label flex-1 flex-col items-start"
                  htmlFor="sync-key-label"
                >
                  <span className="label-text">Key label</span>
                  <input
                    id="sync-key-label"
                    className="input min-h-11 w-full"
                    type="text"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="e.g. Work laptop"
                    autoComplete="off"
                    disabled={creating || atLimit}
                  />
                </label>
                <button
                  className="btn btn-primary min-h-11"
                  type="submit"
                  disabled={creating || atLimit}
                >
                  <KeyIcon aria-hidden="true" />
                  {creating ? "Creating..." : "Create key"}
                </button>
              </form>
              {atLimit && (
                <p className="text-sm opacity-70">
                  You have {credentials.length} of {limit} keys. Revoke one to
                  create another.
                </p>
              )}
            </div>
          </div>

          {created && (
            <section
              className="card border border-warning bg-base-100 shadow-xl"
              aria-label="New sync key"
            >
              <div className="card-body gap-4">
                <h3
                  ref={createdHeadingRef}
                  tabIndex={-1}
                  className="break-all text-lg font-semibold focus:outline-none"
                >
                  Key "{created.credential.label}" created
                </h3>
                <p className="alert alert-warning">
                  Copy the secret now. It won't be shown again.
                </p>

                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    Add this to your rclone config file (
                    <code>rclone config file</code> shows where it is):
                  </p>
                  <pre
                    className="max-w-full whitespace-pre-wrap break-all rounded bg-base-200 p-3 text-sm"
                    aria-label="rclone config"
                  >
                    {created.rcloneConfig}
                  </pre>
                  <div>
                    <CopyButton
                      name="Copy rclone config"
                      copied={copiedName === "Copy rclone config"}
                      onCopy={() =>
                        void handleCopy(
                          "Copy rclone config",
                          created.rcloneConfig,
                        )
                      }
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    Copy your files to this computer, keeping it in step:
                  </p>
                  {commandLine("Copy sync command", SYNC_COMMAND)}
                  <p className="text-sm">
                    Or sync both ways. Use <code>--resync</code> on the first
                    run only and leave it off afterwards:
                  </p>
                  {commandLine("Copy bisync command", BISYNC_COMMAND)}
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    Or set up another S3 client with these values:
                  </p>
                  {rawValue("access key ID", created.credential.accessKeyId)}
                  {rawValue("secret access key", created.secretAccessKey)}
                  {rawValue("endpoint", created.endpoint)}
                  {rawValue("region", created.region)}
                  {rawValue("bucket", created.bucket)}
                  {rawValue("prefix", created.prefix)}
                </div>

                <p className="text-sm italic opacity-70">
                  A new key can take up to about a minute to start working.
                </p>

                {copiedName && (
                  <p className="text-sm text-success" role="status">
                    Copied to clipboard
                  </p>
                )}

                <div className="card-actions justify-end">
                  <button
                    className="btn btn-primary min-h-11"
                    type="button"
                    onClick={() => {
                      setCreated(null);
                      setCopiedName(null);
                    }}
                  >
                    <CheckIcon aria-hidden="true" />
                    I've saved it
                  </button>
                </div>
              </div>
            </section>
          )}

          <div className="card bg-base-100 shadow-xl p-3">
            {credentials.length > 0 ? (
              <table className="table table-xs w-full" aria-label="Sync keys">
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col" className="hidden md:table-cell">
                      Access key ID
                    </th>
                    <th scope="col" className="hidden md:table-cell">
                      Created
                    </th>
                    <th
                      scope="col"
                      className="whitespace-nowrap pr-0 text-right"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {credentials.map((credential) => (
                    <tr key={credential.accessKeyId}>
                      <td className="break-all">
                        <span className="font-semibold break-all">
                          {credential.label}
                        </span>
                        <span className="block break-all font-mono text-xs opacity-60 md:hidden">
                          {credential.accessKeyId}
                        </span>
                        <span className="block text-xs opacity-60 md:hidden">
                          Created {formatDate(credential.createdAt)}
                        </span>
                      </td>
                      <td className="hidden break-all font-mono md:table-cell">
                        {credential.accessKeyId}
                      </td>
                      <td className="hidden md:table-cell">
                        {formatDate(credential.createdAt)}
                      </td>
                      <td className="pr-0 text-right">
                        <button
                          className="btn btn-error min-h-11"
                          type="button"
                          aria-label={`Revoke key ${credential.label}`}
                          onClick={() => {
                            setRevokeError(null);
                            setRevoking(credential);
                          }}
                          disabled={revokeBusy}
                        >
                          <TrashIcon aria-hidden="true" />
                          <span className="hidden sm:inline">Revoke</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-body">
                <p className="py-4 text-center text-sm opacity-70">
                  No sync keys yet.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {revoking && (
        <div className="modal modal-open">
          <div
            className="modal-box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-dialog-title"
          >
            <h2
              id="revoke-dialog-title"
              className="text-lg font-semibold break-all"
            >
              Revoke {revoking.label}?
            </h2>
            <p className="py-4">
              The key stops working within a few minutes, and rclone on any
              computer using it stops syncing. Your files are not touched.
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
                aria-label="Revoke key"
                onClick={() => void handleRevokeConfirm()}
                disabled={revokeBusy}
              >
                <TrashIcon aria-hidden="true" />
                {revokeBusy ? "Revoking..." : "Revoke key"}
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
