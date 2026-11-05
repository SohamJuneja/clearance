/** Session tokens for the fake checkout. Changes under `auth/` carry extra risk in Clearance's policy. */
import { createHmac, timingSafeEqual } from "node:crypto";

export function signSession(customerId: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(customerId).digest("hex");
  return `${customerId}.${mac}`;
}

export function verifySession(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const customerId = token.slice(0, dot);
  const expected = Buffer.from(signSession(customerId, secret));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return customerId;
}
