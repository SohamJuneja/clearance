/** The rules for putting Mattermost on a public tunnel. Anything not proven closed counts as open. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SIGNUP_SETTINGS, attemptProblem, configProblem } from "../lib/exposure";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the public config", () => {
  const off = { EnableOpenServer: "false", EnableUserCreation: "false", EnableSignUpWithEmail: "false" };

  it("passes only when all three settings are off", () => {
    expect(configProblem(off)).toBeNull();
  });

  it.each(SIGNUP_SETTINGS)("fails when %s is on", (setting) => {
    expect(configProblem({ ...off, [setting]: "true" })).toContain(setting);
  });

  it.each(SIGNUP_SETTINGS)("fails when %s is missing: not shown is not off", (setting) => {
    const config: Record<string, unknown> = { ...off };
    delete config[setting];
    expect(configProblem(config)).toContain(setting);
  });

  it("fails on an empty answer", () => {
    expect(configProblem({})).not.toBeNull();
  });
});

describe("a real attempt to sign up", () => {
  it("fails if it succeeded", () => {
    expect(attemptProblem({ status: 201, id: "abc" })).toContain("succeeded");
  });

  it.each([
    [501, "api.user.create_user.signup_email_disabled.app_error"],
    [403, "api.user.create_user.no_open_server"],
  ])("passes when refused with %s because signup is off", (status, id) => {
    expect(attemptProblem({ status, id })).toBeNull();
  });

  it.each([
    [400, "model.user.is_valid.pwd.app_error", "a bad attempt proves nothing"],
    [500, undefined, "a server error proves nothing"],
    [403, "api.context.permissions.app_error", "refused for some other reason"],
    [429, undefined, "rate limited"],
  ])("does not count a %s (%s): %s", (status, id, _why) => {
    expect(attemptProblem({ status, id })).not.toBeNull();
  });
});

describe("the compose override", () => {
  const override = parse(readFileSync(join(ROOT, "deploy", "study-exposure.compose.yml"), "utf8")) as { services: Record<string, { environment: Record<string, string> }> };

  it("touches only Mattermost", () => {
    expect(Object.keys(override.services)).toEqual(["mattermost"]);
  });

  it("turns off all three, as strings, the way the compose file it layers on writes them", () => {
    expect(override.services.mattermost!.environment).toEqual({
      MM_TEAMSETTINGS_ENABLEOPENSERVER: "false",
      MM_TEAMSETTINGS_ENABLEUSERCREATION: "false",
      MM_EMAILSETTINGS_ENABLESIGNUPWITHEMAIL: "false",
    });
  });
});

describe("the expose script", () => {
  const script = readFileSync(join(ROOT, "scripts", "study-expose.sh"), "utf8");

  it("verifies before it starts the tunnel", () => {
    expect(script.indexOf('verify "$LOCAL_URL"')).toBeGreaterThan(-1);
    expect(script.indexOf('verify "$LOCAL_URL"')).toBeLessThan(script.indexOf("cloudflared tunnel"));
  });

  it("checks again through the tunnel before it gives out the URL", () => {
    expect(script.indexOf('verify "$PUBLIC_URL"')).toBeGreaterThan(script.indexOf("cloudflared tunnel"));
    expect(script.indexOf('verify "$PUBLIC_URL"')).toBeLessThan(script.indexOf('echo "Study URL'));
  });

  it("does not give out a URL until a browser would get live updates through it", () => {
    const check = script.indexOf('websocket_status "$PUBLIC_URL"');
    expect(check).toBeGreaterThan(script.indexOf('allow_origin "$PUBLIC_URL"'));
    expect(check).toBeLessThan(script.indexOf('echo "Study URL'));
  });

  it("clears the tunnel's origin when it stops", () => {
    expect(script.slice(script.indexOf("cleanup() {"), script.indexOf("trap cleanup EXIT"))).toContain('allow_origin ""');
  });

  it("stops on any failure, and recreates nothing but Mattermost", () => {
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("--no-deps --no-build mattermost");
  });
});
