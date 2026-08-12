import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { postRegisterOptions, postRegisterVerify } from "../api/client";
import type { ApiClientError, RegisterOptionsResponse } from "../api/client";
import { useSession } from "../auth/sessionContext";

/**
 * Register page: claims an invite token from the URL and creates the
 * passkey. The username, bucket and prefix come from the invite and are
 * shown read-only. Completing the ceremony signs the user in.
 */
export function Register() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [invite, setInvite] = useState<RegisterOptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(token !== "");
  const { refresh } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    postRegisterOptions(token)
      .then((body) => {
        if (!cancelled) setInvite(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const apiError = err as ApiClientError;
          if (apiError?.code === "invite_expired") {
            setError("This invite has expired. Ask the admin to re-send it.");
          } else if (apiError?.code === "invite_claimed") {
            setError("This invite has already been used.");
          } else {
            setError(apiError?.message ?? "This invite is not valid.");
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Create the passkey and verify registration with the server.
   */
  async function handleCreatePasskey(): Promise<void> {
    if (!invite) return;
    setError(null);
    setBusy(true);
    try {
      const credential = await startRegistration({
        optionsJSON: invite.options,
      });
      await postRegisterVerify({ token, credential });
      await refresh();
      navigate("/files", { replace: true });
    } catch (err) {
      const apiError = err as ApiClientError;
      if (apiError?.code === "invite_expired") {
        setError("This invite has expired. Ask the admin to re-send it.");
      } else if (apiError?.code === "invite_claimed") {
        setError("This invite has already been used.");
      } else {
        setError(
          apiError?.code
            ? apiError.message
            : "The passkey prompt was cancelled or failed. Try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-label="Register with invite">
      <h1 className="auth-title">Register your passkey</h1>
      <p className="auth-sub">You have been invited to JiveDrive</p>

      {loading && (
        <p className="status" role="status">
          Checking your invite...
        </p>
      )}

      {!token && !loading && !invite && (
        <>
          <p className="error" role="alert">
            This link is missing an invite token. Open the full invite link to
            register.
          </p>
          <Link className="button" to="/">
            Back to sign in
          </Link>
        </>
      )}

      {!loading && error && !invite && (
        <>
          <p className="error" role="alert">
            {error}
          </p>
          <Link className="button" to="/">
            Back to sign in
          </Link>
        </>
      )}

      {!loading && invite && (
        <>
          <div className="field-group">
            <label className="field-label" htmlFor="invite-username">
              Your username
            </label>
            <input
              id="invite-username"
              className="text-input"
              type="text"
              value={invite.username}
              readOnly
            />
            <p className="annotation">Set by the admin who invited you.</p>
          </div>

          <div className="field-group">
            <label className="field-label">Storage space</label>
            <div className="tag-row">
              <span className="tag">Bucket: {invite.bucket}</span>
              <span className="tag">Prefix: {invite.prefix}</span>
            </div>
            <p className="annotation">Pre-set by the admin who invited you.</p>
          </div>

          <button
            className="button button-primary"
            type="button"
            onClick={() => void handleCreatePasskey()}
            disabled={busy}
          >
            {busy ? "Creating passkey..." : "Create passkey"}
          </button>
        </>
      )}

      {error && invite && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
