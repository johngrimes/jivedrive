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

/**
 * Fetch a JSON API endpoint with cookie credentials.
 *
 * Sessions travel in an httpOnly cookie, so every request must include
 * credentials. Non-OK responses are turned into {@link ApiClientError}s
 * carrying the server's error message and code.
 *
 * @param path - absolute path on the same origin, e.g. "/api/files"
 * @param init - additional fetch options
 * @returns the parsed JSON body
 * @throws {ApiClientError} when the response is not OK
 * @example
 * ```ts
 * const user = await apiFetch<{ user: User | null }>("/api/auth/me");
 * ```
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
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
  return apiFetch<{ user: User | null }>("/api/auth/me");
}
