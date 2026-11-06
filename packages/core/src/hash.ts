import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalCall } from "@clearance/contracts";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * `call_hash = sha256(canonicalJson({class, target, args, bound?}))`, per docs/integration-contract.md. `bound` is there
 * only when `args` alone couldn't tell this call from another, so a plain command hashes as it always has.
 */
export function callHash(call: CanonicalCall): string {
  const { class: cls, target, args, bound } = call;
  return sha256Hex(canonicalJson({ class: cls, target, args, ...(bound && Object.keys(bound).length > 0 ? { bound } : {}) }));
}
