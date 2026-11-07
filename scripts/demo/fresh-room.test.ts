import { describe, expect, it } from "vitest";
import { sessionAction } from "./fresh-room.ts";

const agent = (name: string, inRoom = true, running = false) => ({ name, inRoom, running });

describe("what a fresh take does with each agent", () => {
  it("starts or restarts the room's agents, as it always has", () => {
    expect(sessionAction("eng", agent("coder"), ["coder"], [])).toBe("start");
    expect(sessionAction("eng", agent("coder", true, true), ["coder"], [])).toBe("restart");
  });

  it("starts an agent the template puts in the room when the old room didn't have it", () => {
    expect(sessionAction("eng", agent("coder", false), ["coder"], [])).toBe("start");
  });

  it("leaves anyone else alone", () => {
    expect(sessionAction("eng", agent("support-agent", false, true), ["coder"], [])).toBe("leave");
  });

  it("doesn't start a visitor for a take that didn't ask, or a stray card could land on camera", () => {
    expect(sessionAction("eng", agent("refunds-agent"), ["refunds-agent"], [])).toBe("leave");
    expect(sessionAction("eng", agent("refunds-agent", false), ["refunds-agent"], [])).toBe("leave");
  });

  it("stops a visitor left running, for the same reason", () => {
    expect(sessionAction("eng", agent("refunds-agent", true, true), ["refunds-agent"], [])).toBe("stop");
  });

  it("starts a visitor for the take that asked for it", () => {
    expect(sessionAction("eng", agent("refunds-agent"), ["refunds-agent"], ["refunds-agent"])).toBe("start");
    expect(sessionAction("eng", agent("refunds-agent", true, true), ["refunds-agent"], ["refunds-agent"])).toBe("restart");
  });

  it("treats that agent normally in its own room", () => {
    expect(sessionAction("support", agent("refunds-agent", true, true), ["refunds-agent"], [])).toBe("restart");
  });
});
