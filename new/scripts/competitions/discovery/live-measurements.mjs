/** Synthetic live acceptance measurements. This module never dispatches work. */
import { buildDiscoveryExperimentSummary, summariseBenchmarkNumbers } from "./benchmark-stats.mjs";
export { applyDiscoveryTimingReviews, buildDiscoveryExperimentSummary, bootstrapDiscoveryPairs,
  discoveryBenchmarkIdentity, discoveryBenchmarkResultKey, evaluateDiscoveryBenchmark } from "./benchmark-stats.mjs";
export const LEGACY_PRESENTATION = "legacy";
export const CARDS_PRESENTATION = "discovery-cards.v1";

export function buildDiscoveryComparisonSchedule(profiles) {
  return profiles.flatMap((profile, index) => {
    const versions = index % 2 === 0 ? [LEGACY_PRESENTATION, CARDS_PRESENTATION] : [CARDS_PRESENTATION, LEGACY_PRESENTATION];
    return versions.map(presentationVersion => ({ profile, presentationVersion }));
  });
}

const utf8 = value => Buffer.byteLength(value, "utf8");
const numberedTitle = /^(?:推荐(?:竞赛|赛事)?\s*)?(?:[（(]?\d+[）).、．：:]|[一二三四五六七八九十]+[、．.：:])\s*\S/u;
const conclusionTitle = /优先建议|优先选择|最后建议|总结|下一步|无可靠推荐|暂无可靠推荐/u;
const noRecommendation = /(?:暂无|没有|未找到|无法给出|暂不提供|暂不推荐)[^\n。！？]{0,32}(?:可靠|合适|符合|推荐|候选)/u;

/** Conservative Markdown boundary evidence, never the first character of an item.
 * A following peer/parent heading closes the first item. With one item, only a
 * successful terminal result closes it. Unrecognised layouts stay unmeasured. */
export function detectLegacyContentBoundaries(markdown, terminal = false) {
  const headings = [];
  let offset = 0;
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index], line = raw.replace(/\r$/u, "").trim();
    if (index === lines.length - 1 && !terminal) break;
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    const bold = /^\*\*(.+?)\*\*[ \t]*$/u.exec(line);
    if (heading || bold) {
      const title = (heading?.[2] ?? bold[1]).replace(/\*\*/gu, "");
      headings.push({ title, level: heading?.[1].length ?? 7, offset,
        numbered: numberedTitle.test(title), conclusion: conclusionTitle.test(title) });
    }
    offset += raw.length + 1;
  }
  const first = headings.find(heading => heading.numbered);
  if (!first) return { noRecommendations: terminal && noRecommendation.test(markdown), method: "unrecognised_or_no_recommendation" };
  const next = headings.find(heading => heading.offset > first.offset
    && (heading.numbered || heading.conclusion || first.level < 7 && heading.level <= first.level));
  return {
    profileEndUtf8Bytes: utf8(markdown.slice(0, first.offset)),
    firstRecommendationStartUtf8Bytes: utf8(markdown.slice(0, first.offset)),
    firstRecommendationEndUtf8Bytes: next ? utf8(markdown.slice(0, next.offset)) : terminal ? utf8(markdown) : null,
    firstRecommendationTitle: first.title,
    method: next ? "following_section_heading" : terminal ? "successful_report_end" : "awaiting_following_boundary",
    noRecommendations: false,
  };
}

function timing(at, observedVia, evidence = {}) {
  return { elapsedMs: at.elapsedMs, reportElapsedMs: at.reportElapsedMs, observedVia, ...evidence };
}

export function createDiscoveryLiveMeasurements(presentationVersion) {
  let markdown = "", attempt = 1, profile = null, firstRecommendation = null, conclusion = null, cardCount = 0, completed = null;
  const textTimeline = [], attemptHistory = [];
  const legacy = presentationVersion === LEGACY_PRESENTATION;
  const inspectLegacy = (text, at, observedVia, terminal = false) => {
    const boundary = detectLegacyContentBoundaries(text, terminal);
    if (profile === null && boundary.profileEndUtf8Bytes !== undefined) {
      profile = timing(at, observedVia, { endUtf8Bytes: boundary.profileEndUtf8Bytes, method: "first_recommendation_heading" });
    }
    if (firstRecommendation === null && boundary.firstRecommendationEndUtf8Bytes !== null
      && boundary.firstRecommendationEndUtf8Bytes !== undefined) {
      firstRecommendation = timing(at, observedVia, {
        startUtf8Bytes: boundary.firstRecommendationStartUtf8Bytes, endUtf8Bytes: boundary.firstRecommendationEndUtf8Bytes,
        title: boundary.firstRecommendationTitle, method: boundary.method,
      });
    }
    return boundary;
  };
  return {
    text(delta, presentationRecord, at, seq) {
      markdown += delta;
      textTimeline.push({ seq, attempt, ...at, delta, cumulativeUtf8Bytes: utf8(markdown),
        ...(presentationRecord ? { recordType: presentationRecord.type, ...(presentationRecord.type === "card" ? { cardKey: presentationRecord.key } : {}) } : {}) });
      if (legacy) { inspectLegacy(markdown, at, "sse"); return; }
      if (presentationRecord?.type === "profile" && profile === null) profile = timing(at, "sse", { method: "validated_profile_record" });
      if (presentationRecord?.type === "card") {
        cardCount += 1;
        if (firstRecommendation === null) firstRecommendation = timing(at, "sse", { method: "validated_card_record", cardKey: presentationRecord.key });
      }
      if (presentationRecord?.type === "conclusion") conclusion = timing(at, "sse", { method: "validated_conclusion_record" });
    },
    reset(nextAttempt, at, seq) {
      attemptHistory.push({ attempt, profile, firstRecommendation, conclusion, cardCount });
      textTimeline.push({ seq, attempt, ...at, reset: true, nextAttempt });
      attempt = nextAttempt; markdown = ""; profile = null; firstRecommendation = null; conclusion = null; cardCount = 0;
      completed = null;
    },
    terminal(type, at, seq) {
      textTimeline.push({ seq, attempt, ...at, terminal: type });
      if (type === "complete") {
        completed = timing(at, "sse_terminal");
        if (legacy) inspectLegacy(markdown, at, "sse", true);
      }
    },
    finish(run, at) {
      const complete = run?.status === "complete";
      const finalMarkdown = typeof run?.markdown === "string" ? run.markdown : markdown;
      let noRecommendations = null;
      if (legacy) {
        const boundary = inspectLegacy(finalMarkdown, at, "snapshot_upper_bound", complete);
        if (complete) noRecommendations = boundary.noRecommendations === true ? true : firstRecommendation ? false : null;
      } else {
        const presentation = run?.presentation;
        // This is explicitly an upper bound when the SSE was unavailable. A
        // final snapshot is never presented as an exact early streaming time.
        if (presentation?.profile && profile === null) profile = timing(at, "snapshot_upper_bound", { method: "final_profile_snapshot" });
        if (presentation?.cards?.length) {
          cardCount = presentation.cards.length;
          if (firstRecommendation === null) firstRecommendation = timing(at, "snapshot_upper_bound", { method: "final_card_snapshot", cardKey: presentation.cards[0].key });
        }
        if (presentation?.conclusion && conclusion === null) conclusion = timing(at, "snapshot_upper_bound", { method: "final_conclusion_snapshot" });
        if (complete && presentation?.conclusion && Array.isArray(presentation.cards)) noRecommendations = presentation.cards.length === 0;
      }
      return {
        schemaVersion: "saitu.discovery-live-measurements.v1", presentationVersion, attempt,
        profile, firstRecommendation, conclusion, cardCount: legacy ? null : cardCount,
        noRecommendations, noRecommendationAvailable: complete && noRecommendations === true ? completed ?? timing(at, "terminal_snapshot") : null,
        completeAvailable: complete ? completed ?? timing(at, "terminal_snapshot") : null,
        incompleteOrUnrecognisedRecommendationTiming: noRecommendations !== true && firstRecommendation === null,
        textTimeline, attemptHistory,
        review: legacy ? "Conservative complete-section boundaries; review the saved deltas and byte offsets. Unrecognised layouts require manual timing review."
          : "Timing starts when a complete server-validated record arrives; a snapshot fallback is an explicit upper bound.",
      };
    },
  };
}

export function summariseNumbers(values) {
  return summariseBenchmarkNumbers(values);
}

/** Backward-compatible descriptive comparison, never a formal release gate.
 * New experiments must declare variants/rounds using buildDiscoveryExperimentSummary. */
export function buildDiscoveryComparisonSummary(results, selectedCaseIds, options = {}) {
  const summary = buildDiscoveryExperimentSummary(results, selectedCaseIds, {
    variants: [LEGACY_PRESENTATION, CARDS_PRESENTATION], baselineVariant: LEGACY_PRESENTATION,
    rounds: options.rounds ?? Math.max(1, ...results.map(row => row.round ?? 1)),
    startRound: options.startRound ?? 1, allowUnreviewedLegacy: true, ...options,
  });
  return { ...summary, schemaVersion: "saitu.discovery-live-comparison.v1",
    notes: [...summary.notes, "Compatibility-only raw legacy timing is exploratory and cannot satisfy the manual-review release gate.",
      "Token and charged-micros values use the existing accounting price snapshot, not a provider invoice."] };
}
