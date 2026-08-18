import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { PersonIcon, GearIcon } from "@primer/octicons-react";
import { useSession } from "../auth/sessionContext";
import { Sidebar } from "./Sidebar";

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
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer after every navigation (FR-011): tapping a drawer
  // link navigates, and the destination must not stay covered by the
  // drawer on mobile. The close keys on location.key (not pathname) so it
  // also fires for same-route pushes — tapping the current route's link in
  // the drawer still closes it instead of leaving it covering the screen.
  // State is adjusted during render when the location prop changes (the
  // repo's established pattern, see Files.tsx), because the close is a
  // response to the location prop changing, not a sync with an external
  // system.
  const [prevKey, setPrevKey] = useState(location.key);
  if (prevKey !== location.key) {
    setPrevKey(location.key);
    setDrawerOpen(false);
  }

  /**
   * Sign out and return to the sign-in page.
   */
  async function handleSignOut(): Promise<void> {
    await signOut();
    navigate("/", { replace: true });
  }

  return (
    <div className="drawer lg:drawer-open">
      {user && (
        <input
          id="app-drawer-toggle"
          type="checkbox"
          className="drawer-toggle"
          tabIndex={-1}
          aria-label="Navigation drawer"
          checked={drawerOpen}
          onChange={(event) => setDrawerOpen(event.target.checked)}
        />
      )}
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
      {user && (
        <div className="drawer-side">
          <label
            htmlFor="app-drawer-toggle"
            aria-label="Close menu"
            className="drawer-overlay"
          />
          <Sidebar user={user} activePath={location.pathname} />
        </div>
      )}
    </div>
  );
}
