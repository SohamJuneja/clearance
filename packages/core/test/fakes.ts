/**
 * Plain fakes for the ports core depends on. No mocks: they record what happened and answer with
 * what a test gave them. `FakeChat` numbers its cards so tests can answer one by id.
 */
import type {
  ChatPort,
  Clock,
  ExecuteResult,
  GatePort,
  LookupPort,
  OpenCardInput,
  OpenCardResult,
} from "@clearance/contracts";

export class FakeClock implements Clock {
  constructor(
    private now: number,
    private readonly scale = 1,
  ) {}
  nowMs(): number {
    return this.now;
  }
  scaledMs(policyMs: number): number {
    return policyMs / this.scale;
  }
  advance(ms: number): void {
    this.now += ms;
  }
  set(ms: number): void {
    this.now = ms;
  }
}

export type World = Record<string, Record<string, Record<string, unknown>>>;

export class FakeLookup implements LookupPort {
  readonly calls: { kind: string; id: string }[] = [];
  failing = false;
  constructor(public world: World = {}) {}
  async lookup(kind: string, id: string): Promise<Record<string, unknown> | null> {
    this.calls.push({ kind, id });
    if (this.failing) throw new Error("gate unreachable");
    return this.world[kind]?.[id] ?? null;
  }
}

export type OpenedCard = OpenCardInput & OpenCardResult & { closed: boolean };

export class FakeChat implements ChatPort {
  readonly cards: OpenedCard[] = [];
  readonly messages: { roomId: string; body: string; threadId?: string }[] = [];
  readonly targeted: { roomId: string; body: string; targets: string[]; threadId?: string }[] = [];
  readonly documents: { roomId: string; name: string; content: string }[] = [];
  readonly directRooms: string[] = [];
  /** Set to answer where an agent is working. Unset, as for a port with no way to ask. */
  unseenRoomCount?: (agentName: string) => Promise<number>;
  /** Set to make openCard reject, as if Switch were down. */
  failOpenCard = false;
  /** Real direct rooms give no handle: Switch writes it into the post and no API returns it. */
  giveHandles = false;
  private next = 1;

  async openCard(input: OpenCardInput): Promise<OpenCardResult> {
    if (this.failOpenCard) throw new Error("switch unreachable");
    const number = this.next++;
    const result: OpenCardResult = {
      sessionId: `session-${number}`,
      switchRequestId: `sw-${number}`,
      ...(this.giveHandles ? { handle: `A${number}` } : {}),
    };
    this.cards.push({ ...input, ...result, closed: false });
    return result;
  }
  async closeCard(sessionId: string, switchRequestId: string): Promise<void> {
    const card = this.cards.find((c) => c.sessionId === sessionId && c.switchRequestId === switchRequestId);
    if (card) card.closed = true;
  }
  async postMessage(input: { roomId: string; body: string; threadId?: string }): Promise<{ messageId?: string }> {
    this.messages.push(input);
    return { messageId: `m-${this.messages.length}` };
  }
  async sendTargeted(input: { roomId: string; body: string; targets: string[]; threadId?: string }): Promise<void> {
    this.targeted.push(input);
  }
  async ensureDirectRoom(person: { userName: string }): Promise<{ roomId: string }> {
    if (!this.directRooms.includes(person.userName)) this.directRooms.push(person.userName);
    return { roomId: `dm-${person.userName}` };
  }
  async upsertDocument(input: { roomId: string; name: string; content: string }): Promise<void> {
    this.documents.push(input);
  }

  openCards(): OpenedCard[] {
    return this.cards.filter((card) => !card.closed);
  }
  cardIn(roomId: string): OpenedCard {
    const card = this.cards.find((c) => c.roomId === roomId);
    if (!card) throw new Error(`no card in ${roomId}; cards are in ${this.cards.map((c) => c.roomId).join(", ")}`);
    return card;
  }
}

export class FakeGate implements GatePort {
  readonly calls: { requestId: string; callHash: string }[] = [];
  /** What the next execute returns. A function may throw to simulate the gate being down. */
  respond: (requestId: string, callHash: string) => ExecuteResult = () => ({
    ok: true,
    alreadyExecuted: false,
    status: 200,
    result: { id: "re_7731" },
  });
  async execute(requestId: string, callHash: string): Promise<ExecuteResult> {
    this.calls.push({ requestId, callHash });
    return this.respond(requestId, callHash);
  }
  readonly edits: { requestId: string; callHash: string; newRequestId: string; newCallHash: string; amount: number }[] = [];
  /** What the next edit returns. May throw, as the real client does when the gate can't be reached. */
  respondEdit: () => { ok: boolean; error?: string } = () => ({ ok: true });
  async edit(requestId: string, edit: { callHash: string; newRequestId: string; newCallHash: string; amount: number }): Promise<{ ok: boolean; error?: string }> {
    this.edits.push({ requestId, ...edit });
    return this.respondEdit();
  }
}
