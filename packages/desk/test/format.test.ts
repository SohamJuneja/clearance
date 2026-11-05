import { describe, expect, it } from "vitest";
import { formatClock, formatCount, formatDuration, formatLatency, formatUntil, shortHash, stateName, summariseEntry } from "../src/web/format";

describe("durations", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [45_000, "45s"],
    [60_000, "1m 00s"],
    [134_000, "2m 14s"],
    [3_600_000, "1h 00m"],
    [3_900_000, "1h 05m"],
    [172_800_000, "2d"],
    [-5_000, "0s"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("says when something is overdue rather than showing a negative", () => {
    expect(formatUntil("2026-11-06T10:00:00.000Z", Date.parse("2026-11-06T10:00:01.000Z"))).toBe("overdue");
    expect(formatUntil("2026-11-06T10:00:30.000Z", Date.parse("2026-11-06T10:00:00.000Z"))).toBe("in 30s");
  });

  it("gives no latency as a dash", () => {
    expect(formatLatency(null)).toBe("–");
    expect(formatLatency(48_000)).toBe("48s");
  });
});

describe("spelling", () => {
  it("shows the team's clock, whichever machine shows the page", () => {
    expect(formatClock(Date.parse("2026-11-06T10:12:03.000Z"))).toBe("15:42:03 IST");
  });

  it("groups digits the Indian way, like the cards", () => {
    expect(formatCount(125000)).toBe("1,25,000");
  });

  it("shortens hashes", () => {
    expect(shortHash("3fa9c1d2e4b7")).toBe("3fa9c1d2");
  });

  it("names request states in plain words", () => {
    expect(stateName("ROUTED")).toBe("With approver");
    expect(stateName("HELD")).toBe("Held");
    expect(stateName("BREAK_GLASS")).toBe("Break glass");
  });
});

describe("ledger summaries read core's real payloads", () => {
  it.each([
    ["held", { agent: "refunds-agent", class: "refund", tier: "high" }, "refunds-agent · refund · high"],
    ["routed", { chosen: ["sam", "neha"] }, "To sam, neha"],
    ["routed", { chosen: [] }, "To nobody yet"],
    ["answered", { user_id: "sam", decision: "deny", latency_ms: 62_000 }, "sam: deny in 1m 02s"],
    ["ineligible_answer", { user_id: "priya", reasons: ["requester", "agent_owner"] }, "priya's answer refused: requester, agent owner"],
    ["approved", { approved_by: ["sam"] }, "By sam"],
    ["denied", { denied_by: "sam" }, "By sam"],
    ["denied", { reason: "DENIED by policy" }, "DENIED by policy"],
    ["escalated", { kind: "add", added: "neha" }, "Backup added: neha"],
    ["escalated", { kind: "add", added: null }, "Backup added: nobody available"],
    ["escalated", { kind: "post", room: "#approvals" }, "Posted to #approvals"],
    ["escalated", { kind: "notify", notified: ["priya"] }, "Requester told"],
    ["executed", { ok: true }, "Ran"],
    ["executed", { ok: false, error: "gate down" }, "Failed: gate down"],
    ["expired", { after_ms: 1 }, "Nothing was executed"],
    ["policy_loaded", { hash: "abc123def456" }, "Version abc123de"],
    ["something_new", { x: 1 }, ""],
  ] as const)("%s %j", (type, payload, text) => {
    expect(summariseEntry(type, payload as Record<string, unknown>)).toBe(text);
  });

  it("names people, because product copy does, and falls back to the id for someone unknown", () => {
    const names = { sam: "Sam", neha: "Neha", priya: "Priya" };
    expect(summariseEntry("routed", { chosen: ["sam", "ghost"] }, names)).toBe("To Sam, ghost");
    expect(summariseEntry("answered", { user_id: "sam", decision: "approve" }, names)).toBe("Sam: approve");
    expect(summariseEntry("ineligible_answer", { user_id: "priya", reasons: ["requester"] }, names)).toBe("Priya's answer refused: requester");
    expect(summariseEntry("approved", { approved_by: ["sam", "neha"] }, names)).toBe("By Sam, Neha");
    expect(summariseEntry("denied", { denied_by: "sam" }, names)).toBe("By Sam");
    expect(summariseEntry("escalated", { kind: "add", added: "neha" }, names)).toBe("Backup added: Neha");
  });
});
