import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getMe, postLogout } from "../api/client";
import type { User } from "../api/client";
import { SessionContext } from "./sessionContext";

/**
 * Load the signed-in user once on mount and keep the session state in sync
 * with the server.
 *
 * Reloads keep the session because the session cookie is sent with
 * /auth/me. Signing out clears both the cookie and the local state.
 *
 * @param props - child components
 * @returns the session provider element
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const body = await getMe();
      setUser(body.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((body) => {
        if (!cancelled) setUser(body.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await postLogout();
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <SessionContext.Provider value={{ user, loading, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}
