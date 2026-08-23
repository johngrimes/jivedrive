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
    // FR-015: a received folder row never carries a share button, even
    // when the own-space handler is present for own folders.
    expect(mountRow?.querySelector('[aria-label="Share projects"]')).toBeNull();

    const ownRow = rows(container).find(
      (row) => !row.textContent?.includes("Shared by"),
    );
    expect(ownRow).toBeDefined();
    expect(ownRow?.textContent).toContain("projects");
    expect(
      ownRow?.querySelector('[aria-label="Share projects"]'),
    ).not.toBeNull();
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

  it("renders no share buttons on folder rows when none is provided (shared view, FR-015)", () => {
    const container = renderListing({
      folders: ["docs", "photos"],
      onShareFolder: undefined,
    });

    expect(rows(container)).toHaveLength(2);
    expect(container.querySelector('[aria-label="Share docs"]')).toBeNull();
    expect(container.querySelector('[aria-label="Share photos"]')).toBeNull();
  });

  it("renders no delete button on file rows when none is provided (shared view)", () => {
    const onShare = vi.fn();
    const container = renderListing({
      files: [fileEntry],
      onShare,
    });

    // Download and Share stay; Delete is absent in this phase.
    expect(container.querySelector('[aria-label="Download"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Share"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Delete"]')).toBeNull();
  });

  it("keeps the delete button when a handler is provided (own view)", () => {
    const container = renderListing({
      files: [fileEntry],
      onDelete: () => {},
    });

    expect(container.querySelector('[aria-label="Delete"]')).not.toBeNull();
  });
});
