import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FileListing } from "../src/components/FileListing";
import type { FileListingProps } from "../src/components/FileListing";
import type { FileEntry } from "../src/api/client";

/** A file row fixture, mirroring the contract FileEntry shape. */
const fileEntry: FileEntry = {
  key: "plan.txt",
  name: "plan.txt",
  size: 512,
  lastModified: "2026-08-12T00:00:00.000Z",
};

/**
 * Render the FileListing into jsdom with base props overridable per test.
 *
 * @param props - prop overrides
 * @returns the container element holding the rendered listing
 */
function renderListing(props: Partial<FileListingProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const baseProps: FileListingProps = {
    folders: [],
    files: [],
    loading: false,
    loadingMore: false,
    nextCursor: null,
    error: null,
    hasParent: false,
    onOpenFolder: () => {},
    onDownload: () => {},
    onShare: () => {},
    onLoadMore: () => {},
    onRetry: () => {},
  };
  act(() => {
    root.render(<FileListing {...baseProps} {...props} />);
  });
  return container;
}

/** All list rows currently rendered. */
function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("li.list-row"));
}

/** A row's actions-menu trigger, or null when the row has no actions. */
function actionsTrigger(
  container: HTMLElement,
  name: string,
): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="Actions for ${name}"]`);
}

/**
 * Open a row's actions menu and list its item labels in order.
 *
 * @param container - the rendered listing
 * @param name - the row's file or folder name
 * @returns the menu's item labels
 */
function openActions(container: HTMLElement, name: string): string[] {
  act(() => actionsTrigger(container, name)?.click());
  return Array.from(
    container.querySelectorAll(`ul[aria-label="Actions for ${name}"] button`),
  ).map((item) => item.textContent ?? "");
}

/** Click an item in a row's (already open) actions menu. */
function chooseAction(container: HTMLElement, name: string, label: string) {
  const item = Array.from(
    container.querySelectorAll(`ul[aria-label="Actions for ${name}"] button`),
  ).find((button) => button.textContent === label) as HTMLButtonElement;
  act(() => item.click());
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FileListing mounts (T023)", () => {
  it("renders a mount row labelled 'Shared by <username>' alongside a same-named own folder", () => {
    const container = renderListing({
      folders: ["projects"],
      mounts: [
        { id: "share-1", folderName: "projects", sharerUsername: "alice" },
      ],
      onShareFolder: () => {},
    });

    // Both rows coexist: bob's own folder and alice's mount (US2 sc.6).
    expect(rows(container)).toHaveLength(2);

    const mountRow = rows(container).find((row) =>
      row.textContent?.includes("Shared by alice"),
    );
    expect(mountRow).toBeDefined();
    expect(mountRow?.textContent).toContain("projects");

    const ownRow = rows(container).find(
      (row) => !row.textContent?.includes("Shared by"),
    );
    expect(ownRow).toBeDefined();
    expect(ownRow?.textContent).toContain("projects");
    expect(openActions(ownRow!, "projects")).toEqual(["Share"]);
    // FR-015: a received folder row never carries an actions menu, even
    // when the own-space handler is present for own folders.
    expect(mountRow?.querySelector("button")).toBeNull();
  });

  it("renders two same-named mounts from different sharers, each labelled", () => {
    const container = renderListing({
      mounts: [
        { id: "share-1", folderName: "docs", sharerUsername: "alice" },
        { id: "share-2", folderName: "docs", sharerUsername: "carol" },
      ],
    });

    expect(rows(container)).toHaveLength(2);
    expect(
      rows(container).some((row) =>
        row.textContent?.includes("Shared by alice"),
      ),
    ).toBe(true);
    expect(
      rows(container).some((row) =>
        row.textContent?.includes("Shared by carol"),
      ),
    ).toBe(true);
  });

  it("opens the mount via onOpenMount when the mount row is clicked", () => {
    const onOpenMount = vi.fn();
    const container = renderListing({
      mounts: [
        { id: "share-1", folderName: "projects", sharerUsername: "alice" },
      ],
      onOpenMount,
    });

    const mountRow = rows(container).find((row) =>
      row.textContent?.includes("Shared by alice"),
    );
    const link = mountRow?.querySelector("a");
    expect(link).toBeDefined();
    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The Files page maps this id to space=shared:<id> at prefix "".
    expect(onOpenMount).toHaveBeenCalledWith("share-1");
  });

  it("renders mounts even when the own space has no folders or files", () => {
    const container = renderListing({
      folders: [],
      files: [],
      mounts: [
        { id: "share-1", folderName: "projects", sharerUsername: "alice" },
      ],
    });

    // An empty own space must still surface its mounts (FR-008); the
    // empty state must not swallow them.
    expect(rows(container)).toHaveLength(1);
    expect(container.textContent).toContain("Shared by alice");
    expect(container.textContent).not.toContain("Your space is empty");
  });

  it("renders no actions menu on folder rows when no share handler is provided (shared view, FR-015)", () => {
    const container = renderListing({
      folders: ["docs", "photos"],
      onShareFolder: undefined,
    });

    expect(rows(container)).toHaveLength(2);
    expect(actionsTrigger(container, "docs")).toBeNull();
    expect(actionsTrigger(container, "photos")).toBeNull();
  });

  it("offers folder Share from the folder row's menu", () => {
    const onShareFolder = vi.fn();
    const container = renderListing({ folders: ["docs"], onShareFolder });

    expect(openActions(container, "docs")).toEqual(["Share"]);
    chooseAction(container, "docs", "Share");
    expect(onShareFolder).toHaveBeenCalledWith("docs");
  });
});

describe("FileListing file actions menu", () => {
  it("puts every file action behind one trigger, in order", () => {
    const container = renderListing({
      files: [fileEntry],
      onMove: () => {},
      onDelete: () => {},
    });

    const row = rows(container)[0]!;
    // The row's only button is the menu trigger.
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(openActions(container, "plan.txt")).toEqual([
      "Download",
      "Share",
      "Move",
      "Delete",
    ]);
  });

  it("omits Move and Delete when no handlers are provided (shared view)", () => {
    const container = renderListing({ files: [fileEntry] });

    expect(openActions(container, "plan.txt")).toEqual(["Download", "Share"]);
  });

  it.each([
    ["Download", "onDownload"],
    ["Share", "onShare"],
    ["Move", "onMove"],
    ["Delete", "onDelete"],
  ] as const)("%s calls %s with the file", (label, handler) => {
    const spy = vi.fn();
    const container = renderListing({
      folders: ["docs"],
      files: [fileEntry],
      onMove: () => {},
      onDelete: () => {},
      [handler]: spy,
    });

    openActions(container, "plan.txt");
    chooseAction(container, "plan.txt", label);
    expect(spy).toHaveBeenCalledWith(fileEntry);
  });

  it("downloads the file when its name is clicked", () => {
    const onDownload = vi.fn();
    const container = renderListing({ files: [fileEntry], onDownload });

    const link = rows(container)[0]!.querySelector("a");
    expect(link?.textContent).toBe("plan.txt");
    act(() => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(onDownload).toHaveBeenCalledWith(fileEntry);
  });
});
