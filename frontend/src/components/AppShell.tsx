import { Link, Outlet, useNavigate } from "react-router-dom";
import { PersonIcon, GearIcon } from "@primer/octicons-react";
import { useSession } from "../auth/sessionContext";

/**
 * Application shell: persistent header showing the sign-in state on every
 * page, with the routed page below (T035).
 *
 * The whole shell is wrapped in a daisyUI drawer (T015): below `lg` the
 * shared navigation lives behind a hamburger button in the navbar, at
 * `lg` and up the same content renders as a permanently open sidebar
 * (research R2). The drawer is driven by a controlled checkbox so the
 * hamburger and the overlay both close it, and a `useLocation` effect
 * closes it after every navigation (FR-011).
 *
 * Signed-out visitors see neither the hamburger nor the drawer side
 * (US1 sc.5): the drawer content is only rendered for signed-in users.
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
    <div className="drawer lg:drawer-open">
      <div className="drawer-content flex min-h-screen flex-col">
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
              {user.isAdmin && (
                <Link to="/admin">
                  <button className="btn" type="button">
                    <GearIcon size={16} />
                    Settings
                  </button>
                </Link>
              )}
              <button
                className="btn"
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
    </div>
  );
}
