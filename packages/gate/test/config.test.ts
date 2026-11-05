import { describe, expect, it } from "vitest";
import { loadGateConfig } from "../src/index.js";

const good = {
  GATE_AGENT_TOKENS: JSON.stringify({
    "secret-token-aaaa": { agent: "refunds-agent", classes: ["refund"] },
  }),
  ACME_ADMIN_KEY: "admin-key",
  CLEARANCE_INTERNAL_TOKEN: "internal-token",
};

describe("loadGateConfig", () => {
  it("reads the env and applies contract defaults", () => {
    const config = loadGateConfig(good);
    expect(config.agentTokens["secret-token-aaaa"]).toEqual({
      agent: "refunds-agent",
      classes: ["refund"],
    });
    expect(config.coreUrl).toBe("http://127.0.0.1:7700");
    expect(config.acmeUrl).toBe("http://127.0.0.1:7800");
    expect(config.port).toBe(7710);
    expect(config.host).toBe("127.0.0.1");
    expect(config.dbPath).toBe("./data/gate.sqlite");
  });

  it("honours overrides", () => {
    const config = loadGateConfig({
      ...good,
      CLEARANCE_CORE_URL: "http://core:1",
      ACME_URL: "http://acme:2",
      CLEARANCE_GATE_PORT: "9000",
      CLEARANCE_GATE_DB_PATH: "/tmp/x.sqlite",
    });
    expect(config).toMatchObject({
      coreUrl: "http://core:1",
      acmeUrl: "http://acme:2",
      port: 9000,
      dbPath: "/tmp/x.sqlite",
    });
  });

  it.each(["ACME_ADMIN_KEY", "CLEARANCE_INTERNAL_TOKEN", "GATE_AGENT_TOKENS"])(
    "refuses to start without %s",
    (name) => {
      const env: Record<string, string | undefined> = { ...good };
      delete env[name];
      expect(() => loadGateConfig(env)).toThrow(name);
    },
  );

  it.each(["ACME_ADMIN_KEY", "CLEARANCE_INTERNAL_TOKEN"])(
    "refuses to start with the .env.example placeholder in %s",
    (name) => {
      expect(() => loadGateConfig({ ...good, [name]: "change-me" })).toThrow(name);
    },
  );

  it("does not read the hook token, which agents can read too", () => {
    const config = loadGateConfig({ ...good, CLEARANCE_HOOK_TOKEN: "hook-token" });
    expect(JSON.stringify(config)).not.toContain("hook-token");
  });

  it("refuses an unknown class so a typo cannot silently change what a token can do", () => {
    const env = {
      ...good,
      GATE_AGENT_TOKENS: JSON.stringify({
        "secret-token-bbbb": { agent: "a", classes: ["refunds"] },
      }),
    };
    expect(() => loadGateConfig(env)).toThrow(/GATE_AGENT_TOKENS/);
  });

  it("never echoes a token value in a config error", () => {
    const bad = [
      JSON.stringify({ "secret-token-cccc": { agent: "", classes: ["refund"] } }),
      JSON.stringify({ "secret-token-cccc": { classes: "refund" } }),
      "secret-token-cccc not json",
    ];
    for (const value of bad) {
      let message = "";
      try {
        loadGateConfig({ ...good, GATE_AGENT_TOKENS: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("GATE_AGENT_TOKENS");
      expect(message).not.toContain("secret-token-cccc");
    }
  });

  it("does not start with an empty token map, since no agent could call anything", () => {
    expect(() => loadGateConfig({ ...good, GATE_AGENT_TOKENS: "{}" })).toThrow(/GATE_AGENT_TOKENS/);
  });
});
