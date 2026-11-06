/**
 * What fixing the fourth review turned up next to each finding: the same kind of break by another way in, and what the fixes
 * must not take away. The review's own tests stay in fourth-review.test.ts. What the shell reader must hold and leave quiet is
 * in policy/tests/fourth-review-shell.yaml.
 */
import { codexToActions, patchPaths } from "@clearance/adapters";
import type { Action } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCard, type CardView } from "../src/cards/render.js";
import { clipKeepingBothEnds } from "../src/format.js";
import { Directory } from "../src/people/directory.js";
import { cannotCompleteText } from "../src/router/why.js";
import type { RouteTrace } from "../src/router/router.js";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, hookShell, IDENTITIES, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC4, WORLD, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
  h.lookup.world = structuredClone(WORLD);
});
afterEach(() => {
  try {
    h.core.close();
  } catch {
    // A test that restarted closed it already.
  }
});

const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@oksbi" };
const CODER_CWD = "/home/x/.switch/agents/m/coder";

const says = (who: string, body: string, roomId = "#support", overrides: Parameters<typeof chatMessage>[2] = {}) =>
  h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true, ...overrides }));
const state = (id: string | undefined) => h.core.stores.requests.get(id as string)?.state;
const flagCodes = (id: string | undefined) => (h.core.stores.requests.get(id as string)?.flags ?? []).map((flag) => flag.code);
const atL = (level: "L1" | "L2" | "L3", agent = "refunds-agent") => h.core.stores.autonomy.setLevel(agent, "refund", "small", level, NOW);
const cardIn = (room: string): OpenedCard => h.chat.cards.filter((card) => card.roomId === room).at(-1) as OpenedCard;
const said = () => h.chat.messages.at(-1)?.body ?? "";
const told = () => h.chat.messages.map((message) => message.body).join("\n");

function perRoomHandles(): void {
  const perRoom = new Map<string, number>();
  const open = h.chat.openCard.bind(h.chat);
  h.chat.openCard = async (input) => {
    const result = await open(input);
    const number = (perRoom.get(input.roomId) ?? 0) + 1;
    perRoom.set(input.roomId, number);
    return { ...result, handle: `A${number}` };
  };
}

describe("F1: the check and what it counts on are one step", () => {
  beforeEach(async () => {
    atL("L3");
    await says(PARTICIPANTS.priya, "@refunds-agent please sort out Meera's refunds");
  });

  it("the same action delivered twice at once is one call, and one request", async () => {
    const action = gateRefund(SMALL);
    const [first, second] = await Promise.all([h.core.check(action), h.core.check(action)]);
    expect(first?.request_id).toBe(second?.request_id);
    expect(h.core.stores.requests.listInState(["AUTO"])).toHaveLength(1);
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_8812", 0)).toBe(2000);
  });

  it("an identical call a person is deciding doesn't also run alone, whatever the level has become", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L0", NOW);
    const held = await h.core.check(gateRefund(SMALL));
    expect(held.decision).toBe("hold");
    atL("L3");
    const again = await h.core.check(gateRefund(SMALL));
    expect(again).toMatchObject({ decision: "hold", request_id: held.request_id });
  });

  it("a person is told about calls made at the same moment, as they would be about calls made one after another", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L0", NOW);
    const eight = (order: string) => gateRefund({ ...SMALL, amount: 8000, order_id: order });
    const answers = await Promise.all([h.core.check(eight("A-1931")), h.core.check(eight("A-1941"))]);
    expect(answers.flatMap((answer) => flagCodes(answer.request_id))).toContain("aggregate_limit");
  });

  it("a demotion that lands while a call waits on a lookup holds it", async () => {
    let answer: () => void = () => undefined;
    const waiting = new Promise<void>((done) => (answer = done));
    const lookup = h.lookup.lookup.bind(h.lookup);
    h.lookup.lookup = async (kind, id) => {
      const found = await lookup(kind, id);
      if (kind === "destinations") await waiting;
      return found;
    };
    const call = h.core.check(gateRefund(SMALL));
    await new Promise((done) => setImmediate(done));
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L0", NOW);
    answer();
    expect((await call).decision).toBe("hold");
  });

  it("a lookup that hangs holds up its own call and nobody else's", async () => {
    const lookup = h.lookup.lookup.bind(h.lookup);
    h.lookup.lookup = (kind, id) => (id === "A-2004" ? new Promise(() => undefined) : lookup(kind, id));
    void h.core.check(gateRefund(REFUND_SC4));
    expect((await h.core.check(gateRefund(SMALL))).decision).toBe("allow");
  });

  it("calls at once that don't get in each other's way all run, so this isn't a blanket hold", async () => {
    const answers = await Promise.all([h.core.check(gateRefund(SMALL)), h.core.check(gateRefund({ ...SMALL, order_id: "A-1941" }))]);
    expect(answers.map((answer) => answer.decision)).toEqual(["allow", "allow"]);
  });
});

describe("F2: a handle means the card in the room it was used in", () => {
  async function bothRooms(): Promise<{ here: string; there: string }> {
    perRoomHandles();
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    const here = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await says(PARTICIPANTS.priya, "@refunds-agent refund it", "#finance");
    const there = (await h.core.check(gateRefund({ ...REFUND_SC4, amount: 30000 }, { session: { switchRoomId: "#finance" } }))).request_id as string;
    return { here, there };
  }

  it("an incident lands on this room's card, not the other room's", async () => {
    const { here, there } = await bothRooms();
    await says(PARTICIPANTS.sam, "@clearance incident A1 looks wrong");
    expect(h.core.stores.incidents.all().map((row) => row.request_id)).toEqual([here]);
    expect(h.core.stores.incidents.all().map((row) => row.request_id)).not.toContain(there);
  });

  it("in a room with no card of that name, nothing happens to anything", async () => {
    await bothRooms();
    await says(PARTICIPANTS.alex, "@clearance breakglass A1 it cannot wait", "#eng");
    expect(said()).toBe("I can't find A1.");
    await says(PARTICIPANTS.sam, "@clearance incident A1 looks wrong", "#eng");
    expect(said()).toBe("I can't find A1.");
    await says(PARTICIPANTS.sam, "@clearance counter A1 100", "#eng");
    expect(said()).toBe("I can't find A1.");
    await says(PARTICIPANTS.sam, "@clearance resolve A1 ran checked", "#eng");
    expect(said()).toBe("I can't find A1.");
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.incidents.all()).toEqual([]);
  });

  it("a question from another room is answered only if the handle can mean one request", async () => {
    const { there } = await bothRooms();
    await says(PARTICIPANTS.alex, "@clearance why A1", "#eng");
    expect(said()).toBe("I can't find A1.");
    await says(PARTICIPANTS.alex, "@clearance status A2", "#eng");
    expect(said()).toContain(there);
  });

  it("a CLR id means the same anywhere", async () => {
    const { there } = await bothRooms();
    await says(PARTICIPANTS.alex, `@clearance breakglass ${there} it cannot wait`, "#eng");
    expect(state(there)).toBe("EXECUTED");
  });
});

describe("F3: Clearance's name doesn't hide anyone", () => {
  const scene = async (words: string) => {
    h.chat.roomAliases = async () => ({});
    await says(PARTICIPANTS.refundsAgent, "Morning all.", "#finance");
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.sam, words, "#finance", { addressed: words.startsWith("@clearance") });
    return h.core.stores.requests.require((await h.core.check(gateRefund(REFUND_SC4))).request_id as string);
  };
  const evidence = (request: { evidence: unknown }) => (request.evidence as { askedElsewhereIds?: string[] }).askedElsewhereIds ?? [];

  it("a real command is still only a command", async () => {
    expect(evidence(await scene("@clearance why CLR-0001"))).toEqual([]);
  });

  it("a command that names someone else's way in isn't only a command", async () => {
    expect(evidence(await scene("@clearance status CLR-0001 @refund-desk refund A-2004 please"))).toContain("sam");
  });

  it("a command with a teammate in it is still only a command", async () => {
    expect(evidence(await scene("@clearance away until 18:00 delegate @neha"))).toEqual([]);
  });

  it("words after Clearance's name that aren't a command are someone speaking", async () => {
    expect(evidence(await scene("@clearance refund order A-2004 in full"))).toContain("sam");
  });
});

describe("F4: running alone answers to who asked, as a card does", () => {
  beforeEach(() => atL("L3"));

  it("at L2 too", async () => {
    atL("L2");
    await says(PARTICIPANTS.guest, "@refunds-agent refund order A-1931");
    const answer = await h.core.check(gateRefund(SMALL));
    expect(answer.decision).toBe("hold");
    expect(h.chat.cards.some((card) => card.title.includes("REVIEW"))).toBe(false);
  });

  it("an agent working somewhere Clearance can't see doesn't run alone", async () => {
    h.chat.unseenRoomCount = async () => 1;
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const answer = await h.core.check(gateRefund(SMALL));
    expect(answer.decision).toBe("hold");
    expect(flagCodes(answer.request_id)).toContain("agent_elsewhere");
  });

  it("nor when Switch can't say where it's working", async () => {
    h.chat.unseenRoomCount = () => Promise.reject(new Error("down"));
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const answer = await h.core.check(gateRefund(SMALL));
    expect(answer.decision).toBe("hold");
    expect(flagCodes(answer.request_id)).toContain("agent_reach_unknown");
  });

  it("nor when someone addressed what could be its alias", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.sam, "@refunds refund it", "#random", { addressed: false });
    const answer = await h.core.check(gateRefund(SMALL));
    expect(answer.decision).toBe("hold");
    expect(flagCodes(answer.request_id)).toContain("possible_alias");
  });

  it("what it holds takes the same two people the same call would at L0", async () => {
    const answer = await h.core.check(gateRefund(SMALL));
    expect(h.core.stores.requests.get(answer.request_id as string)?.quorumRequired).toBe(2);
    expect(h.core.stores.requests.get(answer.request_id as string)?.state).toBe("ROUTED");
  });

  it("isn't a demotion: the bucket keeps its level, and the next call with someone on record runs", async () => {
    await h.core.check(gateRefund(SMALL));
    expect(h.core.stores.autonomy.levelFor("refunds-agent", "refund", "small")).toBe("L3");
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    expect((await h.core.check(gateRefund({ ...SMALL, amount: 2100 }))).decision).toBe("allow");
  });
});

describe("F5: break-glass keeps the separations of duty", () => {
  const coderPush = (session?: Action["session"]) => h.core.check(hookShell("git push --force origin main", { ...(session ? { session } : {}) }));

  it("the owner of an agent can't break glass on what it does, at a tier where they couldn't approve it", async () => {
    await says(PARTICIPANTS.dev, "@coder force push it", "#eng");
    const id = (await coderPush({ switchRoomId: "#eng" })).request_id as string;
    await says(PARTICIPANTS.alex, `@clearance breakglass ${id} prod is down`, "#eng");
    expect(state(id)).toBe("ROUTED");
    expect(said()).toContain("agent owner");
    const refused = h.core.stores.ledger.list({ requestId: id }).filter((row) => row.type === "ineligible_answer").at(-1);
    expect(refused?.payload).toMatchObject({ reasons: ["agent_owner"], break_glass: true });
  });

  it("where the policy lets an owner decide, they can break glass too", async () => {
    await says(PARTICIPANTS.priya, "@ops-agent look at checkout", "#eng");
    const held = await h.core.check({ id: actionId(), at: new Date(NOW).toISOString(), source: "gate", vendor: "gate", agent: { name: "ops-agent" }, kind: "business", raw: {}, business: { endpoint: "POST /acme/deploys", args: { service: "checkout", env: "prod", version: "v2.13.2" } } });
    await says(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} checkout is down`, "#eng");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("the requester's words stay what they were", async () => {
    await says(PARTICIPANTS.alex, "@refunds-agent refund it");
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await says(PARTICIPANTS.alex, `@clearance breakglass ${id} it cannot wait`);
    expect(said()).toBe(`Alex asked for ${id}, so can't break glass on it.`);
  });
});

describe("F6: what a chain passes on stays what it was", () => {
  it("someone only guessed at through a chain doesn't get to move the decision", async () => {
    await says(PARTICIPANTS.sam, "@support-agent please get order A-2004 refunded");
    await says(PARTICIPANTS.neha, "@support-agent and the other one");
    h.clock.advance(11 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.supportAgent, "@refunds-agent refund order A-2004 for Rohan");
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(flagCodes(id)).toContain("may_have_asked");
    expect(h.core.stores.requests.get(id)?.quorumRequired).toBe(2);
    expect(cardIn("dm-sam")).toBeDefined();
  });

  it("nor does someone who only spoke where the first agent was", async () => {
    await says(PARTICIPANTS.supportAgent, "Morning all.", "#finance");
    await says(PARTICIPANTS.sam, "anyone free for the month-end check?", "#finance");
    await says(PARTICIPANTS.neha, "after lunch", "#finance");
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.supportAgent, "@refunds-agent refund order A-2004 for Rohan", "#finance");
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(flagCodes(id)).toContain("may_have_asked");
    expect(cardIn("dm-sam")).toBeDefined();
  });

  it("someone who named the first agent in the window stays on record as having asked", async () => {
    await says(PARTICIPANTS.sam, "@support-agent please get order A-2004 refunded");
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.supportAgent, "@refunds-agent refund order A-2004 for Rohan");
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(h.core.stores.requests.get(id)?.requesterIds).toContain("sam");
    expect(flagCodes(id)).not.toContain("may_have_asked");
  });

  it("once the first agent has answered, the person isn't waiting and isn't passed on", async () => {
    await says(PARTICIPANTS.sam, "@support-agent please get order A-2004 refunded");
    await says(PARTICIPANTS.supportAgent, "On it.");
    h.clock.advance(11 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.supportAgent, "@refunds-agent refund order A-2004 for Rohan");
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(h.core.stores.requests.get(id)?.requesterIds).not.toContain("sam");
  });
});

describe("S1 and F7h: what a vendor sends means what it means", () => {
  const ctx = { agent: "coder", id: "a", at: new Date(NOW).toISOString() };

  it("a padded marker is bound as well as read", () => {
    const patch = (body: string) => `*** Begin Patch\n  ***  Update File:  .github/workflows/deploy.yml\n+${body}\n*** End Patch`;
    expect(patchPaths(patch("x"))).toEqual([".github/workflows/deploy.yml"]);
    const written = (body: string) => codexToActions({ tool_name: "apply_patch", cwd: CODER_CWD, tool_input: { command: patch(body) } }, ctx)[0]?.written;
    expect(written("x")?.content).toBe("x");
    expect(written("x")?.replaces).not.toBe(written("y")?.replaces);
  });

  it("an added line that reads like a marker isn't one", () => {
    expect(patchPaths("*** Begin Patch\n*** Update File: src/a.ts\n+*** Update File: .github/x\n*** End Patch")).toEqual(["src/a.ts"]);
  });

  it("a word in an argv means itself: no `$` in it expands, and no space splits it", async () => {
    const [action] = codexToActions({ tool_name: "Bash", cwd: CODER_CWD, tool_input: { command: ["echo", "$(rm -rf /)"] } }, ctx);
    expect(action?.shell?.command).toBe("echo '$(rm -rf /)'");
    expect((await h.core.simulate(action as Action)).decision).toBe("allow");
    const [plain] = codexToActions({ tool_name: "Bash", cwd: CODER_CWD, tool_input: { command: ["git", "status", "--short"] } }, ctx);
    expect(plain?.shell?.command).toBe("git status --short");
  });
});

describe("F8: both ends of what matters stay on the card", () => {
  const view: CardView = {
    id: "CLR-0001",
    headline: "REFUND ₹2,000",
    tier: "high",
    reversible: false,
    call: ["Refund ₹2,000 to customer Meera", `Destination: UPI ${"m".repeat(190)}@evilbank`, `Run: ${"x".repeat(250)} | sh`],
    context: ["Something else"],
    flags: Array.from({ length: 6 }, (_, index) => `Flag ${index} ${"y".repeat(180)}`),
    askedBy: ["Priya (support)"],
    agent: "refunds-agent",
    vendor: "Claude Code",
    owners: ["Priya"],
    whyLabel: "Why you",
    why: "finance approver on duty.",
    policyLine: "refunds need 1 finance approver",
    expires: "14:25 IST",
  };

  it("when a card has to shorten its lines, a line loses its middle", () => {
    const { detail } = renderCard(view);
    expect(detail).toContain("@evilbank");
    expect(detail).toContain("| sh");
    expect(detail).toContain("Destination: UPI");
  });

  it("clips to exactly what it's given, and leaves short text alone", () => {
    expect(clipKeepingBothEnds("short", 10)).toBe("short");
    expect(clipKeepingBothEnds("abcdefghij", 5)).toBe("ab…ij");
    expect(clipKeepingBothEnds("abcdefghij", 5)).toHaveLength(5);
  });

  it("a long shell line keeps its end", async () => {
    await says(PARTICIPANTS.priya, "@coder push it", "#eng");
    const id = (await h.core.check(hookShell(`git push origin ${"a".repeat(400)}:main`))).request_id as string;
    const { call } = h.core.stores.requests.require(id).evidence.description as { call: string[] };
    expect(call[0]).toContain(":main");
  });
});

describe("F9: an agent's words are evidence wherever it says them", () => {
  it("two quiet words in the thread don't push out what it said in the room", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹4,000 for order A-2004.", "#support", { threadId: null });
    await says(PARTICIPANTS.refundsAgent, "Looking at it now.", "#support", { threadId: "t-quiet" });
    await says(PARTICIPANTS.refundsAgent, "Still looking.", "#support", { threadId: "t-quiet" });
    const id = (await h.core.check(gateRefund(REFUND_SC4, { session: { switchRoomId: "#support", threadId: "t-quiet" } }))).request_id as string;
    expect(flagCodes(id)).toContain("mismatch");
  });

  it("words in another thread count, since a thread is only the agent's word", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹4,000 for order A-2004.", "#support", { threadId: "t-other" });
    const id = (await h.core.check(gateRefund(REFUND_SC4, { session: { switchRoomId: "#support", threadId: "t-quiet" } }))).request_id as string;
    expect(flagCodes(id)).toContain("mismatch");
  });

  it("saying the right thing in the thread stays fine, whatever else was said in the room", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹2,000 for order A-1931.", "#support", { threadId: "t-other" });
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹40,000 for order A-2004 to rohan.s@okhdfc for cus_2044.", "#support", { threadId: "t-mine" });
    const id = (await h.core.check(gateRefund(REFUND_SC4, { session: { switchRoomId: "#support", threadId: "t-mine" } }))).request_id as string;
    expect(flagCodes(id)).not.toContain("mismatch");
  });
});

describe("F10: a request nobody can approve says so, and offers only what would work", () => {
  const trace = (over: Partial<RouteTrace>): RouteTrace => ({ fallback: null, ...over }) as RouteTrace;

  it("fits a question card's 200 characters, with the longest names it might have to carry", () => {
    const text = cannotCompleteText(trace({ shortOfPeople: { needed: 1, could: [], breakGlass: ["Alex", "Priya Raman"] }, fallback: { group: "eng-leads", room: "#approvals", reason: "x", eligible: ["alex"] } }), "CLR-12345") as string;
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain("@clearance breakglass CLR-12345 why");
  });

  it("doesn't offer a group with nobody left in it, or break-glass by nobody", () => {
    const text = cannotCompleteText(trace({ shortOfPeople: { needed: 1, could: [], breakGlass: [] }, fallback: { group: "eng-leads", room: "#approvals", reason: "x", eligible: [] } }), "CLR-1") as string;
    expect(text).toBe("Nobody can approve this, so it can't complete as things stand. To finish: add an approver.");
  });

  it("takes break-glass off the card of whoever it would refuse", async () => {
    await says(PARTICIPANTS.dev, "@coder force push it", "#eng");
    const id = (await h.core.check(hookShell("git push --force origin main", { session: { switchRoomId: "#eng" } }))).request_id as string;
    expect(h.core.traces.latest(id)?.shortOfPeople?.breakGlass).toEqual([]);
    expect(cardIn("#eng").detail).not.toContain("breakglass");
  });

  it("a request nobody can approve tells the room who it went to, in the old words, once", async () => {
    await says(PARTICIPANTS.dev, "@coder update the workflow", "#eng");
    const write: Action = { id: actionId(), at: new Date(NOW).toISOString(), source: "hook", vendor: "claude", agent: { name: "coder", cwd: CODER_CWD }, kind: "file_write", raw: {}, file: { path: ".github/workflows/deploy.yml" }, written: { content: "x" } };
    const id = (await h.core.check(write)).request_id as string;
    expect(told()).toContain(`Nobody eligible for ${id}`);
    expect(told()).not.toContain("It takes");
    expect(cardIn("#approvals").detail).toContain("Nobody can approve this, so it can't complete as things stand.");
    expect(cardIn("#approvals").detail).not.toContain("have Alex run");
  });

  it("a review card about something that already ran doesn't say it can't complete", async () => {
    atL("L2");
    await says(PARTICIPANTS.sam, "@refunds-agent refund it");
    await says(PARTICIPANTS.neha, "@refunds-agent refund it");
    await says(PARTICIPANTS.alex, "@refunds-agent refund it");
    await says(PARTICIPANTS.dev, "@refunds-agent refund it");
    expect((await h.core.check(gateRefund(SMALL))).decision).toBe("allow");
    for (const card of h.chat.cards) expect(card.detail).not.toContain("can't complete");
  });
});

describe("F11: only a fire stops drills", () => {
  const asked = () => says(PARTICIPANTS.priya, "@refunds-agent refund it");

  it("an incident on something that ran does, whoever reports it", async () => {
    atL("L3");
    await asked();
    const ran = await h.core.check(gateRefund(SMALL));
    await says(PARTICIPANTS.dev, `@clearance incident ${ran.request_id} customer disputes this`, "#eng");
    expect(await h.core.sendDrill("neha")).toEqual({ ok: false, reason: "there is an open incident" });
  });

  it("one on something still waiting doesn't, and stays on the record", async () => {
    await asked();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    await says(PARTICIPANTS.dev, `@clearance incident ${held.request_id} looks wrong`, "#eng");
    expect(h.core.stores.incidents.all()).toHaveLength(1);
    expect((await h.core.sendDrill("neha")).ok).toBe(true);
  });

  it("one on something that ran long ago doesn't, or anyone could keep drills off with an old run", async () => {
    atL("L3");
    await asked();
    const ran = await h.core.check(gateRefund(SMALL));
    h.clock.advance(3 * 24 * 60 * MINUTE);
    await says(PARTICIPANTS.dev, `@clearance incident ${ran.request_id} no reason at all`, "#eng");
    expect((await h.core.sendDrill("neha")).ok).toBe(true);
  });

  it("one on a drill doesn't, because a drill is nothing", async () => {
    const sent = await h.core.sendDrill("sam");
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await says(PARTICIPANTS.dev, `@clearance incident ${sent.requestId} no reason at all`, "#eng");
    expect((await h.core.sendDrill("neha")).ok).toBe(true);
  });

  it("it runs out after a day, as it always did", async () => {
    atL("L3");
    await asked();
    const ran = await h.core.check(gateRefund(SMALL));
    await says(PARTICIPANTS.dev, `@clearance incident ${ran.request_id} customer disputes this`, "#eng");
    h.clock.advance(24 * 60 * MINUTE + 1);
    expect((await h.core.sendDrill("neha")).ok).toBe(true);
  });
});

describe("S2: a name doesn't outrank an id", () => {
  const team = () => h.core.team;

  it("once Clearance's id is on file, only that id is Clearance", () => {
    const { directory } = h.core.people;
    expect(directory.isSelf(PARTICIPANTS.clearance, "clearance")).toBe(true);
    expect(directory.isSelf("@stranger:localhost", "clearance")).toBe(false);
    expect(directory.isSelf(PARTICIPANTS.sam, "clearance")).toBe(false);
  });

  it("with no id on file its name is enough, except for someone who is on file as someone else", () => {
    const directory = new Directory(team(), { people: IDENTITIES.people, agents: { "refunds-agent": IDENTITIES.agents["refunds-agent"] } });
    expect(directory.isSelf("@anyone:localhost", "clearance")).toBe(true);
    expect(directory.isSelf(PARTICIPANTS.sam, "clearance")).toBe(false);
    expect(directory.isSelf(PARTICIPANTS.refundsAgent, "clearance")).toBe(false);
  });

  it("a stranger using the name of an agent whose id is on file isn't that agent, and their ask still counts", async () => {
    const { directory } = h.core.people;
    expect(directory.agentForSender("@stranger:localhost", "refunds-agent")).toBeNull();
    expect(directory.agentForSender(PARTICIPANTS.refundsAgent, "refunds-agent")).toBe("refunds-agent");
    await h.core.onMessage(chatMessage("@stranger:localhost", "@support-agent refund it", { senderName: "refunds-agent", roomId: "#support", threadId: null }));
    expect(h.core.people.requesters.requestersOf("support-agent")).toContain("@stranger:localhost");
  });

  it("a stranger's words under an agent's name aren't that agent's words on a card", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    await h.core.onMessage(chatMessage("@stranger:localhost", "Refunding ₹4,000 for order A-2004.", { senderName: "refunds-agent", roomId: "#support", threadId: null }));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(flagCodes(id)).not.toContain("mismatch");
  });
});

describe("shadow reports what enforcing would do", () => {
  it("a call nobody asked for would have been held, even where the policy alone would run it", async () => {
    h.core.close();
    const dir = (await import("node:fs")).mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/clearance-shadow-`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { POLICY_PATH } = await import("./harness.js");
    const path = `${dir}/policy.yaml`;
    writeFileSync(path, readFileSync(POLICY_PATH, "utf8").replace("mode: enforce", "mode: shadow"));
    h = makeHarness({ policyPath: path });
    h.lookup.world = structuredClone(WORLD);
    atL("L3");
    const response = await h.core.check(gateRefund(SMALL));
    expect(response).toMatchObject({ decision: "allow", would_decide: "hold" });
    expect(response.flags?.map((flag) => flag.code)).toContain("requester_unknown");
  });
});
