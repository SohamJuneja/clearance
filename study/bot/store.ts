/**
 * What the bot remembers. Results go to the same JSONL as the Lab, and are the truth about how far a
 * session has got. Beside them, in a folder `pnpm eval:study` does not read:
 *
 *   bot-state/<participant>.json          what only the bot knows: when each card went up, what it has said
 *   bot-state/<participant>.audit.ndjson  answers it ignored, and why
 *   bot-state/stream.json                 where in Switch's stream it got to
 *   bot-state/alive.json                  when it last ran, to tell how long it was down
 *
 * Every write is complete or absent, so a kill at any moment leaves a file that can be read.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { createResultsLog, type ResultsLog } from "../lib/results";

const SessionStateSchema = z.object({
  /** The participant's first message. Cards mention its sender, which is what notifies them. */
  startMessageId: z.string().optional(),
  /** Ended before consent was given, so nothing is recorded. */
  declined: z.boolean().default(false),
  consent: z.object({ agreed: z.boolean().optional(), role: z.string().optional() }).default({}),
  /** When each request first went up, by clock key. A card re-asked keeps its clock, as in the Lab. */
  clocks: z.record(z.string()).default({}),
  /** How many times a card was posted again because it was used up. Part of the next card's id. */
  reopens: z.record(z.number()).default({}),
  /** Clock keys whose time includes something other than deciding. */
  disturbed: z.array(z.string()).default([]),
  /** Every card ever opened, by request id. `opened` turns true once Switch has confirmed it. */
  cards: z.record(z.object({ key: z.string(), opened: z.boolean() })).default({}),
  /** Messages, by key. `pending` means it may or may not have gone out. */
  said: z.record(z.enum(["pending", "sent"])).default({}),
  /** Short notes owed to the person, said before the next card so the order reads right. */
  notices: z.array(z.object({ key: z.string(), body: z.string() })).default([]),
  breakStartedAt: z.string().optional(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export type StudyStore = {
  results: ResultsLog;
  readState(participant: string): SessionState;
  writeState(participant: string, state: SessionState): void;
  audit(participant: string, entry: Record<string, unknown>): void;
  readPosition(): Record<string, number> | undefined;
  mergePosition(next: Record<string, number> | undefined): void;
  lastAlive(): Date | undefined;
  touchAlive(): void;
};

export function createStudyStore(options: { resultsDir: string; synthetic?: boolean; now?: () => Date }): StudyStore {
  const now = options.now ?? (() => new Date());
  const results = createResultsLog({ resultsDir: options.resultsDir, platform: "switch", synthetic: options.synthetic, now });
  const dir = resolve(options.resultsDir, "bot-state");
  const stateFile = (participant: string) => resolve(dir, `${participant}.json`);
  const positionFile = resolve(dir, "stream.json");
  const aliveFile = resolve(dir, "alive.json");

  const writeAtomic = (file: string, value: unknown) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  };

  return {
    results,
    readState(participant) {
      const file = stateFile(participant);
      return SessionStateSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
    },
    writeState(participant, state) {
      writeAtomic(stateFile(participant), state);
    },
    audit(participant, entry) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = resolve(dir, `${participant}.audit.ndjson`);
      const isNew = !existsSync(file);
      appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), participant, ...entry })}\n`);
      if (isNew) chmodSync(file, 0o600);
    },
    readPosition() {
      if (!existsSync(positionFile)) return undefined;
      return z.record(z.number()).parse(JSON.parse(readFileSync(positionFile, "utf8")));
    },
    mergePosition(next) {
      if (!next) return;
      const merged = { ...(this.readPosition() ?? {}) };
      for (const [source, seq] of Object.entries(next)) {
        if (seq > (merged[source] ?? -1)) merged[source] = seq;
      }
      writeAtomic(positionFile, merged);
    },
    lastAlive() {
      if (!existsSync(aliveFile)) return undefined;
      return new Date(z.object({ at: z.string() }).parse(JSON.parse(readFileSync(aliveFile, "utf8"))).at);
    },
    touchAlive() {
      writeAtomic(aliveFile, { at: now().toISOString() });
    },
  };
}
