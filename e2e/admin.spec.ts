import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import {
  enableVirtualAuthenticator,
  expectNoHorizontalOverflow,
  expectSignedInAs,
} from "./helpers";

/**
 * Start signed in as the pre-seeded admin (no WebAuthn ceremony; the
 * admin session is seeded in e2eServer like alice's browse-session) and
 * open the user management page.
 *
 * @param page - the page
 * @param context - the browser context
 */
async function openAdmin(page: Page, context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "admin-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();
}

/** A row in the invites table matching the given text. */
function inviteRow(page: Page, text: string) {
  return page.locator(".invites-table tbody tr", { hasText: text });
}

/** A row in the users table matching the given text. */
function userRow(page: Page, text: string) {
  return page.locator(".users-table tbody tr", { hasText: text });
}

/**
 * Fill the invite form and submit it for the given username.
 *
 * @param page - the page
 * @param username - the invitee username
 */
async function createInvite(page: Page, username: string): Promise<void> {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Bucket").fill("jivedrive-prod");
  await page.getByLabel("Prefix").fill(`users/${username}/`);
  await page.getByRole("button", { name: "Create invite link" }).click();
}

/**
 * Read the generated invite link from the readonly link input.
 *
 * @param page - the page
 * @returns the full registration URL
 */
async function generatedLink(page: Page): Promise<string> {
  const input = page.locator("input[readonly]");
  await expect(input).toHaveValue(/\/register\?token=/);
  return (await input.inputValue()).trim();
}

test("an admin creates an invite and sees the 48-hour link and pending row", async ({
  page,
  context,
}) => {
  await openAdmin(page, context);

  await createInvite(page, "erin");

  // The form shows the generated link: a full registration URL carrying a
  // token, with the 48-hour expiry annotation (FR-003, US6 scenario 1).
  const link = await generatedLink(page);
  expect(link).toMatch(/^http:\/\/localhost:5173\/register\?token=/);
  await expect(
    page.getByText("Invite expires 48 hours after creation"),
  ).toBeVisible();

  // The invite appears in the pending invites table with a pending status.
  const row = inviteRow(page, "erin");
  await expect(row).toBeVisible();
  await expect(row).toContainText("users/erin/");
  await expect(row).toContainText("pending");

  // The page stays usable at mobile, tablet and desktop widths.
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("heading", { name: "User management" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("re-sending an invite issues a fresh token and a new expiry", async ({
  page,
  context,
}) => {
  await openAdmin(page, context);

  await createInvite(page, "felix");
  const original = await generatedLink(page);

  // Re-send from the pending invites table.
  await inviteRow(page, "felix")
    .getByRole("button", { name: "Re-send" })
    .click();

  // The fresh link is shown and differs from the original (new token), and
  // the invite is still pending.
  const resent = await generatedLink(page);
  expect(resent).toMatch(/^http:\/\/localhost:5173\/register\?token=/);
  expect(resent).not.toBe(original);
  await expect(inviteRow(page, "felix")).toContainText("pending");
});

test("cancelling an invite removes it from the list", async ({
  page,
  context,
}) => {
  await openAdmin(page, context);

  await createInvite(page, "gina");
  await expect(inviteRow(page, "gina")).toBeVisible();

  await inviteRow(page, "gina").getByRole("button", { name: "Cancel" }).click();

  // Explicit success feedback, then the row is gone.
  await expect(page.getByText(/Invite for "gina" cancelled/)).toBeVisible();
  await expect(inviteRow(page, "gina")).toHaveCount(0);
});

test("an invite created in the admin UI can be claimed by registering", async ({
  page,
  context,
  browser,
}) => {
  await openAdmin(page, context);

  await createInvite(page, "hazel");
  const link = await generatedLink(page);

  // The invitee opens the link in a private window with a virtual
  // authenticator and registers their passkey (the register flow is the
  // same one that claims the seeded invites, so claiming must work).
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await enableVirtualAuthenticator(inviteeContext, inviteePage);
  await inviteePage.goto(link);
  await expect(inviteePage.getByLabel("Your username")).toHaveValue("hazel");
  await inviteePage.getByRole("button", { name: "Create passkey" }).click();
  await expect(inviteePage).toHaveURL(/\/files/);
  await expectSignedInAs(inviteePage, "hazel");
  await inviteeContext.close();

  // The admin reloads and sees the invite as claimed, with no actions.
  await page.reload();
  const row = inviteRow(page, "hazel");
  await expect(row).toContainText("claimed");
  await expect(row.getByRole("button", { name: "Re-send" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Cancel" })).toHaveCount(0);
});

test("an admin removes a user and their session stops working", async ({
  page,
  context,
}) => {
  await openAdmin(page, context);

  // frank is seeded in e2eServer as a dedicated removal target; no other
  // spec depends on him.
  const row = userRow(page, "frank");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Member");

  // Removing requires confirmation (safety); the dialog explains that
  // storage objects are untouched (FR-014).
  await row.getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("frank");
  await expect(dialog).toContainText("left untouched");
  await dialog.getByRole("button", { name: "Remove" }).click();

  // Explicit success feedback and the row disappears from the user list.
  await expect(page.getByText(/Removed user "frank"/)).toBeVisible();
  await expect(userRow(page, "frank")).toHaveCount(0);

  // The removed user's pre-seeded session is cascade-deleted: /auth/me no
  // longer reports them (they cannot sign in). Replace the admin cookie in
  // this context's jar with frank's token for the check.
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "frank-session",
      url: "http://localhost:5173",
    },
  ]);
  const me = await page.request.get("/auth/me");
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { user: unknown };
  expect(body.user).toBeNull();
});

test("an expired invite shows an expired status with a re-send option", async ({
  page,
  context,
}) => {
  await openAdmin(page, context);

  // ina's invite is seeded already expired in e2eServer, dedicated to this
  // spec (which re-sends it). dave's expired invite is left alone because
  // auth.spec asserts its refusal, and both specs share one server.
  const row = inviteRow(page, "ina");
  await expect(row).toContainText("expired");
  await expect(row.getByRole("button", { name: "Re-send" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Cancel" })).toBeVisible();

  // Re-sending an expired invite re-activates it.
  await row.getByRole("button", { name: "Re-send" }).click();
  const link = await generatedLink(page);
  expect(link).toMatch(/\/register\?token=/);
  await expect(inviteRow(page, "ina")).toContainText("pending");
});

test("a non-admin cannot access user management", async ({ page, context }) => {
  // Sign in as alice via her pre-seeded session (admin link is hidden to
  // non-admins; see browse.spec).
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/admin");
  await expect(page.getByText(/admin access required/i)).toBeVisible();

  // The API itself refuses non-admins with 403 on every endpoint.
  const users = await page.request.get("/api/admin/users");
  expect(users.status()).toBe(403);
  const invites = await page.request.get("/api/admin/invites");
  expect(invites.status()).toBe(403);
  const create = await page.request.post("/api/admin/invites", {
    data: { username: "x", bucket: "b", prefix: "x/" },
  });
  expect(create.status()).toBe(403);
  const remove = await page.request.delete("/api/admin/users?id=x");
  expect(remove.status()).toBe(403);
});
