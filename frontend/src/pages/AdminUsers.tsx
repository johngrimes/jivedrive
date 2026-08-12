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
      <p className="status" role="status">
        Loading...
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }
  if (!user.isAdmin) {
    return (
      <div className="page" role="alert">
        <h1>Access denied</h1>
        <p>Admin access required. Only admins can manage users and invites.</p>
        <Link className="button" to="/files">
          Back to files
        </Link>
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
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <Link className="admin-sidebar-link" to="/files">
          Files
        </Link>
        <p className="admin-sidebar-link admin-sidebar-active">Manage users</p>
      </aside>

      <main className="admin-main">
        <h1 className="admin-title">User management</h1>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="success" role="status">
            {notice}
          </p>
        )}

        <section className="admin-section">
          <h2 className="admin-section-title">Invite a user</h2>
          <div className="admin-card">
            <form
              className="invite-form"
              onSubmit={(e) => void handleCreate(e)}
            >
              <div className="invite-row">
                <div className="field-group">
                  <label className="field-label" htmlFor="invite-username">
                    Username
                  </label>
                  <input
                    id="invite-username"
                    className="text-input"
                    type="text"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="field-group">
                  <label className="field-label admin-checkbox-label">
                    <input
                      className="admin-checkbox"
                      type="checkbox"
                      checked={isAdmin}
                      onChange={(event) => setIsAdmin(event.target.checked)}
                    />
                    Admin?
                  </label>
                </div>
              </div>
              <div className="invite-row">
                <div className="field-group">
                  <label className="field-label" htmlFor="invite-bucket">
                    Bucket
                  </label>
                  <input
                    id="invite-bucket"
                    className="text-input"
                    type="text"
                    value={bucket}
                    onChange={(event) => setBucket(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="invite-prefix">
                    Prefix
                  </label>
                  <input
                    id="invite-prefix"
                    className="text-input"
                    type="text"
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder="users/alice/"
                    autoComplete="off"
                  />
                </div>
              </div>
              <button
                className="button button-primary"
                type="submit"
                disabled={creating}
              >
                {creating ? "Creating..." : "Create invite link"}
              </button>
            </form>
            <p className="annotation">
              Invite expires 48 hours after creation. You can re-send or cancel
              it from the list below.
            </p>
          </div>

          {generatedLink && (
            <div className="admin-card invite-link-card">
              <p className="invite-link-title">
                Invite link for {generatedLink.username}
              </p>
              <div className="invite-link-row">
                <input
                  className="share-link-input"
                  type="text"
                  readOnly
                  value={generatedLink.url}
                  aria-label="Invite link"
                />
                <button
                  className="button button-small"
                  type="button"
                  onClick={() => void handleCopy()}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {copied && (
                <p className="share-copied" role="status">
                  Link copied to clipboard
                </p>
              )}
            </div>
          )}
        </section>

        <section className="admin-section">
          <h2 className="admin-section-title">Invites</h2>
          <div className="admin-card">
            {loading ? (
              <p className="status" role="status">
                Loading invites...
              </p>
            ) : invites && invites.length > 0 ? (
              <table className="file-table invites-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Bucket / prefix</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th className="file-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((invite) => (
                    <tr key={invite.id}>
                      <td className="file-name">{invite.username}</td>
                      <td>{roleLabel(invite.isAdmin)}</td>
                      <td>
                        {invite.bucket} / {invite.prefix}
                      </td>
                      <td>
                        <span className={`tag tag-${invite.status}`}>
                          {invite.status}
                        </span>
                      </td>
                      <td>{formatDate(invite.expiresAt)}</td>
                      <td className="file-actions">
                        {invite.status === "pending" && (
                          <>
                            <button
                              className="file-action"
                              type="button"
                              onClick={() => void handleResend(invite)}
                              disabled={resending?.id === invite.id}
                            >
                              {resending?.id === invite.id
                                ? "Re-sending..."
                                : "Re-send"}
                            </button>
                            <span className="file-action-sep">·</span>
                            <button
                              className="file-action"
                              type="button"
                              onClick={() => void handleCancel(invite)}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {invite.status === "expired" && (
                          <>
                            <button
                              className="file-action"
                              type="button"
                              onClick={() => void handleResend(invite)}
                              disabled={resending?.id === invite.id}
                            >
                              {resending?.id === invite.id
                                ? "Re-sending..."
                                : "Re-send"}
                            </button>
                            <span className="file-action-sep">·</span>
                            <button
                              className="file-action"
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
              <p className="empty-state-text">
                No invites yet. Create one above.
              </p>
            )}
          </div>
        </section>

        <section className="admin-section">
          <h2 className="admin-section-title">Users</h2>
          <div className="admin-card">
            {loading ? (
              <p className="status" role="status">
                Loading users...
              </p>
            ) : users && users.length > 0 ? (
              <table className="file-table users-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Bucket / prefix</th>
                    <th>Created</th>
                    <th className="file-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((entry) => (
                    <tr key={entry.id}>
                      <td className="file-name">{entry.username}</td>
                      <td>{roleLabel(entry.isAdmin)}</td>
                      <td>
                        {entry.bucket} / {entry.prefix}
                      </td>
                      <td>{formatDate(entry.createdAt)}</td>
                      <td className="file-actions">
                        {entry.id !== user.id ? (
                          <button
                            className="file-action file-action-danger"
                            type="button"
                            onClick={() =>
                              setRemoval({
                                id: entry.id,
                                username: entry.username,
                              })
                            }
                          >
                            Remove
                          </button>
                        ) : (
                          <span className="file-action-sep">(you)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty-state-text">No users yet.</p>
            )}
            <p className="annotation">
              Removing a user deletes the account and invite links only. Their
              objects in storage are left untouched.
            </p>
          </div>
        </section>
      </main>

      {removal && (
        <div className="modal-overlay">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-dialog-title"
          >
            <h2 id="remove-dialog-title" className="confirm-dialog-title">
              Remove {removal.username}?
            </h2>
            <p className="confirm-dialog-text">
              "{removal.username}" will no longer be able to sign in, and any
              invite links will stop working. Objects in their storage space are
              left untouched.
            </p>

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}

            <div className="confirm-dialog-actions">
              <button
                className="button button-small"
                type="button"
                onClick={() => setRemoval(null)}
                disabled={removing}
              >
                Cancel
              </button>
              <button
                className="button button-small button-danger"
                type="button"
                onClick={() => void handleRemoveConfirm()}
                disabled={removing}
              >
                {removing ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
