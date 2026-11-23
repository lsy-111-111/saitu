import { describe, expect, it } from "vitest";
import { parseDiscoverySseFrames, readDiscoveryEventStream } from "@/components/competitions/discovery/discovery-stream";

describe("discovery browser event reader", () => {
  it("retains incomplete frames, combines data lines and ignores heartbeat comments", () => {
    expect(parseDiscoverySseFrames(': heartbeat\r\n\r\nid: 7\r\nevent: text\r\ndata: first\r\ndata: second\r\n\r\ndata: wait')).toEqual({
      frames: [{ event: "text", id: "7", data: "first\nsecond" }], remaining: "data: wait",
    });
  });

  it("decodes a Chinese character split between network chunks without changing the event", async () => {
    const bytes = new TextEncoder().encode('id: 3\nevent: text\ndata: {"text":"竞赛"}\n\n');
    const chineseStart = bytes.findIndex(value => value > 127);
    const chunks = [bytes.slice(0, chineseStart + 1), bytes.slice(chineseStart + 1, chineseStart + 4), bytes.slice(chineseStart + 4)];
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
    const frames: string[] = [];
    await readDiscoveryEventStream(response, frame => frames.push(frame.data));
    expect(frames).toEqual(['{"text":"竞赛"}']);
  });
});
