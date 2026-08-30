/**
 * CLI entry for the search gold-set evaluation: prints the per-query
 * metric table and the summary. Core logic lives in search-eval.ts,
 * which is also imported by tests/search-eval.test.ts as the quality
 * gate. Run with: bun run scripts/eval-search.ts
 */
import { runSearchEval } from "./search-eval";

await runSearchEval().then((report) => {
  console.log(`Corpus: ${report.docs} docs, ${report.queries} queries\n`);
  console.log(
    "query".padEnd(16),
    "P@5".padStart(6),
    "nDCG@10".padStart(8),
    "MRR".padStart(6),
    "R@10".padStart(6),
  );
  for (const m of report.perQuery) {
    console.log(
      m.query.padEnd(16),
      m.pAt5.toFixed(2).padStart(6),
      m.ndcgAt10.toFixed(3).padStart(8),
      m.mrr.toFixed(2).padStart(6),
      m.recallAt10.toFixed(2).padStart(6),
    );
  }
  console.log(
    "\nsummary".padEnd(16),
    report.summary.pAt5.toFixed(2).padStart(6),
    report.summary.ndcgAt10.toFixed(3).padStart(8),
    report.summary.mrr.toFixed(2).padStart(6),
    report.summary.recallAt10.toFixed(2).padStart(6),
  );
});
