import { Link, Outlet, useNavigate } from "react-router-dom";
import { PersonIcon, GearIcon } from "@primer/octicons-react";
import { useSession } from "../auth/sessionContext";

/**
 * Application shell: a persistent header with the brand, the Settings link
 * (every signed-in user) and the username button that signs out, showing
 * the sign-in state on every page, with the routed page below (T035).
 *
 * The Settings link is icon-only below `sm` (accessible name "Settings")
 * so the header fits a 375px viewport, and is at least 44px tall.
 */
export function AppShell() {
  const { user, loading, signOut } = useSession();
  const navigate = useNavigate();

  /**
   * Sign out and return to the sign-in page.
   */
  async function handleSignOut(): Promise<void> {
    await signOut();
    navigate("/", { replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="navbar bg-base-200 border-b border-base-300 gap-2">
        <Link to="/" className="btn btn-ghost text-xl font-bold">
          JiveDrive
        </Link>
        <div className="grow"></div>
        {loading ? (
          <span className="text-sm opacity-70" role="status">
            Checking session...
          </span>
        ) : user ? (
          <>
            <Link
              className="btn min-h-11 shrink-0"
              to="/settings"
              aria-label="Settings"
            >
              <GearIcon size={16} aria-hidden="true" />
              <span className="hidden sm:inline">Settings</span>
            </Link>
            <button
              className="btn shrink-0 max-w-36 truncate"
              type="button"
              title="Click to sign out"
              onClick={() => void handleSignOut()}
            >
              <PersonIcon size={16} />
              {user.username}
            </button>
          </>
        ) : (
          <Link className="btn" to="/">
            Sign in
          </Link>
        )}
      </header>
      <main className="flex-1 p-4 sm:p-8 flex items-start justify-center">
        <Outlet />
      </main>
    </div>
  );
}
