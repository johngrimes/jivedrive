/**
 * Settings page: every signed-in user's "Sync with rclone" section, plus a
 * "Manage users" link to /admin for admins only.
 *
 * Signed-out visitors are redirected to sign in.
 */
import { Link, Navigate } from "react-router-dom";
import { PeopleIcon } from "@primer/octicons-react";
import { useSession } from "../auth/sessionContext";
import { SyncCredentials } from "../components/SyncCredentials";

/**
 * Settings page.
 *
 * @returns the settings element
 */
export function SettingsPage() {
  const { user, loading } = useSession();

  if (loading) {
    return (
      <p className="py-8 text-center opacity-70" role="status">
        Loading...
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4 pt-2">
      <div className="min-w-0 flex-1 rounded-box bg-base-200 p-4 md:p-6">
        <h1 className="mb-1 text-2xl font-semibold">Settings</h1>

        {user.isAdmin && (
          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider opacity-60">
              Administration
            </h2>
            <Link className="btn min-h-11" to="/admin">
              <PeopleIcon aria-hidden="true" />
              Manage users
            </Link>
          </section>
        )}

        <SyncCredentials />
      </div>
    </div>
  );
}
