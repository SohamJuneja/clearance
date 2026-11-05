import { readFileSync } from "node:fs";
import type { Tier } from "@clearance/contracts";
import { describe, expect, it } from "vitest";
import { Directory } from "../src/people/directory.js";
import { parsePolicy, parseTeam } from "../src/policy/load.js";
import { assessAnswer, route, type RouteContext, type RouteSignals } from "../src/router/router.js";
import { exclusionWords, explainTrace, heldExplanation, whyCopy, whyFallback, whyYou } from "../src/router/why.js";
import { IDENTITIES, MINUTE, NOW, POLICY_PATH, TEAM_ALEX_ONLY_PATH, TEAM_PATH } from "./harness.js";

const policy = parsePolicy(readFileSync(POLICY_PATH, "utf8"), "p.yaml");
const team = parseTeam(readFileSync(TEAM_PATH, "utf8"), "t.yaml");
const directory = new Directory(team, IDENTITIES);

/** Alex is the only engineer here, so a merge or delete can run out of people. */
const alexOnlyTeam = parseTeam(readFileSync(TEAM_ALEX_ONLY_PATH, "utf8"), "team-alex-only.yaml");
const alexOnly = { team: alexOnlyTeam, directory: new Directory(alexOnlyTeam, IDENTITIES) };

function signals(overrides: Partial<RouteSignals> = {}): RouteSignals {
  return {
    openCards: () => 0,
    lastActive: () => null,
    lastActiveIn: () => null,
    away: () => null,
    ...overrides,
  };
}

function ctx(cls: string | null, overrides: Partial<RouteContext> = {}): RouteContext {
  const compiled = policy.classes.find((candidate) => candidate.name === cls) ?? null;
  const tier: Tier = overrides.tier ?? "high";
  return {
    requestId: "CLR-0042",
    policy,
    directory,
    team,
    cls: compiled,
    className: cls ?? "unknown_protected",
    tier,
    quorumRequired: 1,
    requesterIds: ["priya"],
    agentOwnerIds: ["priya"],
    authorIds: [],
    extracted: {},
    originRoom: "#support",
    nowMs: NOW,
    signals: signals(),
    counted: [],
    alreadyRouted: [],
    fallbackActive: false,
    ...overrides,
  };
}

const ids = (list: { id: string }[]) => list.map((person) => person.id);

describe("candidates and exclusions", () => {
  it("takes candidates from the policy rule, deduplicated across role and group", () => {
    const trace = route(ctx("refund"), 1);
    expect(trace.candidates.filter((c) => c.matchedBy).map((c) => c.id)).toEqual(["sam", "neha"]);
    expect(trace.candidates.find((c) => c.id === "sam")?.matchedBy).toBe("role:finance-approver");
  });

  it("shows a requester who is not a candidate as excluded, so the trace explains them", () => {
    const trace = route(ctx("refund"), 1);
    expect(trace.candidates.map((c) => c.id)).toEqual(["sam", "neha", "priya"]);
    expect(trace.excluded).toEqual([{ id: "priya", name: "Priya", reasons: ["requester", "agent_owner"] }]);
  });

  it("excludes every requester, including a chain through agents", () => {
    const trace = route(ctx("refund", { requesterIds: ["sam"], agentOwnerIds: ["priya"] }), 1);
    expect(trace.chosen).toEqual(["neha"]);
    expect(trace.excluded.find((e) => e.id === "sam")?.reasons).toEqual(["requester"]);
  });

  it("excludes the agent's owner at tier high and above", () => {
    const high = route(ctx("delete", { requesterIds: ["sam"], agentOwnerIds: ["alex"], tier: "high" }), 1);
    expect(high.excluded.find((e) => e.id === "alex")?.reasons).toEqual(["agent_owner"]);
    const critical = route(ctx("delete", { requesterIds: ["sam"], agentOwnerIds: ["alex"], tier: "critical" }), 1);
    expect(critical.excluded.find((e) => e.id === "alex")?.reasons).toEqual(["agent_owner"]);
  });

  it("lets the agent's owner approve below that tier", () => {
    const medium = route(ctx("delete", { requesterIds: ["sam"], agentOwnerIds: ["alex"], tier: "medium" }), 1);
    expect(medium.chosen).toEqual(["alex"]);
    expect(medium.excluded.find((e) => e.id === "alex")).toBeUndefined();
  });

  it("honours a class that turns the owner exclusion off, but never for the requester", () => {
    const sc6 = route(ctx("deploy", { requesterIds: ["priya"], agentOwnerIds: ["alex"], tier: "critical", extracted: { service: "checkout" } }), 1);
    expect(sc6.chosen).toEqual(["alex"]);
    const sc7 = route(ctx("deploy", { requesterIds: ["alex"], agentOwnerIds: ["alex"], tier: "critical", extracted: { service: "checkout" } }), 1);
    expect(sc7.chosen).toEqual([]);
    expect(sc7.excluded.find((e) => e.id === "alex")?.reasons).toEqual(["requester"]);
  });

  it("excludes the merge author", () => {
    const trace = route(ctx("merge", { requesterIds: ["priya"], agentOwnerIds: ["priya"], authorIds: ["alex"] }), 1);
    expect(trace.chosen).toEqual(["dev"]);
    expect(trace.excluded.find((e) => e.id === "alex")?.reasons).toEqual(["author"]);
  });

  it("excludes anyone away", () => {
    const trace = route(
      ctx("refund", { signals: signals({ away: (id) => (id === "sam" ? { untilMs: NOW + MINUTE, delegateTo: null } : null) }) }),
      1,
    );
    expect(trace.chosen).toEqual(["neha"]);
    expect(trace.excluded.find((e) => e.id === "sam")?.reasons).toEqual(["away"]);
  });

  it("brings in the delegate of someone away", () => {
    const trace = route(
      ctx("refund", {
        requesterIds: ["priya"],
        signals: signals({
          away: (id) => {
            if (id === "sam") return { untilMs: NOW + MINUTE, delegateTo: "alex" };
            if (id === "neha") return { untilMs: NOW + MINUTE, delegateTo: null };
            return null;
          },
        }),
      }),
      1,
    );
    expect(trace.chosen).toEqual(["alex"]);
    expect(trace.candidates.find((c) => c.id === "alex")?.matchedBy).toBe("delegate:sam");
  });

  it("does not let a requester approve through a delegation to themselves (case 24)", () => {
    const trace = route(
      ctx("refund", {
        requesterIds: ["alex"],
        agentOwnerIds: ["priya"],
        signals: signals({
          away: (id) => {
            if (id === "sam") return { untilMs: NOW + MINUTE, delegateTo: "alex" };
            if (id === "neha") return { untilMs: NOW + MINUTE, delegateTo: null };
            return null;
          },
        }),
      }),
      1,
    );
    expect(trace.chosen).toEqual([]);
    expect(trace.excluded.find((e) => e.id === "alex")?.reasons).toContain("requester");
  });

  it("excludes anyone already counted in this request's quorum", () => {
    const trace = route(ctx("refund", { counted: ["sam"], quorumRequired: 2 }), 1);
    expect(trace.chosen).toEqual(["neha"]);
    expect(trace.excluded.find((e) => e.id === "sam")?.reasons).toEqual(["counted"]);
  });

  it("does not exclude the requester when the policy turns that off", () => {
    const relaxed = { ...policy, defaults: { ...policy.defaults, exclude_requester: false } };
    const trace = route(ctx("refund", { policy: relaxed, requesterIds: ["sam"], agentOwnerIds: [] }), 1);
    expect(trace.chosen).toEqual(["sam"]);
  });
});

describe("ranking", () => {
  it("puts the rota holder on duty first", () => {
    const trace = route(ctx("refund"), 1);
    expect(ids(trace.ranked)).toEqual(["sam", "neha"]);
    expect(trace.ranked[0]?.rank).toBe("rota_on_duty");
    expect(trace.chosen).toEqual(["sam"]);
  });

  it("falls to the backup when the rota holder is off duty", () => {
    // The demo team keeps Sam always on duty, so the schedule is stated here to keep proving this path.
    const scheduled = {
      ...team,
      rotas: {
        "finance-approver": [
          { person: "sam", days: "Mon-Fri", hours: "09:00-19:00", tz: "Asia/Kolkata" },
          { person: "neha", backup: true },
        ],
      },
    };
    const night = Date.parse("2026-11-04T23:00:00+05:30");
    const trace = route(ctx("refund", { nowMs: night, team: scheduled }), 1);
    expect(trace.chosen).toEqual(["neha"]);
    expect(trace.ranked[0]?.backup).toBe(true);
  });

  it("orders on duty over resource owner over room activity over any activity over others", () => {
    const people = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      name: id.toUpperCase(),
      pronoun: "they" as const,
      groups: ["ops"],
      roles: id === "a" ? ["ops-oncall"] : [],
    }));
    const opsTeam = {
      people,
      rotas: { "ops-oncall": [{ person: "a" }] },
      owners: { services: { checkout: "b" } },
      agents: {},
      rooms: {},
    };
    const opsPolicy = parsePolicy(
      readFileSync(POLICY_PATH, "utf8").replace(
        "any_of: [ { owner_of: service }, { role: eng-oncall } ]",
        "any_of: [ { owner_of: service }, { role: ops-oncall }, { group: ops } ]",
      ),
      "p.yaml",
    );
    const opsDirectory = new Directory(opsTeam, { people: {}, agents: {} });
    const trace = route(
      ctx("deploy", {
        policy: opsPolicy,
        cls: opsPolicy.classes.find((cls) => cls.name === "deploy") ?? null,
        directory: opsDirectory,
        team: opsTeam,
        requesterIds: [],
        agentOwnerIds: [],
        extracted: { service: "checkout" },
        signals: signals({
          // e is the most recently active anywhere; c is active in the origin room; d only elsewhere.
          lastActiveIn: (id) => (id === "c" ? NOW - MINUTE : null),
          lastActive: (id) => {
            if (id === "c") return { room: "#support", atMs: NOW - MINUTE };
            if (id === "d") return { room: "#eng", atMs: NOW - 2 * MINUTE };
            return null;
          },
        }),
      }),
      1,
    );
    expect(ids(trace.ranked)).toEqual(["a", "b", "c", "d", "e"]);
    expect(trace.ranked.map((entry) => entry.rank)).toEqual([
      "rota_on_duty",
      "resource_owner",
      "active_in_room",
      "active_anywhere",
      "other",
    ]);
  });

  it("does not count activity older than 15 minutes", () => {
    const trace = route(
      ctx("refund", {
        // No rota, so nothing but activity can raise Sam's rank.
        team: { ...team, rotas: {} },
        nowMs: Date.parse("2026-11-04T23:00:00+05:30"),
        signals: signals({
          lastActive: () => ({ room: "#support", atMs: Date.parse("2026-11-04T22:44:00+05:30") }),
          lastActiveIn: () => Date.parse("2026-11-04T22:44:00+05:30"),
        }),
      }),
      1,
    );
    expect(trace.ranked.find((entry) => entry.id === "sam")?.rank).toBe("other");
  });

  it("breaks ties by fewest open cards", () => {
    const night = Date.parse("2026-11-04T23:00:00+05:30");
    const fairTeam = { ...team, rotas: {} };
    const trace = route(
      ctx("refund", {
        team: fairTeam,
        nowMs: night,
        signals: signals({ openCards: (id) => (id === "sam" ? 3 : 1) }),
      }),
      1,
    );
    expect(trace.chosen).toEqual(["neha"]);
    expect(trace.ranked.map((entry) => entry.openCards)).toEqual([1, 3]);
  });

  it("skips anyone at the card cap and routes to the next", () => {
    const trace = route(ctx("refund", { signals: signals({ openCards: (id) => (id === "sam" ? 6 : 0) }) }), 1);
    expect(trace.chosen).toEqual(["neha"]);
    expect(trace.capped).toEqual([{ id: "sam", name: "Sam", openCards: 6 }]);
    expect(ids(trace.ranked)).toEqual(["neha"]);
  });

  it("is deterministic: same input, same trace", () => {
    expect(route(ctx("refund"), 2)).toEqual(route(ctx("refund"), 2));
  });
});

describe("quorum", () => {
  it("picks that many distinct people", () => {
    const trace = route(ctx("refund", { quorumRequired: 2, tier: "critical" }), 2);
    expect(trace.chosen).toEqual(["sam", "neha"]);
    expect(trace.quorumRequired).toBe(2);
  });

  it("does not pick someone who already holds a card", () => {
    const trace = route(ctx("refund", { alreadyRouted: ["sam"] }), 1);
    expect(trace.chosen).toEqual(["neha"]);
  });

  it("goes to fallback for the part of a quorum it cannot fill", () => {
    const trace = route(ctx("delete", { ...alexOnly, requesterIds: ["priya"], agentOwnerIds: ["priya"], quorumRequired: 2 }), 2);
    expect(trace.chosen).toEqual(["alex"]);
    expect(trace.fallback?.group).toBe("eng-leads");
    expect(trace.fallback?.room).toBe("#approvals");
  });
});

describe("nobody eligible", () => {
  it("goes to the fallback group and says why", () => {
    const trace = route(
      ctx("refund", {
        signals: signals({ away: (id) => (id === "sam" || id === "neha" ? { untilMs: NOW + MINUTE, delegateTo: null } : null) }),
      }),
      1,
    );
    expect(trace.chosen).toEqual([]);
    expect(trace.fallback).toMatchObject({ group: "eng-leads", room: "#approvals", eligible: ["alex"] });
    expect(trace.fallback?.reason).toBe("Priya (requester, agent owner); Sam (away); Neha (away)");
  });

  it("has someone left on the real team: Alex's own force-push goes to Dev", () => {
    const trace = route(ctx("merge", { requesterIds: ["alex"], agentOwnerIds: ["alex"] }), 1);
    expect(trace.chosen).toEqual(["dev"]);
    expect(trace.fallback).toBeNull();
    expect(trace.excluded.find((e) => e.id === "alex")?.reasons).toEqual(["requester", "agent_owner"]);
  });

  it("two engineers fill a delete's quorum of two on the real team", () => {
    const trace = route(ctx("delete", { requesterIds: ["priya"], agentOwnerIds: ["priya"], quorumRequired: 2 }), 2);
    expect(trace.chosen).toEqual(["alex", "dev"]);
    expect(trace.fallback).toBeNull();
  });

  it("uses the class's own fallback when it has one", () => {
    const text = readFileSync(POLICY_PATH, "utf8").replace(
      "      label: eng\n      any_of: [ { group: eng } ]\n      exclude: [ author ]",
      '      label: eng\n      any_of: [ { group: eng } ]\n      exclude: [ author ]\n      fallback: { group: finance, room: "#eng" }',
    );
    const custom = parsePolicy(text, "p.yaml");
    const trace = route(
      ctx("merge", {
        ...alexOnly,
        policy: custom,
        cls: custom.classes.find((cls) => cls.name === "merge") ?? null,
        requesterIds: ["alex"],
        agentOwnerIds: ["alex"],
      }),
      1,
    );
    expect(trace.fallback).toMatchObject({ group: "finance", room: "#eng", eligible: ["sam", "neha"] });
  });

  it("still names a fallback room when even the fallback group has nobody, so the room hears why", () => {
    const trace = route(ctx("merge", { ...alexOnly, requesterIds: ["alex"], agentOwnerIds: ["alex"] }), 1);
    expect(trace.fallback).toMatchObject({ group: "eng-leads", eligible: [] });
  });

  it("routes a call with no class straight to the fallback group", () => {
    const trace = route(ctx(null, { requesterIds: ["priya"], agentOwnerIds: ["priya"] }), 1);
    expect(trace.chosen).toEqual([]);
    expect(trace.fallback).toMatchObject({ group: "eng-leads", eligible: ["alex"] });
  });
});

describe("assessAnswer: the same rules, re-checked on every answer", () => {
  it("accepts someone the rule names", () => {
    expect(assessAnswer(ctx("refund"), "sam")).toEqual({ eligible: true, reasons: [] });
  });

  it("refuses the requester who is also the owner, with both reasons", () => {
    expect(assessAnswer(ctx("refund"), "priya")).toEqual({ eligible: false, reasons: ["requester", "agent_owner"] });
  });

  it("refuses someone outside the rule (case 3)", () => {
    expect(assessAnswer(ctx("refund"), "alex")).toEqual({ eligible: false, reasons: ["not_approver"] });
  });

  it("refuses a person who went away after the card was opened", () => {
    const later = ctx("refund", { signals: signals({ away: (id) => (id === "sam" ? { untilMs: NOW + MINUTE, delegateTo: null } : null) }) });
    expect(assessAnswer(later, "sam")).toEqual({ eligible: false, reasons: ["away"] });
  });

  it("refuses a second approval by someone already counted", () => {
    expect(assessAnswer(ctx("refund", { counted: ["sam"], quorumRequired: 2 }), "sam")).toEqual({
      eligible: false,
      reasons: ["counted"],
    });
  });

  it("accepts the fallback group only once fallback is active", () => {
    expect(assessAnswer(ctx("refund", { fallbackActive: false }), "alex").eligible).toBe(false);
    expect(assessAnswer(ctx("refund", { fallbackActive: true }), "alex").eligible).toBe(true);
    expect(assessAnswer(ctx("refund", { fallbackActive: true, requesterIds: ["alex"] }), "alex").eligible).toBe(false);
  });

  it("accepts a delegate of someone away, and nobody else outside the rule", () => {
    const delegated = ctx("refund", {
      signals: signals({ away: (id) => (id === "sam" ? { untilMs: NOW + MINUTE, delegateTo: "alex" } : null) }),
    });
    expect(assessAnswer(delegated, "alex").eligible).toBe(true);
  });
});

describe("why text comes from the trace", () => {
  const appendixContext = {
    handle: "A12",
    tier: "high" as Tier,
    className: "refund",
    fired: [{ source: "amount > 10000", points: 35, certain: true }],
    extracted: { amount: 40000 },
    currency: "INR",
    tz: "Asia/Kolkata",
    escalation: [
      { kind: "person" as const, name: "Neha", atMs: Date.parse("2026-11-04T15:20:00+05:30") },
      { kind: "room" as const, name: "#approvals", atMs: Date.parse("2026-11-04T15:25:00+05:30") },
    ],
    expiresAtMs: Date.parse("2026-11-04T15:42:00+05:30"),
  };
  const at = Date.parse("2026-11-04T15:17:00+05:30");

  function appendixTrace() {
    return route(
      ctx("refund", {
        nowMs: at,
        signals: signals({
          lastActive: (id) => (id === "sam" ? { room: "#finance", atMs: at - 3 * MINUTE } : null),
        }),
      }),
      1,
    );
  }

  it("renders the Appendix D why-me trace word for word", () => {
    expect(explainTrace(appendixTrace(), appendixContext)).toBe(
      "A12 → rule refund (₹40,000 > ₹10,000 → HIGH). Candidates: Sam, Neha, Priya. Excluded: Priya (requester; agent owner). Ranked: Sam (finance rota on duty, active in #finance 3 min ago, 0 open cards), Neha (backup). Escalates to Neha at 15:20, #approvals at 15:25, expires 15:42.",
    );
  });

  it("explains the rule by tier alone when no rule gives a clean comparison", () => {
    const text = explainTrace(appendixTrace(), { ...appendixContext, fired: [] });
    expect(text).toContain("rule refund (HIGH)");
  });

  it("names who has it when asked by CLR id, and says when there is no backup", () => {
    const text = explainTrace(route(ctx("merge", { requesterIds: ["priya"], agentOwnerIds: ["priya"] }), 1), {
      ...appendixContext,
      handle: "CLR-0042",
      className: "merge",
      escalation: [],
    });
    expect(text.startsWith("CLR-0042 → rule merge")).toBe(true);
    expect(text).toContain("expires 15:42.");
  });

  it("explains a fallback in the trace", () => {
    const text = explainTrace(route(ctx("merge", { ...alexOnly, requesterIds: ["alex"], agentOwnerIds: ["alex"] }), 1), {
      ...appendixContext,
      className: "merge",
    });
    expect(text).toContain("Nobody eligible: Alex (requester, agent owner).");
    expect(text).toContain("Fallback: eng-leads in #approvals.");
  });

  it("gives the requester the plain-language line", () => {
    expect(heldExplanation(appendixTrace(), "refunds over ₹10,000 need finance approval", "priya")).toBe(
      "Held because refunds over ₹10,000 need finance approval. Sam (finance, on duty) has it. You can't approve your own request.",
    );
  });

  it("does not tell a bystander they can't approve their own request", () => {
    expect(heldExplanation(appendixTrace(), "refunds over ₹10,000 need finance approval", "alex")).toBe(
      "Held because refunds over ₹10,000 need finance approval. Sam (finance, on duty) has it.",
    );
  });

  it("writes the card's Why you line", () => {
    expect(whyYou(appendixTrace(), "sam")).toBe("finance approver on duty. Can't approve: Priya (requester, agent owner).");
    expect(whyYou(route(ctx("refund", { requesterIds: ["alex"], agentOwnerIds: ["priya"] }), 2), "neha")).toBe(
      "backup finance approver. Can't approve: Alex (requester), Priya (agent owner).",
    );
  });

  it("agrees the verb on the room's copy when two people decide", () => {
    expect(whyCopy(route(ctx("refund", { quorumRequired: 2, tier: "critical" }), 2))).toBe(
      "copy for this room; Sam (finance, on duty) and Neha (finance, backup) decide. Can't approve: Priya (requester, agent owner).",
    );
    expect(whyCopy(route(ctx("refund"), 1))).toBe(
      "copy for this room; Sam (finance, on duty) decides. Can't approve: Priya (requester, agent owner).",
    );
  });

  it("drops the second sentence when nobody was excluded", () => {
    expect(whyYou(route(ctx("refund", { requesterIds: [], agentOwnerIds: [] }), 1), "sam")).toBe("finance approver on duty.");
  });

  it("lists everyone the trace excluded, for whatever reason", () => {
    const away = signals({ away: (id) => (id === "neha" ? { untilMs: NOW + MINUTE, delegateTo: null } : null) });
    expect(whyYou(route(ctx("refund", { signals: away }), 1), "sam")).toBe(
      "finance approver on duty. Can't approve: Neha (away), Priya (requester, agent owner).",
    );
  });

  it("writes the fallback room's Why here line", () => {
    const trace = route(ctx("merge", { ...alexOnly, requesterIds: ["priya"], agentOwnerIds: ["alex"] }), 1);
    expect(whyFallback(trace)).toBe(
      "nobody else could take it, so it came to eng-leads. Can't approve: Alex (agent owner), Priya (requester).",
    );
  });

  it.each([
    [["requester", "agent_owner"], "requester, agent owner"],
    [["requester"], "requester"],
    [["agent_owner"], "agent owner"],
    [["author"], "code author"],
    [["away"], "away"],
    [["counted"], "already counted"],
    [["not_approver"], "not a finance approver"],
  ] as const)("words the exclusion %j", (reasons, text) => {
    expect(exclusionWords(reasons, "finance")).toBe(text);
  });

  it("picks the article by the label", () => {
    expect(exclusionWords(["not_approver"], "eng")).toBe("not an eng approver");
  });
});
