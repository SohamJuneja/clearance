/**
 * `@clearance install` and `@clearance ledger`: commands about running Clearance rather than about a
 * request. They sit beside core's own commands, which ignore these words.
 *
 * Who asked comes from `sender`, the only identity Switch vouches for, and never from the message text.
 * An agent or an account linked to nobody is not a person on the team, so it is not an admin.
 */
import { ChatMessageEventSchema, type ChatMessageEvent, type ChatPort } from "@clearance/contracts";
import type { Installer, InstallResult } from "../install/install.js";
import { installReply } from "../install/install.js";
import type { LedgerMirror, MirrorReport } from "../ledger/mirror.js";
import { STATE_DOCUMENT } from "../ledger/mirror.js";
import { joinNames } from "../format.js";
import type { Directory, Person } from "../people/directory.js";
import { parseCommand } from "./parse.js";

export type OperatorDeps = {
  directory: Directory;
  /** `admins:` in team.yaml, the same list `@clearance drills` goes by. */
  admins: string[];
  chat: Pick<ChatPort, "postMessage">;
  installer?: Installer;
  /** After an install, or a re-install that found the room: the policy's name for the room now has an id. */
  onRoom?: (policyRoom: string, roomId: string) => void;
  mirror?: Pick<LedgerMirror, "flush">;
  mirrorRoom?: string;
  /** Where a person can read the room's documents, when known. */
  documentsPage?: () => string | null;
  log?: (message: string) => void;
};

export class OperatorCommands {
  constructor(private readonly deps: OperatorDeps) {}

  /**
   * Handles a message without being waited for. The stream hands over frames one at a time, so a slow
   * install or ledger copy waited on here would hold up every answer behind it.
   */
  start(input: ChatMessageEvent): void {
    this.onMessage(input).catch((error: unknown) => this.deps.log?.(`@clearance command failed: ${(error as Error).message}`));
  }

  async onMessage(input: ChatMessageEvent): Promise<void> {
    const parsed = ChatMessageEventSchema.safeParse(input);
    if (!parsed.success) return;
    const evt = parsed.data;
    const { directory } = this.deps;
    if (directory.isSelf(evt.sender, evt.senderName)) return;
    const command = parseCommand(evt);
    // The bare word and nothing after it: these act on the whole team, so "install later" isn't an install.
    if (!command || command.words.length > 0) return;
    const { verb } = command;
    let reply: string | null = null;
    if (verb === "install") reply = await this.install(directory.personByParticipant(evt.sender));
    if (verb === "ledger") reply = await this.ledger();
    if (!reply) return;
    try {
      await this.deps.chat.postMessage({ roomId: evt.roomId, body: reply, ...(evt.threadId ? { threadId: evt.threadId } : {}) });
    } catch (error) {
      this.deps.log?.(`could not answer @clearance ${verb}: ${(error as Error).message}`);
    }
  }

  private async install(person: Person | null): Promise<string | null> {
    const { installer, directory, admins } = this.deps;
    if (!installer) return null;
    if (!person || !admins.includes(person.id)) {
      const names = admins.flatMap((id) => directory.person(id)?.name ?? []);
      return names.length > 0 ? `Only a team admin can install Clearance. Ask ${joinNames(names)}.` : "Only a team admin can install Clearance.";
    }
    let result: InstallResult;
    try {
      result = await installer.install();
    } catch (error) {
      this.deps.log?.(`install failed: ${(error as Error).message}`);
      return `The install didn't finish: ${(error as Error).message}. Run it again; it checks what exists first.`;
    }
    if (result.kind === "created") this.remember(result.policyRoom, result.run.roomId);
    if (result.kind === "already") this.remember(result.policyRoom, result.roomId);
    return installReply(result);
  }

  /** The room exists whatever happens here, so a failure to note it doesn't change what the person is told. */
  private remember(policyRoom: string, roomId: string): void {
    try {
      this.deps.onRoom?.(policyRoom, roomId);
    } catch (error) {
      this.deps.log?.(`could not remember ${policyRoom}: ${(error as Error).message}`);
    }
  }

  private async ledger(): Promise<string | null> {
    const { mirror } = this.deps;
    if (!mirror) return null;
    return this.ledgerReply(await mirror.flush());
  }

  private ledgerReply(report: MirrorReport): string {
    const room = this.deps.mirrorRoom ?? "#approvals";
    const page = this.deps.documentsPage?.();
    const place = page ? `the room's page: ${page}` : "the room's page in the Gateway.";
    if (!report.ok) {
      return `I couldn't copy the ledger just now (${report.error}). Nothing is lost: entries are safe in SQLite, and I'll try again. The copy runs through entry ${report.mirrored_seq} so far.`;
    }
    const updated = [...report.documents, ...(report.state_updated ? [STATE_DOCUMENT] : [])];
    // Says where the copy has reached and never how far behind it is: that gap is what an open drill looks like.
    if (updated.length === 0) return `The ledger copy in ${room} runs through entry ${report.mirrored_seq}. Read it on ${place}`;
    return `Copied the ledger to ${room}, through entry ${report.mirrored_seq}: ${joinNames(updated)}. Read it on ${place}`;
  }
}
