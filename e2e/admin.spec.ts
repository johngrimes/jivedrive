import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import {
  enableVirtualAuthenticator,
  enrollViaLink,
  expectNoHorizontalOverflow,
  expectSignedInAs,
  signOut,
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

/**
 * A row in the invites table whose username cell contains the given text
 * exactly. Exact matching (not substring) so usernames like "ina" never
 * match a row for "gina" in the same table. The match targets the
 * username's own nested span: since US3 the cell also carries stacked
 * metadata below the breakpoints, so its accessible name is the
 * concatenation, not the bare username (T015). The table is scoped by its
 * accessible name (aria-label="Invites", added in T018).
 *
 * @param page - the page
 * @param text - the exact username
 * @returns the matching row locator
 */
function inviteRow(page: Page, text: string) {
  return page.getByRole("table", { name: "Invites" }).locator("tbody tr", {
    has: page.getByRole("cell").getByText(text, { exact: true }),
  });
}

/**
 * A row in the users table whose username cell contains the given text
 * exactly (same nested-span rationale as {@link inviteRow}, T015). Scoped
 * by the accessible name (aria-label="Users", added in T018).
 *
 * @param page - the page
 * @param text - the exact username
 * @returns the matching row locator
 */
function userRow(page: Page, text: string) {
  return page.getByRole("table", { name: "Users" }).locator("tbody tr", {
    has: page.getByRole("cell").getByText(text, { exact: true }),
  });
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
 * A username unique to this test attempt. The e2e server keeps one in-memory
 * database for the whole run, retries included, and invite creation rejects
 * a duplicate pending/expired invite (409). Seeded users (e.g. erin) and
 * other parallel specs collide with a bare base name, so every attempt —
 * not just retries — carries a distinct suffix.
 *
 * @param base - the readable base username
 * @param testInfo - test info providing the retry count
 * @returns the attempt-unique username
 */
function inviteUsername(base: string, testInfo: TestInfo): string {
  return `${base}-r${testInfo.retry}`;
}

/**
 * Read the generated invite link from the readonly link input.
 *
 * @param page - the page
 * @param previous - when set, first wait for the link to change away from
 *   this value. A re-send replaces the link asynchronously; reading before
 *   the replacement lands would return the stale original link.
 * @returns the full registration URL
 */
async function generatedLink(page: Page, previous?: string): Promise<string> {
  const input = page.locator("input[readonly]");
  await expect(input).toHaveValue(/\/register\?token=/);
  if (previous) {
    await expect(input).not.toHaveValue(previous);
  }
  return (await input.inputValue()).trim();
}

test("an admin creates an invite and sees the 48-hour link and pending row", async ({
  page,
  context,
}, testInfo) => {
  await openAdmin(page, context);

  const username = inviteUsername("erin", testInfo);
  await createInvite(page, username);

  // The form shows the generated link: a full registration URL carrying a
  // token, with the 48-hour expiry annotation (FR-003, US6 scenario 1).
  const link = await generatedLink(page);
  expect(link).toMatch(/^http:\/\/localhost:5173\/register\?token=/);
  await expect(
    page.getByText("Invite expires 48 hours after creation"),
  ).toBeVisible();

  // The invite appears in the pending invites table with a pending status.
  const row = inviteRow(page, username);
  await expect(row).toBeVisible();
  await expect(row).toContainText(`users/${username}/`);
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
}, testInfo) => {
  await openAdmin(page, context);

  const username = inviteUsername("felix", testInfo);
  await createInvite(page, username);
  const original = await generatedLink(page);

  // Re-send from the pending invites table.
  await inviteRow(page, username)
    .getByRole("button", { name: "Re-send" })
    .click();

  // The fresh link is shown and differs from the original (new token), and
  // the invite is still pending. Wait for the link to change: the card keeps
  // showing the original until the re-send response lands.
  const resent = await generatedLink(page, original);
  expect(resent).toMatch(/^http:\/\/localhost:5173\/register\?token=/);
  expect(resent).not.toBe(original);
  await expect(inviteRow(page, username)).toContainText("pending");
});

test("cancelling an invite removes it from the list", async ({
  page,
  context,
}, testInfo) => {
  await openAdmin(page, context);

  const username = inviteUsername("grace", testInfo);
  await createInvite(page, username);
  await expect(inviteRow(page, username)).toBeVisible();

  await inviteRow(page, username)
    .getByRole("button", { name: "Cancel" })
    .click();

  // Explicit success feedback, then the row is gone.
  await expect(
    page.getByText(new RegExp(`Invite for "${username}" cancelled`)),
  ).toBeVisible();
  await expect(inviteRow(page, username)).toHaveCount(0);
});

test("an invite created in the admin UI can be claimed by registering", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await openAdmin(page, context);

  const username = inviteUsername("hazel", testInfo);
  await createInvite(page, username);
  const link = await generatedLink(page);

  // The invitee opens the link in a private window with a virtual
  // authenticator and registers their passkey (the register flow is the
  // same one that claims the seeded invites, so claiming must work).
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await enableVirtualAuthenticator(inviteeContext, inviteePage);
  await inviteePage.goto(link);
  await expect(inviteePage.getByLabel("Your username")).toHaveValue(username);
  await inviteePage.getByRole("button", { name: "Create passkey" }).click();
  await expect(inviteePage).toHaveURL(/\/files/);
  await expectSignedInAs(inviteePage, username);
  await inviteeContext.close();

  // The admin reloads and sees the invite as claimed, with no actions.
  await page.reload();
  const row = inviteRow(page, username);
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

test("an admin resets a user's passkeys and the user re-enrolls via the returned reset link", async ({
  page,
  context,
  browser,
}) => {
  await openAdmin(page, context);

  // Re-arm first: the e2e server keeps one in-memory DB for the whole run,
  // so a previous (failed) attempt may have left kate with a passkey. An
  // unconditional reset deletes any leftover credentials and sessions and
  // cancels stale invites, and the response carries the fresh re-enrollment
  // link (FR-006); no seeded invite is needed, so every attempt starts
  // from the same state.
  const row = userRow(page, "kate");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Reset passkeys" }).click();
  let dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("kate");
  // The dialog explains the new semantics: sessions are revoked and a
  // re-enrollment link is issued (no more "left untouched").
  await expect(dialog).toContainText("revoked");
  await expect(dialog).toContainText("re-enrollment");
  await dialog.getByRole("button", { name: "Reset passkeys" }).click();

  // Explicit success feedback plus the re-enrollment link from the reset
  // response (US2 scenario 1).
  await expect(page.getByText(/Passkeys reset for "kate"/)).toBeVisible();
  const firstLink = await generatedLink(page);
  expect(firstLink).toMatch(/^http:\/\/localhost:5173\/register\?token=/);

  // kate's own context: she enrolls her first passkey via THAT link (the
  // reset-created invite attaches to her existing account, US1 attach
  // semantics) and signs out again.
  const kateContext = await browser.newContext();
  const katePage = await kateContext.newPage();
  await enableVirtualAuthenticator(kateContext, katePage);
  await enrollViaLink(katePage, firstLink);
  await expect(katePage).toHaveURL(/\/files/);
  await expectSignedInAs(katePage, "kate");
  await signOut(katePage, "kate");

  // The admin resets kate again: the UI shows a NEW re-enrollment link
  // (fresh token, not the one already claimed), and kate re-enrolls via it
  // in the same context and lands signed in again (US2 scenario 1; the
  // attach flow matches: kate exists with zero discoverable passkeys).
  await userRow(page, "kate")
    .getByRole("button", { name: "Reset passkeys" })
    .click();
  dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("kate");
  await dialog.getByRole("button", { name: "Reset passkeys" }).click();
  await expect(page.getByText(/Passkeys reset for "kate"/)).toBeVisible();
  const secondLink = await generatedLink(page, firstLink);
  expect(secondLink).toMatch(/^http:\/\/localhost:5173\/register\?token=/);
  expect(secondLink).not.toBe(firstLink);

  await enrollViaLink(katePage, secondLink);
  await expect(katePage).toHaveURL(/\/files/);
  await expectSignedInAs(katePage, "kate");

  await kateContext.close();
});

test("an expired invite shows an expired status with a re-send option", async ({
  page,
  context,
}, testInfo) => {
  await openAdmin(page, context);

  // ina's invite is seeded already expired in e2eServer, dedicated to this
  // spec (which re-sends it). dave's expired invite is left alone because
  // auth.spec asserts its refusal, and both specs share one server.
  const row = inviteRow(page, "ina");
  if (testInfo.retry > 0) {
    // A retry re-runs the whole test; the server's in-memory database is not
    // reset between attempts, so a previous attempt already re-sent ina and
    // she is pending now. The expired-status assertions hold only on a fresh
    // run; the re-send transition below still applies to pending invites.
    await expect(row).toContainText("pending");
  } else {
    await expect(row).toContainText("expired");
    await expect(row.getByRole("button", { name: "Re-send" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Cancel" })).toBeVisible();
  }

  // Re-sending re-activates the invite with a fresh link.
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
