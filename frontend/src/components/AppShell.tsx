import { Link, Outlet, useNavigate } from "react-router-dom";
import { useSession } from "../auth/sessionContext";

/**
 * Application shell: persistent header showing the sign-in state on every
 * page, with the routed page below.
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
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="app-logo">
          JiveDrive
        </Link>
        <div className="app-session">
          {loading ? (
            <span className="annotation">Checking session...</span>
          ) : user ? (
            <>
              <span className="app-session-user">
                Signed in as {user.username}
              </span>
              <button
                className="button button-small"
                type="button"
                onClick={() => void handleSignOut()}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link className="button button-small" to="/">
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
