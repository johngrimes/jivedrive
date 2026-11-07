import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { postLoginOptions, postLoginVerify } from "../api/client";
import type { ApiClientError } from "../api/client";
import { useSession } from "../auth/sessionContext";
import { DriveIcon } from "../components/icons";

/** Props of {@link SignIn}. */
export interface SignInProps {
  /**
   * Where to go once signed in, e.g. "/authorize?request=abc" when the
   * sign-in is embedded in the OAuth consent page. Defaults to "/files".
   */
  returnTo?: string;
}

/**
 * Sign-in page.
 *
 * The only sign-in action is a username-less passkey assertion: "Sign in
 * with passkey" completes the ceremony with zero text entry and the server
 * resolves the user from the asserted credential (US1, FR-001/FR-002).
 * First-passkey enrollment is token-gated only and happens on the
 * Register page via a full invite link; a username alone can never claim
 * an account (FR-001).
 *
 * @param props - where to land after signing in
 * @returns the sign-in element
 */
export function SignIn({ returnTo = "/files" }: SignInProps = {}) {
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
    // A signed-in user visiting the sign-in page goes straight on: to the
    // file browser by default (spec US1 scenario 1).
    return <Navigate to={returnTo} replace />;
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
      // re-enabled for a retry; new users register via a full invite link.
      setError("The passkey prompt was cancelled or failed. Try again.");
    }
  }

  /**
   * Sign in with a passkey, username-less: fetch bodyless options, run
   * the assertion ceremony, verify with the requestId, then go to
   * `returnTo` signed in.
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
      navigate(returnTo, { replace: true });
    } catch (err) {
      showSignInError(err);
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
          </div>
        </section>
      </div>
    </div>
  );
}
