/**
 * Removing Clearance's own posts, which Switch gives an agent no way to do. Mattermost's API does it with
 * a token for the bot Switch made for the agent. That token can't touch anyone else's post
 * (spikes/s-inbox-posts.ts: HTTP 403). It is best effort and Mattermost only, like reading a handle.
 */
import type { SwitchAgent } from "./agent.js";

export type OwnPostsConfig = {
  agent: Pick<SwitchAgent, "op">;
  mattermostUrl: string;
  /** A token for the agent's own Mattermost account. Never logged. */
  token: string;
  /** How far back to look. Posts older than this stay, which only costs a stale line far up the room. */
  perPage?: number;
  fetch?: typeof fetch;
};

export type OwnPosts = {
  /** Deletes this agent's posts in the room whose text matches, and returns how many went. Throws if it can't look. */
  remove(roomId: string, matches: (message: string) => boolean): Promise<number>;
};

export function createOwnPosts(config: OwnPostsConfig): OwnPosts {
  const doFetch = config.fetch ?? fetch;
  const baseUrl = config.mattermostUrl.replace(/\/$/, "");
  const perPage = config.perPage ?? 100;
  const channels = new Map<string, string>();
  let me: string | undefined;

  const call = async (method: string, path: string): Promise<unknown> => {
    const res = await doFetch(`${baseUrl}/api/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Mattermost answered ${res.status} to ${method} ${path.split("?")[0]}`);
    return res.json();
  };

  const channelOf = async (roomId: string): Promise<string> => {
    const known = channels.get(roomId);
    if (known) return known;
    const detail = await config.agent.op<{ external_channel_id?: string | null }>("get_room_detail", { room_id: roomId });
    if (!detail.external_channel_id) throw new Error("the room has no Mattermost channel");
    channels.set(roomId, detail.external_channel_id);
    return detail.external_channel_id;
  };

  return {
    async remove(roomId, matches) {
      const channelId = await channelOf(roomId);
      me ??= ((await call("GET", "/users/me")) as { id: string }).id;
      const body = (await call("GET", `/channels/${channelId}/posts?per_page=${perPage}`)) as {
        order: string[];
        posts: Record<string, { id: string; user_id: string; message: string }>;
      };
      let removed = 0;
      for (const id of body.order) {
        const post = body.posts[id];
        if (!post || post.user_id !== me || !matches(post.message)) continue;
        await call("DELETE", `/posts/${post.id}`);
        removed += 1;
      }
      return removed;
    },
  };
}
