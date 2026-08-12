import { describe, expect, it } from "vitest";
import { formatDate, formatSize } from "../src/lib/format";

describe("formatSize", () => {
  it("formats bytes without a unit suffix", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
  });

  it("formats kilobytes, megabytes and gigabytes with one decimal", () => {
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(831488)).toBe("812 KB");
    expect(formatSize(2516582)).toBe("2.4 MB");
    expect(formatSize(18979226)).toBe("18.1 MB");
    expect(formatSize(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  it("trails zeros are trimmed", () => {
    expect(formatSize(2 * 1024)).toBe("2 KB");
  });

  it("renders invalid input as a dash", () => {
    expect(formatSize(-1)).toBe("-");
    expect(formatSize(Number.NaN)).toBe("-");
  });
});

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
