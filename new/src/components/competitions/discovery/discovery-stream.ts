export type DiscoverySseFrame = { event: string; id: string | null; data: string };

/** Network chunks and SSE messages have independent boundaries. */
export function parseDiscoverySseFrames(buffer: string): { frames: DiscoverySseFrame[]; remaining: string } {
  const frames: DiscoverySseFrame[] = [];
  let remaining = buffer;
  let boundary: RegExpExecArray | null;
  while ((boundary = /\r?\n\r?\n/.exec(remaining))) {
    const raw = remaining.slice(0, boundary.index);
    remaining = remaining.slice(boundary.index + boundary[0].length);
    let event = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const key = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (key === "event") event = value;
      else if (key === "id") id = value;
      else if (key === "data") data.push(value);
    }
    if (data.length) frames.push({ event, id, data: data.join("\n") });
  }
  return { frames, remaining };
}

export async function readDiscoveryEventStream(response: Response, onFrame: (frame: DiscoverySseFrame) => void, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw new Error("服务器没有返回报告更新。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!signal?.aborted) {
      const result = await reader.read();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error("报告更新过大，请重新连接。");
      const parsed = parseDiscoverySseFrames(buffer);
      buffer = parsed.remaining;
      for (const frame of parsed.frames) onFrame(frame);
      if (result.done) break;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
