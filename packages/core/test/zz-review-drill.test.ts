/** Independent review: can a drill be told apart from a real card? Not committed. */
import { afterEach, beforeEach, it } from "vitest";
import { chatMessage, gateRefund, makeHarness, PARTICIPANTS, REFUND_SC3, type Harness } from "./review-harness.js";
let h: Harness;
beforeEach(() => { h = makeHarness({ rollDrills: true, drillRate: 1 }); });
afterEach(() => h.core.close());
it("real card vs drill card, side by side", async () => {
  await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle T-77"));
  const res = await h.core.check(gateRefund(REFUND_SC3));
  console.log("real", res.request_id);
  for (const c of h.chat.cards) console.log(JSON.stringify({ req: (c as any).requestId, room: c.roomId, thread: (c as any).threadId ?? null, title: (c as any).title, at: h.clock.nowMs() }));
  console.log("messages", JSON.stringify(h.chat.messages.map((m) => m.roomId)), "targeted", JSON.stringify(h.chat.targeted.map((m) => m.roomId)));
});
