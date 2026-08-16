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
    <div className="min-h-screen flex flex-col">
      <header className="navbar bg-base-200 border-b border-base-300">
        <div className="navbar-start">
          <Link to="/" className="btn btn-ghost text-xl font-bold">
            JiveDrive
          </Link>
        </div>
        <div className="navbar-end gap-2">
          {loading ? (
            <span className="text-sm opacity-70" role="status">
              Checking session...
            </span>
          ) : user ? (
            <>
              <span>Signed in as {user.username}</span>
              <button
                className="btn"
                type="button"
                onClick={() => void handleSignOut()}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link className="btn" to="/">
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main className="flex-1 p-4 sm:p-8 flex items-start justify-center">
        <Outlet />
      </main>
    </div>
  );
}
