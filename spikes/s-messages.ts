/** What a message looks like on Clearance's stream, addressed and not, and how quickly it arrives. */
import { Frames, clearanceAgent, mattermost, say, sleep } from "./lib.js";

const agent = clearanceAgent();
const frames = new Frames();
await agent.start({ frame: frames.handler });
const room = await agent.op<{ id: string }>("create_room", {
  name: `spike-msg-${Date.now()}`,
  description: "spike",
  agent_names: ["clearance"],
  user_names: ["sam", "priya", "guest"],
  channel_type: "channel_private",
});
const { external_channel_id: channelId } = await agent.op<{ external_channel_id: string }>("get_room_detail", {
  room_id: room.id,
});
await sleep(1000);
const started = Date.now();
await mattermost("priya").post(channelId, "just chatting, no mention");
await mattermost("sam").post(channelId, "@clearance inbox");
await mattermost("guest").post(channelId, "@clearance inbox from guest");
await sleep(5000);
for (const frame of frames.all) {
  say(`${frame.at - started} ms ${frame.name} ${JSON.stringify(frame.data).slice(0, 600)}`);
}
await sleep(20000);
say(`after 25 s: ${frames.all.map((frame) => frame.name).join(",")}`);
await agent.stop();
