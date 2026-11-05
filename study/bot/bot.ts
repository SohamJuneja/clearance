/**
 * Routes what Switch sends to the right participant's session. A message is found by its room and an
 * answer by its session, and neither says who someone is: each session checks that itself.
 */
import type { ApprovalOutcomeEvent, ChatMessageEvent } from "../../packages/contracts/src/index";
import { roomSessionId } from "../../packages/switch-agent/src/agent";
import type { ParticipantAccount } from "../lib/accounts";
import { Session, type SessionDeps } from "./session";

/**
 * Switch counts an agent gone after 30 s of silence, and then open cards show "Host offline" with no
 * buttons until it returns. Measured in the rehearsal. A little under, so nothing near the edge is missed.
 */
export const OUTAGE_MS = 25_000;

/** Enough to find the cause later: what failed, and where in this code. Holds no credentials. */
function describe(error: unknown): string {
  const failure = error as NodeJS.ErrnoException;
  const where = failure.stack
    ?.split("\n")
    .filter((line) => line.includes("/study/") || line.includes("/packages/switch-agent/"))
    .slice(0, 2)
    .map((line) => line.trim().replace(/^at /, "").replace(/.*\/(study|packages)\//, "$1/"))
    .join(" < ");
  const detail = [failure.code, failure.syscall, failure.errno].filter((part) => part !== undefined).join(" ");
  return `${failure.message}${detail ? ` [${detail}]` : ""}${where ? ` at ${where}` : ""}`;
}

export type StudyBot = {
  sessions: Session[];
  /** Call once on starting, before the first tick. */
  resume(): Promise<void>;
  /** Resolves once the answer is recorded. Only then may Switch be told it was delivered. */
  onOutcome(event: ApprovalOutcomeEvent): Promise<void>;
  /** The position is saved once the message is handled, so a restart resumes after it and no sooner. */
  onMessage(event: ChatMessageEvent, meta?: { position?: Record<string, number> }): Promise<void>;
  /** Timers and retries. Safe to call as often as you like. */
  tick(): Promise<void>;
};

export function createStudyBot(participants: Record<string, ParticipantAccount>, deps: SessionDeps): StudyBot {
  const sessions = Object.entries(participants)
    .filter(([, account]) => !account.retired)
    .map(([id, account]) => new Session(id, account, deps));
  const byRoom = new Map(sessions.map((session) => [session.account.roomId, session]));
  const bySession = new Map(sessions.map((session) => [roomSessionId(session.account.roomId), session]));

  return {
    sessions,
    async onOutcome(event) {
      const session = bySession.get(event.sessionId);
      if (!session) {
        deps.log(`an answer arrived for a session that is not in this study: ${event.sessionId}`);
        return;
      }
      await session.handleOutcome(event);
    },
    async onMessage(event, meta) {
      await byRoom.get(event.roomId)?.handleMessage(event);
      deps.store.mergePosition(meta?.position);
    },
    async resume() {
      const last = deps.store.lastAlive();
      if (!last) return;
      const downFor = deps.now().getTime() - last.getTime();
      if (downFor < OUTAGE_MS) return;
      deps.log(`it was down for ${Math.round(downFor / 1000)} s, long enough for open cards to lose their buttons until now`);
      await Promise.all(sessions.map((session) => session.noteOutage()));
    },
    async tick() {
      deps.store.touchAlive();
      await Promise.all(
        sessions.map((session) =>
          session.advance().catch((error: unknown) => {
            deps.log(`${session.participant}: ${describe(error)}`);
          }),
        ),
      );
    },
  };
}
