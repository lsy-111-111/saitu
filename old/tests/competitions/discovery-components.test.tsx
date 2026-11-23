import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiscoveryChoices, moveDiscoveryPriority, toggleDiscoveryChoice, type DiscoveryChoiceField } from "@/components/competitions/discovery/DiscoveryChoices";
import { DiscoveryFollowupStatus } from "@/components/competitions/discovery/DiscoveryFollowupStatus";
import { DiscoveryQuestionCard } from "@/components/competitions/discovery/DiscoveryQuestionCard";
import { DiscoverySummary } from "@/components/competitions/discovery/DiscoverySummary";
import { DISCOVERY_QUESTIONS, createEmptyDiscoveryAnswers } from "@/lib/competitions/discovery/questionnaire";

const field: DiscoveryChoiceField = {
  id: "interest", label: "你愿意做什么？", selection: "multiple", maxSelections: 2,
  exclusiveValues: ["unknown", "none"],
  options: [{ value: "code", label: "写代码" }, { value: "research", label: "做调研" }, { value: "design", label: "做设计" }, { value: "unknown", label: "暂不确定" }, { value: "none", label: "以上都没有" }],
};

function findElement(node: React.ReactNode, predicate: (element: React.ReactElement<{ id?: string; children?: React.ReactNode }>) => boolean): React.ReactElement | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement<{ id?: string; children?: React.ReactNode }>(child)) continue;
    if (predicate(child)) return child;
    const found = findElement(child.props.children, predicate);
    if (found) return found;
  }
}

describe("new competition discovery choices", () => {
  beforeAll(() => vi.stubGlobal("React", React));
  afterAll(() => vi.unstubAllGlobals());

  it("makes failed followup saves visible with an explicit retry and never claims an initial unsaved draft was saved", () => {
    expect(renderToStaticMarkup(<DiscoveryFollowupStatus saving={false} saved={false} error="" onRetry={vi.fn()} />)).toBe("");
    const failed = renderToStaticMarkup(<DiscoveryFollowupStatus saving={false} saved={false} error="补问暂未保存" onRetry={vi.fn()} />);
    expect(failed).toContain('role="alert"'); expect(failed).toContain("重试保存补问");
    expect(renderToStaticMarkup(<DiscoveryFollowupStatus saving saved={false} error="" onRetry={vi.fn()} />)).toContain("正在保存补问");
    expect(renderToStaticMarkup(<DiscoveryFollowupStatus saving={false} saved error="" onRetry={vi.fn()} />)).toContain("补问已保存");
  });

  it("lets an exclusive answer replace a full selection and clears it when a concrete answer is chosen", () => {
    expect(toggleDiscoveryChoice(field, ["code", "research"], "unknown")).toEqual(["unknown"]);
    expect(toggleDiscoveryChoice(field, ["unknown"], "research")).toEqual(["research"]);
    expect(toggleDiscoveryChoice(field, ["none"], "unknown")).toEqual(["unknown"]);
    expect(toggleDiscoveryChoice(field, ["code", "research"], "design")).toEqual(["code", "research"]);
    expect(toggleDiscoveryChoice(field, ["code", "research"], "code")).toEqual(["research"]);
  });

  it("keeps unknown selectable after the multiple-choice limit is reached", () => {
    const html = renderToStaticMarkup(<DiscoveryChoices field={field} answer={{ status: "answered", values: ["code", "research"] }} onChange={vi.fn()} />);
    expect(html).toMatch(/value="unknown"/);
    const unknownInput = html.match(/<input[^>]*value="unknown"[^>]*>/)?.[0];
    const designInput = html.match(/<input[^>]*value="design"[^>]*>/)?.[0];
    expect(unknownInput).not.toContain("disabled");
    expect(designInput).toContain("disabled");
  });

  it("keeps other single-choice options enabled after selecting one", () => {
    const single = { ...field, selection: "single" as const, maxSelections: 1 };
    const html = renderToStaticMarkup(<DiscoveryChoices field={single} answer={{ status: "answered", values: ["code"] }} onChange={vi.fn()} />);
    expect(html.match(/<input[^>]*value="research"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(toggleDiscoveryChoice(single, ["code"], "research")).toEqual(["research"]);
    expect(html).not.toContain("跳过");
    expect(html).toContain("interest-text");
    expect(html).toContain("0/200 字");
  });

  it("requires every subquestion before advancing and renders a text box for each", () => {
    const answers = createEmptyDiscoveryAnswers(), question = DISCOVERY_QUESTIONS[0];
    answers.learningStage = { status: "answered", values: [], text: "本科二年级" };
    const props = { question, index: 0, total: DISCOVERY_QUESTIONS.length, onChange: vi.fn(), onNext: vi.fn(), onBack: vi.fn() };
    const incomplete = renderToStaticMarkup(<DiscoveryQuestionCard {...props} answers={answers} />);
    expect(incomplete).toMatch(/<button[^>]*disabled=""[^>]*>下一步<\/button>/);
    expect(incomplete.match(/<textarea/g)).toHaveLength(2);
    expect(incomplete).not.toContain("跳过");
    answers.enrollmentStatus = { status: "answered", values: [], text: "全日制在读" };
    const complete = renderToStaticMarkup(<DiscoveryQuestionCard {...props} answers={answers} />);
    expect(complete).not.toMatch(/<button[^>]*disabled=""[^>]*>下一步<\/button>/);
  });

  it("accepts text-only answers, limits Unicode characters, and makes clearing an answer incomplete", () => {
    const onChange = vi.fn();
    const element = DiscoveryChoices({ field, answer: { status: "unanswered", values: [] }, onChange });
    const textarea = findElement(element, node => node.props.id === "interest-text") as React.ReactElement<{ onChange: (event: { target: { value: string } }) => void }>;
    textarea.props.onChange({ target: { value: "😀".repeat(201) } });
    expect(onChange).toHaveBeenLastCalledWith({ status: "answered", values: [], text: "😀".repeat(200) });
    textarea.props.onChange({ target: { value: "   " } });
    expect(onChange).toHaveBeenLastCalledWith({ status: "unanswered", values: [], text: "   " });
  });

  it("shows per-question text and only a removable historical supplement on review", () => {
    const answers = createEmptyDiscoveryAnswers();
    answers.major = { status: "answered", values: [], text: "交互设计，做过校园服务原型" };
    const props = { answers, consentAccepted: false, busy: false, error: "", onEdit: vi.fn(), onRemoveLegacyText: vi.fn(), onConsent: vi.fn(), onSubmit: vi.fn() };
    const html = renderToStaticMarkup(<DiscoverySummary {...props} additionalText="上次保留的跨专业说明" />);
    expect(html).toContain("交互设计，做过校园服务原型");
    expect(html).toContain("上次保留的跨专业说明");
    expect(html).toContain("删除这段历史说明");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("最多两道补充");
    const fresh = renderToStaticMarkup(<DiscoverySummary {...props} additionalText="" />);
    expect(fresh).not.toContain("上次草稿保留");
  });

  it("shows explicit priorities and confirmation without requiring drag and drop", () => {
    const ranked = { ...field, selection: "ranked" as const };
    const html = renderToStaticMarkup(<DiscoveryChoices field={ranked} answer={{ status: "answered", values: ["research", "code"], orderConfirmed: false }} onChange={vi.fn()} />);
    expect(html).toContain("目标优先顺序");
    expect(html).toContain("我确认以上目标顺序");
    expect(html).toContain("提高写代码的优先级");
    expect(moveDiscoveryPriority(["research", "code"], 1, -1)).toEqual(["code", "research"]);
    expect(moveDiscoveryPriority(["research", "code"], 0, -1)).toEqual(["research", "code"]);
  });
});
