import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BucketEventStore } from "../packages/core/src/autonomy/history.ts";
import { openDatabase } from "../packages/core/src/db/index.ts";
import { seedHistory } from "./seed-history.ts";

describe("seed-history", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clearance-seed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes labelled rows, keeps the ledger empty, and can be run twice", () => {
    const path = join(dir, "clearance.sqlite");
    const first = seedHistory(path, 1_800_000_000_000);
    const second = seedHistory(path, 1_800_000_000_000);
    expect(second).toEqual(first);
    expect(first.refunds).toBe(120);
    const db = openDatabase(path);
    try {
      expect(new BucketEventStore(db).counts()).toEqual({ synthetic: first.events, real: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ledger`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
