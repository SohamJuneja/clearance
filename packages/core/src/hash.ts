import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalCall } from "@clearance/contracts";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `call_hash = sha256(canonicalJson({class, target, args}))`, per docs/integration-contract.md. */
export function callHash(call: CanonicalCall): string {
  return sha256Hex(canonicalJson({ class: call.class, target: call.target, args: call.args }));
}
