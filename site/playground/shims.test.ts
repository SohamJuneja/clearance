/**
 * The browser build swaps node:path and node:crypto for site/playground/shims. A wrong answer there would change a
 * decision or a call_hash without a word, so each function is held to Node's own on a few thousand inputs.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash as shimHash } from "./shims/crypto.ts";
import { posix as shim } from "./shims/path.ts";

/** Every short path over the pieces that make paths hard, and some long ones from a fixed seed. */
function paths(): string[] {
  const pieces = ["", "/", "//", ".", "..", "a", "b", "...", ".env", "~", "a b", "$x"];
  const out = new Set<string>();
  for (const one of pieces) for (const two of pieces) for (const three of pieces) out.add(`${one}/${two}/${three}`).add(`${one}${two}/${three}`).add(`${one}${two}${three}`);
  let seed = 7;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  for (let i = 0; i < 1500; i += 1) {
    const length = next() % 9;
    out.add(Array.from({ length }, () => pieces[next() % pieces.length]).join(next() % 3 === 0 ? "" : "/"));
  }
  return [...out];
}

const ALL = paths();

describe("the path shim", () => {
  it(`gives Node's answers for normalize, dirname and isAbsolute (${ALL.length} paths)`, () => {
    for (const path of ALL) {
      expect(shim.normalize(path), path).toBe(posix.normalize(path));
      expect(shim.dirname(path), path).toBe(posix.dirname(path));
      expect(shim.isAbsolute(path), path).toBe(posix.isAbsolute(path));
    }
  });

  it("gives Node's answers for join, resolve and relative, from an absolute directory or none", () => {
    const bases = ["/agents/refunds-agent", "/", "/a/b/", "//x", "/a/../b"];
    for (const path of ALL) {
      expect(shim.join("x", path), path).toBe(posix.join("x", path));
      expect(shim.join(path, "y", path), path).toBe(posix.join(path, "y", path));
      for (const base of bases) {
        expect(shim.resolve(base, path), `${base} + ${path}`).toBe(posix.resolve(base, path));
        expect(shim.relative(base, shim.resolve(base, path)), `${base} -> ${path}`).toBe(posix.relative(base, posix.resolve(base, path)));
        expect(shim.relative(shim.resolve(base, path), base), `${path} -> ${base}`).toBe(posix.relative(posix.resolve(base, path), base));
      }
      // Under Node the shim starts a relative resolve where Node does; in a browser, at the root.
      expect(shim.resolve(path), path).toBe(posix.resolve(path));
    }
    expect(shim.join()).toBe(posix.join());
  });
});

describe("the hash shim", () => {
  it("gives Node's SHA-256 across block boundaries, in UTF-8, and over several updates", () => {
    const samples = ["", "abc", "₹4,000 to meera.k@okaxis", "\u0000￿😀", "x".repeat(1000)];
    for (let length = 0; length < 200; length += 1) samples.push("a".repeat(length), "₹".repeat(length));
    for (const text of samples) {
      expect(shimHash("sha256").update(text).digest("hex"), text.slice(0, 20)).toBe(createHash("sha256").update(text).digest("hex"));
    }
    expect(shimHash("sha256").update("ab").update("c").digest("hex")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("refuses what it doesn't do, rather than answer wrongly", () => {
    expect(() => shimHash("md5")).toThrow(/only has sha256/);
    expect(() => shimHash("sha256").update("x").digest("base64" as "hex")).toThrow(/only digests to hex/);
  });
});
