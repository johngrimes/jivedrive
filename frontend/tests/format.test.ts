import { describe, expect, it } from "vitest";
import { formatDate } from "../src/lib/format";

describe("formatDate", () => {
  it("formats a local date-time as YYYY-MM-DD HH:MM", () => {
    // No timezone suffix: parsed as local time, so the output is stable.
    expect(formatDate("2026-08-10T14:32:00")).toBe("2026-08-10 14:32");
    expect(formatDate("2026-01-05T09:05:00")).toBe("2026-01-05 09:05");
  });

  it("renders an invalid date as a dash", () => {
    expect(formatDate("not-a-date")).toBe("-");
  });
});
