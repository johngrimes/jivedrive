import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * Move a file to another folder (issue #14). Every test runs as milo, a
 * user dedicated to this spec (seeded in e2eServer.ts with one folder
 * tree per test), or as nina, who receives milo's `move-shared` folder.
 * Tests that move a file upload their own uniquely named file first, so
 * they are parallel- and retry-safe against the shared in-memory server.
 */

/** The indexed results take up to one scan interval to appear. */
const INDEX_TIMEOUT = 20_000;

/** The incoming share shape returned by GET /api/shares. */
interface ShareIncomingBody {
  id: string;
  folderName: string;
  sharer: { username: string };
}

/**
 * Sign in with a pre-seeded session cookie (no WebAuthn ceremony).
 *
 * @param context - the browser context
 * @param token - the seeded session token
 */
async function useSession(
  context: BrowserContext,
  token: string,
): Promise<void> {
  await context.addCookies([
    { name: "jivedrive_session", value: token, url: "http://localhost:5173" },
  ]);
}

/**
 * A unique file name for this attempt, so retries never collide with a
 * file an earlier attempt already moved.
 *
 * @param base - readable prefix
 * @returns the file name
 */
function uniqueName(base: string): string {
  return `${base}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`;
}

/**
 * Upload a small file through the API (presigned PUT into the mock S3).
 *
 * @param page - a page whose context carries the session cookie
 * @param folder - destination folder relative to the space root
 * @param fileName - the file name
 * @param space - the space to upload into
 */
async function uploadFile(
  page: Page,
  folder: string,
  fileName: string,
  space = "own",
): Promise<void> {
  const res = await page.request.post("/api/files/upload-url", {
    data: { folder, fileName, overwrite: false, space },
  });
  expect(res.status()).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const put = await page.request.put(url, { data: `content of ${fileName}` });
  expect(put.status()).toBe(200);
}

/**
 * Open milo's Files page at a folder.
 *
 * @param page - the page
 * @param context - the browser context
 * @param prefix - the folder to open ("" for the root)
 */
async function openAsMilo(
  page: Page,
  context: BrowserContext,
  prefix: string,
): Promise<void> {
  await useSession(context, "milo-session");
  await page.goto(
    prefix === "" ? "/files" : `/files?prefix=${encodeURIComponent(prefix)}`,
  );
  await expectSignedInAs(page, "milo");
}

/**
 * The file row with the given name.
 *
 * @param page - the page
 * @param name - the file name
 * @returns the row locator
 */
function fileRow(page: Page, name: string): Locator {
  return page.locator("li.list-row", { hasText: name });
}

/**
 * Open the move dialog from a row and wait for it to name the file.
 *
 * @param page - the page
 * @param row - the row carrying the Move button
 * @param name - the file name
 * @param buttonName - the Move button's accessible name
 * @returns the dialog locator
 */
async function openMove(
  page: Page,
  row: Locator,
  name: string,
  buttonName = "Move",
): Promise<Locator> {
  await row.getByRole("button", { name: buttonName, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Move ${name}`);
  return dialog;
}

/**
 * The dialog's destination breadcrumb trail.
 *
 * @param dialog - the move dialog
 * @returns the breadcrumb locator
 */
function trail(dialog: Locator): Locator {
  return dialog.getByRole("navigation", { name: "Destination folder" });
}

/**
 * Navigate the picker into a subfolder of the current destination.
 *
 * @param dialog - the move dialog
 * @param folder - the subfolder name
 */
async function enterFolder(dialog: Locator, folder: string): Promise<void> {
  await dialog
    .getByRole("list", { name: "Folders" })
    .getByRole("button", { name: folder, exact: true })
    .click();
  await expect(trail(dialog)).toContainText(folder);
}

test("moves a file into a subfolder", async ({ page, context }) => {
  await openAsMilo(page, context, "");
  const name = uniqueName("into-sub");
  await uploadFile(page, "move-sub/", name);
  await page.goto("/files?prefix=move-sub%2F");

  const row = fileRow(page, name);
  await expect(row).toBeVisible();
  const dialog = await openMove(page, row, name);

  // The picker starts at the file's current folder.
  await expect(trail(dialog)).toContainText("move-sub");
  await enterFolder(dialog, "Reports");
  await dialog.getByRole("button", { name: "Move here" }).click();

  // Pending state while the copy + delete runs, then the dialog closes,
  // the success alert names the destination and the row leaves the list.
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".alert-success")).toHaveText(
    `Moved "${name}" to move-sub/Reports`,
  );
  await expect(fileRow(page, name)).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("move-sub");

  // The file is in the destination folder.
  await page.getByRole("link", { name: /Reports/ }).click();
  await expect(fileRow(page, name)).toBeVisible();
});

test("moves a file to the space root via the breadcrumb", async ({
  page,
  context,
}) => {
  await openAsMilo(page, context, "");
  const name = uniqueName("to-root");
  await uploadFile(page, "move-root/deep/", name);
  await page.goto("/files?prefix=move-root%2Fdeep%2F");

  const dialog = await openMove(page, fileRow(page, name), name);
  await expect(trail(dialog)).toContainText("deep");
  await trail(dialog).getByRole("button", { name: "Home" }).click();
  await expect(trail(dialog).locator("[aria-current]")).toHaveText("Home");
  await dialog.getByRole("button", { name: "Move here" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".alert-success")).toHaveText(
    `Moved "${name}" to Home`,
  );
  await expect(fileRow(page, name)).toHaveCount(0);

  // The file now lives at the root of milo's space.
  const res = await page.request.get(
    `/api/files/download-url?key=${encodeURIComponent(`users/milo/${name}`)}&space=own`,
  );
  expect(res.status()).toBe(200);
});

test("Move here is disabled for the file's current folder", async ({
  page,
  context,
}) => {
  await openAsMilo(page, context, "move-collide/");
  const dialog = await openMove(page, fileRow(page, "dup.txt"), "dup.txt");
  const moveHere = dialog.getByRole("button", { name: "Move here" });

  await expect(moveHere).toBeDisabled();
  await enterFolder(dialog, "Inner");
  await expect(moveHere).toBeEnabled();
  await trail(dialog).getByRole("button", { name: "move-collide" }).click();
  await expect(moveHere).toBeDisabled();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fileRow(page, "dup.txt")).toBeVisible();
});

test("a name collision at the destination is refused with the error shown", async ({
  page,
  context,
}) => {
  await openAsMilo(page, context, "move-collide/");
  const dialog = await openMove(page, fileRow(page, "dup.txt"), "dup.txt");

  await enterFolder(dialog, "Inner");
  await dialog.getByRole("button", { name: "Move here" }).click();

  // The server's refusal is shown in the dialog, which stays open.
  await expect(dialog.getByRole("alert")).toContainText(
    'A file named "dup.txt" already exists in that folder',
  );
  await expect(dialog).toBeVisible();
  await expect(page.locator(".alert-success")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fileRow(page, "dup.txt")).toBeVisible();
  await expectSignedInAs(page, "milo");
});

test("moves a file from a search result row", async ({ page, context }) => {
  await openAsMilo(page, context, "");
  const name = uniqueName("srchmv");
  await uploadFile(page, "move-search/", name);

  // The scan indexes the upload in the background and the results page
  // fetches once per submitted query, so re-open and search until the
  // file surfaces (search.spec's polling pattern).
  const box = page.getByRole("searchbox", { name: "Search files" });
  const result = fileRow(page, name);
  await expect(async () => {
    await page.goto("/files");
    await box.fill(name);
    await box.press("Enter");
    await expect(result).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: INDEX_TIMEOUT });
  await expect(result).toContainText("move-search");

  const dialog = await openMove(page, result, name, `Move ${name}`);
  await expect(trail(dialog)).toContainText("move-search");
  await enterFolder(dialog, "Target");
  await dialog.getByRole("button", { name: "Move here" }).click();

  // The search view stays, re-runs and shows the file at its new path.
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".alert-success")).toHaveText(
    `Moved "${name}" to move-search/Target`,
  );
  await expect(box).toHaveValue(name);
  await expect(fileRow(page, name)).toContainText("move-search / Target");
});

test("a recipient moves a file inside a shared mount", async ({
  page,
  context,
}) => {
  // milo shares move-shared/ with nina (idempotent across retries).
  await useSession(context, "milo-session");
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "move-shared/", recipientUsername: "nina" },
  });
  expect([201, 409]).toContain(shareRes.status());

  await useSession(context, "nina-session");
  const shares = (await (await page.request.get("/api/shares")).json()) as {
    incoming: ShareIncomingBody[];
  };
  const share = shares.incoming.find(
    (entry) =>
      entry.folderName === "move-shared" && entry.sharer.username === "milo",
  );
  expect(share).toBeDefined();
  const space = `shared:${share?.id}`;
  const name = uniqueName("shared-mv");
  await uploadFile(page, "", name, space);

  await page.goto(`/files?space=${encodeURIComponent(space)}`);
  await expectSignedInAs(page, "nina");
  const dialog = await openMove(page, fileRow(page, name), name);

  // The picker is rooted at the mount: moves never leave the share.
  await expect(trail(dialog)).toContainText("move-shared");
  await expect(trail(dialog)).not.toContainText("Home");
  await expect(
    dialog.getByRole("button", { name: "Move here" }),
  ).toBeDisabled();
  await enterFolder(dialog, "inbox");
  await dialog.getByRole("button", { name: "Move here" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".alert-success")).toHaveText(
    `Moved "${name}" to move-shared/inbox`,
  );
  await expect(fileRow(page, name)).toHaveCount(0);
  await page.getByRole("link", { name: /inbox/ }).click();
  await expect(fileRow(page, name)).toBeVisible();
});

test("the move dialog is fully usable at 375px without horizontal scroll", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openAsMilo(page, context, "");
  const name = uniqueName("mobile-mv");
  await uploadFile(page, "move-mobile/", name);
  await page.goto("/files?prefix=move-mobile%2F");

  const row = fileRow(page, name);
  const moveButton = row.getByRole("button", { name: "Move", exact: true });
  await expect(moveButton).toBeVisible();
  // Icon-only below sm, with a touch-sized target.
  await expect(moveButton.getByText("Move", { exact: true })).toBeHidden();
  expect((await moveButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalOverflow(page);

  const dialog = await openMove(page, row, name);
  await expectNoHorizontalOverflow(page);
  const folderButton = dialog
    .getByRole("list", { name: "Folders" })
    .getByRole("button", { name: "Dest", exact: true });
  for (const control of [
    folderButton,
    dialog.getByRole("button", { name: "Cancel" }),
    dialog.getByRole("button", { name: "Move here" }),
  ]) {
    await expect(control).toBeVisible();
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  await enterFolder(dialog, "Dest");
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "Move here" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".alert-success")).toHaveText(
    `Moved "${name}" to move-mobile/Dest`,
  );
  await expect(fileRow(page, name)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
