import "server-only";
import {
  REPORT_START_MARKER, REPORT_END_MARKER, PresentationError, applyDiscoveryPresentationRecord,
  emptyDiscoveryPresentation, type DiscoveryModelPresentationRecord, type DiscoveryPresentationSource,
  type DiscoveryPresentationState,
} from "./presentation";
import { extractDiscoveryMarkdownSources } from "./sources";
import type { DiscoveryProtocolFinishOptions } from "./protocol-wire";

type Kind = "profile" | "card" | "conclusion";
type Sections = Map<string, string[]>;
const PROFILE_HEADINGS = new Map([["背景", "background"], ["目标", "goals"], ["已有经历", "experience"], ["现实条件", "constraints"]]);
const CARD_HEADINGS = new Map([["任务", "tasks"], ["推荐理由", "reasons"], ["收获", "value"], ["条件", "conditions"], ["新增依据", "sources"]]);
const CONCLUSION_HEADINGS = new Map([["整体说明", "note"], ["冲突例外", "exceptions"]]);
const MAX_BUFFER = 2_000_000;
const invalid = (code: "invalid_record" | "invalid_sequence" = "invalid_record"): never => { throw new PresentationError(code); };

function paragraphs(lines: readonly string[]): string[] {
  const result: string[] = [];
  let current: string[] = [];
  const flush = () => { if (current.length) result.push(current.join("\n").trim()); current = []; };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) return invalid();
    const value = line.trim();
    if (!value) { flush(); continue; }
    if (/^-\s+/u.test(value)) { flush(); current.push(value.replace(/^-\s+/u, "")); }
    else current.push(value);
  }
  flush();
  return result;
}

function completeSourceLink(line: string): boolean {
  if (!line.startsWith("[")) return false;
  let at = 1;
  for (; at < line.length; at += 1) {
    if (line[at] === "\\") { at += 1; continue; }
    if (line[at] === "]") break;
  }
  if (at < 2 || line.slice(at, at + 2) !== "](") return false;
  at += 2;
  if (line[at] === "<") {
    const close = line.indexOf(">", at + 1);
    return close > at + 1 && line.slice(close + 1) === ")";
  }
  const start = at;
  let depth = 1;
  for (; at < line.length; at += 1) {
    if (/\s/u.test(line[at])) return false;
    if (line[at] === "\\") { at += 1; continue; }
    if (line[at] === "(") depth += 1;
    else if (line[at] === ")") {
      depth -= 1;
      if (!depth) return at > start && at === line.length - 1;
    }
  }
  return false;
}

function sources(lines: readonly string[]): DiscoveryPresentationSource[] {
  return lines.map(line => line.trim().replace(/^-\s+/u, "")).filter(Boolean).map(line => {
    if (!completeSourceLink(line)) return invalid();
    const values = extractDiscoveryMarkdownSources(line);
    return values.length === 1 ? values[0] : invalid();
  });
}

/** Only control labels may use bold or an inline colon value. Body wording is
 * never rewritten, interpreted, shortened or used to guess another field. */
function labelled(value: string): { label: string; first?: string } {
  const bold = /^\*\*([^*]+)\*\*(?:[：:][ \t]*(.*))?$/u.exec(value);
  const plain = /^([^：:]+?)(?:[：:][ \t]*(.*))?$/u.exec(value);
  const match = bold ?? plain;
  return match ? { label: match[1].trim(), ...(match[2] === undefined ? {} : { first: match[2] }) } : invalid();
}

/** A closed Chinese Markdown grammar. The decoder supplies the same frozen
 * name resolution, public schema and URL identity boundary as other arms. */
export class DiscoveryMarkdownProtocolParser {
  private buffer = "";
  private started = false;
  private ended = false;
  private finished = false;
  private failed = false;
  private kind?: Kind;
  private competitionId?: string | null;
  private sections: Sections = new Map();
  private metadata = new Map<string, string>();
  private field?: string;
  private blockSize = 0;
  private state = emptyDiscoveryPresentation();

  constructor(private readonly options: {
    decode: (value: unknown) => DiscoveryModelPresentationRecord;
    onRecord: (record: DiscoveryModelPresentationRecord) => void | Promise<void>;
  }) {}

  async push(delta: string): Promise<void> {
    if (this.finished || this.failed) return invalid("invalid_sequence");
    try {
      this.buffer += delta;
      if (!this.started) {
        const at = this.buffer.indexOf(REPORT_START_MARKER);
        if (at < 0) { this.buffer = this.buffer.slice(-(REPORT_START_MARKER.length - 1)); return; }
        this.buffer = this.buffer.slice(at + REPORT_START_MARKER.length);
        this.started = true;
      }
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        if (at > MAX_BUFFER) throw new PresentationError("response_too_large");
        const line = this.buffer.slice(0, at).replace(/\r$/u, "");
        this.buffer = this.buffer.slice(at + 1);
        await this.acceptLine(line);
      }
      if (this.buffer.length > MAX_BUFFER) throw new PresentationError("response_too_large");
    } catch (error) { this.failed = true; throw error; }
  }

  async finish(options: DiscoveryProtocolFinishOptions = {}): Promise<DiscoveryPresentationState> {
    if (this.finished || this.failed) return invalid("invalid_sequence");
    try {
      if (!this.started) throw new PresentationError("missing_marker");
      if (this.buffer.trim()) await this.acceptLine(this.buffer.replace(/\r$/u, ""));
      this.buffer = "";
      // EOF is a record boundary only when the caller has independently
      // authenticated the provider's normal stop + DONE, never on raw EOF.
      if (!this.ended && options.upstreamEndedNormally === true && this.kind === "conclusion") {
        await this.closeCurrent();
        this.ended = true;
      }
      if (!this.ended || this.kind || !this.state.profile || !this.state.conclusion) throw new PresentationError("incomplete_report");
      this.finished = true;
      return this.state;
    } catch (error) { this.failed = true; throw error; }
  }

  private async acceptLine(line: string): Promise<void> {
    const value = line.trim();
    if (this.ended) { if (value) return invalid("invalid_sequence"); return; }
    if (value === REPORT_START_MARKER) return invalid("invalid_sequence");
    if (value === REPORT_END_MARKER) {
      if (this.kind !== "conclusion") return invalid("invalid_sequence");
      await this.closeCurrent();
      this.ended = true;
      return;
    }
    const heading = /^(#{2,3})[ \t]+(.+)$/u.exec(value);
    if (heading) {
      if (heading[1] === "##") {
        const title = labelled(heading[2]);
        let kind: Kind, id: string | null | undefined;
        if (title.label === "用户画像" && title.first === undefined) kind = "profile";
        else if (title.label === "优先建议" && title.first === undefined) kind = "conclusion";
        else if (title.label === "赛事" && title.first?.trim()) {
          kind = "card"; id = title.first.trim() === "库外" ? null : title.first.trim();
        } else return invalid("invalid_sequence");
        if (this.kind) {
          if (this.kind === "conclusion" || kind === "profile") return invalid("invalid_sequence");
          await this.closeCurrent();
        }
        this.kind = kind; this.competitionId = id; this.sections = new Map(); this.metadata = new Map(); this.blockSize = 0;
        this.field = kind === "profile" ? "summary" : kind === "conclusion" ? "priorities" : undefined;
        if (this.field) this.sections.set(this.field, []);
        return;
      }
      if (!this.kind) return invalid("invalid_sequence");
      const title = labelled(heading[2]), allowed = this.kind === "profile" ? PROFILE_HEADINGS : this.kind === "card" ? CARD_HEADINGS : CONCLUSION_HEADINGS;
      const field = allowed.get(title.label);
      if (!field || this.sections.has(field)) return invalid();
      this.field = field; this.sections.set(field, title.first === undefined ? [] : [title.first]);
      return;
    }
    // Unknown control headings, old field syntax and XML-style protocol tags
    // fail rather than becoming a hidden addition to an adjacent paragraph.
    if (/^#{1,6}(?:[ \t]|$)/u.test(value)
      || /^\[[A-Za-z][A-Za-z0-9_]*\](?:[ \t].*)?$/u.test(value)
      || /^\[(?:key|summary|timing|sourceRefs|title)\](?!\()/u.test(value)
      || /^<\/?SAITU(?:_|$)/u.test(value)
      || /^<\/?[A-Z][A-Z0-9_]*(?:\s[^<>]*)?\/?>(?:\s*)$/u.test(value)) return invalid();
    if (!this.kind) { if (value) return invalid("invalid_sequence"); return; }
    if (this.kind === "card" && !this.field && value) {
      const field = labelled(value);
      if (!["赛道", "名称"].includes(field.label) || field.first === undefined || this.metadata.has(field.label)) return invalid();
      this.metadata.set(field.label, field.first.trim());
      return;
    }
    if (!this.field) { if (value) return invalid(); return; }
    this.blockSize += line.length + 1;
    if (this.blockSize > MAX_BUFFER) throw new PresentationError("response_too_large");
    this.sections.get(this.field)!.push(line);
  }

  private async closeCurrent(): Promise<void> {
    const required = this.kind === "profile" ? [...PROFILE_HEADINGS.values()] : this.kind === "card"
      ? ["tasks", "reasons", "value", "conditions"] : ["priorities", "note", "exceptions"];
    if (!this.kind || required.some(field => !this.sections.has(field))) return invalid();
    const lines = (field: string) => this.sections.get(field) ?? [];
    const text = (field: string) => lines(field).join("\n").trim();
    let value: unknown;
    if (this.kind === "profile") value = {
      type: "profile", summary: text("summary"), groups: Object.fromEntries([...PROFILE_HEADINGS.values()].map(field => [field, paragraphs(lines(field))])),
    };
    else if (this.kind === "card") {
      if (!this.metadata.has("赛道") || this.competitionId === undefined
        || this.competitionId !== null && this.metadata.has("名称")
        || this.competitionId === null && !this.metadata.get("名称")) return invalid();
      const details = { tasks: paragraphs(lines("tasks")), reasons: paragraphs(lines("reasons")), value: paragraphs(lines("value")), conditions: paragraphs(lines("conditions")) };
      const authoredSources = sources(lines("sources"));
      if (this.competitionId === null && !authoredSources.length) return invalid();
      value = {
        type: "card", key: `r${this.state.cards.length + 1}`, competitionId: this.competitionId,
        ...(this.competitionId === null ? { title: this.metadata.get("名称") } : {}),
        track: this.metadata.get("赛道"), summary: details.reasons[0], timing: details.conditions[0], details, sources: authoredSources,
      };
    } else value = {
      type: "conclusion", priorities: paragraphs(lines("priorities")).map(line => {
        const at = line.indexOf("|");
        if (at < 1) return invalid();
        return { cardKey: line.slice(0, at).trim(), reason: line.slice(at + 1).trim() };
      }), note: text("note"), exceptions: paragraphs(lines("exceptions")),
    };
    const record = this.options.decode(value), next = applyDiscoveryPresentationRecord(this.state, record);
    await this.options.onRecord(record);
    this.state = next; this.kind = undefined; this.field = undefined; this.sections = new Map(); this.metadata = new Map();
  }
}
