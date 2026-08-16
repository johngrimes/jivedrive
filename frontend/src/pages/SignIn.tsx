import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  postLoginOptions,
  postLoginVerify,
  postRegisterVerify,
} from "../api/client";
import type { ApiClientError } from "../api/client";
import { useSession } from "../auth/sessionContext";

/**
 * Sign-in page: enter a username, then complete the passkey prompt.
 *
 * When the account has no passkey yet (bootstrap admin, seeded user), the
 * server sends registration options instead and the first passkey is
 * created here, which signs the user in.
 */
export function SignIn() {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
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
   * Show a human-readable message for a failed action.
   *
   * @param err - the thrown error
   */
  function showError(err: unknown): void {
    const apiError = err as ApiClientError;
    if (apiError?.code === "unknown_user") {
      setError(
        "Unknown username. Check the name or ask an admin for an invite.",
      );
    } else if (apiError?.code) {
      setError(apiError.message);
    } else {
      setError("The passkey prompt was cancelled or failed. Try again.");
    }
  }

  /**
   * Start a sign-in: request options, complete the passkey ceremony, then
   * verify with the server.
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
      const { options, needsRegistration } = await postLoginOptions(name);
      if (needsRegistration) {
        setStatus(`No passkey found for "${name}" - creating one now.`);
        const credential = await startRegistration({
          optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
        });
        await postRegisterVerify({ username: name, credential });
      } else {
        setStatus(`Waiting for your passkey for "${name}"...`);
        const credential = await startAuthentication({
          optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
        });
        await postLoginVerify(name, credential);
      }
      await refresh();
      navigate("/files", { replace: true });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <section
      className="card bg-base-100 w-full max-w-md shadow-xl"
      aria-label="Sign in"
    >
      <div className="card-body">
        <h1 className="card-title justify-center text-2xl">Sign in</h1>
        <p className="text-sm opacity-70 text-center">
          Use your passkey to access your files
        </p>

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
            {busy ? "Waiting for passkey..." : "Continue with passkey"}
          </button>
        </form>

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
  );
}
