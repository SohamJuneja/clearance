/**
 * Switch's template operations, as `@clearance install` needs them (spike S11). An agent running a
 * template that names it needs no "can manage agents" capability, because the template creates no agent.
 */
import type { SwitchAgent } from "./agent.js";

type ListedRoom = { room_id: string; name: string; archived?: boolean };
type RunResult = {
  room_id?: string;
  room_name?: string;
  created_document_ids?: string[];
  failed_attachments?: unknown[];
  errors?: { room_name?: string; error?: string }[];
};

const PAGE = 500;

export function createTemplatePort(agent: Pick<SwitchAgent, "op">) {
  return {
    /**
     * `list_all_rooms`, not `list_rooms`: a room Clearance isn't in still takes the name, and running the
     * template over it would make a second room.
     */
    async roomsNamed(name: string) {
      const rooms: { roomId: string; name: string; archived: boolean }[] = [];
      let cursor: string | null = null;
      do {
        const page: { rooms: ListedRoom[]; next_cursor: string | null } = await agent.op("list_all_rooms", {
          include_archived: true,
          name_contains: name,
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        });
        for (const room of page.rooms) {
          if (room.name === name) rooms.push({ roomId: room.room_id, name: room.name, archived: room.archived ?? false });
        }
        cursor = page.next_cursor;
      } while (cursor);
      return rooms;
    },

    async isMember(roomId: string) {
      const rooms = await agent.op<ListedRoom[]>("list_rooms", { include_archived: true });
      return rooms.some((room) => room.room_id === roomId);
    },

    async findTemplate(name: string) {
      const rows = await agent.op<{ id: string; name: string; can_edit?: boolean }[]>("list_templates", { query: name });
      const row = rows.find((entry) => entry.name === name);
      return row ? { id: row.id, canEdit: row.can_edit ?? false } : null;
    },

    async saveTemplate(input: { name: string; description: string; yaml: string }) {
      const saved = await agent.op<{ id: string }>("save_template", { ...input, visibility: "private" });
      return { id: saved.id };
    },

    async updateTemplate(id: string, yaml: string) {
      await agent.op("update_template", { template_id: id, yaml });
    },

    async runTemplate(id: string, inputs: Record<string, unknown>) {
      const run = await agent.op<RunResult>("run_template", { template_id: id, inputs });
      if (!run.room_id) throw new Error(`the template made no room: ${JSON.stringify(run.errors ?? run)}`);
      // Who ended up in it comes from the room, not from what the template asked for.
      const detail = await agent.op<{ connected_user_names?: string[] }>("get_room_detail", { room_id: run.room_id });
      const errors = [
        ...(run.errors ?? []).map((entry) => `${entry.room_name ?? "a room"}: ${entry.error ?? "failed"}`),
        ...(run.failed_attachments ?? []).map((entry) => `an attachment: ${JSON.stringify(entry)}`),
      ];
      return {
        roomId: run.room_id,
        roomName: run.room_name ?? "",
        documents: run.created_document_ids?.length ?? 0,
        users: detail.connected_user_names ?? [],
        errors,
      };
    },
  };
}
