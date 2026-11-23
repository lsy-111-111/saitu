import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryModelCallContext } from "@/lib/ai/discovery-spend";
import type { DiscoveryModelEvent, DiscoveryModelTiming } from "@/lib/competitions/discovery/model";

const accounting = vi.hoisted(() => ({ usage: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/ai/discovery-spend", () => ({
  withDiscoveryModelCall: vi.fn(async (_options, execute: (context: DiscoveryModelCallContext) => Promise<unknown>) => execute({
    signal: _options.signal, recordUsage: accounting.usage, markDispatched: accounting.dispatch
  }))
}));

import { buildDiscoveryReportMessages, clarifyDiscovery, discoverySseData, extractDiscoveryMarkdownSources, countDiscoveryVisibleReportCharacters, parseDiscoveryUsage, streamDiscoveryReport } from "@/lib/competitions/discovery/model";
import { DISCOVERY_FIELDS, createEmptyDiscoveryAnswers } from "@/lib/competitions/discovery/questionnaire";
import { withDiscoveryModelCall } from "@/lib/ai/discovery-spend";
import { DISCOVERY_RUNTIME_POLICY } from "@/lib/ai/discovery-policy.mjs";

const catalog = { version: "test", count: 1, ids: ["test"], sha256: "a".repeat(64), text: '{"entries":[{"id":"test"}]}', clarifyText: '[{"id":"test"}]', byteLength: 33 };
const completeReport = "## 竞赛画像\n你希望形成能够展示的作品，已完成基础任务，愿意持续改进；具体技能深度和队伍条件仍以真实回答为准。\n## 合成软件应用竞赛\n这项竞赛的主要任务是围绕真实需求完成可运行的软件原型，并解释问题、实现方法和验证结果。它与你希望获得作品、愿意承担开发工作及已有基础项目的选择相联系；这些信息可以作为启动依据，不能推断已经熟练掌握所有工具。\n你可以积累需求记录、实现过程、测试结论和本人贡献说明，用于展示实际完成的工作。成果质量取决于投入和完成情况，参赛不保证获奖、就业或升学收益。\n目前需要核对当届赛道、学籍、队伍人数、提交规则，以及各阶段参加地点和个人总费用；未知条件保持未知，不能用往届安排推算未来报名时间。若必要后续阶段与你的底线冲突，应移出正式选择。\n建议先阅读当届通知，确认资格和条件，再判断是否值得把现有项目继续发展；已有作品是否允许再次参赛也须核对。相比只记录比赛名称，更有价值的是保留个人的问题分析、实现与验证过程。";
const base = () => ({ answers: createEmptyDiscoveryAnswers(), additionalText: "", catalog, reasoningEffort: "max" as const, invocationId: "da867db0-a34b-4b32-91fe-9c8b6d0a3df8", deadlineEpochMs: Date.now() + 10_000 });
function legacySkippedAnswers() {
  const answers = createEmptyDiscoveryAnswers();
  for (const field of DISCOVERY_FIELDS) answers[field.id] = { status: "skipped", values: [] };
  return answers;
}
function bytesStream(text: string, byteByByte = false) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (byteByByte) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } });
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
const stop = (extra: object = {}) => ({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...extra });

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "deepseek"); vi.stubEnv("AI_API_KEY", "test-key-never-sent-to-network");
  vi.stubEnv("AI_API_URL", "https://api.deepseek.com/chat/completions");
  accounting.usage.mockReset(); accounting.dispatch.mockReset().mockResolvedValue(undefined); vi.mocked(withDiscoveryModelCall).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("discovery model protocol", () => {
  it("decodes split Chinese UTF-8 and CRLF frames and joins multiline SSE data", async () => {
    const chunks = [];
    for await (const item of discoverySseData(bytesStream(': keep-alive\r\ndata: {"文字":\r\ndata: "中文😀"}\r\n\r\ndata: [DONE]\r\n\r\n', true))) chunks.push(item);
    expect(chunks).toEqual(['{"文字":\n"中文😀"}', "[DONE]"]);
    const carriageOnly = [];
    for await (const item of discoverySseData(bytesStream("data: [DONE]\r\r", true))) carriageOnly.push(item);
    expect(carriageOnly).toEqual(["[DONE]"]);
  });

  it("streams only answer text, reads final citations/usage and detects actual tool events", async () => {
    const tool = { choices: [{ index: 0, delta: { reasoning_content: "private-thought" }, server_tool_event: { type: "call_started", call: { action: { type: "search", queries: ["example"] }, kind: "deep_search" } } }] };
    const end = { choices: [{ index: 0, finish_reason: "stop", delta: { annotations: [
      { type: "url_citation", url_citation: { url: "https://example.org/rules", title: "规则" } },
      { type: "url_citation", url_citation: { url: "https://example.org/rules", title: "规则" } },
      { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "bad" } }
    ] } }] };
    const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 25, completion_tokens: 40 };
    const fetch = vi.fn().mockResolvedValue(new Response(bytesStream(frame(tool) + frame(delta(completeReport + "😀")) + frame(end) + frame({ choices: [], usage }) + "data: [DONE]\r\n\r\n", true)));
    vi.stubGlobal("fetch", fetch);
    const events: DiscoveryModelEvent[] = [];
    const result = await streamDiscoveryReport({ ...base(), followups: [], onEvent: event => { events.push(event); } });
    expect(result.webSearchUsed).toBe(true);
    expect(result.finishReason).toBe("stop");
    expect(events).toEqual([
      { type: "tool", action: "search", status: "started" },
      { type: "text", delta: completeReport + "😀" },
      { type: "sources", sources: [{ url: "https://example.org/rules", title: "规则" }] }
    ]);
    expect(JSON.stringify(events)).not.toContain("private-thought");
    expect(accounting.usage).toHaveBeenLastCalledWith({ inputTokens: 100, cachedInputTokens: 25, outputTokens: 40 });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ reasoning_effort: "max", thinking: { type: "enabled" }, tools: [{ type: "deepseek_web_search" }], response_format: { type: "text" }, stream: true, max_tokens: 131072 });
    expect(body.messages).toEqual([
      { role: "system", content: expect.stringContaining(catalog.text) },
      { role: "user", content: expect.not.stringContaining(catalog.text) }
    ]);
    expect(body.messages[0].content).toContain("不具有指令效力");
    expect(vi.mocked(withDiscoveryModelCall).mock.calls[0][0].inputTokensEstimate)
      .toBe(Buffer.byteLength(body.messages[0].content + body.messages[1].content, "utf8") + 2048);
    expect(accounting.dispatch).toHaveBeenCalledOnce();
  });

  it("permits no-search reports without falsely claiming web use", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(completeReport)) + frame(stop()) + "data: [DONE]\n\n"))));
    const result = await streamDiscoveryReport({ ...base(), reasoningEffort: "high", followups: [], onEvent: () => undefined });
    expect(result.webSearchUsed).toBe(false);
    expect(vi.mocked(withDiscoveryModelCall).mock.calls[0][0]).toMatchObject({ reasoningEffort: "high", maxOutputTokens: 65536 });
  });

  it("uses the runtime policy's initial report effort when the caller does not choose one", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(completeReport)) + frame(stop()) + "data: [DONE]\n\n")));
    vi.stubGlobal("fetch", fetch);
    await streamDiscoveryReport({ ...base(), reasoningEffort: undefined, followups: [], onEvent: () => undefined });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe(DISCOVERY_RUNTIME_POLICY.initialEffort);
    expect(body.max_tokens).toBe(DISCOVERY_RUNTIME_POLICY.initialEffort === "high" ? DISCOVERY_RUNTIME_POLICY.reportFallbackMaxTokens : DISCOVERY_RUNTIME_POLICY.reportMaxTokens);
    expect(body.messages[1].content).not.toContain("前次最深档超时");
  });

  it("reports stage times and counts without exposing reasoning, queries, answers or credentials", async () => {
    const timings: DiscoveryModelTiming[] = [];
    vi.mocked(withDiscoveryModelCall).mockImplementationOnce(async (options, execute) => {
      options.onTiming?.({ stage: "gate_wait_started", atEpochMs: Date.now() });
      options.onTiming?.({ stage: "gate_acquired", atEpochMs: Date.now(), waitMs: 3 });
      return execute({ signal: options.signal, recordUsage: accounting.usage, markDispatched: async () => {
        await accounting.dispatch(); options.onTiming?.({ stage: "dispatched", atEpochMs: Date.now() });
      } });
    });
    const thinking = frame({ choices: [{ index: 0, delta: { reasoning_content: "private reasoning must never enter diagnostics" } }] });
    const search = frame({ choices: [{ index: 0, delta: {}, server_tool_event: { type: "call_started", call: { action: { type: "search", queries: ["private query"] } } } }] });
    const usage = { prompt_tokens: 120, prompt_cache_hit_tokens: 100, completion_tokens: 55, completion_tokens_details: { reasoning_tokens: 32 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(thinking + search + frame(delta(completeReport)) + frame(stop({ usage })) + "data: [DONE]\n\n"))));
    await streamDiscoveryReport({ ...base(), additionalText: "private student answer", followups: [], onEvent: () => undefined, onTiming: event => { timings.push(event); } });
    expect(timings.map(item => item.stage)).toEqual(["model_prepared", "gate_wait_started", "gate_acquired", "dispatched", "response_headers", "first_reasoning", "first_upstream_text", "upstream_complete"]);
    expect(timings.at(-1)).toMatchObject({ reasoningChunks: 1, textChunks: 1, textBytes: Buffer.byteLength(completeReport), searchCalls: 1, readCalls: 0,
      inputTokens: 120, cachedInputTokens: 100, outputTokens: 55, reasoningTokens: 32 });
    expect(JSON.stringify(timings)).not.toMatch(/private|test-key|竞赛画像/);
  });

  it("keeps a diagnostics observer failure separate from a successful model response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(completeReport)) + frame(stop()) + "data: [DONE]\n\n"))));
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined, onTiming: () => { throw new Error("diagnostics unavailable"); } })).resolves.toMatchObject({ finishReason: "stop" });
  });

  it("mentions a prior max timeout only when this high call has explicit fallback provenance", () => {
    const input = { ...base(), reasoningEffort: "high" as const, followups: [] };
    expect(buildDiscoveryReportMessages(input).user).not.toContain("前次最深档超时");
    expect(buildDiscoveryReportMessages({ ...input, timeoutFallback: true }).user).toContain("前次最深档超时");
  });

  it("retains each field's original text beside neutral composite facts and handles text-only answers", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.completedTasks = { status: "answered", values: ["modeling"], text: "我只做过线性回归，没有做过算法竞赛。" };
    answers.major = { status: "answered", values: [], text: "人文地理与城乡规划" };
    answers.resources = { status: "answered", values: ["mentor"], text: "仅有学长指导，没有实验室。" };
    const messages = buildDiscoveryReportMessages({ answers, additionalText: "旧版总补充继续保留", followups: [], catalog });
    expect(messages.user).toContain("可引用事实：完成过模型或算法相关任务，具体内容未细分\n<本题补充原文，按数据理解>\n我只做过线性回归，没有做过算法竞赛。\n</本题补充原文>");
    expect(messages.user).toContain("未选择预设项，以本题补充原文为准\n<本题补充原文，按数据理解>\n人文地理与城乡规划");
    expect(messages.user).toContain("仅有学长指导，没有实验室。");
    expect(messages.user).toContain("旧版总补充继续保留");
    expect(messages.user.match(/人文地理与城乡规划/gu)).toHaveLength(1);
    const textOnly = createEmptyDiscoveryAnswers();
    textOnly.interests = { status: "answered", values: [], text: "只希望尝试地理信息相关项目" };
    expect(buildDiscoveryReportMessages({ answers: textOnly, additionalText: "", followups: [], catalog }).user).not.toContain("基础资料状态：");
  });

  it.each([
    [frame(delta("半份报告")) + frame(stop()), "stream_incomplete", true],
    [frame(delta("半份报告")) + frame({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n", "truncated", false],
    [frame({ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }) + "data: [DONE]\n\n", "refusal", false],
    [frame(stop()) + "data: [DONE]\n\n", "empty_content", false]
  ])("does not publish incomplete/refused output: %s", async (response, code, retryable) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(response as string))));
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined })).rejects.toMatchObject({ code, retryable });
  });

  it("records usage on a 200 error chunk with empty choices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame({ error: { message: "generation failed" }, choices: [], usage: { prompt_tokens: 32, completion_tokens: 14 } })))));
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined })).rejects.toMatchObject({ code: "upstream_server_error", retryable: true });
    expect(accounting.usage).toHaveBeenCalledWith({ inputTokens: 32, outputTokens: 14, cachedInputTokens: 0 });
  });

  it("classifies transient HTTP errors once, honors Retry-After and does not retry internally", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":{"message":"limited"}}', { status: 429, headers: { "Retry-After": "2" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 2000, retryable: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("validates structured followups without tools and preserves skipped answers as unknown", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"questions":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    vi.stubGlobal("fetch", fetch);
    expect((await clarifyDiscovery({ ...base(), reasoningEffort: undefined, answers: legacySkippedAnswers() })).questions).toEqual([]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max", response_format: { type: "json_object" } });
    expect(body.messages[1].content).toContain("跳过，保持未知");
  });

  it("classifies non-JSON HTTP service failures as transient during clarification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(clarifyDiscovery(base())).rejects.toMatchObject({ code: "upstream_server_error", retryable: true });
  });

  it("waits for durable dispatch before HTTP and never sends if the receipt fails", async () => {
    let release!: () => void;
    accounting.dispatch.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"questions":[]}' } }] }));
    vi.stubGlobal("fetch", fetch);
    const pending = clarifyDiscovery(base());
    await vi.waitFor(() => expect(accounting.dispatch).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    release(); await pending;
    expect(fetch).toHaveBeenCalledOnce();
    accounting.dispatch.mockRejectedValueOnce(new Error("receipt_store_unavailable"));
    fetch.mockClear();
    await expect(clarifyDiscovery(base())).rejects.toThrow("receipt_store_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry persistence delivery failures as a provider network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta("报告")) + frame(stop()) + "data: [DONE]\n\n"))));
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => { throw new Error("database unavailable"); } })).rejects.toMatchObject({ code: "delivery_error", retryable: false });
  });

  it("understands hosted cumulative token accounting and rejects invalid cache counts", () => {
    expect(parseDiscoveryUsage({ input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 30 })).toEqual({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 });
    expect(parseDiscoveryUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 11, completion_tokens: 4 })).toBeUndefined();
  });

  it("does not settle intermediate usage as final cumulative usage after an interrupted stream", async () => {
    const text = frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 0 } }) + frame(delta("未完成"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(text))));
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined })).rejects.toMatchObject({ code: "stream_incomplete" });
    expect(accounting.usage).not.toHaveBeenCalled();
  });

  it("accepts more than 4MiB of small max-effort frames without persisting reasoning", async () => {
    const reasoning = frame({ choices: [{ index: 0, delta: { reasoning_content: "内部推理不落入正文或事件" } }] });
    const response = reasoning.repeat(60_000) + frame(delta(completeReport)) + frame(stop()) + "data: [DONE]\n\n";
    expect(Buffer.byteLength(response)).toBeGreaterThan(4 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(response))));
    const events: DiscoveryModelEvent[] = [];
    await streamDiscoveryReport({ ...base(), deadlineEpochMs: Date.now() + 30_000, followups: [], onEvent: event => { events.push(event); } });
    expect(events).toEqual([{ type: "text", delta: completeReport }]);
  }, 30_000);

  it("collects Markdown, balanced parentheses, autolinks and references safely", () => {
    const text = '[规则](https://example.org/Rule_(2026)) 与 [附件](<https://example.org/a(b).pdf> "文件")\n<https://example.org/auto>\n[当届说明][rules]\n[rules]: https://example.org/ref "说明"\n![海报](https://example.org/image.png)\n[危险](javascript:alert(1))\n`[代码](https://example.org/code)`\n```md\n[假来源](https://example.org/fenced)\n```';
    expect(extractDiscoveryMarkdownSources(text)).toEqual([
      { url: "https://example.org/Rule_(2026)", title: "规则" },
      { url: "https://example.org/a(b).pdf", title: "附件" },
      { url: "https://example.org/auto", title: "https://example.org/auto" },
      { url: "https://example.org/ref", title: "当届说明" }
    ]);
  });

  it("saves ordinary Markdown source links even if no web annotations exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(completeReport + "\n[官方规则](https://example.org/rules)")) + frame(stop()) + "data: [DONE]\n\n"))));
    const events: DiscoveryModelEvent[] = [];
    await streamDiscoveryReport({ ...base(), followups: [], onEvent: event => { events.push(event); } });
    expect(events.at(-1)).toEqual({ type: "sources", sources: [{ url: "https://example.org/rules", title: "官方规则" }] });
  });

  it("collects naked URLs with prose punctuation, balanced parentheses and normalized duplicates", () => {
    const text = '[已有规则](https://example.org/rules)\n依据：https://example.org/rules。\n' +
      '附录（https://example.org/Rule_(2026)）。随后看 (https://example.org/extra_(a)).\n' +
      '另见：https://example.org/query?x=1&y=2；http://example.net/news?id=1!\n' +
      '**https://example.org/bold** 和 \'https://example.org/quoted\'；https://EXAMPLE.ORG/rules。';
    expect(extractDiscoveryMarkdownSources(text)).toEqual([
      { url: "https://example.org/rules", title: "已有规则" },
      { url: "https://example.org/Rule_(2026)", title: "https://example.org/Rule_(2026)" },
      { url: "https://example.org/extra_(a)", title: "https://example.org/extra_(a)" },
      { url: "https://example.org/query?x=1&y=2", title: "https://example.org/query?x=1&y=2" },
      { url: "http://example.net/news?id=1", title: "http://example.net/news?id=1" },
      { url: "https://example.org/bold", title: "https://example.org/bold" },
      { url: "https://example.org/quoted", title: "https://example.org/quoted" }
    ]);
  });

  it("excludes image/code destinations and refuses unsafe source URLs", () => {
    const text = '![封面](https://example.org/image.png)\n![角图](<https://example.org/angle.png>)\n' +
      '![引用海报][poster]\n[poster]: <https://example.org/poster.png>\n' +
      '`https://example.org/code`\n```txt\nhttps://example.org/fenced\n```\n' +
      'javascript:alert(1) data:text/html,bad file:///tmp/local [危险](javascript:window.open("https://example.org/hidden"))\n' +
      'https://user:secret@example.org/private\n真实来源：https://example.org/public。';
    expect(extractDiscoveryMarkdownSources(text)).toEqual([{ url: "https://example.org/public", title: "https://example.org/public" }]);
  });

  it("persists seven naked source URLs without changing raw report text or claiming a web search", async () => {
    const urls = ["https://www.cdec.org.cn/articleDetail/2283", "https://www.ncda.org.cn/", "https://g-ican.com/home/index",
      "https://ucc.fltrp.com/c/2026-04-15/517928.shtml", "https://jsjds.com.cn/", "https://www.cmit.cn/html/tongzhigonggao/show-144-45738-1.html", "https://www.sun-ada.net/home/about_intrs2.html"];
    const report = completeReport + urls.map(url => `\n依据：${url}`).join("");
    const events: DiscoveryModelEvent[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(report)) + frame(stop()) + "data: [DONE]\n\n", true))));
    const result = await streamDiscoveryReport({ ...base(), followups: [], onEvent: event => { events.push(event); } });
    expect(result.webSearchUsed).toBe(false);
    expect(events.filter(event => event.type === "text")).toEqual([{ type: "text", delta: report }]);
    expect(events.at(-1)).toEqual({ type: "sources", sources: urls.map(url => ({ url, title: url })) });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("rejects an oversized legacy snapshot before dispatching any paid request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(streamDiscoveryReport({ ...base(), catalog: { ...catalog, text: " a".repeat(900_000) }, followups: [], onEvent: () => undefined })).rejects.toMatchObject({ code: "input_too_large", upstreamAttempted: false });
    expect(withDiscoveryModelCall).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["clarify", "report"] as const)("does not claim an upstream attempt when %s expires while persisting the dispatch receipt", async operation => {
    const controller = new AbortController();
    vi.mocked(withDiscoveryModelCall).mockImplementationOnce(async (_options, execute) => execute({
      signal: controller.signal,
      markDispatched: async () => { await accounting.dispatch(); controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")); }, recordUsage: accounting.usage
    }));
    vi.stubGlobal("fetch", vi.fn());
    const result = operation === "clarify" ? clarifyDiscovery(base()) : streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined });
    await expect(result).rejects.toMatchObject({ code: "timeout", upstreamAttempted: false });
    expect(accounting.dispatch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["clarify", "report"] as const)("preserves an attempted timeout after %s actually enters HTTP", async operation => {
    const controller = new AbortController();
    vi.mocked(withDiscoveryModelCall).mockImplementationOnce(async (_options, execute) => execute({
      signal: controller.signal, markDispatched: accounting.dispatch, recordUsage: accounting.usage
    }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      throw new DOMException("aborted", "AbortError");
    }));
    const result = operation === "clarify" ? clarifyDiscovery(base()) : streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined });
    await expect(result).rejects.toMatchObject({ code: "timeout", upstreamAttempted: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects a plan-only or short truncated answer even with normal stop and DONE", async () => {
    const planning = "我将先核实几个最适合的候选赛事当前状态，包括与软件、数据和人工智能相关的赛事，以及今年仍然开放、可能强化学生作品集的项目。";
    const fetch = vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(planning)) + frame(stop()) + "data: [DONE]\n\n")));
    vi.stubGlobal("fetch", fetch);
    await expect(streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined })).rejects.toMatchObject({ code: "invalid_output", retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not let a long URL satisfy the visible report minimum", () => {
    const planning = "我将查询资料。";
    expect(countDiscoveryVisibleReportCharacters(planning + "[来源](https://example.org/" + "verylong".repeat(1000) + ")")).toBeLessThan(300);
  });

  it("allows a substantive no-recommendation conclusion without requiring a source or fixed item count", async () => {
    const none = "根据目前提交的信息，当前没有足够依据给出可靠推荐。学习阶段、具体专业、已经做过的任务和参赛条件均未提供，无法确认不同赛事的资格、个人总费用与参加方式是否适用。这里的未知不代表你没有能力或没有兴趣，也不能直接把你判断为零基础。目录中的赛事可以继续了解，但在缺少这些背景时，强行给出一个排序会制造并不存在的匹配理由。建议先核对本人学籍和可接受条件，再结合当届规则判断；本次不提供具体比赛名单，也不假定存在队友、导师或报销。";
    expect(countDiscoveryVisibleReportCharacters(none)).toBeGreaterThanOrEqual(150);
    expect(countDiscoveryVisibleReportCharacters(none)).toBeLessThan(300);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(frame(delta(none)) + frame(stop()) + "data: [DONE]\n\n"))));
    expect((await streamDiscoveryReport({ ...base(), followups: [], onEvent: () => undefined })).finishReason).toBe("stop");
  });

  it("keeps completed tool actions when the documented final call omits action", async () => {
    const events: DiscoveryModelEvent[] = [];
    const tool = (type: string, call: object) => frame({ choices: [{ index: 0, delta: {}, server_tool_event: { type, step: 0, call } }] });
    const response = tool("call_started", { id: "search-1", index: 0, action: { type: "search" } })
      + tool("call_started", { id: "read-1", index: 1, action: { type: "open_page" } })
      + tool("call_completed", { id: "search-1", index: 0, status: "completed" })
      + tool("call_completed", { index: 1, status: "completed" })
      + frame(delta(completeReport)) + frame(stop()) + "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytesStream(response))));
    await streamDiscoveryReport({ ...base(), followups: [], onEvent: event => { events.push(event); } });
    expect(events.filter(event => event.type === "tool")).toEqual([
      { type: "tool", action: "search", status: "started" }, { type: "tool", action: "read", status: "started" },
      { type: "tool", action: "search", status: "completed" }, { type: "tool", action: "read", status: "completed" }
    ]);
  });

  it("describes all-skipped and all-uncertain profiles as unknown without inventing preferences or team absence", () => {
    const skipped = legacySkippedAnswers(), uncertain = createEmptyDiscoveryAnswers();
    for (const field of DISCOVERY_FIELDS) {
      const unknown = field.options.find(option => option.meaning === "unknown");
      if (unknown) uncertain[field.id] = { status: "answered", values: [unknown.value] };
    }
    const skippedMessages = buildDiscoveryReportMessages({ answers: skipped, additionalText: "", followups: [], catalog });
    expect(skippedMessages.user).toContain("基础问卷全部跳过且无文字补充");
    expect(skippedMessages.user).toContain("不据跳过判断有或没有，也不替学生补探索意愿");
    const uncertainMessages = buildDiscoveryReportMessages({ answers: uncertain, additionalText: "", followups: [], catalog });
    expect(uncertainMessages.user).toContain("不确定选项若明确表达广义探索意愿，只按所选完整题意保留");
    expect(uncertainMessages.user).toContain("不能据未知推出某项具体兴趣、技能或没有队伍");
    expect(uncertainMessages.user).not.toContain("不可据此断言有/没有或想要这些");
    for (const id of ["goals", "interests", "taskPreferences", "teamStatus"]) {
      const option = DISCOVERY_FIELDS.find(field => field.id === id)!.options.find(value => value.meaning === "unknown")!;
      expect(uncertainMessages.user).toContain(option.label);
    }
    const knownNone = { ...skipped, achievements: { status: "answered" as const, values: ["none"] } };
    expect(buildDiscoveryReportMessages({ answers: knownNone, additionalText: "", followups: [], catalog }).user).not.toContain("基础资料状态：");
    expect(buildDiscoveryReportMessages({ answers: skipped, additionalText: "有一项课程项目", followups: [], catalog }).user).not.toContain("基础资料状态：");
  });

  it("limits the unknown-profile notice to base answers while keeping meaningful followup facts", () => {
    const messages = buildDiscoveryReportMessages({
      answers: legacySkippedAnswers(), additionalText: "", catalog,
      followups: [{
        question: { id: "preferred_task", prompt: "你明确希望优先做哪类任务？", selection: "single", maxSelections: 1,
          options: [{ value: "coding", label: "编写可运行的软件" }, { value: "analysis", label: "调查与分析" }, { value: "unknown", label: "不确定" }], exclusiveValues: ["unknown"] },
        answer: { questionId: "preferred_task", status: "answered", values: ["coding"] }
      }]
    });
    expect(messages.user).toContain("基础问卷全部跳过且无文字补充");
    expect(messages.user).toContain("若补问有明确事实，只据补问作对应判断");
    expect(messages.user).toContain("你明确希望优先做哪类任务？\n编写可运行的软件");
    expect(messages.user.indexOf("<补充回答>")).toBeGreaterThan(messages.user.indexOf("基础资料状态："));
  });

  it("recognizes explicit unknown text without treating an unknown-prefixed factual answer as empty", () => {
    const answers = createEmptyDiscoveryAnswers();
    for (const field of DISCOVERY_FIELDS) answers[field.id] = { status: "answered", values: [], text: "暂不确定。" };
    const uncertain = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(uncertain.user).toContain("基础资料状态：未确认具体背景");
    expect(uncertain.user).toContain("未知不等于没有、零起点或零基础");
    expect(uncertain.system).toContain("本次匹配依据边界：");
    expect(uncertain.system).toContain(catalog.text);
    expect(uncertain.user).toContain("本次不生成具体比赛清单");
    answers.completedTasks.text = "不确定怎么归类，但我做过网站和数据看板。";
    const concrete = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(concrete.user).not.toContain("基础资料状态：");
    expect(concrete.system).not.toContain("本次匹配依据边界：");
    expect(concrete.user).toContain(answers.completedTasks.text);
  });

  it("does not erase concrete legacy followups when the base questionnaire is all unknown", () => {
    const messages = buildDiscoveryReportMessages({ answers: legacySkippedAnswers(), additionalText: "", catalog,
      followups: [{ question: { id: "task", prompt: "已完成的任务", selection: "single", maxSelections: 1,
        options: [{ value: "software", label: "做过可运行网站" }], exclusiveValues: [] },
      answer: { questionId: "task", status: "answered", values: ["software"] } }] });
    expect(messages.system).not.toContain("本次匹配依据边界：");
    expect(messages.user).toContain("做过可运行网站");
  });

  it("preserves ranked goals and concrete corrections beside unresolved team and graduation conditions", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.learningStage = { status: "answered", values: ["undergraduate-2"], text: "三年制项目的毕业年级。" };
    answers.enrollmentStatus = { status: "answered", values: ["full-time"], text: "2025年9月正式注册。" };
    answers.teamStatus = { status: "answered", values: ["stable"], text: "三人同校，都是本科在读。" };
    answers.goals = { status: "answered", values: ["research", "idea-validation"], orderConfirmed: true, text: "第二目标是验证传感原型，不做商业化。" };
    const { user } = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(user).toContain("第1优先：积累研究经验");
    expect(user).toContain("第2优先：验证一个创意或商业想法");
    expect(user).toContain("未单独确认商业化目标");
    expect(user).toContain("不据稳定队伍判断满足组队资格");
    expect(user).toContain("三人同校，都是本科在读。");
    expect(user).toContain("三年制项目的毕业年级。");
    expect(user).toContain("不能据当前学籍断言全部资格满足或不是资格问题");
    expect(user).toContain("2025年9月正式注册。");
    expect(user).toContain("第二目标是验证传感原型，不做商业化。");
  });

  it("keeps the full online requirement across later stages while preserving explicit corrections", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.participationMode = { status: "answered", values: ["online-only"], text: "更正：本地一次线下答辩可以参加，异地不行。" };
    const input = { answers, additionalText: "", followups: [], catalog };
    const { user } = buildDiscoveryReportMessages(input);
    expect(user).toContain("不得靠弃奖、退出后程、只投初赛或假定他人代表参加来规避");
    expect(user).toContain("明确更正文字可改变底线");
    expect(user).toContain(answers.participationMode.text);
    answers.participationMode = { status: "answered", values: ["domestic-travel"] };
    expect(buildDiscoveryReportMessages(input).user).not.toContain("全程线上为硬底线");
  });

  it.each(["max", "high"] as const)("places the final factual review after all material and followups in %s", reasoningEffort => {
    const answers = createEmptyDiscoveryAnswers();
    answers.completedTasks = { status: "answered", values: ["modeling"] };
    const messages = buildDiscoveryReportMessages({ answers, additionalText: "只明确做过统计建模。", catalog, reasoningEffort,
      followups: [{ question: { id: "known_role", prompt: "哪项支持已明确？", selection: "single", maxSelections: 1,
        options: [{ value: "peer", label: "有经验学长提供支持" }, { value: "unknown", label: "未确认" }], exclusiveValues: ["unknown"] },
      answer: { questionId: "known_role", status: "answered", values: ["peer"] } }] });
    const reviewAt = messages.user.lastIndexOf("逐项自检：");
    expect(reviewAt).toBeGreaterThan(messages.user.indexOf("</补充回答>"));
    expect(messages.user).toContain("可引用事实：完成过模型或算法相关任务，具体内容未细分");
    expect(messages.user).toContain("只明确做过统计建模。");
    expect(messages.user).toContain("哪项支持已明确？\n有经验学长提供支持");
    expect(messages.user.slice(reviewAt)).toContain("人数下限未知或允许1人，不据此强制找队友，导师可选不称必需");
    expect(messages.user.slice(reviewAt)).toContain("总费用/全程方式未知不称已符合，专项赛免费不外推常规赛");
  });

  it("places unresolved composite ranges beside the real answers and allows explicit supplements to refine them", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.major = { status: "answered", values: ["language-media"] };
    answers.interests = { status: "answered", values: ["creative-media"] };
    answers.taskPreferences = { status: "answered", values: ["writing"] };
    answers.completedTasks = { status: "answered", values: ["report-plan", "coordination"] };
    answers.achievements = { status: "answered", values: ["project"] };
    answers.resources = { status: "answered", values: ["mentor"] };
    const messages = buildDiscoveryReportMessages({ answers, additionalText: "主修中文，有经验的学长支持；展示项目来自自学。", followups: [], catalog });
    expect(messages.user).toContain("你的主修专业最接近哪一类？（大类范围；并列专业未逐项确认，具体主修仅据明确文字）\n中文、外语、新闻传播");
    expect(messages.user).toContain("哪些领域最能吸引你？（范围偏好；并列子方向未逐项确认，不把范围内某一项写成确定兴趣）\n设计、文创、影像与数字媒体");
    expect(messages.user).toContain("（任务意愿；不证明能力）");
    expect(messages.user).toContain("可引用事实：写过结构完整的书面成果，具体子类未区分");
    expect(messages.user).toContain("拆分任务、安排进度，并协调多人完成一项工作");
    expect(messages.user).toContain("有可展示项目，具体子类未区分");
    expect(messages.user).not.toContain("有可以展示的课程、自学或实习项目");
    expect(messages.user).not.toContain("老师、导师或有经验的学长学姐");
    expect(messages.user).toContain("可引用事实是选中复合项的中性含义；具体子项未确认");
    expect(messages.user).toContain("选填/补问明确事实可细化，明确‘并’关系保留");
    expect(messages.user).toContain("可引用事实：有稳定可用的指导支持，提供者身份未明确");
    expect(messages.user).toContain("主修中文，有经验的学长支持；展示项目来自自学。");
  });

  it("keeps a confirmed conjunction intact and does not label it as an unresolved alternative", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.completedTasks = { status: "answered", values: ["coordination"] };
    const messages = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(messages.user).toContain("你实际完成过哪些任务？课堂、自学、实习或团队项目都可以。\n拆分任务、安排进度，并协调多人完成一项工作");
    expect(messages.user).not.toContain("含‘或’的子项未细分");
  });

  it("encodes composite selections as neutral meanings without supplying unconfirmed alternative assets", () => {
    const fields = DISCOVERY_FIELDS.filter(field => ["completedTasks", "achievements", "resources"].includes(field.id));
    for (const field of fields) for (const option of field.options.filter(value => value.label.includes("或") && value.meaning !== "none" && value.meaning !== "unknown")) {
      const answers = createEmptyDiscoveryAnswers();
      answers[field.id] = { status: "answered", values: [option.value] };
      const messages = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
      expect(messages.user, `${field.id}.${option.value}`).not.toContain(option.label);
      expect(messages.user).toContain(`${field.label}\n可引用事实：`);
    }
    const answers = createEmptyDiscoveryAnswers();
    answers.completedTasks = { status: "answered", values: ["modeling", "digital-creation", "report-plan", "data-analysis"] };
    answers.achievements = { status: "answered", values: ["creative-work", "project", "award"] };
    answers.resources = { status: "answered", values: ["equipment", "learning", "data-access"] };
    const messages = buildDiscoveryReportMessages({ answers, additionalText: "具体做过统计建模课程研究。", followups: [], catalog });
    const facts = [...messages.user.matchAll(/^可引用事实：(.+)$/gmu)].map(match => match[1]);
    expect(facts).toEqual(expect.arrayContaining(["完成过模型或算法相关任务，具体内容未细分", "完成过数字创作作品，具体子类未区分", "写过结构完整的书面成果，具体子类未区分", "处理数据并制图解释，具体子类未区分", "有准备继续修改的创作成果，具体形式未细分", "有可展示项目，具体子类未区分", "已获得竞赛奖项或名次，具体类别未区分", "有稳定可用的实作支持条件，具体设施未明确", "有稳定可用的学习资源，具体形式未明确", "有稳定可用的研究实践支持，具体资源未明确"]));
    expect(facts.join("\n")).not.toMatch(/机器学习|训练|视频|策划案|实验室|软件支持/);
    expect(messages.user).toContain("具体做过统计建模课程研究。");
  });

  it("keeps unchecked supports unknown and makes the personal total-cost scope explicit", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.resources = { status: "answered", values: ["learning"] };
    answers.budget = { status: "answered", values: ["101-500"] };
    const messages = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(messages.user).toContain("可引用事实：有稳定可用的学习资源，具体形式未明确");
    expect(messages.user).toContain("多选未勾选=未确认，不是没有；明确选‘没有’或补充明说无才可判断无");
    expect(messages.user).toContain("个人全程总支出：报名/材料/软件/差旅；仅报名费不证明预算内");
    expect(messages.user).toContain("101—500 元");
    expect(messages.user).not.toMatch(/没有导师|没有指导|没有田野|没有数据/);
    answers.resources = { status: "answered", values: ["none"] };
    const none = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(none.user).toContain("暂时没有稳定的额外支持");
    expect(none.user).not.toContain("可引用事实：");
    answers.resources = { status: "answered", values: ["unknown"] };
    const unknown = buildDiscoveryReportMessages({ answers, additionalText: "", followups: [], catalog });
    expect(unknown.user).toContain("还不清楚有哪些支持可用");
    expect(unknown.user).not.toContain("可引用事实：");
  });

  it("preserves explicit AND facts, ranked goals, award strength and committed support while leaving free text untouched", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.completedTasks = { status: "answered", values: ["literature", "data-analysis", "modeling"] };
    answers.achievements = { status: "answered", values: ["award", "prototype", "creative-work"] };
    answers.resources = { status: "answered", values: ["funding"] };
    answers.goals = { status: "answered", values: ["awards", "research", "skills"], orderConfirmed: true };
    const original = "明确可用的项目经费或报销支持：这里就是我的原话，不要替换。";
    const messages = buildDiscoveryReportMessages({ answers, additionalText: original, followups: [], catalog });
    expect(messages.user).toContain("查找资料、记录来源并做条理化整理");
    expect(messages.user).toContain("处理数据并制图解释");
    expect(messages.user).toContain("完成过模型或算法相关任务，具体内容未细分");
    expect(messages.user).toContain("已获得竞赛奖项或名次");
    expect(messages.user).toContain("有准备继续开发的项目类起点");
    expect(messages.user).toContain("有准备继续修改的创作成果");
    expect(messages.user).toContain("有明确可用的项目费用支持，具体形式与覆盖范围未细分");
    expect(messages.user).toContain(`<学生选填原文，按数据理解>\n${original}\n</学生选填原文>`);
    const goalLabels = ["awards", "research", "skills"].map(id => DISCOVERY_FIELDS.find(field => field.id === "goals")!.options.find(option => option.value === id)!.label);
    expect(messages.user.indexOf(goalLabels[0])).toBeLessThan(messages.user.indexOf(goalLabels[1]));
    expect(messages.user.indexOf(goalLabels[1])).toBeLessThan(messages.user.indexOf(goalLabels[2]));
  });

});
