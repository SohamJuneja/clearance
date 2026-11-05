/**
 * `@clearance install` (F15): makes the approvals room from templates/clearance.template.yaml.
 *
 * `run_template` is not idempotent. Run twice it makes a second room with the same name and a suffixed
 * channel (spike S11), so this looks first and runs only when no room has the name. One install at a time,
 * since two running together would both find nothing and both make a room.
 *
 * What a template can't do, and this does not pretend to: a direct room (the person writes to Clearance
 * once) and joining a room that exists (someone in it invites Clearance). The reply says so.
 */

export type RoomRef = { roomId: string; name: string; archived: boolean };

export type TemplateRun = {
  roomId: string;
  roomName: string;
  documents: number;
  users: string[];
  errors: string[];
};

/** Implemented over Switch's template operations by `createTemplatePort` in @clearance/switch-agent. */
export type TemplatePort = {
  /** Every room with exactly this name that Clearance's owner can see, archived ones too. */
  roomsNamed(name: string): Promise<RoomRef[]>;
  isMember(roomId: string): Promise<boolean>;
  /** A template of this name, and whether it is ours to change. */
  findTemplate(name: string): Promise<{ id: string; canEdit: boolean } | null>;
  saveTemplate(input: { name: string; description: string; yaml: string }): Promise<{ id: string }>;
  updateTemplate(id: string, yaml: string): Promise<void>;
  runTemplate(id: string, inputs: Record<string, unknown>): Promise<TemplateRun>;
};

export type InstallConfig = {
  templateName: string;
  templateYaml: string;
  /** The room the template makes, and the name the policy calls it by. */
  roomName: string;
  policyRoom: string;
  inputs?: Record<string, unknown>;
};

export type InstallResult =
  | { kind: "created"; run: TemplateRun; policyRoom: string }
  | { kind: "already"; roomId: string; policyRoom: string }
  | { kind: "blocked"; reason: string };

export class Installer {
  private running: Promise<InstallResult> | null = null;

  constructor(
    private readonly port: TemplatePort,
    private readonly config: InstallConfig,
  ) {}

  /** Asked twice at once, both askers get the one run. */
  install(): Promise<InstallResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<InstallResult> {
    const { port, config } = this;
    const { policyRoom, roomName } = config;
    const existing = await port.roomsNamed(roomName);
    const live = existing.filter((room) => !room.archived);
    for (const room of live) {
      if (await port.isMember(room.roomId)) return { kind: "already", roomId: room.roomId, policyRoom };
    }
    if (live.length > 0) {
      return {
        kind: "blocked",
        reason: `A room named ${roomName} exists and I'm not in it, so I made nothing. Someone in it can add me with \`!invite-agent @clearance\`, then run this again.`,
      };
    }
    if (existing.length > 0) {
      return { kind: "blocked", reason: `A room named ${roomName} exists but is archived, so I made nothing. Unarchive it, or remove it, then run this again.` };
    }

    const id = await this.templateId();
    if (!id) {
      return { kind: "blocked", reason: `A template named ${config.templateName} exists and isn't mine to change, so I made nothing.` };
    }
    const run = await port.runTemplate(id, { room_name: roomName, ...config.inputs });
    return { kind: "created", run, policyRoom };
  }

  /** Saved once, then kept up to date with the file. */
  private async templateId(): Promise<string | null> {
    const { port, config } = this;
    const found = await port.findTemplate(config.templateName);
    if (!found) {
      const saved = await port.saveTemplate({
        name: config.templateName,
        description: "Clearance's approvals room: where requests, drill notices and the ledger live.",
        yaml: config.templateYaml,
      });
      return saved.id;
    }
    if (!found.canEdit) return null;
    await port.updateTemplate(found.id, config.templateYaml);
    return found.id;
  }
}

/** What the person who asked reads. */
export function installReply(result: InstallResult): string {
  if (result.kind === "blocked") return result.reason;
  if (result.kind === "already") {
    return `Clearance is already installed: ${result.policyRoom} exists and I'm in it. I made nothing new.`;
  }
  const { run, policyRoom } = result;
  const people = run.users.length > 0 ? ` with ${run.users.join(", ")}` : "";
  const documents = run.documents === 1 ? "1 document" : `${run.documents} documents`;
  const problems = run.errors.length > 0 ? ` Some of it failed: ${run.errors.join("; ")}.` : "";
  return (
    `Installed. I made ${policyRoom}${people}, and ${documents} explaining how I work.${problems} ` +
    "Two things a template can't do: each approver should send me one direct message, so cards reach them there, " +
    "and someone in each room your agents work in should add me with `!invite-agent @clearance`."
  );
}
