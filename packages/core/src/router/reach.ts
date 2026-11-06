/**
 * Whether an agent could be working for someone Clearance can't hear.
 *
 * Clearance learns who asked from the rooms it is in. Someone who asks the same agent in a room it isn't in leaves
 * no trace, and if anyone else asked within the window the request looks attributed: that person is excluded, and
 * the real requester can approve alone. So before a hold counts on who is on record, it asks Switch whether the
 * agent is anywhere Clearance isn't. If so, or if nobody can say, the record may be incomplete, and two different
 * people decide, since only one of them can be the requester.
 *
 * What Switch can answer, measured in spikes/s-hidden-session.ts: a Mattermost direct room is readable, so
 * membership shows for any kind of agent. A private Switch chat shows only through a protocol agent's live
 * session. A managed agent in a private chat shows nothing, unless Clearance's owner is a workspace admin. That
 * gap is a stated limit in docs/threat-model.md.
 */
import type { ChatPort, Clock } from "@clearance/contracts";

/** Long enough for the usual 20 to 60 ms, short enough that a stuck Switch only costs a hold this much. */
export const REACH_TIMEOUT_MS = 1_500;
/** A room opened just now must count soon. A burst of holds from one agent need not ask each time. */
export const REACH_CACHE_MS = 5_000;

/** `unknown` is a lookup that failed, which is treated like `elsewhere`. */
export type AgentReach = "all_seen" | "elsewhere" | "unknown";

export class AgentReachCheck {
  private readonly cache = new Map<string, { reach: AgentReach; atMs: number }>();

  constructor(
    private readonly chat: Pick<ChatPort, "unseenRoomCount">,
    private readonly clock: Clock,
    private readonly timeoutMs = REACH_TIMEOUT_MS,
  ) {}

  async of(agent: string): Promise<AgentReach> {
    // A port with no way to ask has nothing to report. The real one always has it.
    if (!this.chat.unseenRoomCount) return "all_seen";
    const now = this.clock.nowMs();
    const cached = this.cache.get(agent);
    if (cached && now - cached.atMs < REACH_CACHE_MS) return cached.reach;
    try {
      const unseen = await this.withinTime(this.chat.unseenRoomCount(agent));
      const reach = unseen > 0 ? "elsewhere" : "all_seen";
      this.cache.set(agent, { reach, atMs: now });
      return reach;
    } catch {
      // Not kept: the next hold should get a real answer if Switch has come back.
      return "unknown";
    }
  }

  private withinTime<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer in time")), this.timeoutMs);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }
}
