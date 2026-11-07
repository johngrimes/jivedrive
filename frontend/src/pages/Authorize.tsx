/**
 * OAuth consent page (`/authorize?request=<id>`): where `/oauth/authorize`
 * sends the browser when an app such as Claude asks to access the user's
 * drive through the MCP server.
 *
 * A signed-out visitor signs in with a passkey here and stays on the same
 * URL. The signed-in user sees the app's self-declared name, the host it
 * returns to, who they are signed in as, and exactly what the app can and
 * cannot do, then Allows or Denies. Either decision sends the browser back
 * to the app; expired requests and failures are explained (constitution V).
 */
import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { CheckIcon, XIcon } from "@primer/octicons-react";
import {
  decideAuthorizationRequest,
  getAuthorizationRequest,
} from "../api/client";
import type {
  ApiClientError,
  AuthorizationDecision,
  AuthorizationRequest,
} from "../api/client";
import { useSession } from "../auth/sessionContext";
import { SignIn } from "./SignIn";

/** Message shown when a request never reached the server. */
const NETWORK_ERROR =
  "Could not reach the server. Check your connection and try again.";

/** Message shown for an unknown, expired or already decided request. */
const EXPIRED_MESSAGE =
  "This authorization request has expired or was already used. Return to the app and try connecting again.";

/** What an approved app can do, in the order shown. */
const CAPABILITIES = [
  "List, search and read files",
  "Create folders",
  "Write new files, and replace existing files when asked",
  "Move files",
  "Create public share links to files",
];

/** The consent request's loading state. */
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; request: AuthorizationRequest }
  | { kind: "expired" }
  | { kind: "error"; message: string };

/**
 * Turn an API or network failure into a readable message.
 *
 * @param err - the thrown error
 * @param fallback - the message when the server gave none
 * @returns the message to show
 */
function errorMessage(err: unknown, fallback: string): string {
  const apiError = err as Partial<ApiClientError> | null;
  if (typeof apiError?.status !== "number") return NETWORK_ERROR;
  return apiError.message || fallback;
}

/** The card the consent page's states render in. */
function ConsentCard({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="card bg-base-100 w-full max-w-md shadow-xl"
      aria-label="Connect an app"
    >
      <div className="card-body gap-4">{children}</div>
    </section>
  );
}

/** The explanation for an unusable request. */
function ExpiredRequest() {
  return (
    <ConsentCard>
      <p className="alert alert-warning" role="alert">
        {EXPIRED_MESSAGE}
      </p>
    </ConsentCard>
  );
}

/** Props of {@link Consent}. */
interface ConsentProps {
  /** The authorization request id from the URL. */
  requestId: string;
  /** The signed-in user's username. */
  username: string;
}

/**
 * Load one authorization request and let the signed-in user decide it.
 *
 * @param props - the request id and the signed-in username
 * @returns the consent element
 */
function Consent({ requestId, username }: ConsentProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [deciding, setDeciding] = useState<AuthorizationDecision | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAuthorizationRequest(requestId)
      .then((request) => {
        if (!cancelled) setState({ kind: "ready", request });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(
          (err as Partial<ApiClientError> | null)?.code === "not_found"
            ? { kind: "expired" }
            : {
                kind: "error",
                message: errorMessage(
                  err,
                  "Could not load this authorization request.",
                ),
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, attempt]);

  /**
   * Send the decision, then hand the browser back to the app. The buttons
   * stay disabled while the browser leaves; a failure re-enables them.
   *
   * @param decision - "approve" or "deny"
   */
  async function handleDecision(
    decision: AuthorizationDecision,
  ): Promise<void> {
    if (deciding) return;
    setDeciding(decision);
    setDecideError(null);
    try {
      const { redirectTo } = await decideAuthorizationRequest(
        requestId,
        decision,
      );
      window.location.assign(redirectTo);
    } catch (err) {
      setDeciding(null);
      if ((err as Partial<ApiClientError> | null)?.code === "not_found") {
        setState({ kind: "expired" });
      } else {
        setDecideError(
          errorMessage(err, "Could not complete your decision. Try again."),
        );
      }
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsentCard>
        <p className="py-4 text-center text-sm opacity-70" role="status">
          Loading the request...
        </p>
      </ConsentCard>
    );
  }
  if (state.kind === "expired") {
    return <ExpiredRequest />;
  }
  if (state.kind === "error") {
    return (
      <ConsentCard>
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
        <button
          className="btn min-h-11"
          type="button"
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </ConsentCard>
    );
  }

  const { request } = state;
  return (
    <ConsentCard>
      <h1 className="text-xl font-semibold break-words">
        {request.clientName}{" "}
        <span className="font-normal">wants to access your JiveDrive</span>
      </h1>
      <p className="text-sm break-words">
        After you decide, you return to{" "}
        <strong className="break-all">{request.redirectHost}</strong>.
      </p>
      <p className="text-sm break-words">
        Signed in as <strong>{username}</strong>
      </p>

      <div className="flex flex-col gap-2 text-sm">
        <p>
          If you allow it, it can do the following in your drive and in folders
          shared with you:
        </p>
        <ul className="list-disc pl-5">
          {CAPABILITIES.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
        <p className="font-semibold">It cannot delete files.</p>
      </div>

      <p className="text-xs opacity-60">
        The name above is chosen by the app itself. Only allow apps you trust.
        You can disconnect it at any time in Settings.
      </p>

      {deciding && (
        <p className="alert alert-info" role="status">
          {deciding === "approve" ? "Connecting..." : "Returning to the app..."}
        </p>
      )}
      {decideError && (
        <p className="alert alert-error" role="alert">
          {decideError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          className="btn min-h-11 sm:min-w-28"
          type="button"
          onClick={() => void handleDecision("deny")}
          disabled={deciding !== null}
        >
          <XIcon aria-hidden="true" />
          Deny
        </button>
        <button
          className="btn btn-primary min-h-11 sm:min-w-28"
          type="button"
          onClick={() => void handleDecision("approve")}
          disabled={deciding !== null}
        >
          <CheckIcon aria-hidden="true" />
          Allow
        </button>
      </div>
    </ConsentCard>
  );
}

/**
 * The OAuth consent page. Signed-out visitors see the passkey sign-in and
 * come back to this same URL once signed in.
 *
 * @returns the consent page element
 */
export function AuthorizePage() {
  const { user, loading } = useSession();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const requestId = searchParams.get("request");

  if (loading) {
    return (
      <p className="alert alert-info max-w-md" role="status">
        Checking session...
      </p>
    );
  }
  if (!user) {
    return (
      <div className="flex w-full flex-col items-center gap-2">
        <p className="max-w-md text-center text-sm opacity-70">
          Sign in to review an app's request to access your JiveDrive.
        </p>
        <SignIn returnTo={location.pathname + location.search} />
      </div>
    );
  }
  if (!requestId) {
    return <ExpiredRequest />;
  }
  return (
    <Consent key={requestId} requestId={requestId} username={user.username} />
  );
}
