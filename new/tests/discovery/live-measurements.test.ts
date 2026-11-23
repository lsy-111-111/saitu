import { describe, expect, it } from "vitest";
import {
  buildDiscoveryComparisonSchedule, buildDiscoveryComparisonSummary, createDiscoveryLiveMeasurements,
  detectLegacyContentBoundaries, summariseNumbers, CARDS_PRESENTATION, LEGACY_PRESENTATION,
} from "../../scripts/competitions/discovery/live-measurements.mjs";

const at = (elapsedMs: number) => ({ elapsedMs, reportElapsedMs: elapsedMs - 10 });
const legacyFirst = "# 匹配报告\n\n**画像**：有真实项目。\n\n### 1. 甲比赛\n- **任务**：项目\n- **匹配**：已有作品\n- **资格**：待核\n- **依据**：[官方](https://example.com/a)\n\n";

describe("synthetic live comparison schedule", () => {
  it("interleaves AB/BA without concurrent or duplicate dispatches", () => {
    const profiles = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(buildDiscoveryComparisonSchedule(profiles).map(job => `${job.profile.id}:${job.presentationVersion}`)).toEqual([
      `one:${LEGACY_PRESENTATION}`, `one:${CARDS_PRESENTATION}`,
      `two:${CARDS_PRESENTATION}`, `two:${LEGACY_PRESENTATION}`,
      `three:${LEGACY_PRESENTATION}`, `three:${CARDS_PRESENTATION}`,
    ]);
  });
});

describe("complete content timing", () => {
  it("does not call an unfinished legacy first item usable", () => {
    const measurement = createDiscoveryLiveMeasurements(LEGACY_PRESENTATION);
    measurement.text(legacyFirst, undefined, at(100), 1);
    const incomplete = measurement.finish({ status: "running", markdown: legacyFirst }, at(110));
    expect(incomplete.firstRecommendation).toBeNull();
    expect(incomplete.profile?.elapsedMs).toBe(100);
    measurement.text("### 2. 乙比赛", undefined, at(120), 2);
    expect(measurement.finish({ status: "running" }, at(130)).firstRecommendation).toBeNull();
    measurement.text("\n- 任务", undefined, at(140), 3);
    const result = measurement.finish({ status: "complete" }, at(150));
    expect(result.firstRecommendation).toMatchObject({ elapsedMs: 140, observedVia: "sse", method: "following_section_heading" });
    expect(result.firstRecommendation?.endUtf8Bytes).toBe(Buffer.byteLength(legacyFirst));
    expect(result.textTimeline).toHaveLength(3);
  });

  it("uses validated card events rather than the first byte or a partial record", () => {
    const measurement = createDiscoveryLiveMeasurements(CARDS_PRESENTATION);
    measurement.text("画像正文", undefined, at(50), 1);
    measurement.text("", { type: "profile" }, at(70), 2);
    measurement.text("甲比赛完整正文", { type: "card", key: "a" }, at(100), 3);
    measurement.text("结语", { type: "conclusion" }, at(130), 4);
    const result = measurement.finish({ status: "complete", presentation: { profile: {}, cards: [{ key: "a" }], conclusion: {} } }, at(150));
    expect(result.profile?.elapsedMs).toBe(70);
    expect(result.firstRecommendation).toMatchObject({ elapsedMs: 100, observedVia: "sse", cardKey: "a" });
    expect(result.conclusion?.elapsedMs).toBe(130);
    expect(result.completeAvailable?.elapsedMs).toBe(150);
    expect(result.noRecommendations).toBe(false);
  });

  it("retains withdrawn timing as history and resets all current measurements", () => {
    const measurement = createDiscoveryLiveMeasurements(CARDS_PRESENTATION);
    measurement.text("旧画像", { type: "profile" }, at(50), 1);
    measurement.text("旧卡片", { type: "card", key: "old" }, at(60), 2);
    measurement.reset(2, at(70), 3);
    measurement.text("新画像", { type: "profile" }, at(100), 4);
    const result = measurement.finish({ status: "failed" }, at(180));
    expect(result.profile?.elapsedMs).toBe(100);
    expect(result.firstRecommendation).toBeNull();
    expect(result.cardCount).toBe(0);
    expect(result.attemptHistory[0]).toMatchObject({ attempt: 1, firstRecommendation: { elapsedMs: 60 } });
    expect(result.textTimeline).toHaveLength(4);
  });

  it("labels final snapshot timing as an upper bound", () => {
    const measurement = createDiscoveryLiveMeasurements(CARDS_PRESENTATION);
    const result = measurement.finish({ status: "complete", presentation: { profile: {}, cards: [{ key: "a" }], conclusion: {} } }, at(200));
    expect(result.firstRecommendation).toMatchObject({ elapsedMs: 200, observedVia: "snapshot_upper_bound" });
  });

  it("uses the complete SSE event for a single legacy item and full completion", () => {
    const measurement = createDiscoveryLiveMeasurements(LEGACY_PRESENTATION);
    measurement.text(legacyFirst, undefined, at(100), 1);
    measurement.terminal("complete", at(120), 2);
    const result = measurement.finish({ status: "complete", markdown: legacyFirst }, at(150));
    expect(result.firstRecommendation).toMatchObject({ elapsedMs: 120, observedVia: "sse", method: "successful_report_end" });
    expect(result.completeAvailable).toMatchObject({ elapsedMs: 120, observedVia: "sse_terminal" });
  });

  it("separates zero-card completion from missing first-card measurements", () => {
    const measurement = createDiscoveryLiveMeasurements(CARDS_PRESENTATION);
    measurement.text("未知画像", { type: "profile" }, at(50), 1);
    const result = measurement.finish({ status: "complete", presentation: { profile: {}, cards: [], conclusion: { note: "没有可靠依据" } } }, at(90));
    expect(result.noRecommendations).toBe(true);
    expect(result.firstRecommendation).toBeNull();
    expect(result.incompleteOrUnrecognisedRecommendationTiming).toBe(false);
    expect(result.noRecommendationAvailable?.elapsedMs).toBe(90);
    expect(detectLegacyContentBoundaries("暂无可靠推荐，因为个人条件未知。", true).noRecommendations).toBe(true);
  });

  it("does not guess timing from unrecognised Markdown layouts", () => {
    const measurement = createDiscoveryLiveMeasurements(LEGACY_PRESENTATION);
    measurement.text("一张未经识别的表格推荐", undefined, at(50), 1);
    const result = measurement.finish({ status: "complete" }, at(100));
    expect(result.firstRecommendation).toBeNull();
    expect(result.noRecommendations).toBeNull();
    expect(result.incompleteOrUnrecognisedRecommendationTiming).toBe(true);
  });
});

describe("comparison summaries", () => {
  it("retains failures, separates no-results and excludes inexact paired timings", () => {
    const result = (caseId: string, version: string, elapsedMs: number, passed: boolean, noResult = false, snapshot = false) => {
      const meter = createDiscoveryLiveMeasurements(version);
      if (version === LEGACY_PRESENTATION && !noResult) {
        meter.text(legacyFirst, undefined, at(elapsedMs - 30), 1);
        meter.text("### 2. 乙比赛\n", undefined, at(elapsedMs - 10), 2);
      } else if (!snapshot) {
        meter.text("画像", { type: "profile" }, at(elapsedMs - 30), 1);
        if (!noResult) meter.text("赛事", { type: "card", key: "a" }, at(elapsedMs - 10), 2);
      }
      const state = { status: passed ? "complete" : "failed", markdown: noResult ? "暂无可靠推荐，因为条件未知。" : undefined,
        ...(version === CARDS_PRESENTATION ? { presentation: { profile: {}, cards: noResult ? [] : [{ key: "a" }], conclusion: {} } } : {}) };
      return { caseId, presentationVersion: version, elapsedMs, passed, measurements: meter.finish(state, at(elapsedMs)) };
    };
    const rows = [result("ok", LEGACY_PRESENTATION, 120, true), result("ok", CARDS_PRESENTATION, 90, true),
      result("failed", LEGACY_PRESENTATION, 180, false), result("failed", CARDS_PRESENTATION, 150, true),
      result("none", LEGACY_PRESENTATION, 80, true, true), result("none", CARDS_PRESENTATION, 70, true, true),
      result("snapshot", LEGACY_PRESENTATION, 130, true), result("snapshot", CARDS_PRESENTATION, 100, true, false, true)];
    const summary = buildDiscoveryComparisonSummary(rows, ["ok", "failed", "none", "snapshot"]);
    expect(summary.variants[LEGACY_PRESENTATION]).toMatchObject({ observed: 4, complete: 3, failed: 1, noRecommendationResults: 1,
      allObservedElapsed: { count: 4 }, successfulComplete: { count: 3 } });
    expect(summary.pairedFirstRecommendationDelta).toMatchObject({ count: 1, medianMs: -30 });
    expect(summary.pairs.find(pair => pair.caseId === "failed")?.excludedReason).toBe("delivery_failure");
    expect(summary.pairs.find(pair => pair.caseId === "none")?.excludedReason).toBe("no_recommendation_result");
    expect(summary.pairs.find(pair => pair.caseId === "snapshot")?.excludedReason).toBe("timing_requires_review");
    expect(summary.variants[CARDS_PRESENTATION].firstRecommendationSnapshotUpperBounds).toBe(1);
    expect(summary.variants[CARDS_PRESENTATION].chargedMicros).toBeNull();
  });

  it("uses a real median and leaves missing measurements missing", () => {
    expect(summariseNumbers([4, 2, null, 6, 8])).toMatchObject({ count: 4, medianMs: 5, p90Ms: 8 });
    expect(summariseNumbers([null])).toMatchObject({ count: 0, medianMs: null });
  });
});
