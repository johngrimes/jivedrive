import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/** A JiveDrive user as returned by the API. */
export interface User {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
}

/** Error body returned by the API for failed requests. */
export interface ApiErrorBody {
  error: string;
  code: string;
}

/** Error thrown by {@link apiFetch} for non-OK responses. */
export interface ApiClientError extends Error {
  /** Machine-readable error code from the server. */
  code: string;
  /** HTTP status of the failed response. */
  status: number;
}

/** Options for {@link apiFetch}. */
export interface ApiFetchOptions {
  /** Do not parse the response body as JSON (e.g. 204 responses). */
  noBody?: boolean;
}

/**
 * Fetch a JSON API endpoint with cookie credentials.
 *
 * Sessions travel in an httpOnly cookie, so every request must include
 * credentials. Non-OK responses are turned into {@link ApiClientError}s
 * carrying the server's error message and code.
 *
 * @param path - absolute path on the same origin, e.g. "/auth/me"
 * @param init - additional fetch options
 * @param options - whether to skip JSON parsing
 * @returns the parsed JSON body
 * @throws {ApiClientError} when the response is not OK
 * @example
 * ```ts
 * const user = await apiFetch<{ user: User | null }>("/auth/me");
 * ```
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: ApiFetchOptions,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    let code = "unknown";
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>;
      if (body.error) message = body.error;
      if (body.code) code = body.code;
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    const error = new Error(message) as ApiClientError;
    error.code = code;
    error.status = res.status;
    throw error;
  }
  if (options?.noBody) return undefined as T;
  return (await res.json()) as T;
}

/**
 * @returns the healthcheck body
 */
export function getHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/healthcheck");
}

/**
 * @returns the signed-in user, or null when signed out
 */
export function getMe(): Promise<{ user: User | null }> {
  return apiFetch<{ user: User | null }>("/auth/me");
}

/** Response of POST /auth/login/options. */
export interface LoginOptionsResponse {
  /** Assertion options when the user has credentials. */
  options:
    | PublicKeyCredentialRequestOptionsJSON
    | PublicKeyCredentialCreationOptionsJSON;
  /** True when the user has no passkey yet and must register one. */
  needsRegistration: boolean;
}

/** Response of POST /auth/register/options. */
export interface RegisterOptionsResponse {
  options: PublicKeyCredentialCreationOptionsJSON;
  /** Username from the invite. */
  username: string;
  bucket: string;
  prefix: string;
}

/** Response of the verify endpoints. */
export interface AuthResponse {
  user: User;
}

/**
 * Start a passkey sign-in for a username.
 *
 * @param username - the username from the sign-in form
 * @returns assertion (or registration) options and a registration flag
 */
export function postLoginOptions(
  username: string,
): Promise<LoginOptionsResponse> {
  return apiFetch<LoginOptionsResponse>("/auth/login/options", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

/**
 * Verify a passkey assertion and create a session.
 *
 * @param username - the username from the sign-in form
 * @param credential - the assertion response from the browser
 * @returns the signed-in user
 */
export function postLoginVerify(
  username: string,
  credential: AuthenticationResponseJSON,
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/login/verify", {
    method: "POST",
    body: JSON.stringify({ username, credential }),
  });
}

/**
 * Start passkey registration for an invite token.
 *
 * @param token - invite token from the invite link
 * @returns registration options and the invite's username/bucket/prefix
 */
export function postRegisterOptions(
  token: string,
): Promise<RegisterOptionsResponse> {
  return apiFetch<RegisterOptionsResponse>("/auth/register/options", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/**
 * Verify a passkey registration. Accepts either an invite token or a
 * username (for first-passkey registration of an existing user).
 *
 * @param body - token or username plus the registration response
 * @returns the signed-in user
 */
export function postRegisterVerify(body: {
  token?: string;
  username?: string;
  credential: RegistrationResponseJSON;
}): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/register/verify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * End the current session.
 */
export async function postLogout(): Promise<void> {
  await apiFetch<void>("/auth/logout", { method: "POST" }, { noBody: true });
}
