/**
 * Unit tests for the plan4 (loader-remediation hint) and plan5
 * (loader-proliferation budget) helper functions. The full levers are
 * exercised end-to-end by the KramaBench runs; these lock in the pure logic.
 */
import { describe, expect, test } from "bun:test";
import { formatLoaderHint } from "./util/context-utils";
import { extractLoaderSourcePath } from "./tools/code-op-tools";
import { formatValueFormatHints, formatLineage } from "./tools/result-formatting";

describe("formatValueFormatHints (value-format flags)", () => {
  // The backend (data_processor._detect_numeric_format) does detection over the
  // whole column and ships a `format=<tag>` field on columnStats; this renders.
  const mk = (columnStats: Record<string, string>) => ({ columnStats } as any);
  test("thousands tag → coerce-dataloss warning", () => {
    const h = formatValueFormatHints(mk({ n: "(str): null=0, distinct=3, format=thousands" }));
    expect(h).toBeDefined();
    expect(h!).toContain("thousands-separated");
    expect(h!.toLowerCase()).toContain("coerce");
  });
  test("currency tag flagged", () => {
    const h = formatValueFormatHints(mk({ amt: "(str): null=0, distinct=3, format=currency" }));
    expect(h).toBeDefined();
    expect(h!).toContain("currency");
  });
  test("accounting tag → minus-sign guidance", () => {
    const h = formatValueFormatHints(mk({ pnl: "(str): null=0, distinct=4, format=accounting" }));
    expect(h).toBeDefined();
    expect(h!.toLowerCase()).toContain("minus");
  });
  test("multi-word tag (numeric-as-text) parses fully", () => {
    const h = formatValueFormatHints(mk({ v: "(str): null=0, format=numeric-as-text" }));
    expect(h).toBeDefined();
    expect(h!.toLowerCase()).toContain("text");
  });
  test("untagged columns NOT flagged", () => {
    expect(formatValueFormatHints(mk({ city: '(str): null=0, distinct=2, top_5={"East"=1, "West"=1}' }))).toBeUndefined();
    expect(formatValueFormatHints(mk({ x: "(numeric): null=0, mean=1.5, min=1, max=2" }))).toBeUndefined();
    expect(formatValueFormatHints(mk({}))).toBeUndefined();
  });
});

describe("formatLineage (lever 1: cardinality ALARM, alarm-only emission)", () => {
  const mk = (out: number, inRows: number[]) =>
    ({ totalRowCount: out, inputPortShapes: inRows.map((rows, portIndex) => ({ portIndex, rows, columns: 3 })) } as any);
  test("normal shrink → NO line (alarm-only)", () => {
    expect(formatLineage(mk(200, [1000]))).toBeUndefined();
  });
  test("empty output → EMPTY alarm", () => {
    const h = formatLineage(mk(0, [1000]));
    expect(h!).toContain("EMPTY output");
    expect(h!).toContain("⚠");
  });
  test("fan-out explosion → EXPLODED alarm", () => {
    const h = formatLineage(mk(5000, [100]));
    expect(h!).toContain("EXPLODED");
    expect(h!).toContain("⚠");
  });
  test("2x concat does NOT alarm", () => {
    expect(formatLineage(mk(2000, [1000, 1000]))).toBeUndefined();
  });
  test("source: empty load alarms, non-empty load is silent", () => {
    expect(formatLineage(mk(500, []))).toBeUndefined();
    expect(formatLineage(mk(0, []))!).toContain("⚠");
  });
  test("aggregation to 1 row does NOT alarm (legit shrink)", () => {
    expect(formatLineage(mk(1, [50000]))).toBeUndefined();
  });
  test("no output count → undefined", () => {
    expect(formatLineage({ inputPortShapes: [{ portIndex: 0, rows: 5, columns: 2 }] } as any)).toBeUndefined();
  });
});

describe("formatLoaderHint (plan4)", () => {
  test("UnicodeDecodeError → suggests cp1252/latin-1, not utf-8 retry", () => {
    const h = formatLoaderHint(
      "UnicodeDecodeError: 'utf-8' codec can't decode byte 0x93 in position 1489: invalid start byte"
    );
    expect(h).toBeDefined();
    expect(h!).toContain("cp1252");
    expect(h!.toLowerCase()).toContain("encoding");
  });

  test("ParserError → suggests delimiter/skiprows/on_bad_lines", () => {
    const h = formatLoaderHint("pandas.errors.ParserError: Error tokenizing data. C error: Expected 3 fields");
    expect(h).toBeDefined();
    expect(h!.toLowerCase()).toMatch(/delimiter|sep|skiprows|on_bad_lines/);
  });

  test("FileNotFoundError → tells the model to use the exact provided path", () => {
    const h = formatLoaderHint("FileNotFoundError: [Errno 2] No such file or directory: 'data/wrong.csv'");
    expect(h).toBeDefined();
    expect(h!.toUpperCase()).toContain("EXACT");
  });

  test("ValueError conversion → suggests dtype=str / to_numeric coerce", () => {
    const h = formatLoaderHint("ValueError: could not convert string to float: '1,234'");
    expect(h).toBeDefined();
    expect(h!).toMatch(/to_numeric|dtype/);
  });

  test("non-load error classes return undefined (no hint)", () => {
    expect(formatLoaderHint("KeyError: 'Case_excluded'")).toBeUndefined();
    expect(formatLoaderHint("TypeError: unsupported operand type(s)")).toBeUndefined();
    expect(formatLoaderHint("ValueError: math domain error")).toBeUndefined(); // ValueError w/o conversion phrase
  });
});

describe("extractLoaderSourcePath (plan5)", () => {
  test("plain read_csv literal", () => {
    expect(extractLoaderSourcePath("def load():\n    return pd.read_csv('/data/customers.csv')")).toBe(
      "/data/customers.csv"
    );
  });

  test("os.path.join keys on the path-like component (bare dir name dropped)", () => {
    // 'data' is not path-like (no separator/extension) so it's dropped; the key
    // is the filename. Conservative: keys on identifiable path literals only,
    // so the budget under-detects rather than false-rejecting distinct files.
    expect(extractLoaderSourcePath("pd.read_csv(os.path.join('data', 'y.csv'))")).toBe("y.csv");
  });

  test("encoding/sep kwargs are filtered out of the key (same file → same key)", () => {
    const a = extractLoaderSourcePath("pd.read_csv('/d/x.csv', encoding='cp1252')");
    const b = extractLoaderSourcePath('pd.read_csv("/d/x.csv", sep=";", encoding="latin-1")');
    expect(a).toBe("/d/x.csv");
    expect(b).toBe("/d/x.csv"); // kwargs 'cp1252'/'latin-1'/';' are not path-like → dropped
    expect(a).toBe(b); // two loaders of the same file collapse to one budget key
  });

  test("read_excel / open / read_parquet recognised", () => {
    expect(extractLoaderSourcePath("pd.read_excel('book.xlsx')")).toBe("book.xlsx");
    expect(extractLoaderSourcePath("open('/tmp/a.dat')")).toBe("/tmp/a.dat");
    expect(extractLoaderSourcePath("pd.read_parquet('/p/t.parquet')")).toBe("/p/t.parquet");
  });

  test("dynamic path (no literal) → undefined (budget does not apply)", () => {
    expect(extractLoaderSourcePath("def load():\n    return pd.read_csv(path_var)")).toBeUndefined();
    expect(extractLoaderSourcePath("def process(df):\n    return df[df.x > 1]")).toBeUndefined();
  });
});
