import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  postLoginOptions,
  postLoginVerify,
  postRegisterOptions,
  postRegisterVerify,
} from "../api/client";
import type { ApiClientError } from "../api/client";
import { useSession } from "../auth/sessionContext";
import { DriveIcon } from "../components/icons";

/**
 * Sign-in page.
 *
 * The primary action is a username-less passkey assertion: "Sign in with
 * passkey" completes the ceremony with zero text entry and the server
 * resolves the user from the asserted credential (US1, FR-001/FR-002).
 * A "First time? Use your username" link stays visible at all times so an
 * empty passkey sheet is never a dead end (FR-011), and reveals the
 * first-passkey bootstrap form for accounts with no usable passkey
 * (US2, FR-004).
 */
export function SignIn() {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const { user, loading, refresh } = useSession();
  const navigate = useNavigate();

  if (loading) {
    return (
      <p className="alert alert-info max-w-md" role="status">
        Checking session...
      </p>
    );
  }
  if (user) {
    // A signed-in user visiting the sign-in page goes straight to the
    // file browser (spec US1 scenario 1).
    return <Navigate to="/files" replace />;
  }

  /**
   * Show a human-readable message for a failed username-less sign-in.
   *
   * @param err - the thrown error
   */
  function showSignInError(err: unknown): void {
    const apiError = err as ApiClientError;
    if (apiError?.code === "challenge_expired") {
      setError("Your sign-in request expired. Try again.");
    } else if (apiError?.code === "authentication_failed") {
      setError("This passkey could not be verified. Try again.");
    } else if (apiError?.code) {
      setError(apiError.message);
    } else {
      // Ceremony failure (prompt cancelled, no passkeys): the button is
      // re-enabled for a retry and the username form remains the escape
      // hatch (FR-011).
      setError(
        "The passkey prompt was cancelled or failed. Try again, or use the username form below.",
      );
    }
  }

  /**
   * Sign in with a passkey, username-less: fetch bodyless options, run
   * the assertion ceremony, verify with the requestId, then go to the
   * files page signed in.
   */
  async function handlePasskeySignIn(): Promise<void> {
    setError(null);
    setBusy(true);
    setStatus("Waiting for your passkey...");
    try {
      const { requestId, options } = await postLoginOptions();
      const credential = await startAuthentication({
        optionsJSON: options,
      });
      await postLoginVerify(requestId, credential);
      await refresh();
      navigate("/files", { replace: true });
    } catch (err) {
      showSignInError(err);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  /**
   * Show a human-readable message for a failed fallback registration.
   *
   * @param err - the thrown error
   */
  function showError(err: unknown): void {
    const apiError = err as ApiClientError;
    if (apiError?.code === "unknown_user") {
      setError(
        "Unknown username. Check the name or ask an admin for an invite.",
      );
    } else if (apiError?.code === "user_has_passkey") {
      setError("This account already has a passkey - sign in with it.");
    } else if (apiError?.code) {
      setError(apiError.message);
    } else {
      setError("The passkey prompt was cancelled or failed. Try again.");
    }
  }

  /**
   * Register the first passkey for an existing account: request options
   * with the username, complete the ceremony, verify, then go to the files
   * page signed in.
   *
   * @param event - the form submit event
   */
  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = username.trim().toLowerCase();
    if (!name) {
      setError("Enter your username to continue.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { options } = await postRegisterOptions({ username: name });
      setStatus(`Creating your first passkey for "${name}"...`);
      const credential = await startRegistration({
        optionsJSON: options,
      });
      await postRegisterVerify({ username: name, credential });
      await refresh();
      navigate("/files", { replace: true });
    } catch (err) {
      // The form stays usable so the user can retry (FR-011).
      showError(err);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <div className="hero w-full">
      <div className="hero-content w-full max-w-md flex-col items-center gap-6 py-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <DriveIcon className="size-12 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">JiveDrive</h1>
          <p className="text-sm opacity-70">
            Your files, protected by passkeys. No passwords, ever.
          </p>
        </div>
        <section
          className="card bg-base-100 w-full shadow-xl"
          aria-label="Sign in"
        >
          <div className="card-body">
            <h2 className="card-title justify-center">Sign in</h2>
            <p className="text-sm opacity-70 text-center">
              Use your passkey to access your files
            </p>

            <button
              className="btn btn-primary w-full"
              type="button"
              onClick={() => void handlePasskeySignIn()}
              disabled={busy}
            >
              {busy ? "Signing in..." : "Sign in with passkey"}
            </button>

            {/* Always visible: an empty passkey sheet must not be a dead
                end (FR-011, edge case "Username-less prompt with no
                passkeys"). */}
            <a
              href="#"
              className="btn btn-ghost w-full"
              onClick={(event) => {
                event.preventDefault();
                setShowFallback(true);
              }}
            >
              First time? Use your username
            </a>

            {showFallback && (
              <form onSubmit={handleSubmit} className="flex flex-col gap-2">
                <label className="label" htmlFor="username">
                  <span className="label-text">Username</span>
                </label>
                <input
                  id="username"
                  className="input w-full"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="alice"
                />

                <button
                  className="btn btn-primary w-full"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? "Creating passkey..." : "Create passkey"}
                </button>
              </form>
            )}

            {status && (
              <p className="alert alert-info" role="status">
                {status}
              </p>
            )}
            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}

            <div className="divider">or</div>

            <Link className="btn btn-outline w-full" to="/register">
              Register with an invite link
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
