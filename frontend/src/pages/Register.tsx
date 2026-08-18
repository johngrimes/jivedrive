import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { postRegisterOptions, postRegisterVerify } from "../api/client";
import type { ApiClientError, RegisterOptionsResponse } from "../api/client";
import { useSession } from "../auth/sessionContext";
import { DriveIcon } from "../components/icons";

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
    postRegisterOptions({ token })
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
    <div className="hero w-full">
      <div className="hero-content w-full max-w-md flex-col items-center gap-6 py-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <DriveIcon className="size-12 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">JiveDrive</h1>
          <p className="text-sm opacity-70">
            You have been invited to a private space.
          </p>
        </div>
        <section
          className="card bg-base-100 w-full max-w-md shadow-xl"
          aria-label="Register with invite"
        >
          <div className="card-body">
            <h2 className="card-title justify-center">Register your passkey</h2>
            <p className="text-sm opacity-70 text-center">
              You have been invited to JiveDrive
            </p>

            {loading && (
              <p className="alert alert-info" role="status">
                Checking your invite...
              </p>
            )}

            {!token && !loading && !invite && (
              <>
                <p className="alert alert-error" role="alert">
                  This link is missing an invite token. Open the full invite
                  link to register.
                </p>
                <Link className="btn btn-outline w-full" to="/">
                  Back to sign in
                </Link>
              </>
            )}

            {!loading && error && !invite && (
              <>
                <p className="alert alert-error" role="alert">
                  {error}
                </p>
                <Link className="btn btn-outline w-full" to="/">
                  Back to sign in
                </Link>
              </>
            )}

            {!loading && invite && (
              <>
                <div className="flex flex-col gap-2">
                  <label className="label" htmlFor="invite-username">
                    <span className="label-text">Your username</span>
                  </label>
                  <input
                    id="invite-username"
                    className="input w-full"
                    type="text"
                    value={invite.username}
                    readOnly
                  />
                  <p className="text-sm opacity-70 italic">
                    Set by the admin who invited you.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="label-text font-medium">Storage space</span>
                  <div className="flex flex-wrap gap-2">
                    <span className="badge badge-outline">
                      Bucket: {invite.bucket}
                    </span>
                    <span className="badge badge-outline">
                      Prefix: {invite.prefix}
                    </span>
                  </div>
                  <p className="text-sm opacity-70 italic">
                    Pre-set by the admin who invited you.
                  </p>
                </div>

                <button
                  className="btn btn-primary w-full"
                  type="button"
                  onClick={() => void handleCreatePasskey()}
                  disabled={busy}
                >
                  {busy ? "Creating passkey..." : "Create passkey"}
                </button>
              </>
            )}

            {error && invite && (
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
