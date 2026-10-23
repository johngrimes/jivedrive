/**
 * Per-row actions menu: one "⋯" trigger that discloses a row's actions
 * (download, share, move, delete) so listing rows stay uncluttered at
 * every width. A disclosure (button + list of buttons), not an ARIA
 * menu: Tab reaches the items, Escape closes and refocuses the trigger,
 * and a press or focus move outside closes it.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KebabHorizontalIcon } from "@primer/octicons-react";

/** One entry in a {@link RowActionsMenu}. */
export interface RowAction {
  /** Visible label, also the item's accessible name. */
  label: string;
  /** Decorative icon shown before the label. */
  icon: ReactNode;
  /** Runs when the item is chosen; the menu closes first. */
  onSelect: () => void;
}

/** Props for {@link RowActionsMenu}. */
export interface RowActionsMenuProps {
  /** The row's file or folder name; names the trigger and the list. */
  name: string;
  /** The row's actions, in display order. */
  actions: RowAction[];
}

/**
 * Render a row's actions behind a single "⋯" trigger. Items render only
 * while open. Renders nothing when the row has no actions.
 *
 * @param props - component props
 * @param props.name - the row's file or folder name
 * @param props.actions - the row's actions, in display order
 * @returns the trigger and (when open) its action list, or null
 */
export function RowActionsMenu({ name, actions }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    // A menu opened near the bottom of the screen drops below the fold;
    // bring it fully on screen rather than leave items unreachable.
    list.current?.scrollIntoView({ block: "nearest" });
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  if (actions.length === 0) return null;

  const label = `Actions for ${name}`;
  return (
    <div
      ref={wrapper}
      className={`dropdown dropdown-end shrink-0 ${open ? "dropdown-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        setOpen(false);
        trigger.current?.focus();
      }}
      onBlur={(event) => {
        // Only a focus move to a known element outside closes the menu:
        // a null target is a press on a non-focusable spot (handled by
        // the pointerdown listener), and some browsers report null while
        // a click on an item is still in progress.
        const next = event.relatedTarget;
        if (next && !wrapper.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost btn-sm btn-square size-11"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <KebabHorizontalIcon aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={list}
          id={listId}
          aria-label={label}
          className="dropdown-content menu z-10 mt-1 w-44 rounded-box bg-base-200 p-2 shadow-lg"
        >
          {actions.map((action) => (
            <li key={action.label}>
              <button
                type="button"
                className="min-h-11"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  action.onSelect();
                }}
              >
                {action.icon}
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
