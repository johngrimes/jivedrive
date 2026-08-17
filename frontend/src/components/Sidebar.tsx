import { Link } from "react-router-dom";
import type { User } from "../api/client";

/**
 * Shared navigation surface shown in the mobile drawer below `lg` and as
 * the permanent sidebar at `lg` and up (US1): Files, Manage users for
 * admins only, and the signed-in user's bucket and space. Rendered inside
 * the daisyUI `drawer-side` owned by AppShell.
 *
 * The Manage users entry is rendered only for admins (FR-002, constitution
 * IV: no admin surface for non-admins at any width). The current route is
 * highlighted via `menu-active`.
 *
 * @param props - component props
 * @param props.user - the signed-in user whose navigation is shown
 * @param props.activePath - the current route path, used for active-state
 *   highlighting (Files on `/files*`, Manage users on `/admin*`)
 * @returns the sidebar navigation element
 */
export function Sidebar({
  user,
  activePath,
}: {
  user: User;
  activePath: string;
}) {
  const filesActive = activePath.startsWith("/files");
  const adminActive = activePath.startsWith("/admin");

  return (
    <nav
      aria-label="Main"
      className="w-72 min-h-full bg-base-200 text-base-content"
    >
      <ul className="menu gap-1 p-4">
        <li>
          <Link
            to="/files"
            className={`min-h-11 ${filesActive ? "menu-active" : ""}`}
          >
            Files
          </Link>
        </li>
        {user.isAdmin && (
          <li>
            <Link
              to="/admin"
              className={`min-h-11 ${adminActive ? "menu-active" : ""}`}
            >
              Manage users (admin)
            </Link>
          </li>
        )}
      </ul>
      <div className="px-4 pb-4">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider opacity-60">
          Space
        </p>
        <p className="break-all text-xs opacity-70">Bucket: {user.bucket}</p>
        <p className="break-all text-xs opacity-70">Space: {user.prefix}</p>
      </div>
    </nav>
  );
}
