import { describe, expect, it } from "vitest";

// Placeholder so the frontend Vitest runner has something meaningful to run
// until the Phase 2+ component test suites are written. Also verifies that
// the jsdom environment is active.
describe("frontend test runner", () => {
  it("executes tests in a DOM environment", () => {
    expect(typeof document).toBe("object");
  });
});
