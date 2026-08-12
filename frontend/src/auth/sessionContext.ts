import { createContext, useContext } from "react";
import type { User } from "../api/client";

/** The signed-in user plus session helpers exposed to pages. */
export interface SessionValue {
  /** The signed-in user, or null when signed out. */
  user: User | null;
  /** True while the initial /auth/me request is in flight. */
  loading: boolean;
  /** Re-fetch the current user from the server. */
  refresh: () => Promise<void>;
  /** End the session on the server and clear the local user. */
  signOut: () => Promise<void>;
}

/** React context carrying the session value. */
export const SessionContext = createContext<SessionValue | null>(null);

/**
 * Read the current session.
 *
 * @returns the session value
 * @throws {Error} when used outside a SessionProvider
 */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return value;
}
