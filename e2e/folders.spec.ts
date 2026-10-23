import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * Folder creation (issue #11). nora and otto are dedicated to this spec
 * (see e2eServer.ts): nora's space holds one `existing` folder, and otto
 * shares his `team` folder with her. Every test creates uniquely named
 * folders so the tests can run in parallel and under retries.
 */

/**
 * Start signed in with a pre-seeded session (no WebAuthn ceremony).
 *
 * @param page - the page
 * @param context - the browser context
 * @param username - the seeded user
 * @param token - the seeded session token
 */
async function startSignedInAs(
  page: Page,
  context: BrowserContext,
  username: string,
  token: string,
): Promise<void> {
  await context.addCookies([
    { name: "jivedrive_session", value: token, url: "http://localhost:5173" },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, username);
}

/**
 * Open the New folder dialog, type a name and press Create.
 *
 * @param page - the page
 * @param name - the folder name to type
 */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
}

/** A folder name unique to this test attempt (parallel- and retry-safe). */
function uniqueName(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test("creates an empty folder that persists and opens", async ({
  page,
  context,
}) => {
  await startSignedInAs(page, context, "nora", "nora-session");
  const name = uniqueName("Plans #1");

  // Surrounding whitespace is trimmed; the rest is kept verbatim.
  await createFolder(page, `  ${name}  `);

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: `Created folder "${name}"` }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

  // The empty folder is stored, not just shown: it survives a reload.
  await page.reload();
  await expectSignedInAs(page, "nora");
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();

  await link.click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText(name);
  await expect(page.getByText("This folder is empty")).toBeVisible();
});

test("creates a nested folder and refuses a name already taken", async ({
  page,
  context,
}) => {
  await startSignedInAs(page, context, "nora", "nora-session");
  await page.getByRole("link", { name: "existing", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("existing");
  const name = uniqueName("child");

  await createFolder(page, name);
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  // The existing file in the folder is untouched.
  await expect(page.getByText("notes.txt")).toBeVisible();

  // Same name again: refused inside the dialog, which stays open with the
  // name kept so it can be corrected.
  await createFolder(page, name);
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await expect(dialog.getByRole("alert")).toContainText(
    `A folder named "${name}" already exists`,
  );
  await expect(dialog.getByLabel("Folder name")).toHaveValue(name);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(1);
});

test("refuses an invalid name with an explicit error", async ({
  page,
  context,
}) => {
  await startSignedInAs(page, context, "nora", "nora-session");

  // A blank name cannot be submitted at all.
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByLabel("Folder name").fill("   ");
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // The server's validation message is shown for a name with a slash.
  await createFolder(page, "a/b");
  await expect(dialog.getByRole("alert")).toContainText('contain "/"');
  await expect(dialog).toBeVisible();
});

test("a recipient creates a folder inside a shared folder and the sharer sees it", async ({
  page,
  context,
  browser,
}) => {
  await startSignedInAs(page, context, "nora", "nora-session");
  await page
    .locator("li.list-row")
    .filter({ hasText: "Shared by otto" })
    .getByRole("link")
    .click();
  await expect(page.getByText("plan.txt")).toBeVisible();
  const name = uniqueName("from nora");

  await createFolder(page, name);
  await expect(
    page.getByRole("status").filter({ hasText: `Created folder "${name}"` }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

  // The folder lives in otto's space, inside the shared folder.
  const ottoContext = await browser.newContext();
  const ottoPage = await ottoContext.newPage();
  await startSignedInAs(ottoPage, ottoContext, "otto", "otto-session");
  await ottoPage.goto("/files?prefix=team%2F");
  await expect(ottoPage.getByRole("link", { name, exact: true })).toBeVisible();
  await ottoContext.close();
});

for (const width of [375, 768, 1280]) {
  test(`the new-folder control and dialog fit a ${width}px viewport`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await startSignedInAs(page, context, "nora", "nora-session");

    const newFolder = page.getByRole("button", { name: "New folder" });
    await expect(newFolder).toBeInViewport();
    await expect(page.getByText("Upload file")).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    // Touch target: at least 40px tall (daisyUI btn default).
    const box = await newFolder.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

    await newFolder.click();
    const dialog = page.getByRole("dialog", { name: "New folder" });
    await expect(dialog.getByLabel("Folder name")).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Create" }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: "Cancel" }),
    ).toBeInViewport();
    await expectNoHorizontalOverflow(page);
  });
}
