/** What the real-agent runs turned up: reads that went too far, cards that said too much or too little, lost messages. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, OpenCardInput } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readsOutside } from "../src/classify/reads.js";
import { parseShell } from "../src/classify/shell.js";
import { DETAIL_BUDGET, renderedCost } from "../src/cards/render.js";
import { openDatabase } from "../src/db/index.js";
import { evaluateAction } from "../src/policy/engine.js";
import { parsePolicy } from "../src/policy/load.js";
import { readStreamPosition, streamHandlers, writeStreamPosition } from "../src/stream.js";
import { createSwitchAgent } from "@clearance/switch-agent";
import { AGENT_ID, API_KEY, FakeSwitch, frame, quietLogger } from "../../switch-agent/test/helpers.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, POLICY_PATH, REFUND_SC3, REFUND_SC4, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const CWD = "/home/agent/.switch/agents/host/coder";

const shell = (command: string, cwd: string | undefined = CWD): Action => hookShell(command, { agent: { name: "coder", ...(cwd ? { cwd } : {}) } });
const fileRead = (path: string, cwd: string | undefined = CWD): Action => ({
  id: `read-${path}-${Math.random()}`,
  at: new Date(NOW).toISOString(),
  source: "hook",
  vendor: "claude",
  agent: { name: "coder", ...(cwd ? { cwd } : {}) },
  kind: "file_read",
  raw: { path },
  file: { path },
});
const press = (card: OpenedCard, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });
const lastCard = (room: string) => h.chat.cards.filter((card) => card.roomId === room).at(-1) as OpenedCard;
const asked = () => h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle Meera's ticket T-77"));

describe("protected reads: always denied", () => {
  it.each([
    ["a token directory", "cat .clearance/*"],
    ["one token in it", "cat .clearance/gate-token"],
    ["listing it", "ls -la .clearance"],
    ["by absolute path", "cat /home/agent/.switch/agents/host/coder/.clearance/hook-token"],
    ["hook tokens", "cat data/hook-tokens.json"],
    ["gate tokens", "grep refunds data/gate-tokens.json"],
    ["secrets", "cat data/secrets.json"],
    ["identities", "cat data/identities.json"],
    ["ssh keys", "cat ~/.ssh/id_ed25519"],
    ["the ssh directory", "ls ~/.ssh"],
    ["aws", "cat ~/.aws/credentials"],
    ["gnupg", "tar czf x.tgz ~/.gnupg"],
    ["claude's credentials", "cat ~/.claude/.credentials.json"],
    ["codex's auth", "cat ~/.codex/auth.json"],
    ["gh's token", "cat ~/.config/gh/hosts.yml"],
    ["netrc", "cat ~/.netrc"],
    ["a pem", "cat deploy/server.pem"],
    ["a key", "cat prod.key"],
    ["a p12", "base64 cert.p12"],
    ["an id_rsa", "cat keys/id_rsa"],
    ["inside bash -c", `bash -c "cat .clearance/*"`],
    ["under xargs", "echo x | xargs cat .clearance/hook-token"],
  ])("in a shell command: %s", async (_name, command) => {
    expect(await h.core.check(shell(command))).toMatchObject({ decision: "deny", class: "protected_config" });
  });

  it.each([
    [".clearance/hook-token"],
    ["/home/agent/.switch/agents/host/coder/.clearance/gate-token"],
    ["data/hook-tokens.json"],
    ["data/gate-tokens.json"],
    ["data/secrets.json"],
    ["data/identities.json"],
    ["~/.ssh/id_rsa"],
    ["/home/agent/.ssh/config"],
    ["/home/agent/.aws/credentials"],
    ["/home/agent/.gnupg/secring.gpg"],
    ["/home/agent/.claude/.credentials.json"],
    ["/home/agent/.codex/auth.json"],
    ["/home/agent/.config/gh/hosts.yml"],
    ["/home/agent/.netrc"],
    ["deploy/server.pem"],
    ["prod.key"],
    ["cert.p12"],
    ["cert.pfx"],
    ["keys/id_ed25519"],
  ])("as a file read: %s", async (path) => {
    expect(await h.core.check(fileRead(path))).toMatchObject({ decision: "deny", class: "protected_config" });
  });

  it.each([
    ["a public key", "cat keys/id_rsa.pub"],
    ["a word in a filename", "cat src/secrets-manager.ts"],
    ["a similar json", "cat src/identities.test.json"],
    ["key as a word", "grep key src/config.ts"],
    ["a file that only ends in key", "cat src/monkey"],
    ["a key file in code", "cat src/api.key.ts"],
    ["a mention of the name", "echo clearance is fine"],
  ])("leaves %s alone", async (_name, command) => {
    expect((await h.core.check(shell(command))).decision).toBe("allow");
  });

  it("doesn't touch the CLI, which reads its own token without any tool call", async () => {
    for (const command of ["bin/acme refund --order A-1931 --amount 2000", "./bin/acme deploy checkout v2.14.0 --env prod", "acme email --to a@b.example --subject hi"]) {
      const response = await h.core.check(shell(command));
      expect(response.decision, command).toBe("allow");
    }
  });

  it("does deny an agent lifting the token onto its own command line, which is a read in a tool call", async () => {
    const response = await h.core.check(shell("ACME_GATE_TOKEN=$(cat .clearance/gate-token) bin/acme refund --order A-1931 --amount 2000"));
    expect(response).toMatchObject({ decision: "deny", class: "protected_config" });
  });
});

describe("reads outside the agent's own directory", () => {
  const SAFE = ["/usr", "/bin", "/lib", "/tmp", "/dev/null", "/etc/hosts"];

  it.each<[string, string | undefined, boolean]>([
    ["src/a.ts", CWD, false],
    ["./src/a.ts", CWD, false],
    [`${CWD}/src/a.ts`, CWD, false],
    [CWD, CWD, false],
    ["src/../a.ts", CWD, false],
    ["/usr/share/dict/words", CWD, false],
    ["/usr", CWD, false],
    ["/tmp/out.txt", CWD, false],
    ["/etc/hosts", CWD, false],
    ["/dev/null", CWD, false],
    ["../sibling/a.ts", CWD, true],
    ["src/../../sibling/a.ts", CWD, true],
    ["/home/agent/projects/other/x", CWD, true],
    ["/etc/passwd", CWD, true],
    ["/etc/hostsfile", CWD, true],
    ["/usrlocal/x", CWD, true],
    [`${CWD}-other/a.ts`, CWD, true],
    [`${CWD}/../other/a.ts`, CWD, true],
    ["~/notes.txt", CWD, true],
    ["$HOME/notes.txt", CWD, true],
    ["${HOME}/notes.txt", CWD, true],
    ["/", CWD, true],
    ["/home/agent/x", undefined, true],
    ["../x", undefined, true],
    ["src/a.ts", undefined, false],
    ["/usr/lib/x", undefined, false],
  ])("%s from %s: %s", (path, cwd, outside) => {
    expect(readsOutside(path, cwd, SAFE)).toBe(outside);
  });

  it.each([
    ["an absolute path", "cat /home/agent/projects/Clearance/scripts/demo-run.ts"],
    ["the demo scripts, through ls", "ls /home/agent/projects/Clearance/scripts"],
    ["climbing out", "cat ../../projects/x"],
    ["the home directory", "ls ~"],
    ["the root", "find / -name '*.env'"],
    ["grep elsewhere", "grep -r password /home/agent/projects"],
    ["sed elsewhere", "sed -n 1,5p /etc/passwd"],
    ["head elsewhere", "head -20 /var/log/syslog"],
    ["a move into elsewhere", "cd /home/agent/projects && ls"],
    ["copying from elsewhere", "cp /home/agent/projects/x ."],
    ["through a redirect", "wc -l < /etc/passwd"],
    ["after something safe", "ls && cat /etc/passwd"],
    ["through xargs", "echo x | xargs cat /etc/passwd"],
    ["through find -exec", "find . -exec cat /etc/passwd \\;"],
    ["a run-time home", 'cat "$HOME/notes.txt"'],
  ])("holds %s", async (_name, command) => {
    const response = await h.core.check(shell(command));
    expect(response.decision, command).toBe("hold");
    expect(response.flags?.map((flag) => flag.code)).toContain("outside_agent_dir");
  });

  it("holds a file read the same way, and says what it is on the card", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder look at the code"));
    const response = await h.core.check(fileRead("/home/agent/projects/Clearance/scripts/demo-run.ts"));
    expect(response.decision).toBe("hold");
    expect(response.flags?.find((flag) => flag.code === "outside_agent_dir")?.text).toContain("/home/agent/projects/Clearance/scripts/demo-run.ts");
    expect(response.reason).toContain("reading outside the agent's own directory");
  });

  it("runs once approved, on the same call", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder look at the code"));
    const action = shell("cat /etc/passwd");
    const held = await h.core.check(action);
    // No class names approvers for this, so it goes to the fallback group, and Alex asked, so Dev is who's left.
    const row = h.core.stores.routes.openForRequest(held.request_id as string).find((candidate) => candidate.step === "fallback");
    const card = h.chat.cards.find((candidate) => candidate.switchRequestId === row?.switch_request_id) as OpenedCard;
    await press(card, PARTICIPANTS.neha);
    const after = h.core.stores.requests.require(held.request_id as string).state;
    expect(after === "GRANTED" || after === "ROUTED").toBe(true);
  });

  it.each([
    ["reading a file", "cat src/app.ts"],
    ["reading with a path inside", `cat ${CWD}/src/app.ts`],
    ["listing", "ls -la"],
    ["listing a folder", "ls src tests"],
    ["searching", "grep -rn TODO src"],
    ["searching with a path-like pattern", 'grep "/api/v1/" src/routes.ts'],
    ["ripgrep with a path-like pattern", 'rg "/usr/local" src'],
    ["sed's own slashes", "sed -n '/start/,/end/p' src/app.ts"],
    ["awk's own slashes", "awk '/error/ {print}' app.log"],
    ["printing a part", "sed -n 1,20p README.md"],
    ["a head", "head -20 README.md"],
    ["a tail", "tail -n 5 app.log"],
    ["counting", "wc -l src/*.ts"],
    ["finding", "find . -name '*.ts'"],
    ["finding in a folder", "find src -type f"],
    ["a run-time path", 'cat "$FILE"'],
    ["a loop variable", "for f in src/*; do cat $f; done"],
    ["git", "git status && git diff && git log -5"],
    ["tests", "pnpm test"],
    ["the system's files", "cat /etc/hosts"],
    ["the system's tools", "ls /usr/bin"],
    ["temp", "cat /tmp/output.txt"],
    ["nothing to see", "cat src/a.ts 2>/dev/null"],
    ["echoing a path", "echo /home/agent/x"],
    ["printing the directory", "pwd"],
    ["moving around inside", "cd src && ls"],
    ["a subdirectory up and back", "cd src && cat a.ts"],
  ])("leaves %s alone: quiet on ordinary work", async (_name, command) => {
    expect((await h.core.check(shell(command))).decision, command).toBe("allow");
  });

  it.each([["src/app.ts"], [`${CWD}/src/app.ts`], ["README.md"], ["/usr/include/stdio.h"], ["/etc/hosts"], ["/tmp/a.txt"]])("leaves a file read of %s alone", async (path) => {
    expect((await h.core.check(fileRead(path))).decision).toBe("allow");
  });

  it("says which paths the parser found", () => {
    expect(parseShell("cat a.ts /etc/passwd").commands[0]?.reads).toEqual(["/etc/passwd"]);
    expect(parseShell("grep /x /y").commands[0]?.reads).toEqual(["/y"]);
    expect(parseShell("find /y -name /z").commands[0]?.reads).toEqual(["/y"]);
    expect(parseShell("echo /x").commands[0]?.reads).toEqual([]);
    expect(parseShell("cat < a.txt").commands[0]?.reads).toEqual(["a.txt"]);
  });

  it("is in the policy, as a short list", () => {
    const list = h.core.policy().defaults.readable_outside ?? [];
    expect(list.length).toBeLessThan(20);
    expect(list).toEqual(expect.arrayContaining(["/usr", "/bin", "/lib", "/etc/hosts"]));
  });
});

describe("what people were told about a decision", () => {
  it("doesn't credit an approver with a reason they didn't give", async () => {
    await asked();
    const held = await h.core.check(gateRefund(REFUND_SC3));
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
    const said = h.chat.targeted.find((message) => message.targets.includes("refunds-agent"));
    expect(said?.body).toBe(`${held.request_id} denied by Sam. Tell Priya and stop.`);
  });

  it("nor when approving", async () => {
    await asked();
    const held = await h.core.check(gateRefund(REFUND_SC3));
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    const said = h.chat.targeted.find((message) => message.targets.includes("refunds-agent"));
    expect(said?.body).toMatch(new RegExp(`^${held.request_id} approved by Sam and executed: `));
    expect(said?.body).not.toContain("destination");
  });

  describe("in the room whose copy of the card just closed", () => {
    const inRoom = () => h.chat.messages.filter((message) => message.roomId === "#support").map((message) => message.body);

    it("says who denied it, in that thread", async () => {
      await asked();
      const held = await h.core.check(gateRefund(REFUND_SC3));
      expect(lastCard("#support").closed).toBe(false);
      h.clock.advance(MINUTE);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(lastCard("#support").closed).toBe(true);
      expect(h.chat.messages).toContainEqual({ roomId: "#support", threadId: "t-77", body: `${held.request_id} denied by Sam.` });
    });

    it("says who approved it", async () => {
      await asked();
      const held = await h.core.check(gateRefund(REFUND_SC3));
      h.clock.advance(MINUTE);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(inRoom()).toContain(`${held.request_id} approved by Sam.`);
    });

    it("says so on a hook call, too", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder push", { roomId: "#eng", threadId: null }));
      const held = await h.core.check(hookShell("git push origin main", { session: { switchRoomId: "#eng" } }));
      await press(lastCard("dm-dev"), PARTICIPANTS.dev);
      expect(h.chat.messages).toContainEqual({ roomId: "#eng", body: `${held.request_id} approved by Dev.` });
    });

    it("names both when it took two", async () => {
      const held = await h.core.check(gateRefund(REFUND_SC3));
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      await press(lastCard("dm-neha"), PARTICIPANTS.neha);
      expect(inRoom()).toContain(`${held.request_id} approved by Sam and Neha.`);
    });

    it("says nothing when one of two has answered: nothing has landed yet", async () => {
      await h.core.check(gateRefund(REFUND_SC3));
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(inRoom().filter((body) => body.includes("approved by"))).toEqual([]);
    });

    it("says how break-glass ended it", async () => {
      await asked();
      const held = await h.core.check(gateRefund(REFUND_SC3));
      await h.core.onMessage(chatMessage(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} checkout is down`, { roomId: "#approvals", threadId: null, addressed: true }));
      expect(inRoom()).toContain(`${held.request_id} let through by break-glass by Alex.`);
    });

    it("says nothing with no copy, and nothing about timing ever", async () => {
      await asked();
      await h.core.check(gateRefund(REFUND_SC3, { session: undefined }));
      h.core.stores.db.prepare(`DELETE FROM routes WHERE step = 'origin_copy'`).run();
      h.chat.messages.length = 0;
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(h.chat.messages.filter((message) => message.body.endsWith("denied by Sam."))).toEqual([]);
    });

    it("says nothing about a drill", async () => {
      await asked();
      await h.core.sendDrill("sam");
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(inRoom()).toEqual([]);
    });
  });
});

describe("naming the approver on the card", () => {
  const dm = (who: string, room: string, messageId: string) => h.core.onMessage(chatMessage(who, "hello", { roomId: room, threadId: null, addressed: true, messageId }));
  const notified = (room: string) => h.chat.targeted.filter((message) => message.roomId === room);

  it("mentions the person's own message in their direct room, and then needs no separate note", async () => {
    await dm(PARTICIPANTS.sam, "dm-sam", "sw_sam_1");
    await asked();
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("dm-sam").mentionMessageId).toBe("sw_sam_1");
    expect(notified("dm-sam")).toEqual([]);
  });

  it("uses their latest", async () => {
    await dm(PARTICIPANTS.sam, "dm-sam", "sw_sam_1");
    await dm(PARTICIPANTS.sam, "dm-sam", "sw_sam_2");
    await asked();
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("dm-sam").mentionMessageId).toBe("sw_sam_2");
  });

  it("doesn't use someone else's message, or one from another room", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.neha, "hello", { roomId: "dm-sam", threadId: null, messageId: "sw_neha" }));
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "hello", { roomId: "#random", threadId: null, messageId: "sw_elsewhere" }));
    await asked();
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("dm-sam").mentionMessageId).toBeUndefined();
  });

  it("doesn't use an agent's", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "hello", { roomId: "dm-sam", threadId: null, messageId: "sw_agent" }));
    await asked();
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("dm-sam").mentionMessageId).toBeUndefined();
  });

  it("still tells them by name when they've never written there: there is no message to mention", async () => {
    await asked();
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("dm-sam").mentionMessageId).toBeUndefined();
    expect(notified("dm-sam").map((message) => message.targets)).toEqual([["sam"]]);
  });

  it("names whoever asked on the room's copy, which then needs no note in the room", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle Meera's ticket T-77", { messageId: "sw_priya" }));
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("#support").mentionMessageId).toBe("sw_priya");
    expect(notified("#support")).toEqual([]);
  });

  it("still opens the card if Switch won't take the mention, because nobody should lose a card over it", async () => {
    await dm(PARTICIPANTS.sam, "dm-sam", "sw_gone");
    await asked();
    const original = h.chat.openCard.bind(h.chat);
    h.chat.openCard = async (input: OpenCardInput) => {
      if (input.mentionMessageId) throw new Error("no such message");
      return original(input);
    };
    await h.core.check(gateRefund(REFUND_SC3));
    expect(lastCard("dm-sam").mentionMessageId).toBeUndefined();
    expect(notified("dm-sam").map((message) => message.targets)).toEqual([["sam"]]);
  });

  it("stays inside 960 either way", async () => {
    await dm(PARTICIPANTS.sam, "dm-sam", "sw_sam_1");
    await asked();
    await h.core.check(gateRefund(REFUND_SC4));
    expect(DETAIL_BUDGET).toBe(960);
    expect(renderedCost(lastCard("dm-sam").detail)).toBeLessThanOrEqual(960);
  });

  it("applies to review, proposal and break-glass review cards", async () => {
    await dm(PARTICIPANTS.sam, "dm-sam", "sw_sam_1");
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    await asked();
    await h.core.check(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" }));
    expect(lastCard("dm-sam").title).toContain("REVIEW");
    expect(lastCard("dm-sam").mentionMessageId).toBe("sw_sam_1");
    expect(notified("dm-sam")).toEqual([]);
  });
});

describe("the stream position", () => {
  const POSITION = { s: 12, t: 3 };

  it("has nothing to start from on a new database", () => {
    expect(readStreamPosition(h.core.stores.db)).toBeUndefined();
  });

  it("only moves forward, source by source", () => {
    writeStreamPosition(h.core.stores.db, POSITION);
    writeStreamPosition(h.core.stores.db, { s: 10, u: 1 });
    expect(readStreamPosition(h.core.stores.db)).toEqual({ s: 12, t: 3, u: 1 });
  });

  it("survives a restart", () => {
    writeStreamPosition(h.core.stores.db, POSITION);
    h = h.restart();
    expect(readStreamPosition(h.core.stores.db)).toEqual(POSITION);
  });

  it("isn't taken from a value it can't read", () => {
    h.core.stores.db.prepare(`INSERT INTO meta (key, value) VALUES ('switch_stream_position', 'not json')`).run();
    expect(readStreamPosition(h.core.stores.db)).toBeUndefined();
  });

  it("moves only after core has the message, so one that fails is delivered again", async () => {
    const handlers = streamHandlers(h.core);
    const event = chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it");
    h.core.onMessage = async () => {
      throw new Error("core is broken");
    };
    await expect(handlers.message?.(event, { position: POSITION })).rejects.toThrow("core is broken");
    expect(readStreamPosition(h.core.stores.db)).toBeUndefined();
  });

  it("runs what else was asked for, once core has it", async () => {
    const seen: string[] = [];
    const handlers = streamHandlers(h.core, { afterMessage: (event) => void seen.push(event.messageId) });
    await handlers.message?.(chatMessage(PARTICIPANTS.priya, "hi", { messageId: "sw_1" }), { position: POSITION });
    expect(seen).toEqual(["sw_1"]);
    expect(readStreamPosition(h.core.stores.db)).toEqual(POSITION);
  });

  describe("with the fake agent, across a restart", () => {
    const message = (messageId: string, body: string, seq: number) => ({
      ...frame("message_other_agent_addressed"),
      room_id: "#support",
      channel_type: "channel_private",
      payload: {
        ...(frame("message_other_agent_addressed").payload as Record<string, unknown>),
        sender: PARTICIPANTS.priya,
        sender_name: "priya",
        message_id: messageId,
        body,
        timestamp: NOW,
      },
      position: { "r:support": seq },
    });

    async function connect(server: FakeSwitch, index: number) {
      const saved = readStreamPosition(h.core.stores.db);
      const agent = createSwitchAgent({
        bridgeUrl: "http://switch.test/",
        agentId: AGENT_ID,
        apiKey: API_KEY,
        fetch: server.fetch,
        logger: quietLogger(),
        heartbeatMs: 20,
        reconnectDelayMs: { first: 5, max: 20 },
        ...(saved ? { initialPosition: saved } : {}),
      });
      const ready = agent.start(streamHandlers(h.core));
      const stream = await server.stream(index);
      stream.send("connection_state", { ...frame("connection_state"), generation: index + 1 });
      await ready;
      return { agent, stream };
    }

    it("opens where it left off, and a message sent while core was down still names who asked", async () => {
      const server = new FakeSwitch();
      const first = await connect(server, 0);
      expect(first.stream.query.get("start_at")).toBe("head");
      first.stream.send("message", message("sw_1", "good morning all", 41));
      await vi.waitFor(() => expect(readStreamPosition(h.core.stores.db)).toEqual({ "r:support": 41 }));
      await first.agent.stop();

      // Core is down. Priya asks the agent, which calls the gate once core is back.
      const second = await connect(server, 1);
      expect(JSON.parse(second.stream.query.get("start_at") as string)).toEqual({ "r:support": 41 });
      second.stream.send("message", message("sw_2", "@refunds-agent handle Meera's ticket T-77", 42));
      await vi.waitFor(() => expect(readStreamPosition(h.core.stores.db)).toEqual({ "r:support": 42 }));
      await second.agent.stop();

      const held = await h.core.check(gateRefund(REFUND_SC3));
      const request = h.core.stores.requests.require(held.request_id as string);
      expect(request.requesterIds).toEqual(["priya"]);
      expect(request.flags.map((flag) => flag.code)).not.toContain("requester_unknown");
      expect(request.quorumRequired).toBe(1);
    });
  });

  describe("a command delivered late, after a restart", () => {
    const late = (body: string, ageMs: number) =>
      h.core.onMessage(chatMessage(PARTICIPANTS.alex, body, { roomId: "#approvals", threadId: null, addressed: true, timestampMs: NOW - ageMs }));

    it("isn't acted on: break-glass an hour later isn't what was asked for", async () => {
      await asked();
      const held = await h.core.check(gateRefund(REFUND_SC4));
      await late(`@clearance breakglass ${held.request_id} checkout is down`, 60 * MINUTE);
      expect(h.gate.calls).toEqual([]);
      expect(h.core.stores.requests.require(held.request_id as string).state).toBe("ROUTED");
    });

    it("is acted on when it's fresh", async () => {
      await asked();
      const held = await h.core.check(gateRefund(REFUND_SC4));
      await late(`@clearance breakglass ${held.request_id} checkout is down`, MINUTE);
      expect(h.gate.calls).toHaveLength(1);
    });

    it("still counts as who asked: being late doesn't change who sent it", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it", { timestampMs: NOW - 60 * MINUTE }));
      const held = await h.core.check(gateRefund(REFUND_SC4));
      expect(h.core.stores.requests.require(held.request_id as string).requesterIds).toEqual(["priya"]);
    });
  });

  it("passes answers to core", async () => {
    await asked();
    const held = await h.core.check(gateRefund(REFUND_SC3));
    const card = lastCard("dm-sam");
    const handlers = streamHandlers(h.core);
    await handlers.approvalOutcome?.({
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "deny",
      answeredBy: PARTICIPANTS.sam,
      answeredAtMs: h.clock.nowMs(),
    });
    expect(h.core.stores.requests.require(held.request_id as string).state).toBe("DENIED");
  });
});

describe("business hours in the demo policy", () => {
  it("are always on, so a recording at night reads the same as one by day", async () => {
    expect(h.core.policy().file.defaults.business_hours).toMatchObject({ days: "Mon-Sun", hours: "00:00-24:00" });
    h.clock.set(Date.parse("2026-11-08T03:30:00+05:30"));
    await asked();
    const night = await h.core.check(gateRefund(REFUND_SC3));
    expect(night.flags?.map((flag) => flag.code)).not.toContain("outside_hours");
  });

  describe("outside_hours() itself, against a policy that has hours", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "clearance-hours-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const OFFICE_HOURS = readFileSync(POLICY_PATH, "utf8").replace('days: Mon-Sun, hours: "00:00-24:00"', 'days: Mon-Fri, hours: "09:00-19:00"');
    const at = async (when: string) => {
      const path = join(dir, "policy.yaml");
      writeFileSync(path, OFFICE_HOURS);
      const other = makeHarness({ policyPath: path, now: Date.parse(when) });
      try {
        await other.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
        return await other.core.check(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" }));
      } finally {
        other.core.close();
      }
    };

    it.each([
      ["a weekday afternoon", "2026-11-04T14:00:00+05:30", false],
      ["a weekday at 18:59", "2026-11-04T18:59:00+05:30", false],
      ["a weekday at 19:00", "2026-11-04T19:00:00+05:30", true],
      ["a weekday evening", "2026-11-04T21:30:00+05:30", true],
      ["a Sunday afternoon", "2026-11-08T14:00:00+05:30", true],
    ])("%s", async (_name, when, outside) => {
      const response = await at(when);
      expect((response.flags ?? []).map((flag) => flag.code).includes("outside_hours")).toBe(outside);
      expect(response.score).toBe(outside ? 25 : 20);
    });

    it("is never true when the hours cover the whole week", async () => {
      const policy = parsePolicy(readFileSync(POLICY_PATH, "utf8"), "always-on");
      const db = openDatabase(join(dir, "x.sqlite"));
      try {
        const evaluation = await evaluateAction(gateRefund(REFUND_SC4), {
          policy,
          lookup: h.lookup,
          clock: { nowMs: () => Date.parse("2026-11-08T03:30:00+05:30"), scaledMs: (ms) => ms },
          aggregates: { sum: () => 0 },
          autonomy: { levelFor: () => "L0" },
        });
        expect(evaluation.flags.map((flag) => flag.code)).not.toContain("outside_hours");
      } finally {
        db.close();
      }
    });
  });
});

describe("the points on a refund", () => {
  const BOTH_FLAGS = { order_id: "A-1931", customer_id: "cus_8812", amount: 40000, destination: "meera.k@okaxis" };

  it("the spine scene: ₹4,000 to a newly added UPI ID is medium, one approver, an approval card, and the new destination shows", async () => {
    await asked();
    const held = await h.core.check(gateRefund(REFUND_SC3));
    expect(REFUND_SC3).toMatchObject({ amount: 4000, destination: "meera.k@okaxis" });
    expect(held).toMatchObject({ decision: "hold", tier: "medium", score: 45 });
    expect(held.flags?.map((flag) => flag.code)).toEqual(["new_destination"]);
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired).toBe(1);
    expect(lastCard("dm-sam").kind).toBe("approval");
    expect(lastCard("dm-sam").detail).toContain("Destination added in the last 24 h");
  });

  it("₹40,000 with both flags is critical: typed confirmation and two approvers", async () => {
    await asked();
    const held = await h.core.check(gateRefund(BOTH_FLAGS));
    expect(held).toMatchObject({ decision: "hold", tier: "critical" });
    expect(held.flags?.map((flag) => flag.code)).toEqual(expect.arrayContaining(["amount_vs_order", "new_destination"]));
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired).toBe(2);
    expect(lastCard("dm-sam").kind).toBe("questions");
    expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toHaveLength(1);
  });

  it("a very large refund adds its +40 still", async () => {
    await asked();
    const held = await h.core.check(gateRefund({ order_id: "A-2004", customer_id: "cus_2044", amount: 150000, destination: "rohan.s@okhdfc" }));
    expect(held.tier).toBe("critical");
  });
});
