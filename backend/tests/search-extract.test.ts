import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MAX_EXTRACTED_TEXT_CHARS, extractText } from "../src/search/extract";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

/** A unique phrase every valid fixture carries, for content assertions. */
const PHRASE = "quarterly budget review zephyrquill";

describe("extractText", () => {
  it("passes plain text through unchanged (T005)", async () => {
    const body = "buy milk\nalso eggs";
    expect(await extractText(Buffer.from(body), "todo.txt")).toBe(body);
  });

  it("extracts every text-like extension as UTF-8 (T005)", async () => {
    // A representative slice of the documented list (see extract.ts); the
    // full list is enforced by the extension table itself.
    const body = "the quick brown fox";
    for (const name of ["a.md", "b.csv", "c.json", "d.yml", "e.ts", "f.py"]) {
      expect(await extractText(Buffer.from(body), name)).toBe(body);
    }
  });

  it("decodes non-UTF-8 text lossily instead of throwing (T005)", async () => {
    const bytes = new Uint8Array([0x68, 0x69, 0xff, 0xfe]); // "hi" + invalid
    const text = await extractText(bytes, "legacy.txt");
    expect(text).not.toBeNull();
    expect(text?.startsWith("hi")).toBe(true);
  });

  it("strips NUL bytes from extracted text (T005)", async () => {
    expect(await extractText(Buffer.from("a\0b\0\0c"), "weird.txt")).toBe(
      "abc",
    );
  });

  it("truncates text to 1 MB (T005)", async () => {
    const big = "x".repeat(MAX_EXTRACTED_TEXT_CHARS + 1234);
    const text = await extractText(Buffer.from(big), "big.txt");
    expect(text).toHaveLength(MAX_EXTRACTED_TEXT_CHARS);
  });

  it("extracts text from a PDF fixture (T005)", async () => {
    const pdf = readFileSync(join(fixturesDir, "sample.pdf"));
    const text = await extractText(pdf, "sample.pdf");
    expect(text).toContain(PHRASE);
  });

  it("extracts text from a DOCX fixture (T005)", async () => {
    const docx = readFileSync(join(fixturesDir, "sample.docx"));
    const text = await extractText(docx, "sample.docx");
    expect(text).toContain(PHRASE);
  });

  it("returns null for unsupported types (T005)", async () => {
    const bytes = Buffer.from("whatever");
    for (const name of ["image.jpg", "archive.zip", "noext", "sheet.xlsx"]) {
      expect(await extractText(bytes, name)).toBeNull();
    }
  });

  it("returns null when PDF extraction fails (T005)", async () => {
    const corrupt = readFileSync(join(fixturesDir, "corrupt.pdf"));
    expect(await extractText(corrupt, "corrupt.pdf")).toBeNull();
  });

  it("returns null for an empty body rather than throwing (T005)", async () => {
    expect(await extractText(new Uint8Array(0), "empty.pdf")).toBeNull();
    expect(await extractText(new Uint8Array(0), "empty.txt")).toBe("");
  });
});
