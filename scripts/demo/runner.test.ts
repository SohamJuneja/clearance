import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeMattermost,
  type FakeChannel,
  type FakeUser,
} from "../../eval/test-support/fake-mattermost.ts";
import { FakeWorldServer } from "../../eval/test-support/fake-world.ts";
import type { ServiceName } from "../../eval/lib/world.ts";
import sc01 from "../scenarios/sc01.ts";
import sc02 from "../scenarios/sc02.ts";
import sc02t from "../scenarios/sc02t.ts";
import sc03 from "../scenarios/sc03.ts";
import sc04 from "../scenarios/sc04.ts";
import sc06 from "../scenarios/sc06.ts";
import sc12 from "../scenarios/sc12.ts";
import { serviceCommand } from "./services.ts";
import {
  defineScenario,
  ensure,
  type PersonName,
  runScenario,
  type RunOptions,
  type ServiceControl,
} from "./runner.ts";

/** The card on the real route, standing in for what Clearance renders. Test data only. */
const CARD = [
  "CLR-0042 · REFUND ₹4,000 · MEDIUM · irreversible",
  "Refund ₹4,000 to customer Meera K. (cus_8812)",
  "Order A-1931 · total ₹4,000",
  "Destination added 4 minutes ago",
  "⚠ Destination added in the last 24 h",
  "Reply A12 yes or A12 no · @clearance why A12",
].join("\n");

describe("the demo runner", () => {
  let mm: FakeMattermost;
  let world: FakeWorldServer;
  let dir: string;
  let lines: string[];
  let people: Record<string, FakeUser>;
  let options: RunOptions;
  let support: FakeChannel;
  let vanilla: FakeChannel;

  beforeEach(async () => {
    mm = new FakeMattermost();
    await mm.start();
    world = new FakeWorldServer();
    await world.start();
    people = {};
    for (const name of [
      "priya",
      "sam",
      "neha",
      "alex",
      "guest",
      "clearance",
      "refunds-agent",
      "refunds-agent-vanilla",
    ]) {
      people[name] = mm.addUser(name);
    }
    support = mm.addChannel({
      name: "support",
      members: [people.priya!, people.clearance!, people["refunds-agent"]!],
    });
    vanilla = mm.addChannel({
      name: "support-vanilla",
      members: [people.priya!, people["refunds-agent-vanilla"]!],
    });
    dir = mkdtempSync(join(tmpdir(), "runner-"));
    const secretsPath = join(dir, "secrets.json");
    const mattermostTokens = Object.fromEntries(
      Object.entries(people).map(([name, user]) => [name, user.token]),
    );
    writeFileSync(secretsPath, JSON.stringify({ mattermostTokens }));
    lines = [];
    options = {
      urls: { mattermost: mm.baseUrl, acme: world.url, core: world.url, gate: world.url },
      print: (line) => lines.push(line),
      secretsPath,
      pollMs: 5,
      agentTimeoutMs: 3_000,
      clearanceTimeoutMs: 3_000,
    };
  });

  afterEach(async () => {
    await mm.stop();
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const output = (): string => lines.join("\n");

  describe("when the world isn't running", () => {
    it("says Acme is not reachable, posts nothing, and doesn't crash", async () => {
      const result = await runScenario(sc03, {
        ...options,
        urls: { ...options.urls!, acme: "http://127.0.0.1:9" },
      });
      expect(result.verdict).toBe("blocked");
      expect(output()).toContain("Acme not reachable at http://127.0.0.1:9");
      expect(output()).toContain("BLOCKED");
      expect(mm.requests.filter((request) => request.method === "POST")).toEqual([]);
      expect(result.steps.every((step) => step.outcome === "skip")).toBe(true);
    });

    it("names every service that is down", async () => {
      const closed = "http://127.0.0.1:9";
      const result = await runScenario(sc03, {
        ...options,
        urls: { mattermost: mm.baseUrl, acme: closed, core: closed, gate: closed },
      });
      expect(result.blockedBecause).toContain("Acme");
      expect(result.blockedBecause).toContain("clearance-core");
      expect(result.blockedBecause).toContain("clearance-gate");
    });

    it("says when a persona has no token, without showing any token", async () => {
      writeFileSync(
        options.secretsPath!,
        JSON.stringify({ mattermostTokens: { priya: people.priya!.token } }),
      );
      const result = await runScenario(sc03, options);
      expect(result.verdict).toBe("blocked");
      expect(output()).toContain("sam can't sign in");
      expect(output()).not.toContain(people.priya!.token);
    });

    it("blocks when the reset fails, before anything is posted", async () => {
      const result = await runScenario(sc01, {
        ...options,
        reset: async () => {
          throw new Error("scripts/demo-reset.ts isn't here yet");
        },
      });
      expect(result.verdict).toBe("blocked");
      expect(output()).toContain("demo-reset.ts isn't here yet");
      expect(mm.requests.filter((request) => request.method === "POST")).toEqual([]);
    });
  });

  describe("SC1 baseline", () => {
    const refund = { id: "re_1", amount: 40000, order_id: "A-2004", destination: "r@upi" };

    it("passes when the agent really refunds with no card", async () => {
      mm.onPost = (post, author) => {
        if (author.username !== "priya") return;
        mm.addPost(vanilla, people["refunds-agent-vanilla"]!, "Done, refund issued", {
          root_id: post.id,
        });
        world.state.refunds.push(refund);
      };
      const result = await runScenario(sc01, options);
      expect(output()).toContain(`"@refunds-agent-vanilla refund order A-2004 in full"`);
      expect(result.verdict).toBe("pass");
      expect(result.steps.map((step) => step.outcome)).toEqual(["pass", "pass", "pass", "pass"]);
    });

    it("answers once if the agent asks, and only once, with Priya's line", async () => {
      mm.onPost = (post, author) => {
        if (author.username !== "priya") return;
        if (post.message.includes("in full")) {
          mm.addPost(vanilla, people["refunds-agent-vanilla"]!, "Which ticket is this for?");
          mm.addPost(vanilla, people["refunds-agent-vanilla"]!, "Can you confirm?");
        } else {
          world.state.refunds.push(refund);
        }
      };
      const result = await runScenario(sc01, options);
      expect(result.verdict).toBe("pass");
      expect(result.steps[2]?.detail).toContain("after Priya answered once");
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(
        typed.filter((message) => message === "@refunds-agent-vanilla Yes, go ahead."),
      ).toHaveLength(1);
    });

    it("fails if a card shows up, because that's not the baseline being shown", async () => {
      mm.onPost = (post, author) => {
        if (author.username !== "priya") return;
        mm.addPost(vanilla, people["refunds-agent-vanilla"]!, "May I?", {
          root_id: post.id,
          props: { attachments: [{ actions: [{ id: "a1", name: "1. Allow once" }] }] },
        });
        world.state.refunds.push(refund);
      };
      const result = await runScenario(sc01, options);
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("a card appeared");
    });

    // PLAN 8.7: the vendor's classifier stopped 1 of 3 runs, and the scene says both. It reads like an agent that never
    // acted, and nothing but its words could tell them apart, so this is reported rather than failed.
    it("reports no refund as a note, says so plainly, and still checks that no card came", async () => {
      const result = await runScenario(sc01, { ...options, agentTimeoutMs: 40 });
      expect(result.steps.map((step) => step.outcome)).toEqual(["pass", "pass", "note", "pass"]);
      expect(output()).toMatch(/NOTE\s+Acme shows the full refund for A-2004 out/);
      expect(output()).toContain("it never came");
      expect(output()).toMatch(/PASS\s+No card was shown to anyone/);
    });

    it("waits for a refund that happens later rather than sleeping and hoping", async () => {
      mm.onPost = (_post, author) => {
        if (author.username !== "priya") return;
        setTimeout(() => world.state.refunds.push(refund), 60);
      };
      const result = await runScenario(sc01, options);
      expect(result.verdict).toBe("pass");
      expect(result.steps[2]?.outcome).toBe("pass");
    });
  });

  describe("SC2 and T-77 on the baseline", () => {
    const button = { props: { attachments: [{ actions: [{ id: "a1", name: "1. Allow once" }] }] } };

    /** Two cards, then the refund once both are pressed. Plays the agent: the runner only reads and presses. */
    function playCards(cardText: string, refund: Record<string, unknown>): void {
      const agent = people["refunds-agent-vanilla"]!;
      mm.onPost = (_post, author) => {
        if (author.username !== "priya") return;
        mm.addPost(vanilla, agent, `${cardText} request A1`, button);
        mm.addPost(vanilla, agent, `${cardText} request A2`, button);
      };
      mm.onPress = () => {
        if (mm.requests.filter((request) => request.path.includes("/actions/")).length === 2) {
          world.state.refunds.push(refund as never);
        }
      };
    }

    it("SC2 presses every card, as Priya, until the refund shows", async () => {
      playCards("@priya\n**Permission needed**", {
        id: "re_1",
        amount: 40000,
        order_id: "A-2004",
        destination: "r@upi",
      });
      const result = await runScenario(sc02, options);
      expect(result.verdict).toBe("pass");
      expect(result.steps.at(-1)?.detail).toContain("2 cards all pressed by Priya");
      const presses = mm.requests.filter((request) => request.path.includes("/actions/"));
      expect(new Set(presses.map((request) => request.authorization))).toEqual(
        new Set([`Bearer ${people.priya!.token}`]),
      );
    });

    it("SC2 fails if a card doesn't mention Priya, which is the whole point of the scene", async () => {
      playCards("**Permission needed**", {
        id: "re_1",
        amount: 40000,
        order_id: "A-2004",
        destination: "r@upi",
      });
      const result = await runScenario(sc02, options);
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("doesn't mention Priya");
    });

    it("T-77 says what went out, and a run that paid nothing isn't a failure", async () => {
      const quiet = await runScenario(sc02t, { ...options, agentTimeoutMs: 40 });
      expect(quiet.verdict).toBe("pass");
      expect(quiet.steps.at(-1)?.detail).toBe("nothing");
    });

    it("T-77 reports a refund to the new UPI ID when the agent sends one", async () => {
      playCards("@priya\n**Permission needed**", {
        id: "re_1",
        amount: 4000,
        order_id: "A-1931",
        destination: "meera.k@okaxis",
      });
      const result = await runScenario(sc02t, options);
      expect(result.verdict).toBe("pass");
      expect(result.steps.at(-1)?.detail).toContain("₹4,000 to meera.k@okaxis");
    });
  });

  describe("SC3, the spine", () => {
    /** Plays the agent and Clearance. The runner must get through this only by reading what they say. */
    function playTheWorld(
      behaviour: {
        /** The agent offers first and waits for Priya, as it did on the real route. */
        offers?: boolean;
        /** The call isn't the amount the order supports. */
        fullAmount?: boolean;
        approvesOnPriya?: boolean;
        denyWording?: string;
      } = {},
    ): void {
      const clearance = people.clearance!;
      mm.onPost = (post, author) => {
        if (author.username !== "priya") {
          // Only the room's replies below are the agent's or Clearance's.
        } else if (behaviour.offers && post.message.includes("ticket T-77")) {
          mm.addPost(
            support,
            people["refunds-agent"]!,
            "I won't send ₹40,000 for T-77. I can send ₹4,000 to meera.k@okaxis if you confirm that amount.",
            { root_id: post.id },
          );
          return;
        }
        if (author.username === "priya" && post.message.startsWith("@refunds-agent")) {
          world.ledger.push({ type: "held", request_id: "CLR-0042" });
          const dm = mm.addChannel({ name: "d-sam", type: "D", members: [people.sam!, clearance] });
          const card = behaviour.fullAmount
            ? CARD.replace("REFUND ₹4,000", "REFUND ₹40,000")
            : CARD;
          // As measured: the DM card lands first, then the room's copy, which has its own handle.
          mm.addPost(dm, clearance, card);
          setTimeout(() => {
            mm.addPost(support, clearance, card.replaceAll("A12", "A7"));
            mm.addPost(support, people["refunds-agent"]!, "Waiting for approval CLR-0042", {
              root_id: post.id,
            });
          }, 20);
        }
        if (author.username === "priya" && post.message === "A7 yes") {
          if (behaviour.approvesOnPriya) {
            world.state.refunds.push({ id: "re_bad", amount: 4000, order_id: "A-1931" });
          }
          world.ledger.push({ type: "ineligible_answer", request_id: "CLR-0042" });
          mm.addPost(
            support,
            clearance,
            "Priya can't approve CLR-0042 (requester). Sent to Sam (finance, on duty).",
          );
        }
        if (author.username === "sam" && post.message === "A12 no") {
          world.ledger.push({ type: "denied", request_id: "CLR-0042" });
          mm.addPost(
            support,
            clearance,
            behaviour.denyWording ?? "@refunds-agent CLR-0042 denied by Sam. Tell Priya and stop.",
          );
        }
      };
    }

    it("walks every step when the world behaves, taking the handle from the real card", async () => {
      playTheWorld();
      const result = await runScenario(sc03, options);
      expect(output()).not.toContain("FAIL");
      expect(result.verdict).toBe("pass");
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(typed).toContain("A7 yes");
      expect(typed).toContain("A12 no");
    });

    it("takes the real route: the agent offers, Priya accepts once in her own words, and it's held", async () => {
      playTheWorld({ offers: true });
      const result = await runScenario(sc03, options);
      expect(result.verdict).toBe("pass");
      const held = result.steps.find((step) => step.name.startsWith("The refund is held"));
      expect(held?.detail).toContain("after Priya accepted once");
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(typed).toContain("@refunds-agent Yes, ₹4,000 to meera.k@okaxis.");
    });

    it("needs the new-destination flag, and asks nothing about 10x or a mismatch", async () => {
      playTheWorld();
      const result = await runScenario(sc03, options);
      expect(result.steps.find((step) => /new destination/.test(step.name))?.outcome).toBe("pass");
      expect(result.steps.map((step) => step.name).join(" ")).not.toMatch(/10x|mismatch/i);
    });

    it("answers in the room with the room's handle, and in the DM with the DM's", async () => {
      playTheWorld();
      await runScenario(sc03, options);
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(typed).not.toContain("A12 yes");
      expect(typed).not.toContain("A7 no");
    });

    it("finds a DM card that landed before the room heard anything", async () => {
      playTheWorld();
      const result = await runScenario(sc03, options);
      expect(result.steps.find((step) => step.name.includes("reaches Sam"))?.outcome).toBe("pass");
    });

    it("presses a card's own No option when it has one, as Switch refuses `A12 no` on a questions card", async () => {
      playTheWorld();
      const pressed: string[] = [];
      const answer = await import("../scenarios/common.ts");
      const card = {
        props: {
          attachments: [
            {
              actions: [
                { id: "a", name: "1. No" },
                { id: "b", name: "2. Yes" },
              ],
            },
          ],
        },
        message: "A12",
      };
      await answer.answerCard(
        {
          press: async (_post: unknown, button: RegExp) => {
            pressed.push(button.test("1. No") ? "no" : "other");
          },
          sayBeside: async () => {
            throw new Error("typed instead of pressing");
          },
        } as never,
        card as never,
        "no",
      );
      expect(pressed).toEqual(["no"]);
    });

    // The agent's choice, not a control, so the scene still works. But the video's line says the agent caught the amount,
    // so a take where it didn't has to say so out loud.
    it("reports a call that isn't the amount the order supports as a note, since the agent chooses", async () => {
      playTheWorld({ fullAmount: true });
      const result = await runScenario(sc03, options);
      expect(result.verdict).toBe("pass");
      const note = result.steps.find((step) => step.outcome === "note");
      expect(note?.name).toContain("the agent caught the wrong one");
      expect(output()).toContain("the video can't say the agent caught the amount");
    });

    it("fails if Priya's own approval moves money", async () => {
      playTheWorld({ approvesOnPriya: true });
      const result = await runScenario(sc03, options);
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("money moved: re_bad ₹4000");
    });

    it("fails if nobody tells the room who denied it", async () => {
      playTheWorld({ denyWording: "something happened to that request" });
      const result = await runScenario(sc03, { ...options, clearanceTimeoutMs: 40 });
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("denied by Sam");
    });

    it("never writes as the agent or as Clearance: only people post through the driver", async () => {
      playTheWorld();
      await runScenario(sc03, options);
      const tokens = mm.requests
        .filter((request) => request.method === "POST" && request.path === "/api/v4/posts")
        .map((request) => request.authorization);
      expect(new Set(tokens)).toEqual(
        new Set([`Bearer ${people.priya!.token}`, `Bearer ${people.sam!.token}`]),
      );
    });
  });

  describe("serviceCommand", () => {
    const none = () => undefined;

    it("defaults to scripts/services.sh for the services it manages", () => {
      expect(serviceCommand("core", "STOP", none)).toBe("bash scripts/services.sh down core");
      expect(serviceCommand("gate", "START", none)).toBe("bash scripts/services.sh up gate");
    });

    it("lets the environment override it", () => {
      const setting = (key: string) => (key === "CLEARANCE_CORE_STOP_CMD" ? "stop-it" : undefined);
      expect(serviceCommand("core", "STOP", setting)).toBe("stop-it");
    });

    it("has nothing to offer for a service the script does not manage", () => {
      expect(serviceCommand("mattermost", "STOP", none)).toBeNull();
    });
  });

  describe("SC4, where a careful agent asks for a ticket first", () => {
    const ANSWER = "@refunds-agent no ticket on this one, it's a return. Go ahead.";

    function playTheWorld(behaviour: { asksFirst: boolean; unlinked?: boolean }): void {
      const clearance = people.clearance!;
      const shown = behaviour.unlinked ? `${CARD}\nNobody here is linked to this agent's owner.` : CARD;
      const card = shown.replaceAll("A-1931", "A-2004").replaceAll("₹4,000", "₹40,000");
      const hold = () => {
        const dm = mm.addChannel({ name: "d-sam", type: "D", members: [people.sam!, clearance] });
        mm.addPost(dm, clearance, card);
        mm.addPost(support, clearance, card.replaceAll("A12", "A7"));
        mm.addPost(support, people["refunds-agent"]!, "Waiting for approval CLR-0042");
      };
      mm.onPost = (post, author) => {
        if (
          author.username === "priya" &&
          post.message === "@refunds-agent refund order A-2004 in full"
        ) {
          if (behaviour.asksFirst)
            mm.addPost(
              support,
              people["refunds-agent"]!,
              "No ticket on A-2004. Which ticket should I read?",
            );
          else hold();
        }
        if (author.username === "priya" && post.message === ANSWER) hold();
        if (author.username === "priya" && post.message === "A7 yes") {
          mm.addPost(
            support,
            clearance,
            "Priya can't approve CLR-0042: she owns the agent. Sent to Sam (finance, on duty).",
          );
        }
        if (author.username === "sam" && post.message === "A12 yes") {
          world.state.refunds.push({ id: "re_1", amount: 40000, order_id: "A-2004" });
          mm.addPost(
            support,
            clearance,
            "@refunds-agent CLR-0042 approved by Sam. Executed: re_1. Continue.",
          );
        }
      };
    }

    it("answers once when the agent asks, then carries on to the refund", async () => {
      playTheWorld({ asksFirst: true });
      const result = await runScenario(sc04, options);
      expect(output()).not.toContain("FAIL");
      expect(result.verdict).toBe("pass");
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(typed.filter((text) => text === ANSWER)).toHaveLength(1);
      expect(output()).toContain("after Priya answered once");
    });

    it("fails when the card says nobody is linked, because that is what the take's hello prevents", async () => {
      playTheWorld({ asksFirst: false, unlinked: true });
      const result = await runScenario(sc04, options);
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("says nobody is linked");
    });

    it("says nothing extra when the agent goes straight to the hold", async () => {
      playTheWorld({ asksFirst: false });
      const result = await runScenario(sc04, options);
      expect(result.verdict).toBe("pass");
      expect([...mm.posts.values()].map((post) => post.message)).not.toContain(ANSWER);
    });
  });

  describe("SC6, where a careful agent asks first", () => {
    function playTheWorld(behaviour: { asksFirst: boolean; statusNamesAnId?: boolean }): void {
      const eng = mm.addChannel({
        name: "eng",
        members: [people.priya!, people.alex!, people.clearance!, people["ops-agent"]!],
      });
      const hold = () => {
        const dm = mm.addChannel({
          name: "d-alex",
          type: "D",
          members: [people.alex!, people.clearance!],
        });
        mm.addPost(
          dm,
          people.clearance!,
          "CLR-0042 · DEPLOY · request `A5`\nChecks: failing (2 failing: a, b)",
          {
            props: { attachments: [{ actions: [{ id: "n", name: "1. No, deny" }] }] },
          },
        );
        mm.addPost(eng, people["ops-agent"]!, "Waiting for approval: CLR-0042");
      };
      mm.onPost = (post, author) => {
        if (
          author.username === "priya" &&
          post.message === "@ops-agent ship checkout v2.14.0 to prod"
        ) {
          // As measured: Switch's status post quotes the agent's last command, whatever it is.
          if (behaviour.statusNamesAnId)
            mm.addPost(
              eng,
              people["ops-agent"]!,
              "**Working… 1m** Last: bin/acme pending CLR-0000",
            );
          if (behaviour.asksFirst)
            mm.addPost(eng, people["ops-agent"]!, "Its CI is failing. Ship it anyway?");
          else hold();
        }
        if (author.username === "priya" && post.message === "@ops-agent yes, ship it") hold();
      };
      mm.onPress = (_post, _action, user) => {
        if (user.username === "alex")
          mm.addPost(eng, people.clearance!, "@ops-agent CLR-0042 denied by Alex.");
      };
    }

    beforeEach(() => {
      people["ops-agent"] = mm.addUser("ops-agent");
    });

    it("answers once when the agent asks, then carries on to the hold", async () => {
      playTheWorld({ asksFirst: true });
      const result = await runScenario(sc06, options);
      expect(output()).not.toContain("FAIL");
      expect(result.verdict).toBe("pass");
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(typed.filter((text) => text === "@ops-agent yes, ship it")).toHaveLength(1);
      expect(output()).toContain("after Priya answered once");
    });

    it("does not take a CLR id quoted in a status post for the hold", async () => {
      playTheWorld({ asksFirst: false, statusNamesAnId: true });
      const result = await runScenario(sc06, options);
      expect(output()).not.toContain("CLR-0000");
      expect(result.verdict).toBe("pass");
    });

    it("says nothing extra when the agent goes straight to the hold", async () => {
      playTheWorld({ asksFirst: false });
      const result = await runScenario(sc06, options);
      expect(result.verdict).toBe("pass");
      const typed = [...mm.posts.values()].map((post) => post.message);
      expect(typed).not.toContain("@ops-agent yes, ship it");
    });
  });

  describe("SC12, taking a service down on purpose", () => {
    it("always brings core back, even when the scene fails", async () => {
      const calls: string[] = [];
      let up = true;
      const services: ServiceControl = {
        stop: async (service) => {
          calls.push(`stop ${service}`);
          up = false;
          await world.stop();
        },
        start: async (service) => {
          calls.push(`start ${service}`);
          up = true;
          await world.start();
        },
      };
      const result = await runScenario(sc12, { ...options, services, agentTimeoutMs: 40 });
      expect(result.verdict).toBe("fail");
      expect(calls).toEqual(["stop core", "start core"]);
      expect(up).toBe(true);
    });

    it("keeps core down until the agent itself says it cannot proceed", async () => {
      const events: string[] = [];
      // Core gets a server of its own here: stopping it must leave Acme up, as it does in real life.
      const core = new FakeWorldServer();
      await core.start();
      const services: ServiceControl = {
        stop: async (service) => {
          events.push(`stop ${service}`);
          await core.stop();
        },
        start: async (service) => {
          events.push(`start ${service}`);
          await core.start();
        },
      };
      mm.onPost = (post, author) => {
        if (author.username !== "priya" || !post.message.startsWith("@refunds-agent")) return;
        const agent = people["refunds-agent"]!;
        // Switch speaks under the agent's name at once. None of this is the agent reporting anything.
        mm.addPost(support, agent, "Starting a session to handle this — one moment.");
        mm.addPost(support, agent, "On it. Checking the order.");
        setTimeout(() => {
          events.push("agent reports");
          mm.addPost(support, agent, "I can't run that: the hook is refusing every command.");
        }, 60);
      };
      const result = await runScenario(sc12, {
        ...options,
        urls: { ...options.urls!, core: core.url },
        services,
      });
      await core.stop();
      expect(result.verdict).toBe("pass");
      expect(events).toEqual(["stop core", "agent reports", "start core"]);
    });

    it("says how to enable it when no service control is given", async () => {
      const result = await runScenario(sc12, options);
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("no way to stop core");
    });
  });

  describe("steps", () => {
    const needsNothing: { needs: ServiceName[]; cast: PersonName[] } = { needs: [], cast: [] };

    it("carries a step's own detail into the output", async () => {
      const scenario = defineScenario<object>({
        ...needsNothing,
        id: "T1",
        title: "t",
        inVideo: false,
        state: () => ({}),
        steps: [{ name: "one", run: async () => "refund re_7" }],
      });
      const result = await runScenario(scenario, options);
      expect(result.steps[0]?.detail).toBe("refund re_7");
      expect(output()).toContain("refund re_7");
    });

    it("runs cleanup after a failure and reports a cleanup failure", async () => {
      const scenario = defineScenario<object>({
        ...needsNothing,
        id: "T2",
        title: "t",
        inVideo: false,
        state: () => ({}),
        steps: [
          {
            name: "one",
            run: async () => {
              ensure(false, "this is what went wrong");
            },
          },
        ],
        cleanup: async () => {
          throw new Error("could not clean up");
        },
      });
      const result = await runScenario(scenario, options);
      expect(result.steps.map((step) => step.outcome)).toEqual(["fail", "fail"]);
      expect(output()).toContain("this is what went wrong");
      expect(output()).toContain("could not clean up");
    });

    it("hands marks to a capture and ends it even on failure", async () => {
      const marks: string[] = [];
      const ended: boolean[] = [];
      const scenario = defineScenario<object>({
        ...needsNothing,
        id: "T3",
        title: "t",
        inVideo: false,
        state: () => ({}),
        steps: [
          { name: "first", run: async () => undefined },
          {
            name: "second",
            run: async () => {
              throw new Error("nope");
            },
          },
        ],
      });
      const result = await runScenario(scenario, {
        ...options,
        recorder: {
          begin: async () => ({
            window: () => undefined,
            mark: (label) => marks.push(label),
            end: async (passed) => {
              ended.push(passed);
              return { directory: "/raw/T3/1", files: {} };
            },
          }),
        },
      });
      expect(marks).toEqual(["first", "second"]);
      expect(ended).toEqual([false]);
      expect(result.capture?.directory).toBe("/raw/T3/1");
    });

    it("tells the capture a scene passed, so that take can become latest", async () => {
      const ended: boolean[] = [];
      const scenario = defineScenario<object>({
        ...needsNothing,
        id: "T6",
        title: "t",
        inVideo: false,
        state: () => ({}),
        steps: [
          { name: "first", run: async () => undefined },
          {
            name: "conditional",
            conditional: true,
            run: async () => {
              throw new Error("the agent didn't do the optional thing");
            },
          },
        ],
      });
      await runScenario(scenario, {
        ...options,
        recorder: {
          begin: async () => ({
            window: () => undefined,
            mark: () => undefined,
            end: async (passed) => {
              ended.push(passed);
              return { directory: "/raw/T6/1", files: {} };
            },
          }),
        },
      });
      expect(ended).toEqual([true]);
    });

    it("fails the take, and doesn't crash, when the capture can't save", async () => {
      const scenario = defineScenario<object>({
        ...needsNothing,
        id: "T5",
        title: "t",
        inVideo: false,
        state: () => ({}),
        steps: [{ name: "first", run: async () => undefined }],
      });
      const result = await runScenario(scenario, {
        ...options,
        recorder: {
          begin: async () => ({
            window: () => undefined,
            mark: () => undefined,
            end: async () => {
              throw new Error("disk full");
            },
          }),
        },
      });
      expect(result.verdict).toBe("fail");
      expect(output()).toContain("the capture didn't save: disk full");
    });

    it("blocks with the reason when a capture can't start", async () => {
      const scenario = defineScenario<object>({
        ...needsNothing,
        id: "T4",
        title: "t",
        inVideo: false,
        state: () => ({}),
        steps: [{ name: "first", run: async () => undefined }],
      });
      const result = await runScenario(scenario, {
        ...options,
        recorder: {
          begin: async () => {
            throw new Error("no browser");
          },
        },
      });
      expect(result.verdict).toBe("blocked");
      expect(output()).toContain("capture failed to start: no browser");
    });
  });
});
