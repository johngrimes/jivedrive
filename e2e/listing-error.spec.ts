import { expect, test } from "@playwright/test";
import { expectSignedInAs } from "./helpers";

/**
 * A failed first-page listing must surface an explicit error with a Retry
 * action instead of hanging on loading skeletons (constitution V:
 * visibility of system status).
 *
 * Regression test: the initial-load error branch used to be unreachable
 * because the skeleton's "fetching" flag (`listingPrefix !== prefix`)
 * never cleared after a failure, so the page showed loading placeholders
 * forever even though the backend had answered with a 500. Production
 * analogue: OVHcloud rejected the deployed S3 credentials with a 403
 * InvalidAccessKeyId, and the files page appeared "stuck on loading".
 */
test("a failed listing shows an error with Retry, not an eternal skeleton", async ({
  page,
  context,
}) => {
  // gina's space listing always fails in the mock S3 (see listObjectsV2 in
  // e2eServer.ts), so she is the only user whose root view errors.
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "gina-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "gina");

  // The failure surfaces as an explicit error alert with a Retry action.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Internal server error");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  // The loading skeletons are gone, not stuck on the page.
  await expect(page.getByRole("status", { name: "Loading files" })).toHaveCount(
    0,
  );

  // Retry re-fires the listing request; it fails again and the error
  // re-appears (the mock keeps failing), so the UI must not hang on a
  // skeleton between attempts.
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toContainText("Internal server error");
});
