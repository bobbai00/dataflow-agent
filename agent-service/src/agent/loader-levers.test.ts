/**
 * Unit tests for the plan4 (loader-remediation hint) and plan5
 * (loader-proliferation budget) helper functions. The full levers are
 * exercised end-to-end by the KramaBench runs; these lock in the pure logic.
 */
import { describe, expect, test } from "bun:test";
import { formatLoaderHint } from "./util/context-utils";
import { extractLoaderSourcePath } from "./tools/code-op-tools";

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
