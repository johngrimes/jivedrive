/**
 * Search-quality evaluation harness (gold-set method) for the file search
 * feature (007-file-search).
 *
 * A fixed corpus of documents is indexed into an in-memory database with
 * the real migrations, then a list of queries with hand-graded relevance
 * judgments (2 = directly relevant, 1 = partially relevant, unjudged =
 * irrelevant) is replayed through the same ranking the /search route
 * exposes: name matches above content matches (R-008), FTS rank order
 * inside each group, deduplicated by key.
 *
 * Metrics per query: P@5, nDCG@10 (gain 2^rel − 1), MRR (first hit with
 * grade >= 1) and recall@10 over the judged-relevant set. The summary is
 * the unweighted mean over queries. Run with:
 *
 *     bun run scripts/search-eval.ts
 *
 * `runSearchEval` is also imported by `tests/search-eval.test.ts`, which
 * gates the summary metrics so a ranking or extraction regression fails
 * the suite.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  createUser,
  searchContent,
  searchFileNames,
  upsertSearchDoc,
} from "../src/db/repository";
import type { User } from "../src/db/repository";
import { extractText } from "../src/search/extract";

/** Same contract cap as the /search route (routes/files.ts). */
const SEARCH_RESULT_CAP = 50;

/** Storage prefix of the synthetic corpus owner. */
const OWNER_PREFIX = "users/gold/";

/** One corpus document. `body` is the extracted text; `fixture` reads a
 * binary test fixture instead and extracts through the real extractor. */
interface CorpusDoc {
  /** Corpus-relative object key (mounted under OWNER_PREFIX). */
  path: string;
  body?: string;
  fixture?: string;
}

/** One evaluated query with its relevance judgments (grade 0–2). */
interface GoldQuery {
  query: string;
  /** Grade by corpus-relative path; unjudged paths grade 0. */
  grades: Record<string, number>;
}

const fixturesDir = fileURLToPath(
  new URL("../tests/fixtures", import.meta.url),
);

/**
 * The gold corpus: 19 text documents plus 3 binary fixtures. Vocabulary
 * clusters (invoices, recipes, finance, the Zephyrquill project, travel)
 * overlap on purpose so bm25 has hard negatives to discriminate;
 * `budget-notes.txt` is the name-trap (its name matches "budget" queries
 * but its content is about recipes) and `receipt-2023.pdf` is the corrupt
 * fixture, which must degrade to name-only indexing (FR-008).
 */
export const CORPUS: CorpusDoc[] = [
  {
    path: "invoices/invoice-2024-03.txt",
    body: `Invoice #2024-03 for Acme Corporation.
Issued March 2024. Services: frontend consulting.
Amount due: 4,200 EUR. Payment terms: 30 days.`,
  },
  {
    path: "invoices/invoice-2024-11.txt",
    body: `Invoice #2024-11 for Acme Corporation.
Issued November 2024. Services: backend consulting and deployment support.
Amount due: 6,800 EUR. Payment terms: 30 days.`,
  },
  {
    path: "invoices/invoice-draft.txt",
    body: `DRAFT invoice for Huldr LLC, December.
Scope not final: design review and accessibility audit.
Do not send until the statement of work is signed.`,
  },
  {
    path: "clients/acme-agreement.txt",
    body: `Consulting agreement between Jane Doe and Acme Corporation.
The monthly retainer covers up to 40 hours. Each engagement is billed
with a separate invoice at the start of the month.`,
  },
  {
    path: "recipes/pancakes.txt",
    body: `Fluffy pancakes: 2 cups flour, 2 eggs, 1.5 cups milk,
2 teaspoons baking powder, a pinch of salt. Fry on medium heat
until bubbles form, then flip once.`,
  },
  {
    path: "recipes/sourdough-starter.txt",
    body: `Sourdough starter recipe: mix 100 g rye flour with 100 ml
water daily. Keep at room temperature. After five to seven days the
starter smells sour and doubles between feedings.`,
  },
  {
    path: "recipes/meal-plan.md",
    body: `# Weekly meal plan

Monday: pancakes with berries.
Wednesday: sourdough toast and soup.
Friday: roast vegetables and rice.`,
  },
  {
    // Name-trap: the name matches finance queries, the content does not.
    path: "budget-notes.txt",
    body: `Recipe experiments for the weekend: try folding egg whites
into the pancake batter, and feed the sourdough starter twice
before baking.`,
  },
  {
    path: "finance/budget-2026.csv",
    body: `month,category,amount,notes
January,hosting,40,quarterly invoice arrives in March
February,training,120,conference ticket
March,software,55,editor licences
April,travel,300,Japan trip deposit`,
  },
  {
    path: "finance/expenses.csv",
    body: `date,item,amount,notes
2026-01-12,keyboard,89,receipt scanned
2026-02-03,train ticket,34,no receipt`,
  },
  {
    path: "projects/zephyrquill/roadmap.md",
    body: `# Zephyrquill roadmap

Q3: markdown editor beta.
Q4: collaborative cursors.
The quarterly budget review gates the hiring plan.`,
  },
  {
    path: "projects/zephyrquill/meeting-notes.txt",
    body: `Zephyrquill sync, Tuesday. Attendees: Mia, Jonas, Priya.
Discussed the roadmap slip and moved the quarterly budget review
to the last Friday of the month.`,
  },
  {
    path: "travel/japan-itinerary.md",
    body: `# Japan itinerary

Day 1-3: Tokyo, Shibuya and the fish market.
Day 4-6: Kyoto, ryokan stay and the bamboo grove.
Rail pass pickup at the airport counter.`,
  },
  {
    path: "travel/packing-list.txt",
    body: `Packing list for the Japan trip: power adapter, walking shoes,
rain shell, passport, copies of the hotel reservations.`,
  },
  {
    path: "notes/todo.txt",
    body: `File the March invoice, renew the passport, water the plants,
book the dentist.`,
  },
  {
    path: "notes/reading-list.md",
    body: `# Reading list

The Design of Everyday Things.
Thinking in Systems.
A Philosophy of Software Design.`,
  },
  {
    path: "logs/server-2026-03.log",
    body: `2026-03-01T00:00:12Z INFO healthcheck ok
2026-03-01T00:05:00Z WARN slow query on sessions (812 ms)
2026-03-01T00:11:41Z INFO rotation finished`,
  },
  {
    path: "README.md",
    body: `Personal workspace. Documents are organised by folder; see the
share settings to grant a folder to another user.`,
  },
  {
    path: "clients/huldr-contact.txt",
    body: `Huldr LLC: accounts payable contact, Mara Voss.
Billing questions go to ap@huldr.example. Reference the invoice
number in the subject line.`,
  },
  {
    // Valid PDF fixture whose extracted text is the shared review phrase.
    path: "projects/zephyrquill/quarterly-review.pdf",
    fixture: "sample.pdf",
  },
  {
    // Same content as the PDF, exercising the DOCX extraction path.
    path: "projects/zephyrquill/quarterly-review.docx",
    fixture: "sample.docx",
  },
  {
    // Corrupt PDF: extraction yields null, so it indexes name-only.
    path: "scans/receipt-2023.pdf",
    fixture: "corrupt.pdf",
  },
];

/** The gold queries with graded relevance judgments. */
const GOLD: GoldQuery[] = [
  {
    query: "invoice",
    grades: {
      "invoices/invoice-2024-03.txt": 2,
      "invoices/invoice-2024-11.txt": 2,
      "invoices/invoice-draft.txt": 2,
      "clients/acme-agreement.txt": 1,
      "clients/huldr-contact.txt": 1,
      "notes/todo.txt": 1,
      "finance/budget-2026.csv": 1,
    },
  },
  {
    query: "invoice-2024",
    grades: {
      "invoices/invoice-2024-03.txt": 2,
      "invoices/invoice-2024-11.txt": 2,
    },
  },
  {
    query: "pancakes",
    grades: { "recipes/pancakes.txt": 2, "recipes/meal-plan.md": 1 },
  },
  {
    query: "sourdough",
    grades: {
      "recipes/sourdough-starter.txt": 2,
      "recipes/meal-plan.md": 1,
      "budget-notes.txt": 0,
    },
  },
  {
    query: "budget",
    grades: {
      "finance/budget-2026.csv": 2,
      "projects/zephyrquill/quarterly-review.pdf": 2,
      "projects/zephyrquill/quarterly-review.docx": 2,
      "projects/zephyrquill/roadmap.md": 1,
      "projects/zephyrquill/meeting-notes.txt": 1,
      "budget-notes.txt": 1,
    },
  },
  {
    query: "zephyrquill",
    grades: {
      "projects/zephyrquill/roadmap.md": 2,
      "projects/zephyrquill/meeting-notes.txt": 2,
      "projects/zephyrquill/quarterly-review.pdf": 2,
      "projects/zephyrquill/quarterly-review.docx": 2,
    },
  },
  {
    query: "receipt",
    grades: { "scans/receipt-2023.pdf": 2, "finance/expenses.csv": 1 },
  },
  {
    query: "japan",
    grades: { "travel/japan-itinerary.md": 2, "travel/packing-list.txt": 1 },
  },
  { query: "packing", grades: { "travel/packing-list.txt": 2 } },
  {
    query: "quarterly",
    grades: {
      "projects/zephyrquill/quarterly-review.pdf": 2,
      "projects/zephyrquill/quarterly-review.docx": 2,
      "finance/budget-2026.csv": 1,
      "projects/zephyrquill/roadmap.md": 1,
      "projects/zephyrquill/meeting-notes.txt": 1,
    },
  },
  {
    query: "meeting",
    grades: { "projects/zephyrquill/meeting-notes.txt": 2 },
  },
  {
    query: "acme",
    grades: {
      "clients/acme-agreement.txt": 2,
      "invoices/invoice-2024-03.txt": 1,
      "invoices/invoice-2024-11.txt": 1,
    },
  },
  {
    query: "expenses",
    grades: { "finance/expenses.csv": 2, "finance/budget-2026.csv": 1 },
  },
  {
    query: "2024",
    grades: {
      "invoices/invoice-2024-03.txt": 2,
      "invoices/invoice-2024-11.txt": 2,
    },
  },
  {
    query: "roadmap",
    grades: { "projects/zephyrquill/roadmap.md": 2 },
  },
  { query: "meal", grades: { "recipes/meal-plan.md": 2 } },
  {
    query: "budget review",
    grades: {
      "projects/zephyrquill/quarterly-review.pdf": 2,
      "projects/zephyrquill/quarterly-review.docx": 2,
      "projects/zephyrquill/roadmap.md": 1,
      "projects/zephyrquill/meeting-notes.txt": 1,
    },
  },
];

/** The result of one gold query. */
export interface QueryMetrics {
  query: string;
  pAt5: number;
  ndcgAt10: number;
  mrr: number;
  recallAt10: number;
  /** The ranked result paths the merged route search returned. */
  ranked: string[];
}

/** Aggregate result of one evaluation run. */
export interface EvalReport {
  docs: number;
  queries: number;
  perQuery: QueryMetrics[];
  /** Unweighted means over all queries. */
  summary: { pAt5: number; ndcgAt10: number; mrr: number; recallAt10: number };
}

/** Discounted cumulative gain at rank 10 with gain 2^rel − 1. */
function dcgAt10(gains: number[]): number {
  return gains
    .slice(0, 10)
    .reduce(
      (sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2),
      0,
    );
}

/**
 * Seed the in-memory database with the corpus owner and every corpus
 * document, extracting binary fixtures through the real extractor.
 */
async function seed(db: Database): Promise<User> {
  const user = createUser(db, {
    username: "golduser",
    bucket: "jivedrive-prod",
    prefix: OWNER_PREFIX,
  });
  for (const doc of CORPUS) {
    const key = OWNER_PREFIX + doc.path;
    const fileName = doc.path.slice(doc.path.lastIndexOf("/") + 1);
    let body = doc.body ?? "";
    if (doc.fixture !== undefined) {
      // FR-008: extraction failure degrades to name-only (empty body).
      const bytes = readFileSync(join(fixturesDir, doc.fixture));
      body = (await extractText(bytes, fileName)) ?? "";
    }
    upsertSearchDoc(db, {
      userId: user.id,
      key,
      etag: "eval",
      size: Buffer.byteLength(body),
      fileName,
      body,
    });
  }
  return user;
}

/**
 * Replay the /search route's file ranking (R-008): name hits above
 * content hits, FTS rank order inside each group, deduplicated by key,
 * capped at the contract limit. Kept in lockstep with the file passes
 * of the handler in routes/files.ts; its folder pass (#13), which ranks
 * folder-name matches above every file, is outside this file-relevance
 * evaluation (the seeded corpus has no folder rows). The cap semantics
 * (name group exhausting the cap) cannot trigger with this corpus.
 */
export function routeSearch(db: Database, user: User, query: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string): boolean => {
    if (seen.has(key) || keys.length >= SEARCH_RESULT_CAP) return false;
    seen.add(key);
    keys.push(key);
    return true;
  };
  const nameHits = searchFileNames(db, user.id, query, SEARCH_RESULT_CAP + 1);
  const nameCapped = nameHits.length > SEARCH_RESULT_CAP;
  for (const hit of nameCapped
    ? nameHits.slice(0, SEARCH_RESULT_CAP)
    : nameHits) {
    push(hit.key);
  }
  if (!nameCapped && query.length >= 3) {
    const contentHits = searchContent(
      db,
      user.id,
      query,
      SEARCH_RESULT_CAP + 1,
    );
    for (const hit of contentHits) {
      // A file matching both name and content already ranked in the
      // name group: drop the duplicate and keep scanning, exactly as
      // the route does; only the cap ends the loop.
      if (seen.has(hit.key)) continue;
      if (!push(hit.key)) break;
    }
  }
  return keys.map((key) => key.slice(OWNER_PREFIX.length));
}

/** Run one full evaluation: fresh in-memory database, corpus, metrics. */
export async function runSearchEval(): Promise<EvalReport> {
  const db = openDatabase(":memory:");
  try {
    const migrationsDir = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    migrateFromDir(db, migrationsDir);
    const user = await seed(db);
    const perQuery = GOLD.map(({ query, grades }) => {
      const ranked = routeSearch(db, user, query);
      const gains = ranked.map((path) => grades[path] ?? 0);
      const judged = Object.values(grades).filter((g) => g > 0);
      const firstRelevant = gains.findIndex((g) => g > 0);
      const metrics: QueryMetrics = {
        query,
        pAt5: gains.slice(0, 5).filter((g) => g > 0).length / 5,
        ndcgAt10:
          dcgAt10(gains) / dcgAt10(Object.values(grades).sort((a, b) => b - a)),
        mrr: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
        recallAt10:
          gains.slice(0, 10).filter((g) => g > 0).length / judged.length,
        ranked,
      };
      return metrics;
    });
    const mean = (pick: (m: QueryMetrics) => number) =>
      perQuery.reduce((sum, m) => sum + pick(m), 0) / perQuery.length;
    return {
      docs: CORPUS.length,
      queries: GOLD.length,
      perQuery,
      summary: {
        pAt5: mean((m) => m.pAt5),
        ndcgAt10: mean((m) => m.ndcgAt10),
        mrr: mean((m) => m.mrr),
        recallAt10: mean((m) => m.recallAt10),
      },
    };
  } finally {
    db.close();
  }
}
