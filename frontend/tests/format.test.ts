import { describe, expect, it } from "vitest";
import { formatDate, formatSize } from "../src/lib/format";

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

describe("formatSize", () => {
  it("shows sizes under 1 KB as whole bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("uses 1024-based units with KB/MB/GB/TB labels", () => {
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(831488)).toBe("812 KB");
    expect(formatSize(1258291)).toBe("1.2 MB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5 GB");
    expect(formatSize(1.5 * 1024 ** 4)).toBe("1.5 TB");
  });

  it("rounds to one decimal place and drops a trailing .0", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(10496)).toBe("10.3 KB");
    expect(formatSize(1075)).toBe("1 KB");
  });

  it("moves up a unit when rounding reaches 1024", () => {
    expect(formatSize(1048575)).toBe("1 MB");
    expect(formatSize(1024 ** 3 - 1)).toBe("1 GB");
  });

  it("stays in TB beyond 1024 TB", () => {
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048 TB");
  });
});
