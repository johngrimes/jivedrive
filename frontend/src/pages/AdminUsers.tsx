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
 * Rebuilt on daisyUI primitives (T018): card invite form (input, checkbox),
 * generated-link card with readonly input + copy `btn`, invites and users
 * tables with status `badge`s, and a `modal modal-open` removal
 * confirmation (research R5). The sidebar shows at `lg` and up (research
 * R4). The tables carry `aria-label`s ("Invites"/"Users") and hide wide
 * columns below breakpoints so they never scroll horizontally at 375px
 * (spec SC-004).
 */
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  cancelAdminInvite,
  createAdminInvite,
  listAdminInvites,
  listAdminUsers,
  removeAdminUser,
  resendAdminInvite,
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
}

/** The user pending removal confirmation. */
interface PendingRemoval {
  id: string;
  username: string;
}

/** The invite currently being re-sent (busy state). */
interface ResendingInvite {
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
  const [resending, setResending] = useState<ResendingInvite | null>(null);

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
      setGeneratedLink({ url: body.link, username: body.invite.username });
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
      setGeneratedLink({ url: body.link, username: body.invite.username });
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

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4 pt-2 lg:flex-row lg:items-start">
      <aside className="hidden lg:block lg:w-56 lg:shrink-0">
        <div className="flex flex-col gap-1 rounded-box bg-base-200 p-4">
          <Link
            className="link link-hover inline-flex min-h-11 items-center"
            to="/files"
          >
            Files
          </Link>
          <p className="inline-flex min-h-11 items-center rounded-box bg-base-100 px-2 font-semibold">
            Manage users
          </p>
        </div>
      </aside>

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
                  <div className="flex-1">
                    <label className="label" htmlFor="invite-username">
                      <span className="label-text">Username</span>
                    </label>
                    <input
                      id="invite-username"
                      className="input w-full"
                      type="text"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex-1">
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
                </div>
                <div className="flex flex-col gap-4 sm:flex-row">
                  <div className="flex-1">
                    <label className="label" htmlFor="invite-bucket">
                      <span className="label-text">Bucket</span>
                    </label>
                    <input
                      id="invite-bucket"
                      className="input w-full"
                      type="text"
                      value={bucket}
                      onChange={(event) => setBucket(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="label" htmlFor="invite-prefix">
                      <span className="label-text">Prefix</span>
                    </label>
                    <input
                      id="invite-prefix"
                      className="input w-full"
                      type="text"
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                      placeholder="users/alice/"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary"
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
                  Invite link for {generatedLink.username}
                </p>
                <div className="flex items-stretch gap-2">
                  <input
                    className="input min-w-0 flex-1 text-sm"
                    type="text"
                    readOnly
                    value={generatedLink.url}
                    aria-label="Invite link"
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
          <div className="card bg-base-100 shadow-xl">
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
                      <td className="break-all">{invite.username}</td>
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
                              className="btn btn-ghost px-0"
                              type="button"
                              onClick={() => void handleResend(invite)}
                              disabled={resending?.id === invite.id}
                            >
                              {resending?.id === invite.id
                                ? "Re-sending..."
                                : "Re-send"}
                            </button>
                            <span className="opacity-50" aria-hidden="true">
                              ·
                            </span>
                            <button
                              className="btn btn-ghost px-0"
                              type="button"
                              onClick={() => void handleCancel(invite)}
                            >
                              Cancel
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
          <div className="card bg-base-100 shadow-xl">
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
                      <td className="break-all">{entry.username}</td>
                      <td className="hidden sm:table-cell">
                        {roleLabel(entry.isAdmin)}
                      </td>
                      <td className="break-all hidden md:table-cell">
                        {entry.bucket} / {entry.prefix}
                      </td>
                      <td className="hidden md:table-cell">
                        {formatDate(entry.createdAt)}
                      </td>
                      <td className="whitespace-nowrap pr-0 text-right">
                        {entry.id !== user.id ? (
                          <button
                            className="btn btn-error"
                            type="button"
                            onClick={() =>
                              setRemoval({
                                id: entry.id,
                                username: entry.username,
                              })
                            }
                            disabled={removing}
                          >
                            Remove
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
                Cancel
              </button>
              <button
                className="btn btn-error"
                type="button"
                onClick={() => void handleRemoveConfirm()}
                disabled={removing}
              >
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
    </div>
  );
}
