/**
 * Admin user management page (T052, User Story 6): invite creation, the
 * pending/claimed/expired invites table, and the users table with removal.
 *
 * Accessible to admins only (FR-015): a signed-in non-admin sees a clear
 * access-denied message; a signed-out visitor is redirected to sign in.
 *
 * Every action surfaces explicit success or failure feedback (constitution
 * V): the created/re-sent link is shown with a copy button, cancellations
 * and removals report their outcome, and removals require a confirm
 * dialog before any request (wireframes/admin-users.html).
 *
 * Rebuilt on daisyUI primitives (T018): card invite form (input,
 * checkbox), generated-link card with readonly input + copy `btn`,
 * invites and users tables with status `badge`s, and a `modal modal-open`
 * removal confirmation (research R5). Navigation lives in the AppShell
 * drawer/sidebar (US1), so the page renders only its content card.
 *
 * Mobile-first (US3, FR-006/007): breakpoint-hidden column values (role
 * below `sm`; bucket/prefix and expires/created below `md`) stack as
 * secondary lines under the username, returning to their own columns at
 * the breakpoint and up; row actions are octicon buttons — icon+text at
 * `sm` and up, icon-only below with the accessible name on the button
 * (`aria-label` identical to the visible label). The removal dialog's
 * Cancel/Remove buttons carry decorative octicons (FR-004).
 */
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  KeyIcon,
  PaperAirplaneIcon,
  SyncIcon,
  TrashIcon,
  XIcon,
} from "@primer/octicons-react";
import {
  cancelAdminInvite,
  createAdminInvite,
  listAdminInvites,
  listAdminUsers,
  reindexUser,
  removeAdminUser,
  resendAdminInvite,
  resetUserPasskeys,
} from "../api/client";
import type { AdminUser, ApiClientError, Invite } from "../api/client";
import { useSession } from "../auth/sessionContext";
import { formatDate } from "../lib/format";

/** A generated invite link shown to the admin for copying. */
interface GeneratedLink {
  /** Full registration URL containing the invite token. */
  url: string;
  /** The invitee the link belongs to. */
  username: string;
  /** How the link was produced: invite creation/resend or passkey reset. */
  kind: "invite" | "reset";
}

/** The user pending removal confirmation. */
interface PendingRemoval {
  id: string;
  username: string;
}

/** The user pending passkey-reset confirmation. */
interface PendingReset {
  id: string;
  username: string;
}

/** The invite currently being re-sent (busy state). */
interface ResendingInvite {
  id: string;
}

/** The user whose search index is currently being rebuilt (busy state). */
interface ReindexingUser {
  id: string;
}

/** Extract a readable message from an unknown error. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}

/** Role label for the users and invites tables. */
function roleLabel(isAdmin: boolean): string {
  return isAdmin ? "Admin" : "Member";
}

/** daisyUI badge variant for an invite status (pending/claimed/expired). */
function inviteBadgeClass(status: Invite["status"]): string {
  switch (status) {
    case "pending":
      return "badge-warning";
    case "claimed":
      return "badge-success";
    case "expired":
      return "badge-ghost";
  }
}

/**
 * Admin user management page.
 *
 * @returns the user management element
 */
export function AdminUsersPage() {
  const { user, loading: sessionLoading } = useSession();

  // Invite form state.
  const [username, setUsername] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  // Server data.
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Action state.
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [removal, setRemoval] = useState<PendingRemoval | null>(null);
  const [removing, setRemoving] = useState(false);
  const [reset, setReset] = useState<PendingReset | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resending, setResending] = useState<ResendingInvite | null>(null);
  /** The user pending a search-index rebuild (busy state). */
  const [reindexing, setReindexing] = useState<ReindexingUser | null>(null);

  /**
   * Load both admin tables.
   */
  async function loadData(): Promise<void> {
    setError(null);
    try {
      const [usersBody, invitesBody] = await Promise.all([
        listAdminUsers(),
        listAdminInvites(),
      ]);
      setUsers(usersBody.users);
      setInvites(invitesBody.invites);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }

  // Initial load follows the promise pattern (no synchronous setState in
  // the effect body), matching the Files page.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listAdminUsers(), listAdminInvites()])
      .then(([usersBody, invitesBody]) => {
        if (cancelled) return;
        setUsers(usersBody.users);
        setInvites(invitesBody.invites);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (sessionLoading) {
    return (
      <p className="py-8 text-center opacity-70" role="status">
        Loading...
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }
  if (!user.isAdmin) {
    return (
      <div className="alert alert-error" role="alert">
        <div>
          <h1 className="text-lg font-semibold">Access denied</h1>
          <p>
            Admin access required. Only admins can manage users and invites.
          </p>
          <Link className="btn mt-2" to="/files">
            Back to files
          </Link>
        </div>
      </div>
    );
  }

  /**
   * Create an invite and show the generated link (US6 scenario 1).
   *
   * @param event - the form submit event
   */
  async function handleCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const body = await createAdminInvite({
        username,
        bucket,
        prefix,
        isAdmin,
      });
      setGeneratedLink({
        url: body.link,
        username: body.invite.username,
        kind: "invite",
      });
      setNotice(`Invite for "${body.invite.username}" created`);
      setUsername("");
      setBucket("");
      setPrefix("");
      setIsAdmin(false);
      await loadData();
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? "Could not create the invite.");
    } finally {
      setCreating(false);
    }
  }

  /**
   * Copy a generated link to the clipboard.
   */
  async function handleCopy(): Promise<void> {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink.url);
      setCopied(true);
    } catch {
      setError("Could not copy the link. Select it and copy it manually.");
    }
  }

  /**
   * Re-send an invite (fresh token and 48-hour expiry) and show the new
   * link (US6 scenario 3).
   *
   * @param invite - the invite being re-sent
   */
  async function handleResend(invite: Invite): Promise<void> {
    if (resending) return;
    setResending({ id: invite.id });
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const body = await resendAdminInvite(invite.id);
      setGeneratedLink({
        url: body.link,
        username: body.invite.username,
        kind: "invite",
      });
      setNotice(`Invite for "${body.invite.username}" re-sent`);
      await loadData();
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? "Could not re-send the invite.");
    } finally {
      setResending(null);
    }
  }

  /**
   * Cancel a pending or expired invite (US6 scenarios 2-3).
   *
   * @param invite - the invite being cancelled
   */
  async function handleCancel(invite: Invite): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await cancelAdminInvite(invite.id);
      setNotice(`Invite for "${invite.username}" cancelled`);
      await loadData();
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? "Could not cancel the invite.");
    }
  }

  /**
   * Confirm a removal: delete the account row (storage objects are left
   * untouched, FR-014) and refresh the user list.
   */
  async function handleRemoveConfirm(): Promise<void> {
    if (!removal || removing) return;
    setRemoving(true);
    setError(null);
    try {
      await removeAdminUser(removal.id);
      setNotice(`Removed user "${removal.username}"`);
      setRemoval(null);
      await loadData();
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? "Could not remove the user.");
    } finally {
      setRemoving(false);
    }
  }

  /**
   * Confirm a passkey reset (FR-006): delete every credential of the user,
   * revoke all of their sessions (including the caller's own on
   * self-reset) and cancel pending invites; the response carries the fresh
   * 48-hour re-enrollment invite and its link, which is shown for copying
   * so the user can re-enroll (US1 attach flow) — no dead end.
   */
  async function handleResetConfirm(): Promise<void> {
    if (!reset || resetting) return;
    setResetting(true);
    setError(null);
    setCopied(false);
    try {
      const body = await resetUserPasskeys(reset.id);
      setGeneratedLink({
        url: body.link,
        username: body.invite.username,
        kind: "reset",
      });
      setNotice(
        `Passkeys reset for "${body.invite.username}". Re-enrollment link created.`,
      );
      setReset(null);
      await loadData();
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? "Could not reset the passkeys.");
    } finally {
      setResetting(false);
    }
  }

  /**
   * Force an immediate search-index rebuild for a user (007-file-search,
   * US4, FR-017). The endpoint runs synchronously and reports the
   * counts, so the notice can state exactly what happened (constitution
   * V: no silent success or failure).
   *
   * @param target - the user whose index is being rebuilt
   */
  async function handleReindex(target: AdminUser): Promise<void> {
    if (reindexing) return;
    setReindexing({ id: target.id });
    setError(null);
    setNotice(null);
    try {
      const counts = await reindexUser(target.id);
      setNotice(
        `Search index rebuilt for "${target.username}" (${counts.indexed} indexed, ${counts.reindexed} re-extracted, ${counts.removed} removed)`,
      );
    } catch (err) {
      const apiError = err as ApiClientError;
      setError(apiError?.message ?? "Could not rebuild the search index.");
    } finally {
      setReindexing(null);
    }
  }
  return (
    <div className="flex w-full max-w-5xl flex-col gap-4 pt-2">
      <main className="min-w-0 flex-1 rounded-box bg-base-200 p-4 md:p-6">
        <h1 className="mb-1 text-2xl font-semibold">User management</h1>

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="alert alert-success" role="status">
            {notice}
          </p>
        )}

        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider opacity-60">
            Invite a user
          </h2>
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => void handleCreate(e)}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                  <label
                    className="label flex-col items-start"
                    htmlFor="invite-username"
                  >
                    <span className="label-text">Username</span>
                    <input
                      id="invite-username"
                      className="input w-full"
                      type="text"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label
                    className="label flex-col items-start"
                    htmlFor="invite-bucket"
                  >
                    <span className="label-text">Bucket</span>
                    <input
                      id="invite-bucket"
                      className="input w-full"
                      type="text"
                      value={bucket}
                      onChange={(event) => setBucket(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label
                    className="label flex-col items-start"
                    htmlFor="invite-prefix"
                  >
                    <span className="label-text">Prefix</span>
                    <input
                      id="invite-prefix"
                      className="input w-full"
                      type="text"
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                      placeholder="users/alice/"
                      autoComplete="off"
                    />
                  </label>
                  <label
                    className="label min-h-11 cursor-pointer gap-2"
                    htmlFor="invite-admin"
                  >
                    <input
                      id="invite-admin"
                      className="checkbox checkbox-primary"
                      type="checkbox"
                      checked={isAdmin}
                      onChange={(event) => setIsAdmin(event.target.checked)}
                    />
                    <span className="label-text">Admin?</span>
                  </label>
                </div>
                <button
                  className="btn btn-primary max-w-3xs"
                  type="submit"
                  disabled={creating}
                >
                  {creating ? "Creating..." : "Create invite link"}
                </button>
              </form>
              <p className="mt-3 text-xs italic opacity-60">
                Invite expires 48 hours after creation. You can re-send or
                cancel it from the list below.
              </p>
            </div>
          </div>

          {generatedLink && (
            <div className="card mt-4 bg-base-100 shadow-xl">
              <div className="card-body">
                <p className="font-semibold break-all">
                  {generatedLink.kind === "reset"
                    ? `Re-enrollment link for ${generatedLink.username}`
                    : `Invite link for ${generatedLink.username}`}
                </p>
                <div className="flex items-stretch gap-2">
                  <input
                    className="input min-w-0 flex-1 text-sm"
                    type="text"
                    readOnly
                    value={generatedLink.url}
                    aria-label={
                      generatedLink.kind === "reset"
                        ? "Re-enrollment link"
                        : "Invite link"
                    }
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void handleCopy()}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {copied && (
                  <p className="alert alert-info mt-3" role="status">
                    Link copied to clipboard
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider opacity-60">
            Invites
          </h2>
          <div className="card bg-base-100 shadow-xl p-3">
            {loading ? (
              <div className="card-body">
                <p
                  className="py-4 text-center text-sm opacity-70"
                  role="status"
                >
                  Loading invites...
                </p>
              </div>
            ) : invites && invites.length > 0 ? (
              <table className="table table-xs w-full" aria-label="Invites">
                <thead>
                  <tr>
                    <th scope="col">Username</th>
                    <th scope="col" className="hidden sm:table-cell">
                      Role
                    </th>
                    <th scope="col" className="hidden md:table-cell">
                      Bucket / prefix
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col" className="hidden md:table-cell">
                      Expires
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
                  {invites.map((invite) => (
                    <tr key={invite.id}>
                      <td className="break-all">
                        <span className="font-semibold break-all">
                          {invite.username}
                        </span>
                        <span className="block text-xs opacity-60 sm:hidden">
                          {roleLabel(invite.isAdmin)}
                        </span>
                        <span className="block break-all text-xs opacity-60 md:hidden">
                          {invite.bucket} / {invite.prefix}
                        </span>
                        <span className="block text-xs opacity-60 md:hidden">
                          Expires {formatDate(invite.expiresAt)}
                        </span>
                      </td>
                      <td className="hidden sm:table-cell">
                        {roleLabel(invite.isAdmin)}
                      </td>
                      <td className="break-all hidden md:table-cell">
                        {invite.bucket} / {invite.prefix}
                      </td>
                      <td>
                        <span
                          className={`badge ${inviteBadgeClass(invite.status)}`}
                        >
                          {invite.status}
                        </span>
                      </td>
                      <td className="hidden md:table-cell">
                        {formatDate(invite.expiresAt)}
                      </td>
                      <td className="whitespace-nowrap pr-0 text-right">
                        {invite.status !== "claimed" && (
                          <>
                            <button
                              className="btn btn-ghost min-h-11"
                              type="button"
                              aria-label="Re-send"
                              onClick={() => void handleResend(invite)}
                              disabled={resending?.id === invite.id}
                            >
                              <PaperAirplaneIcon aria-hidden="true" />
                              <span className="hidden sm:inline">
                                {resending?.id === invite.id
                                  ? "Re-sending..."
                                  : "Re-send"}
                              </span>
                            </button>
                            <button
                              className="btn btn-ghost min-h-11"
                              type="button"
                              aria-label="Cancel"
                              onClick={() => void handleCancel(invite)}
                            >
                              <XIcon aria-hidden="true" />
                              <span className="hidden sm:inline">Cancel</span>
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-body">
                <p className="py-4 text-center text-sm opacity-70">
                  No invites yet. Create one above.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider opacity-60">
            Users
          </h2>
          <div className="card bg-base-100 shadow-xl p-3">
            {loading ? (
              <div className="card-body">
                <p
                  className="py-4 text-center text-sm opacity-70"
                  role="status"
                >
                  Loading users...
                </p>
              </div>
            ) : users && users.length > 0 ? (
              <table className="table table-xs w-full" aria-label="Users">
                <thead>
                  <tr>
                    <th scope="col">Username</th>
                    <th scope="col" className="hidden sm:table-cell">
                      Role
                    </th>
                    <th scope="col" className="hidden md:table-cell">
                      Bucket / prefix
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
                  {users.map((entry) => (
                    <tr key={entry.id}>
                      <td className="break-all">
                        <span className="font-semibold break-all">
                          {entry.username}
                        </span>
                        <span className="block text-xs opacity-60 sm:hidden">
                          {roleLabel(entry.isAdmin)}
                        </span>
                        <span className="block break-all text-xs opacity-60 md:hidden">
                          {entry.bucket} / {entry.prefix}
                        </span>
                        <span className="block text-xs opacity-60 md:hidden">
                          Created {formatDate(entry.createdAt)}
                        </span>
                      </td>
                      <td className="hidden sm:table-cell">
                        {roleLabel(entry.isAdmin)}
                      </td>
                      <td className="break-all hidden md:table-cell">
                        {entry.bucket} / {entry.prefix}
                      </td>
                      <td className="hidden md:table-cell">
                        {formatDate(entry.createdAt)}
                      </td>
                      <td className="pr-0 text-right">
                        <button
                          className="btn btn-ghost min-h-11"
                          type="button"
                          aria-label="Rebuild search index"
                          onClick={() => void handleReindex(entry)}
                          disabled={reindexing !== null}
                        >
                          <SyncIcon aria-hidden="true" />
                          <span className="hidden sm:inline">
                            {reindexing?.id === entry.id
                              ? "Rebuilding..."
                              : "Rebuild index"}
                          </span>
                        </button>
                        <button
                          className="btn btn-ghost min-h-11"
                          type="button"
                          aria-label="Reset passkeys"
                          onClick={() =>
                            setReset({
                              id: entry.id,
                              username: entry.username,
                            })
                          }
                          disabled={resetting}
                        >
                          <KeyIcon aria-hidden="true" />
                          <span className="hidden sm:inline">
                            Reset passkeys
                          </span>
                        </button>
                        {entry.id !== user.id ? (
                          <button
                            className="btn btn-error min-h-11"
                            type="button"
                            aria-label="Remove"
                            onClick={() =>
                              setRemoval({
                                id: entry.id,
                                username: entry.username,
                              })
                            }
                            disabled={removing}
                          >
                            <TrashIcon aria-hidden="true" />
                            <span className="hidden sm:inline">Remove</span>
                          </button>
                        ) : (
                          <span className="opacity-60">(you)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-body">
                <p className="py-4 text-center text-sm opacity-70">
                  No users yet.
                </p>
              </div>
            )}
            <div className="card-body border-t border-base-300/50">
              <p className="text-xs italic opacity-60">
                Removing a user deletes the account and invite links only. Their
                objects in storage are left untouched.
              </p>
            </div>
          </div>
        </section>
      </main>

      {removal && (
        <div className="modal modal-open">
          <div
            className="modal-box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-dialog-title"
          >
            <h2
              id="remove-dialog-title"
              className="text-lg font-semibold break-all"
            >
              Remove {removal.username}?
            </h2>
            <p className="py-4">
              "{removal.username}" will no longer be able to sign in, and any
              invite links will stop working. Objects in their storage space are
              left untouched.
            </p>

            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}

            <div className="modal-action">
              <button
                className="btn"
                type="button"
                onClick={() => setRemoval(null)}
                disabled={removing}
              >
                <XIcon aria-hidden="true" />
                Cancel
              </button>
              <button
                className="btn btn-error"
                type="button"
                onClick={() => void handleRemoveConfirm()}
                disabled={removing}
              >
                <TrashIcon aria-hidden="true" />
                {removing ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => setRemoval(null)}
          />
        </div>
      )}

      {reset && (
        <div className="modal modal-open">
          <div
            className="modal-box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
          >
            <h2
              id="reset-dialog-title"
              className="text-lg font-semibold break-all"
            >
              Reset passkeys for {reset.username}?
            </h2>
            <p className="py-4">
              All passkeys for "{reset.username}" will be deleted and every
              session for the account will be revoked, including your own if you
              are resetting yourself. Pending invites are cancelled and a fresh
              48-hour re-enrollment link is issued. The user signs in again by
              opening that link and creating a new passkey.
            </p>

            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}

            <div className="modal-action">
              <button
                className="btn"
                type="button"
                onClick={() => setReset(null)}
                disabled={resetting}
              >
                <XIcon aria-hidden="true" />
                Cancel
              </button>
              <button
                className="btn btn-warning"
                type="button"
                onClick={() => void handleResetConfirm()}
                disabled={resetting}
              >
                <KeyIcon aria-hidden="true" />
                {resetting ? "Resetting..." : "Reset passkeys"}
              </button>
            </div>
          </div>
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => setReset(null)}
          />
        </div>
      )}
    </div>
  );
}
