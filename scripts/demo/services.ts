/**
 * How the demo runner stops and starts a service: an override from the environment, or else
 * scripts/services.sh, which is how they are run everywhere else. Null means this service has no such script.
 */
import type { ServiceName } from "../../eval/lib/world.ts";

const MANAGED: readonly string[] = ["acme", "gate", "core"];

export function serviceCommand(
  service: ServiceName,
  verb: "STOP" | "START",
  setting: (key: string) => string | undefined,
): string | null {
  const override = setting(`CLEARANCE_${service.toUpperCase()}_${verb}_CMD`);
  if (override) return override;
  if (!MANAGED.includes(service)) return null;
  return `bash scripts/services.sh ${verb === "STOP" ? "down" : "up"} ${service}`;
}
