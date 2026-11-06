/**
 * Who is who: team.yaml merged with data/identities.json. The participant id on a Switch event is the
 * only thing that identifies a person or an agent; nothing here reads names out of message text.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Vendor } from "@clearance/contracts";
import { z } from "zod";
import type { TeamFile } from "../policy/schema.js";

export const IdentitiesSchema = z.object({
  people: z
    .record(
      z.object({
        switchUserId: z.string().optional(),
        participantIds: z.array(z.string()).default([]),
        mattermostUser: z.string().optional(),
      }),
    )
    .default({}),
  agents: z.record(z.object({ switchAgentId: z.string().optional(), participantId: z.string().optional() })).default({}),
  /** Room names used by the policy mapped to Switch room ids. Merged over team.yaml's `rooms`. */
  rooms: z.record(z.string()).default({}),
});
export type Identities = z.input<typeof IdentitiesSchema>;

export type Person = {
  id: string;
  name: string;
  groups: string[];
  roles: string[];
  /** The name Switch knows them by: `ensureDirectRoom` and `sendTargeted` take this. */
  userName: string;
  participantIds: string[];
  switchUserIds: string[];
  github?: string;
};

export const SELF_AGENT = "clearance";

export function loadIdentities(path: string | undefined): Identities {
  if (!path || !existsSync(path)) return { people: {}, agents: {} };
  return IdentitiesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const BROADCAST_MENTIONS = new Set(["all", "channel", "here"]);

/** Shorter than this and a name is more likely to be something else that happens to start the same way. */
const MIN_NAME_PREFIX = 4;

export class Directory {
  private readonly people = new Map<string, Person>();
  private readonly byParticipant = new Map<string, Person>();
  private readonly bySwitchUser = new Map<string, Person>();
  private readonly agentByParticipant = new Map<string, string>();
  private readonly agentNames = new Set<string>();
  private readonly roomIds = new Map<string, string>();
  private readonly roomNames = new Map<string, string>();
  private readonly selfParticipant: string | undefined;

  constructor(
    private readonly team: TeamFile,
    identitiesInput: Identities,
  ) {
    const identities = IdentitiesSchema.parse(identitiesInput);
    for (const entry of team.people) {
      const identity = identities.people[entry.id];
      const switchUserIds = [identity?.switchUserId, entry.switch_user].filter(
        (value): value is string => typeof value === "string" && value !== "<id>",
      );
      const person: Person = {
        id: entry.id,
        name: entry.name,
        groups: entry.groups,
        roles: entry.roles,
        userName: identity?.mattermostUser ?? entry.id,
        participantIds: identity?.participantIds ?? [],
        switchUserIds,
      };
      if (entry.github) person.github = entry.github;
      this.people.set(entry.id, person);
      for (const participant of person.participantIds) this.byParticipant.set(participant, person);
      for (const userId of switchUserIds) this.bySwitchUser.set(userId, person);
    }
    for (const name of Object.keys(team.agents)) this.agentNames.add(name);
    for (const [name, agent] of Object.entries(identities.agents)) {
      if (agent.participantId) this.agentByParticipant.set(agent.participantId, name);
      if (name !== SELF_AGENT) this.agentNames.add(name);
    }
    this.selfParticipant = identities.agents[SELF_AGENT]?.participantId;
    for (const [name, id] of Object.entries({ ...team.rooms, ...identities.rooms })) {
      this.roomIds.set(name, id);
      this.roomNames.set(id, name);
    }
  }

  person(id: string): Person | null {
    return this.people.get(id) ?? null;
  }

  all(): Person[] {
    return [...this.people.values()];
  }

  /** Unknown participant means null, and an answer from null is ineligible. */
  personByParticipant(participant: string | null | undefined): Person | null {
    if (!participant) return null;
    return this.byParticipant.get(participant) ?? null;
  }

  personBySwitchUser(userId: string | null | undefined): Person | null {
    if (!userId) return null;
    return this.bySwitchUser.get(userId) ?? null;
  }

  /** `answered_by` is a participant id, or `user:<switchUserId>`. Anything else is nobody. */
  personFromAnswer(answeredBy: string | null | undefined): Person | null {
    if (!answeredBy) return null;
    if (answeredBy.startsWith("user:")) return this.personBySwitchUser(answeredBy.slice("user:".length));
    return this.personByParticipant(answeredBy);
  }

  /** `on_behalf_of` is a display name, set only on platform messages. */
  personByDisplayName(name: string | null | undefined): Person | null {
    const wanted = name?.trim().toLowerCase();
    if (!wanted) return null;
    return this.all().find((person) => person.name.toLowerCase() === wanted) ?? null;
  }

  isSelf(participant: string, senderName?: string | null): boolean {
    return participant === this.selfParticipant || senderName === SELF_AGENT;
  }

  /** Which agent a sender is: by participant id, else by the name Switch gave it. A known person is never an agent. */
  agentForSender(participant: string, senderName?: string | null): string | null {
    const known = this.agentByParticipant.get(participant);
    if (known) return known;
    if (this.byParticipant.has(participant)) return null;
    return senderName && this.agentNames.has(senderName) ? senderName : null;
  }

  isAgent(name: string): boolean {
    return this.agentNames.has(name);
  }

  /** The agent a mention means. Switch matches mentions without regard to case, so this has to. */
  agentNamed(mention: string): string | null {
    if (this.agentNames.has(mention)) return mention;
    const lower = mention.toLowerCase();
    return [...this.agentNames].find((name) => name.toLowerCase() === lower) ?? null;
  }

  /**
   * For when Switch can't say what a room's aliases are: whether a name someone wrote could be this agent under another
   * one. `@refunds`, `@Refunds-Bot` and `@refund` could be refunds-agent. An alias that looks nothing like the agent's name
   * can't be told from anything else anyone types, and chat isn't allowed to raise a quorum on a guess: see the threat model.
   */
  couldBeNameOf(agent: string, mention: string): boolean {
    if (this.knowsMention(mention)) return false;
    const bare = (name: string) => name.toLowerCase().replace(/[-_.]?(agent|bot)$/, "").replace(/[-_.]/g, "");
    const own = bare(agent);
    const written = bare(mention);
    return written === own || (written.length >= MIN_NAME_PREFIX && own.startsWith(written));
  }

  /** Whether a mention means anything we know of. One that doesn't could be an agent's alias, which only Switch knows. */
  knowsMention(mention: string): boolean {
    const lower = mention.toLowerCase();
    if (BROADCAST_MENTIONS.has(lower) || this.agentNamed(mention)) return true;
    return this.all().some((person) =>
      [person.id, person.userName, person.name, ...person.groups, ...person.roles, ...person.roles.map((role) => `${role}s`)].some((name) => name.toLowerCase() === lower),
    );
  }

  /** On the team file. Anything else is denied whatever it asks for. */
  isTeamAgent(name: string): boolean {
    return Object.hasOwn(this.team.agents, name);
  }

  agentVendor(name: string): Vendor | null {
    return this.team.agents[name]?.vendor ?? null;
  }

  /** Owners on file for an agent: team.yaml, plus whoever Switch said owns it when the Action carries that. */
  agentOwners(name: string, ownerUserId?: string): string[] {
    const owners: string[] = [];
    const onFile = this.team.agents[name]?.owner;
    if (onFile) owners.push(onFile);
    const fromSwitch = this.personBySwitchUser(ownerUserId)?.id;
    if (fromSwitch && !owners.includes(fromSwitch)) owners.push(fromSwitch);
    return owners;
  }

  /** A merge's author may be a person (id, name or git handle) or an agent, which means its owner. */
  resolveAuthor(value: unknown): string[] {
    if (typeof value !== "string" && typeof value !== "number") return [];
    const text = String(value).trim().toLowerCase();
    for (const person of this.people.values()) {
      if ([person.id, person.name, person.github].some((candidate) => candidate?.toLowerCase() === text)) {
        return [person.id];
      }
    }
    const owner = this.team.agents[String(value)]?.owner;
    return owner ? [owner] : [];
  }

  /** Maps a hook's cwd to its agent. `<host>` in team.yaml matches one path segment. Null is never an allow. */
  resolveAgent(cwd: string | undefined, agentType?: string): string | null {
    // The vendor named the agent: answer for that name only, and never fall back to the directory.
    if (agentType !== undefined) return this.team.agents[agentType] ? agentType : null;
    if (!cwd) return null;
    let best: { name: string; length: number } | null = null;
    for (const [name, agent] of Object.entries(this.team.agents)) {
      const root = agent.cwd.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "");
      const pattern = root
        .split("<host>")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
      if (new RegExp(`^${pattern}(/|$)`).test(cwd) && (!best || root.length > best.length)) {
        best = { name, length: root.length };
      }
    }
    return best?.name ?? null;
  }

  /** `@clearance install` made a room, or found one, that the policy has a name for. */
  setRoom(name: string, id: string): void {
    this.roomIds.set(name, id);
    this.roomNames.set(id, name);
  }

  /** The Switch room id for a policy room name. A name with no mapping is passed through as is. */
  roomId(nameOrId: string): string {
    return this.roomIds.get(nameOrId) ?? nameOrId;
  }

  /** A room's display name for messages, falling back to the id. */
  roomName(id: string): string {
    return this.roomNames.get(id) ?? id;
  }
}
