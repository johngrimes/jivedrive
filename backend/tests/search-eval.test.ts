/**
 * Quality gate for the file-search gold-set harness (007-file-search).
 * Replays the fixed corpus + judgments through the real repository
 * search helpers and asserts the headline metrics stay above the
 * calibrated floor, so a ranking or extraction regression fails the
 * suite instead of shipping silently.
 */
import { describe, expect, it } from "bun:test";
import { runSearchEval } from "../scripts/search-eval";

describe("search gold-set evaluation", () => {
  it("meets the calibrated quality floor (007-file-search)", async () => {
    const report = await runSearchEval();

    // Corpus and queries must load intact: 22 documents, 17 queries.
    expect(report.docs).toBe(22);
    expect(report.queries).toBe(17);

    expect(report.summary.ndcgAt10).toBeGreaterThanOrEqual(0.93);
    expect(report.summary.mrr).toBeGreaterThanOrEqual(0.95);
    expect(report.summary.recallAt10).toBeGreaterThanOrEqual(0.92);
    expect(report.summary.pAt5).toBeGreaterThanOrEqual(0.45);

    // The corrupt PDF must still be found by name after its extraction
    // degrades to name-only (FR-008): the "receipt" query must surface
    // it at rank 1.
    const receipt = report.perQuery.find((m) => m.query === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt?.ranked[0]).toBe("scans/receipt-2023.pdf");

    // The binary fixtures (PDF and DOCX) must both surface for the
    // project keyword, proving the extraction paths feed the index.
    const zephyrquill = report.perQuery.find((m) => m.query === "zephyrquill");
    expect(zephyrquill).toBeDefined();
    expect(zephyrquill?.recallAt10).toBe(1);
    for (const path of [
      "projects/zephyrquill/quarterly-review.pdf",
      "projects/zephyrquill/quarterly-review.docx",
    ]) {
      expect(zephyrquill?.ranked).toContain(path);
    }
  });
});
