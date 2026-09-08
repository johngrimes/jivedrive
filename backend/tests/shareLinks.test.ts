/**
 * Unit tests for the short share-link token generator (T004, D3).
 *
 * The token is the only public identifier of a share link, so it must be
 * uniformly drawn from `[A-Za-z0-9]` (no modulo bias) with enough length
 * that enumeration is infeasible (FR-009).
 */
import { describe, expect, it } from "bun:test";
import { generateShareToken } from "../src/shareLinks";

describe("generateShareToken (T004)", () => {
  it("returns exactly 12 characters from [A-Za-z0-9]", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateShareToken()).toMatch(/^[A-Za-z0-9]{12}$/);
    }
  });

  it("draws are unique over many draws", () => {
    const draws = new Set<string>();
    for (let i = 0; i < 10000; i++) draws.add(generateShareToken());
    // 62^12 ≈ 3.2×10^21 candidates: a collision among 10^4 draws is
    // essentially impossible for a correct generator.
    expect(draws.size).toBe(10000);
  });
});
