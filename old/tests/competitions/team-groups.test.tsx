import * as React from "react";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TeamGroups } from "@/components/teams/TeamGroups";
import { groupCodeIsCurrent, teamGroups } from "@/content/community";
import { GET } from "@/app/community/[code]/route";

const beforeExpiry = Date.parse("2026-11-26T23:59:59+08:00");
const expiry = Date.parse("2026-11-27T00:00:00+08:00");

describe("updated competition team entrances", () => {
  beforeAll(() => vi.stubGlobal("React", React));
  afterAll(() => vi.unstubAllGlobals());
  afterEach(() => vi.useRealTimers());

  it("shows eight distinct entrances including both business codes without the retired general group", () => {
    const html = renderToStaticMarkup(<TeamGroups initialNow={beforeExpiry} />);
    expect(teamGroups).toHaveLength(8);
    expect(new Set(teamGroups.map(group => group.id)).size).toBe(8);
    expect(new Set(teamGroups.map(group => group.src)).size).toBe(8);
    expect(html).toContain("25商赛资源共享组队群 · 入口一");
    expect(html).toContain("25商赛资源共享组队群 · 入口二");
    expect(html).not.toContain("大学生竞赛资源共享群");
    for (const group of teamGroups) {
      expect(html).toContain(`href="${group.src}"`);
      expect(group.expiresAt).toBe("2026-11-27T00:00:00+08:00");
      expect(groupCodeIsCurrent(group.expiresAt, beforeExpiry)).toBe(true);
      expect(groupCodeIsCurrent(group.expiresAt, expiry)).toBe(false);
    }
  });

  it("serves each original JPEG privately and rejects the retired image names", async () => {
    vi.useFakeTimers(); vi.setSystemTime(beforeExpiry);
    const digests = new Set<string>();
    for (const group of teamGroups) {
      const code = group.src.slice("/community/".length);
      const response = await GET(new Request(`http://localhost${group.src}`), { params: Promise.resolve({ code }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([255, 216, 255]);
      digests.add(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(digests.size).toBe(8);
    expect((await GET(new Request("http://localhost/community/group-92.png"), { params: Promise.resolve({ code: "group-92.png" }) })).status).toBe(404);
  });

  it("hides all expired codes and makes direct image requests return 410 at the Shanghai cutoff", async () => {
    vi.useFakeTimers(); vi.setSystemTime(expiry);
    const html = renderToStaticMarkup(<TeamGroups initialNow={expiry} />);
    expect(html).toContain("本批群二维码已过期");
    expect(html).toContain("Emily 学姐");
    for (const group of teamGroups) {
      expect(html).not.toContain(`href="${group.src}"`);
      const response = await GET(new Request(`http://localhost${group.src}`), { params: Promise.resolve({ code: group.src.slice("/community/".length) }) });
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
