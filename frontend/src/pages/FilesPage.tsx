import { Navigate } from "react-router-dom";
import { useSession } from "../auth/sessionContext";

/**
 * File browser page: placeholder for Phase 4 (User Story 2). Shown only
 * when signed in; otherwise redirects to the sign-in page.
 */
export function FilesPage() {
  const { user, loading, signOut } = useSession();

  if (loading) {
    return (
      <p className="status" role="status">
        Loading...
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <section className="page">
      <h1>Files</h1>
      <p>
        Signed in as <strong>{user.username}</strong> ({user.bucket}
        {user.prefix && ` / ${user.prefix}`}).
      </p>
      <p className="annotation">Your file browser will appear here.</p>
      <button className="button" type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}
