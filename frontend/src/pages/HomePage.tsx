import { Link } from "react-router-dom";

/**
 * Landing page shown at "/", before a user signs in.
 */
export function HomePage() {
  return (
    <main>
      <h1>JiveDrive</h1>
      <p>Sign in with a passkey to browse your files.</p>
      <nav>
        <Link to="/files">Files</Link>
        <Link to="/register">Register with invite</Link>
      </nav>
    </main>
  );
}
