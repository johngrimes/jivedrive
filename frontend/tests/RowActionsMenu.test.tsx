import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RowActionsMenu } from "../src/components/RowActionsMenu";
import type { RowAction } from "../src/components/RowActionsMenu";

/**
 * Render a RowActionsMenu for "plan.txt" alongside an outside button.
 *
 * @param actions - the menu's actions
 * @returns the container holding the menu and the outside button
 */
function renderMenu(actions: RowAction[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      <>
        <RowActionsMenu name="plan.txt" actions={actions} />
        <button type="button">Outside</button>
      </>,
    );
  });
  return container;
}

/** The menu's trigger button. */
function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(
    'button[aria-label="Actions for plan.txt"]',
  ) as HTMLButtonElement;
}

/** The labels of the currently rendered menu items. */
function itemLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('ul[aria-label="Actions for plan.txt"] button'),
  ).map((item) => item.textContent ?? "");
}

/** Find a rendered menu item by its label. */
function item(container: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(
    container.querySelectorAll('ul[aria-label="Actions for plan.txt"] button'),
  ).find((button) => button.textContent === label) as HTMLButtonElement;
}

/** Two actions with spy handlers. */
function spyActions(): { actions: RowAction[]; download: () => void } {
  const download = vi.fn();
  return {
    download,
    actions: [
      { label: "Download", icon: null, onSelect: download },
      { label: "Delete", icon: null, onSelect: vi.fn() },
    ],
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RowActionsMenu", () => {
  it("starts collapsed with no items, and opens to show every action in order", () => {
    const container = renderMenu(spyActions().actions);

    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
    expect(itemLabels(container)).toEqual([]);

    act(() => trigger(container).click());

    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    expect(itemLabels(container)).toEqual(["Download", "Delete"]);
  });

  it("toggles closed when the trigger is clicked again", () => {
    const container = renderMenu(spyActions().actions);

    act(() => trigger(container).click());
    act(() => trigger(container).click());

    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
    expect(itemLabels(container)).toEqual([]);
  });

  it("runs the chosen action and closes", () => {
    const { actions, download } = spyActions();
    const container = renderMenu(actions);

    act(() => trigger(container).click());
    act(() => item(container, "Download").click());

    expect(download).toHaveBeenCalledTimes(1);
    expect(itemLabels(container)).toEqual([]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const container = renderMenu(spyActions().actions);

    act(() => trigger(container).click());
    item(container, "Download").focus();
    act(() => {
      item(container, "Download").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(itemLabels(container)).toEqual([]);
    expect(document.activeElement).toBe(trigger(container));
  });

  it("closes on a pointer press outside the menu", () => {
    const container = renderMenu(spyActions().actions);
    const outside = container.querySelector(
      "button:not([aria-label])",
    ) as HTMLButtonElement;

    act(() => trigger(container).click());
    act(() => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(itemLabels(container)).toEqual([]);
  });

  it("stays open on a pointer press inside the menu", () => {
    const container = renderMenu(spyActions().actions);

    act(() => trigger(container).click());
    act(() => {
      item(container, "Delete").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });

    expect(itemLabels(container)).toEqual(["Download", "Delete"]);
  });

  it("closes when keyboard focus leaves the menu", () => {
    const container = renderMenu(spyActions().actions);
    const outside = container.querySelector(
      "button:not([aria-label])",
    ) as HTMLButtonElement;

    act(() => trigger(container).click());
    item(container, "Delete").focus();
    act(() => outside.focus());

    expect(itemLabels(container)).toEqual([]);
  });

  it("renders nothing when there are no actions", () => {
    const container = renderMenu([]);

    expect(trigger(container)).toBeNull();
  });
});
