/** F15: `@clearance install`, and `@clearance ledger` beside it. Identity comes from `sender` and nowhere else. */
import type { ChatMessageEvent } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorCommands } from "../src/commands/operator.js";
import { Installer, installReply, type InstallConfig, type RoomRef, type TemplatePort, type TemplateRun } from "../src/install/install.js";
import type { MirrorReport } from "../src/ledger/mirror.js";
import { chatMessage, makeHarness, PARTICIPANTS, type Harness } from "./harness.js";

/** Switch's template operations, in memory, down to `run_template` happily making a second room. */
class FakeTemplates implements TemplatePort {
  rooms: (RoomRef & { member: boolean })[] = [];
  templates: { id: string; name: string; yaml: string; canEdit: boolean }[] = [];
  runs: { id: string; inputs: Record<string, unknown> }[] = [];
  saves = 0;
  updates = 0;
  failRun = false;
  lookups = 0;
  runResult: Partial<TemplateRun> = {};

  async roomsNamed(name: string) {
    this.lookups += 1;
    return this.rooms.filter((room) => room.name === name);
  }
  async isMember(roomId: string) {
    return this.rooms.find((room) => room.roomId === roomId)?.member ?? false;
  }
  async findTemplate(name: string) {
    const found = this.templates.find((template) => template.name === name);
    return found ? { id: found.id, canEdit: found.canEdit } : null;
  }
  async saveTemplate(input: { name: string; yaml: string }) {
    this.saves += 1;
    if (this.templates.some((template) => template.name === input.name)) throw new Error("a name your owner already uses");
    const id = `tpl-${this.saves}`;
    this.templates.push({ id, name: input.name, yaml: input.yaml, canEdit: true });
    return { id };
  }
  async updateTemplate(id: string, yaml: string) {
    this.updates += 1;
    const template = this.templates.find((entry) => entry.id === id)!;
    template.yaml = yaml;
  }
  async runTemplate(id: string, inputs: Record<string, unknown>): Promise<TemplateRun> {
    if (this.failRun) throw new Error("switch unreachable");
    this.runs.push({ id, inputs });
    const roomId = `room-${this.runs.length}`;
    const roomName = String(inputs.room_name);
    this.rooms.push({ roomId, name: roomName, archived: false, member: true });
    return { roomId, roomName, documents: 1, users: ["sam", "neha", "alex", "priya"], errors: [], ...this.runResult };
  }
}

const CONFIG: InstallConfig = { templateName: "clearance-install", templateYaml: "version: 2\n", roomName: "approvals", policyRoom: "#approvals" };

let h: Harness;
let templates: FakeTemplates;
let rooms: [string, string][];
let commands: OperatorCommands;

beforeEach(() => {
  h = makeHarness();
  templates = new FakeTemplates();
  rooms = [];
  commands = new OperatorCommands({
    directory: h.core.people.directory,
    admins: h.core.team.admins ?? [],
    chat: h.chat,
    installer: new Installer(templates, CONFIG),
    onRoom: (name, id) => void rooms.push([name, id]),
  });
});
afterEach(() => {
  h.core.close();
});

const say = (sender: string, body = "@clearance install", overrides: Partial<ChatMessageEvent> = {}) =>
  commands.onMessage(chatMessage(sender, body, { roomId: "dm-x", threadId: null, addressed: true, ...overrides }));
const reply = () => h.chat.messages.at(-1)?.body;

describe("who may install", () => {
  it("is the team file's admins, the same list @clearance drills goes by, and Alex is on it", () => {
    expect(h.core.team.admins).toEqual(["alex"]);
  });

  it("runs for an admin", async () => {
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toHaveLength(1);
  });

  it.each([
    ["a person who isn't an admin", PARTICIPANTS.sam],
    ["the agent's owner, who isn't an admin", PARTICIPANTS.priya],
    ["an account linked to nobody", PARTICIPANTS.guest],
    ["an agent", PARTICIPANTS.refundsAgent],
    ["someone Switch has never heard of", "@switch-user-nobody:localhost"],
  ])("refuses %s, and touches nothing", async (_who, sender) => {
    await say(sender);
    expect(reply()).toContain("Only a team admin");
    expect(reply()).toContain("Alex");
    expect(templates.lookups).toBe(0);
    expect(templates.saves).toBe(0);
    expect(templates.runs).toEqual([]);
  });

  it("goes by sender, not by anything the message or the name on it claims", async () => {
    await say(PARTICIPANTS.sam, "@clearance install", { senderName: "alex", onBehalfOf: "Alex" });
    expect(templates.runs).toEqual([]);
    await say(PARTICIPANTS.sam, "@clearance install as alex");
    expect(templates.runs).toEqual([]);
    expect(reply()).toContain("Only a team admin");
  });

  it("ignores itself", async () => {
    const before = h.chat.messages.length;
    await say(PARTICIPANTS.clearance);
    expect(h.chat.messages).toHaveLength(before);
  });
});

describe("what it does", () => {
  it("saves the template, runs it with the room's name, and replies with what it made", async () => {
    await say(PARTICIPANTS.alex);
    expect(templates.templates.map((template) => template.name)).toEqual(["clearance-install"]);
    expect(templates.runs).toEqual([{ id: "tpl-1", inputs: { room_name: "approvals" } }]);
    expect(reply()).toContain("Installed. I made #approvals with sam, neha, alex, priya, and 1 document");
  });

  it("says what a template can't do", async () => {
    await say(PARTICIPANTS.alex);
    expect(reply()).toContain("send me one direct message");
    expect(reply()).toContain("!invite-agent @clearance");
  });

  it("tells the core which room the policy's name now means", async () => {
    await say(PARTICIPANTS.alex);
    expect(rooms).toEqual([["#approvals", "room-1"]]);
  });

  it("reports what the template said went wrong", async () => {
    templates.runResult = { errors: ["approvals: Unknown agents: clearance"] };
    await say(PARTICIPANTS.alex);
    expect(reply()).toContain("Some of it failed: approvals: Unknown agents: clearance");
  });

  it("says plainly when the run fails, and running it again works", async () => {
    templates.failRun = true;
    await say(PARTICIPANTS.alex);
    expect(reply()).toContain("didn't finish: switch unreachable");
    templates.failRun = false;
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toHaveLength(1);
    expect(reply()).toContain("Installed.");
  });

  it("answers in the thread it was asked in", async () => {
    await say(PARTICIPANTS.alex, "@clearance install", { roomId: "#eng", threadId: "t-9" });
    expect(h.chat.messages.at(-1)).toMatchObject({ roomId: "#eng", threadId: "t-9" });
  });

  it("ignores other words, and a mention in the middle of a sentence", async () => {
    const before = h.chat.messages.length;
    await say(PARTICIPANTS.alex, "@clearance installation");
    await say(PARTICIPANTS.alex, "please don't @clearance install yet");
    await say(PARTICIPANTS.alex, "@clearance install now");
    expect(h.chat.messages).toHaveLength(before);
    expect(templates.runs).toEqual([]);
  });

  it("reads a command as core does: not addressed is talk, and a direct room needs no mention", async () => {
    await say(PARTICIPANTS.alex, "@clearance install", { addressed: false });
    expect(templates.runs).toEqual([]);
    await say(PARTICIPANTS.alex, "install", { channelType: "direct" });
    expect(templates.runs).toHaveLength(1);
  });
});

describe("running it again", () => {
  it("makes nothing and says so, because run_template would make a second room", async () => {
    await say(PARTICIPANTS.alex);
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toHaveLength(1);
    expect(templates.rooms.filter((room) => room.name === "approvals")).toHaveLength(1);
    expect(reply()).toContain("already installed");
    expect(reply()).toContain("made nothing new");
  });

  it("two at once make one room, with the template already saved so neither is stopped by the name", async () => {
    templates.templates.push({ id: "tpl-old", name: "clearance-install", yaml: "old", canEdit: true });
    await Promise.all([say(PARTICIPANTS.alex), say(PARTICIPANTS.alex)]);
    expect(templates.runs).toHaveLength(1);
    expect(templates.rooms).toHaveLength(1);
  });

  it("finds a room from before this process, and still tells the core about it", async () => {
    templates.rooms.push({ roomId: "room-old", name: "approvals", archived: false, member: true });
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toEqual([]);
    expect(templates.saves).toBe(0);
    expect(rooms).toEqual([["#approvals", "room-old"]]);
  });

  it("won't make a second room beside one it isn't in, and says how to fix it", async () => {
    templates.rooms.push({ roomId: "room-theirs", name: "approvals", archived: false, member: false });
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toEqual([]);
    expect(reply()).toContain("I'm not in it");
    expect(reply()).toContain("!invite-agent @clearance");
    expect(rooms).toEqual([]);
  });

  it("won't make a second room beside an archived one", async () => {
    templates.rooms.push({ roomId: "room-old", name: "approvals", archived: true, member: true });
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toEqual([]);
    expect(reply()).toContain("archived");
  });

  it("doesn't mistake a room with a similar name for the real one", async () => {
    templates.rooms.push({ roomId: "room-other", name: "approvals-old", archived: false, member: true });
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toHaveLength(1);
  });

  it("reuses a saved template and brings it up to date, since saving the same name again is refused", async () => {
    templates.templates.push({ id: "tpl-old", name: "clearance-install", yaml: "old", canEdit: true });
    await say(PARTICIPANTS.alex);
    expect(templates.saves).toBe(0);
    expect(templates.updates).toBe(1);
    expect(templates.templates[0]?.yaml).toBe(CONFIG.templateYaml);
    expect(templates.runs[0]?.id).toBe("tpl-old");
  });

  it("won't run someone else's template of the same name", async () => {
    templates.templates.push({ id: "tpl-theirs", name: "clearance-install", yaml: "other", canEdit: false });
    await say(PARTICIPANTS.alex);
    expect(templates.runs).toEqual([]);
    expect(reply()).toContain("isn't mine to change");
  });
});

describe("nothing here holds up an answer", () => {
  it("start returns at once with a copy stuck, and answers it when the copy comes back", async () => {
    let release: (report: MirrorReport) => void = () => {};
    const stuck = new Promise<MirrorReport>((done) => {
      release = done;
    });
    const quiet = new OperatorCommands({ directory: h.core.people.directory, admins: [], chat: h.chat, mirror: { flush: () => stuck } });
    const before = h.chat.messages.length;
    quiet.start(chatMessage(PARTICIPANTS.sam, "@clearance ledger", { roomId: "dm-sam", threadId: null, addressed: true }));
    await new Promise((done) => setImmediate(done));
    expect(h.chat.messages).toHaveLength(before);

    release({ ok: true, mirrored_seq: 1, head_seq: 1, documents: [], state_updated: false, error: null });
    await new Promise((done) => setImmediate(done));
    expect(h.chat.messages.at(-1)?.body).toContain("runs through entry 1");
  });

  it("start doesn't let a failure escape, and logs it", async () => {
    const logged: string[] = [];
    const broken = new OperatorCommands({
      directory: h.core.people.directory,
      admins: h.core.team.admins ?? [],
      chat: h.chat,
      mirror: {
        flush: async () => {
          throw new Error("nothing should throw here, but");
        },
      },
      log: (message) => void logged.push(message),
    });
    broken.start(chatMessage(PARTICIPANTS.sam, "@clearance ledger", { roomId: "dm-sam", threadId: null, addressed: true }));
    await new Promise((done) => setImmediate(done));
    expect(logged.join()).toContain("nothing should throw here, but");
  });

  it("still replies when the room can't be remembered", async () => {
    const logged: string[] = [];
    commands = new OperatorCommands({
      directory: h.core.people.directory,
      admins: h.core.team.admins ?? [],
      chat: h.chat,
      installer: new Installer(templates, CONFIG),
      onRoom: () => {
        throw new Error("disk full");
      },
      log: (message) => void logged.push(message),
    });
    await say(PARTICIPANTS.alex);
    expect(reply()).toContain("Installed.");
    expect(logged.join()).toContain("disk full");
  });
});

describe("the wording", () => {
  it("counts documents properly", () => {
    const run: TemplateRun = { roomId: "r", roomName: "approvals", documents: 2, users: [], errors: [] };
    expect(installReply({ kind: "created", run, policyRoom: "#approvals" })).toContain("I made #approvals, and 2 documents");
  });
});

describe("@clearance ledger", () => {
  const report: MirrorReport = { ok: true, mirrored_seq: 9, head_seq: 9, documents: ["clearance-ledger-2026-11-04"], state_updated: true, error: null };
  const withMirror = (flush: () => Promise<MirrorReport>, page: string | null = null) =>
    new OperatorCommands({
      directory: h.core.people.directory,
      admins: h.core.team.admins ?? [],
      chat: h.chat,
      mirror: { flush },
      mirrorRoom: "#approvals",
      documentsPage: () => page,
    });

  it("copies on demand for anyone, and says what it copied and where to read it", async () => {
    commands = withMirror(async () => report, "http://gateway/rooms/abc");
    await say(PARTICIPANTS.sam, "@clearance ledger");
    expect(reply()).toBe(
      "Copied the ledger to #approvals, through entry 9: clearance-ledger-2026-11-04 and clearance-state. Read it on the room's page: http://gateway/rooms/abc",
    );
  });

  it("says when there was nothing new", async () => {
    commands = withMirror(async () => ({ ...report, documents: [], state_updated: false }));
    await say(PARTICIPANTS.sam, "@clearance ledger");
    expect(reply()).toContain("runs through entry 9");
  });

  it("says nothing is lost when Switch won't take it", async () => {
    commands = withMirror(async () => ({ ...report, ok: false, mirrored_seq: 4, documents: [], state_updated: false, error: "switch unreachable" }));
    await say(PARTICIPANTS.sam, "@clearance ledger");
    expect(reply()).toContain("Nothing is lost");
    expect(reply()).toContain("through entry 4");
  });

  it("never says how far behind the copy is, since standing still is what an open drill looks like", async () => {
    const behind: MirrorReport = { ok: true, mirrored_seq: 4, head_seq: 90, documents: [], state_updated: false, error: null };
    const level: MirrorReport = { ...behind, head_seq: 4 };
    commands = withMirror(async () => behind);
    await say(PARTICIPANTS.sam, "@clearance ledger");
    const whileBehind = reply();
    commands = withMirror(async () => level);
    await say(PARTICIPANTS.sam, "@clearance ledger");
    expect(reply()).toBe(whileBehind);
    expect(whileBehind).not.toContain("90");
    expect(whileBehind).not.toContain("up to date");
  });
});
