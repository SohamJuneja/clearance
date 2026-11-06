/**
 * Fourth review. Every `it` named with an F number states the secure behaviour, and failed on the code the review found it
 * in: each was one finding, ranked by how bad the outcome is, and all are fixed since. A "control" passed then too, and shows
 * the scene is set up properly, so a failure is the finding and not a broken scene.
 *
 * The shell findings also run each form in a real bash, with a harmless `touch`, to prove the shell really does what the
 * reader says it doesn't. Fakes for every port. The seeded loops are in fourth-review-fuzz.test.ts, which is green.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeToActions, codexToActions, patchPaths } from "@clearance/adapters";
import type { Action } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC4, WORLD, type Harness } from "./harness.js";

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

const CODER_CWD = "/home/x/.switch/agents/m/coder";
/** Small, hers, from a destination on file, so it would run alone at L3. */
const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@oksbi" };

const press = (card: { sessionId: string; switchRequestId: string }, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });
const says = (who: string, body: string, roomId = "#support", overrides: Parameters<typeof chatMessage>[2] = {}) =>
  h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true, ...overrides }));
const state = (id: string | undefined) => h.core.stores.requests.get(id as string)?.state;
const flagCodes = (id: string | undefined) => (h.core.stores.requests.get(id as string)?.flags ?? []).map((flag) => flag.code);
const told = () => [...h.chat.messages.map((m) => m.body), ...h.chat.targeted.map((m) => m.body)].join("\n");
const cardFor = (id: string, room: string): OpenedCard => {
  const row = h.core.stores.routes.forRequest(id).find((entry) => entry.card_room === room);
  if (!row) throw new Error(`no card for ${id} in ${room}: ${h.core.stores.routes.forRequest(id).map((r) => r.card_room).join()}`);
  return h.chat.cards.find((card) => card.switchRequestId === row.switch_request_id) as OpenedCard;
};
/**
 * Where Sam can press. On the unfixed code he has a card of his own, because nothing bars him. Fixed, he's barred, so he has
 * none, and he presses the room's copy, as the controls do. An `it` must fail on what it's about, not on the missing card.
 */
const whereSamCanPress = (id: string): OpenedCard => cardFor(id, h.core.stores.routes.forRequest(id).some((row) => row.card_room === "dm-sam") ? "dm-sam" : "#support");
const refusedForAsking = (id: string) => expect(h.core.stores.answers.forRequest(id).at(-1)?.reason, "he's refused for having asked").toContain("requester");
const cardText = (card: OpenedCard) => `${card.title}\n${card.detail}\n${card.questions.map((q) => q.prompt).join("\n")}`;

function gateCall(agent: string, endpoint: string, args: Record<string, unknown>, session: Action["session"] = { switchRoomId: "#support", threadId: "t-1" }): Action {
  return { id: actionId(), at: new Date(NOW).toISOString(), source: "gate", vendor: "gate", agent: { name: agent }, ...(session ? { session } : {}), kind: "business", raw: args, business: { endpoint, args } };
}

/** What the classifier makes of a line, with nothing recorded. */
const decide = async (line: string): Promise<string> =>
  String((await h.core.simulate(hookShell(line, { agent: { name: "coder", cwd: CODER_CWD } }))).decision);

/** Runs a line in a real bash, in a scratch directory with a `.env` in it. True when it managed to create `hit`. */
function bashRuns(line: string): { hit: boolean; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "clearance-bash-proof-"));
  try {
    writeFileSync(join(dir, ".env"), "SECRET=shown\n");
    const run = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH ?? "", HOME: dir, LC_ALL: "C.UTF-8" } });
    return { hit: existsSync(join(dir, "hit")), stdout: run.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each line must be held or denied. `proof` says the same form really runs its command in bash. */
async function expectAllHeld(cases: { line: string; proof?: string }[]): Promise<void> {
  const allowed: string[] = [];
  for (const { line, proof } of cases) {
    if (proof !== undefined) expect(bashRuns(proof).hit, `bash really runs: ${proof}`).toBe(true);
    if ((await decide(line)) === "allow") allowed.push(line);
  }
  expect(allowed, "these run with no resistance").toEqual([]);
}

describe("F1: parallel calls beat every check autonomy makes before it runs something alone", () => {
  beforeEach(async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", NOW);
    await says(PARTICIPANTS.priya, "@refunds-agent please sort out Meera's refunds");
  });

  it("control: one after the other, the identical second call is held", async () => {
    expect((await h.core.check(gateRefund(SMALL))).decision).toBe("allow");
    const second = await h.core.check(gateRefund(SMALL));
    expect(second.decision).toBe("hold");
    expect(flagCodes(second.request_id)).toContain("ran_recently");
  });

  it("F1a: two identical refunds at once, and only one runs alone", async () => {
    const answers = await Promise.all([h.core.check(gateRefund(SMALL)), h.core.check(gateRefund(SMALL))]);
    expect(answers.map((answer) => answer.decision).sort(), "the gate sends every allow, with no idempotency key").toEqual(["allow", "hold"]);
  });

  const three = [
    { order_id: "A-1931", customer_id: "cus_8812", amount: 4000, destination: "meera.k@oksbi" },
    { order_id: "A-1941", customer_id: "cus_8812", amount: 4000, destination: "meera.k@oksbi" },
    { order_id: "A-1931", customer_id: "cus_8812", amount: 3900, destination: "meera.k@oksbi" },
  ];

  it("control: one after the other, the third refund to a customer goes over ₹10,000 and is held", async () => {
    const answers = [];
    for (const args of three) answers.push((await h.core.check(gateRefund(args))).decision);
    expect(answers).toEqual(["allow", "allow", "hold"]);
  });

  it("F1b: three refunds at once can't slip under the ₹10,000 structuring limit", async () => {
    const answers = await Promise.all(three.map((args) => h.core.check(gateRefund(args))));
    expect(answers.map((answer) => answer.decision).filter((decision) => decision === "allow").length, "₹11,900 to one customer ran alone").toBeLessThan(3);
  });

  it("F1c: calls at once can't overspend L3's daily budget", async () => {
    h.core.stores.autonomy.setLevel("support-agent", "customer_email", "plain_reply", "L3", NOW);
    await says(PARTICIPANTS.sam, "@support-agent please write to them");
    for (let index = 0; index < 39; index += 1) {
      h.core.stores.events.add({ agent: "support-agent", cls: "customer_email", bucket: "plain_reply", requestId: null, atMs: NOW - 1000, fields: { attachments: 0 }, outcome: "auto", approvers: [], fast: false, edited: false, incident: false, autoEligible: true, synthetic: false });
    }
    const email = (to: string) => gateCall("support-agent", "POST /acme/emails", { to, subject: "Hi", body: "Hello", attachments: [] });
    const answers = await Promise.all(["a@acme.in", "b@acme.in", "c@acme.in"].map((to) => h.core.check(email(to))));
    expect(answers.map((answer) => answer.decision).filter((decision) => decision === "allow").length, "the cap is 40 and 39 are spent").toBeLessThanOrEqual(1);
  });
});

describe("F2: break-glass by handle runs a different call than the one in the room", () => {
  /** Switch counts handles per channel, so two rooms each have an A1. */
  function handlesPerRoom(): void {
    const perRoom = new Map<string, number>();
    const open = h.chat.openCard.bind(h.chat);
    h.chat.openCard = async (input) => {
      const result = await open(input);
      const number = (perRoom.get(input.roomId) ?? 0) + 1;
      perRoom.set(input.roomId, number);
      return { ...result, handle: `A${number}` };
    };
  }

  it("F2: Alex breaks glass on A1 in #support, and A1 in #finance runs instead", async () => {
    handlesPerRoom();
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    const inSupport = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-1931 in full", "#finance");
    const inFinance = (await h.core.check(gateRefund({ ...REFUND_SC4, amount: 30000 }, { session: { switchRoomId: "#finance" } }))).request_id as string;
    expect(h.core.stores.routes.forRequest(inSupport).find((row) => row.card_room === "#support")?.handle, "control: A1 is this one here").toBe("A1");
    expect(h.core.stores.routes.forRequest(inFinance).find((row) => row.card_room === "#finance")?.handle, "control: and that one there").toBe("A1");

    await says(PARTICIPANTS.alex, "@clearance breakglass A1 it cannot wait");

    expect(state(inFinance), "a refund nobody looked at went out").toBe("ROUTED");
    expect(state(inSupport)).toBe("EXECUTED");
  });
});

describe("F3: naming @clearance hides who asked", () => {
  const ask = "refund order A-2004 in full";

  async function scene(words: string): Promise<string> {
    h.chat.roomAliases = async () => ({});
    await says(PARTICIPANTS.refundsAgent, "Morning all.", "#finance");
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.sam, words, "#finance", { addressed: false });
    return (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
  }

  it("control: saying it in a room the agent is in bars Sam", async () => {
    const id = await scene(ask);
    await press(cardFor(id, "#support"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
  });

  it("F3: the same words beside @clearance don't let Sam approve alone", async () => {
    const id = await scene(`${ask}, @clearance keep an eye on it`);
    await press(whereSamCanPress(id), PARTICIPANTS.sam);
    expect(h.gate.calls, "Sam asked, and his approval alone ran it").toEqual([]);
    refusedForAsking(id);
  });

  it("F3b: nor does a role mention beside it, which the threat model says the speaking rule covers", async () => {
    const id = await scene(`@refund-desk @clearance ${ask}`);
    await press(whereSamCanPress(id), PARTICIPANTS.sam);
    expect(h.gate.calls, "Sam asked, and his approval alone ran it").toEqual([]);
    refusedForAsking(id);
  });
});

describe("F4: running alone skips the flags core adds about who asked", () => {
  /** A flag is something a person would want to see, so at L2 and L3 it holds (PLAN F11). */
  async function run(scene: () => Promise<void>): Promise<{ decision: string; flags: string[] }> {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", NOW);
    await scene();
    const answer = await h.core.check(gateRefund(SMALL));
    return { decision: answer.decision, flags: flagCodes(answer.request_id) };
  }

  it("control: asked by someone on the team, it runs alone with no flags", async () => {
    expect(await run(() => says(PARTICIPANTS.priya, "@refunds-agent refund order A-1931"))).toEqual({ decision: "allow", flags: [] });
  });

  it("control: the same call at L0 takes two people, and the card says why", async () => {
    await says(PARTICIPANTS.guest, "@refunds-agent refund order A-1931");
    const held = await h.core.check(gateRefund(SMALL));
    expect(held.decision).toBe("hold");
    expect(flagCodes(held.request_id)).toContain("requester_unlinked");
  });

  it("F4a: an account linked to nobody asked, and a refund doesn't run with nobody looking", async () => {
    const { decision, flags } = await run(() => says(PARTICIPANTS.guest, "@refunds-agent refund order A-1931"));
    expect(flags, "control: core knows, and writes it on the record").toContain("requester_unlinked");
    expect(decision).toBe("hold");
  });

  it("F4b: messages were lost, so nobody can say who asked, and it doesn't run alone", async () => {
    const { decision, flags } = await run(async () => {
      await says(PARTICIPANTS.priya, "@refunds-agent refund order A-1931");
      h.core.onStreamGap();
    });
    expect(flags, "control: core knows, and writes it on the record").toContain("messages_lost");
    expect(decision).toBe("hold");
  });

  it("F4c: nobody at all asked, and it doesn't run alone", async () => {
    const { decision, flags } = await run(async () => undefined);
    expect(flags, "control: core knows, and writes it on the record").toContain("requester_unknown");
    expect(decision).toBe("hold");
  });
});

describe("F5: break-glass ignores the other separations of duty", () => {
  it("F5: the author of a pull request can't break glass to merge it", async () => {
    await says(PARTICIPANTS.priya, "@coder merge 42 please", "#eng");
    const id = (await h.core.check(gateCall("coder", "POST /github/merge", { repo: "acme-mini-app", pr: 42 }, { switchRoomId: "#eng" }))).request_id as string;
    await press(cardFor(id, "#eng"), PARTICIPANTS.alex);
    expect(state(id), "control: as an approver, he's refused for being the author").toBe("ROUTED");

    await says(PARTICIPANTS.alex, `@clearance breakglass ${id} ship it`, "#eng");

    expect(h.gate.calls, "Alex merged his own pull request alone").toEqual([]);
  });
});

describe("F6: a chain through agents launders who asked, once the window has passed", () => {
  async function scene(minutes: number): Promise<string> {
    await says(PARTICIPANTS.sam, "@support-agent please get order A-2004 refunded");
    h.clock.advance(minutes * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.supportAgent, "@refunds-agent refund order A-2004 for Rohan");
    return (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
  }

  it("control: inside the 10 minutes, the chain bars Sam", async () => {
    const id = await scene(1);
    await press(cardFor(id, "#support"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
  });

  it("F6: at 11 minutes, Sam still waiting on the first agent is barred on the second", async () => {
    const id = await scene(11);
    await press(whereSamCanPress(id), PARTICIPANTS.sam);
    expect(h.gate.calls, "Sam asked, and his approval alone ran it").toEqual([]);
    refusedForAsking(id);
  });
});

describe("F7: the shell reader doesn't read the shell", () => {
  it("control: the plain forms are held", async () => {
    await expectAllHeld([{ line: "rm -rf /" }, { line: "git push --force origin main" }, { line: "bash -c 'rm -rf /'" }, { line: "echo $(rm -rf /)" }]);
    expect(await decide("cat .env")).toBe("deny");
    expect(await decide("echo x > .github/workflows/deploy.yml")).toBe("hold");
  });

  it("F7a: ANSI-C and locale quoting are quoting", async () => {
    await expectAllHeld([
      { proof: "$'touch' hit", line: "$'rm' -rf /" },
      { proof: "$'\\x74ouch' hit", line: "$'\\x72\\x6d' -rf /" },
      { proof: '$"touch" hit', line: '$"rm" -rf /' },
      { line: "$'git' push --force origin main" },
      { line: "git $'push' --force origin main" },
      { line: "cat $'.env'" },
      { line: "echo x > $'.github/workflows/deploy.yml'" },
      // The reader pairs these quotes differently from the shell, so the whole of the rest of the line looks like one string.
      { proof: "echo $'\\'' ; touch hit ; #'", line: "echo $'\\'' ; rm -rf / ; #'" },
    ]);
  });

  it("F7b: a substitution inside ${...} or $((...)) still runs", async () => {
    await expectAllHeld([
      { proof: "echo ${x:-$(touch hit)}", line: "echo ${x:-$(rm -rf /)}" },
      { proof: 'echo "${x:-$(touch hit)}"', line: 'echo "${x:-$(git push --force origin main)}"' },
      { proof: "echo ${x:-`touch hit`}", line: "echo ${x:-`rm -rf /`}" },
      { proof: "echo $(( $(touch hit; echo 1) ))", line: "echo $(( $(git push --force origin main) ))" },
    ]);
  });

  it("F7c: an unquoted heredoc's body runs its substitutions, and its end can be split", async () => {
    await expectAllHeld([
      { proof: "cat <<EOF\n$(touch hit)\nEOF", line: "cat <<EOF\n$(git push --force origin main)\nEOF" },
      { proof: "cat <<EOF\n`touch hit`\nEOF", line: "cat <<EOF\n`rm -rf /`\nEOF" },
      { proof: "cat <<EOF\nx\nEO\\\nF\ntouch hit\n", line: "cat <<EOF\nx\nEO\\\nF\nrm -rf /\n" },
    ]);
  });

  it("F7d: what JavaScript calls a space and bash doesn't can't start a comment", async () => {
    await expectAllHeld([
      { proof: "true # ; touch hit", line: "ls # ; git push --force origin main" },
      { proof: "true\u000b# ; touch hit", line: "ls\u000b# ; rm -rf /" },
      { proof: "true\f# ; touch hit", line: "ls\f# ; rm -rf /" },
    ]);
  });

  it("F7e: brace expansion and globs make a command word", async () => {
    await expectAllHeld([
      { proof: "{touch,hit}", line: "{rm,-rf,/}" },
      { line: "{git,push,--force,origin,main}" },
      { line: "git push origin ma{i,}n" },
      { line: "rm -rf {/,/etc}" },
      { proof: "tou?h hit; /usr/bin/tou?h hit", line: "/bin/r? -rf /" },
      { proof: "/usr/bin/tou[c]h hit", line: "r[m] -rf /" },
      { line: "git p* --force origin main" },
    ]);
    expect(bashRuns("cat .en?").stdout, "a glob really reads it").toContain("SECRET");
    expect(await decide("cat .en?"), "reading .env is a deny").toBe("deny");
    expect(await decide("cat .e*"), "reading .env is a deny").toBe("deny");
  });

  it("F7f: Grep's own glob reads .env past the deny", async () => {
    const [action] = claudeToActions({ tool_name: "Grep", cwd: CODER_CWD, tool_input: { pattern: "KEY", glob: ".en*" } }, { agent: "coder", id: actionId(), at: new Date(NOW).toISOString() });
    expect((await h.core.simulate(action as Action)).decision).not.toBe("allow");
  });

  it("F7g: known runners, spelled another way, still run what they're given", async () => {
    await expectAllHeld([
      { proof: "env -S'touch hit'", line: "env -S'rm -rf /'" },
      { proof: "env --split-string='touch hit'", line: "env --split-string='git push --force origin main'" },
      { proof: "env - touch hit", line: "env - rm -rf /" },
      { proof: "bash +x -c 'touch hit'", line: "bash +x -c 'git push origin main'" },
      { proof: "bash --rcfile /dev/null -c 'touch hit'", line: "bash --rcfile x -c 'git push origin main'" },
      { proof: "trap 'touch hit' EXIT", line: "trap 'git push --force origin main' EXIT" },
      { line: "echo main | xargs -I{} git push origin {}" },
      { proof: "git init -q r && cd r && git ls-remote --upload-pack='touch ../hit;:' .", line: "git ls-remote --upload-pack='rm -rf /;:' ." },
    ]);
  });

  it("F7h: a Codex argv keeps the script as one word", async () => {
    const payload = { tool_name: "Bash", cwd: CODER_CWD, tool_input: { command: ["bash", "-lc", "git push --force origin main"] } };
    const [action] = codexToActions(payload, { agent: "coder", id: actionId(), at: new Date(NOW).toISOString() });
    expect((await h.core.simulate(action as Action)).decision).not.toBe("allow");
  });

  it("F7i: writing through cp -t, or moving and removing a protected file, touches it", async () => {
    await expectAllHeld([
      { line: "cp -t .github/workflows evil.yml" },
      { line: "cp --target-directory=.github/workflows evil.yml" },
      { line: "mv -t .github/workflows evil.yml" },
      { line: "mv .github/workflows/deploy.yml x" },
      { line: "rm .github/workflows/deploy.yml" },
      { line: "cd .github && cd workflows && rm deploy.yml" },
    ]);
  });
});

describe("F9: an agent's thread hint takes its words out of the evidence", () => {
  const scene = async (session: Action["session"]) => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    await says(PARTICIPANTS.refundsAgent, "Looking at it now.", "#support", { threadId: "t-quiet" });
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹4,000 for order A-2004.", "#support", { threadId: null });
    return (await h.core.check(gateRefund(REFUND_SC4, { session }))).request_id as string;
  };

  it("control: with no thread on the call, ₹4,000 against ₹40,000 is flagged", async () => {
    expect(flagCodes(await scene({ switchRoomId: "#support" }))).toContain("mismatch");
  });

  it("F9: naming a quiet thread doesn't hide what it said in the room", async () => {
    expect(flagCodes(await scene({ switchRoomId: "#support", threadId: "t-quiet" })), "x-clearance-thread is the agent's own word").toContain("mismatch");
  });
});

describe("F8: a long destination hides where the money goes", () => {
  const tail = "@evilbank";
  const long = `${"m".repeat(240)}${tail}`;

  it("control: a long email address keeps its end on the card", async () => {
    await says(PARTICIPANTS.sam, "@support-agent write to them");
    const id = (await h.core.check(gateCall("support-agent", "POST /acme/emails", { to: `ceo${"a".repeat(240)}@evil.example`, subject: "Hi", body: "x", attachments: [] }))).request_id as string;
    expect(cardText(cardFor(id, "dm-priya"))).toContain("evil.example");
  });

  it("F8a: a payout change's card shows the end of the new destination", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent change her payout");
    const id = (await h.core.check(gateCall("refunds-agent", "POST /acme/payouts/destinations", { customer_id: "cus_8812", upi: long }))).request_id as string;
    expect(cardText(cardFor(id, "dm-sam")), "the part after @ is what decides who gets paid").toContain(tail);
  });

  it("F8b: a refund's card shows the end of the destination", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    const id = (await h.core.check(gateRefund({ ...REFUND_SC4, destination: long }))).request_id as string;
    expect(cardText(cardFor(id, "dm-sam"))).toContain(tail);
  });
});

describe("F10: a request nobody can approve doesn't say so", () => {
  it("F10: coder's protected write has no possible approver, and the card says what to do", async () => {
    await says(PARTICIPANTS.dev, "@coder update the workflow", "#eng");
    const write: Action = { id: actionId(), at: new Date(NOW).toISOString(), source: "hook", vendor: "claude", agent: { name: "coder", cwd: CODER_CWD }, kind: "file_write", raw: {}, file: { path: ".github/workflows/deploy.yml" }, written: { content: "name: x" } };
    const id = (await h.core.check(write)).request_id as string;
    const card = cardFor(id, "#approvals");
    await press(card, PARTICIPANTS.alex);
    expect(state(id), "control: Alex owns the agent, so he's refused").toBe("ROUTED");
    expect(h.core.stores.answers.forRequest(id).at(-1)?.reason).toContain("agent_owner");
    expect(cardText(card) + told(), "it says it's posted for eng-leads, Alex is the only one, and it waits out its 25 minutes").toContain("it can't complete as things stand");
  });
});

describe("F11: anyone can switch drills off, with a junk incident", () => {
  it("control: turning drills off takes an admin", async () => {
    await says(PARTICIPANTS.dev, "@clearance drills off", "#eng");
    expect((await h.core.sendDrill("sam")).ok).toBe(true);
  });

  it("F11: an incident on something that never ran doesn't stop drills for a day", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.sam, "deny");
    expect(state(id), "control: it never ran").toBe("DENIED");

    await says(PARTICIPANTS.dev, `@clearance incident ${id} no reason at all`, "#eng");

    const sent = await h.core.sendDrill("neha");
    expect(sent, "Dev isn't an admin, and can do this again every day").toMatchObject({ ok: true });
  });
});

describe("suspicions, reproduced up to the vendor's own behaviour", () => {
  it("S1: padding around a patch's markers, which Codex's parser is tolerant of as far as we recall", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n\n+x\n  *** Update File: .github/workflows/deploy.yml\n\n+y\n*** End Patch";
    expect(patchPaths(patch)).toContain(".github/workflows/deploy.yml");
  });

  it("S2: a linked person whose name reads clearance is still who they are, if Switch lets a person choose that name", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    await says(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full", "#finance", { senderName: "clearance" });
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await press(whereSamCanPress(id), PARTICIPANTS.sam);
    expect(h.gate.calls, "the sender's id says Sam, and the name was believed over it").toEqual([]);
    refusedForAsking(id);
  });
});
