import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DISCOVERY_GENERATION_PROTOCOLS, type DiscoveryGenerationProtocol,
} from "./generation-protocol";
import {
  REPORT_START_MARKER, REPORT_END_MARKER, PresentationError,
  applyDiscoveryPresentationRecord, emptyDiscoveryPresentation, presentationRecordSchema,
  discoveryPresentationSourceSchema, type DiscoveryModelPresentationRecord,
  type DiscoveryPresentationSource, type DiscoveryPresentationState,
} from "./presentation";
import { DiscoveryJsonObjectFramer, DiscoveryPresentationParser } from "./presentation-parser";
import { DiscoveryMarkdownProtocolParser } from "./markdown-protocol";
import { extractDiscoveryMarkdownSources } from "./sources";
import type { DiscoveryCatalogSnapshot } from "./transport";

export { DISCOVERY_GENERATION_PROTOCOLS as DISCOVERY_PROTOCOL_VERSIONS } from "./generation-protocol";
export type DiscoveryProtocolVersion = DiscoveryGenerationProtocol;
export const discoveryProtocolVersionSchema = z.enum(DISCOVERY_GENERATION_PROTOCOLS);
export const DISCOVERY_PROTOCOL_FEATURES: Record<DiscoveryProtocolVersion, {
  rules: boolean; blocks: boolean; refs: boolean; flow?: boolean; flat?: boolean; named?: boolean; narrative?: boolean; orientation?: boolean;
  markdown?: boolean; hostedOnlySources?: boolean; nested?: boolean; late?: boolean; groundedScope?: boolean;
}> = {
  v16: { rules: false, blocks: false, refs: false },
  rules: { rules: true, blocks: false, refs: false },
  blocks: { rules: false, blocks: true, refs: false },
  refs: { rules: false, blocks: false, refs: true },
  "json-optimized": { rules: true, blocks: false, refs: true },
  "blocks-optimized": { rules: true, blocks: true, refs: true },
  "blocks-flow": { rules: false, blocks: true, refs: true, flow: true },
  "json-flat": { rules: false, blocks: false, refs: true, flat: true },
  "blocks-flow-named": { rules: false, blocks: true, refs: true, flow: true, named: true },
  narrative: { rules: false, blocks: true, refs: true, flow: true, narrative: true },
  "narrative-rules": { rules: true, blocks: true, refs: true, flow: true, narrative: true },
  "narrative-index": { rules: false, blocks: true, refs: true, flow: true, narrative: true, orientation: true },
  "markdown-v16": { rules: false, blocks: false, refs: true, markdown: true, hostedOnlySources: true },
  "markdown-single": { rules: false, blocks: false, refs: true, markdown: true, hostedOnlySources: true },
  "markdown-nested": { rules: false, blocks: false, refs: true, markdown: true, hostedOnlySources: true, nested: true },
  "markdown-late": { rules: false, blocks: false, refs: true, markdown: true, hostedOnlySources: true, late: true },
  "markdown-grounded-scope": { rules: false, blocks: false, refs: true, markdown: true, hostedOnlySources: true, groundedScope: true },
};

export type DiscoveryProtocolFinishOptions = { upstreamEndedNormally?: boolean };
export type DiscoveryProtocolParser = {
  push(delta: string): Promise<void>;
  finish(options?: DiscoveryProtocolFinishOptions): Promise<DiscoveryPresentationState>;
};
type ObjectValue = Record<string, unknown>;
type CatalogReference = { title: string; sources: DiscoveryPresentationSource[] };
const MAX_BUFFER = 2_000_000;
const invalid = (code: "invalid_record" | "invalid_sequence" = "invalid_record"): never => { throw new PresentationError(code); };
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : invalid();

/** Index order is the exact localSources order in this frozen catalog, never a
 * URL search, live catalog lookup, metadata inference or fuzzy correction. */
export function createDiscoveryProtocolSourceIndex(catalog: DiscoveryCatalogSnapshot): Map<string, CatalogReference> {
  if (Buffer.byteLength(catalog.text, "utf8") !== catalog.byteLength || createHash("sha256").update(catalog.text).digest("hex") !== catalog.sha256) return invalid();
  let payload: ObjectValue;
  try { payload = object(JSON.parse(catalog.text)); } catch { return invalid(); }
  if (payload.schemaVersion !== "competition-discovery-catalog.v7" || payload.version !== catalog.version
    || !Array.isArray(payload.columns) || !Array.isArray(payload.entries) || payload.entries.length !== catalog.count
    || catalog.ids.length !== catalog.count || new Set(catalog.ids).size !== catalog.count) return invalid();
  const columns = payload.columns as unknown[];
  const idAt = columns.indexOf("id"), titleAt = columns.indexOf("name"), sourcesAt = columns.indexOf("localSources");
  if (idAt < 0 || titleAt < 0 || sourcesAt < 0) return invalid();
  const result = new Map<string, CatalogReference>();
  for (const [rowIndex, value] of payload.entries.entries()) {
    if (!Array.isArray(value)) return invalid();
    const id = value[idAt], title = value[titleAt], rawSources = value[sourcesAt];
    if (typeof id !== "string" || id !== catalog.ids[rowIndex] || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)
      || typeof title !== "string" || !title.trim() || !Array.isArray(rawSources) || result.has(id)) return invalid();
    const sources = rawSources.map((raw, index): DiscoveryPresentationSource => {
      const tuple = typeof raw === "string" ? [raw] : raw;
      if (!Array.isArray(tuple) || typeof tuple[0] !== "string") return invalid();
      const date = typeof raw !== "string" && typeof tuple[2] === "string" && tuple[2] !== "未知" ? `（原目录核查日期：${tuple[2]}）` : "";
      const parsed = discoveryPresentationSourceSchema.safeParse({ url: tuple[0], title: `${title} · 原目录来源${index + 1}${date}` });
      return parsed.success ? parsed.data : invalid();
    });
    result.set(id, { title, sources });
  }
  return result;
}

/** Resolve only explicitly selected same-competition source indexes. */
export function resolveDiscoveryProtocolRecord(value: unknown, index: ReadonlyMap<string, CatalogReference>): DiscoveryModelPresentationRecord {
  const input = object(value);
  if (input.type !== "card") return parsePublic(input);
  const { sourceRefs, ...card } = input;
  const refs = z.array(z.number().int().nonnegative()).max(128).safeParse(sourceRefs === undefined ? [] : sourceRefs);
  if (!refs.success || new Set(refs.data).size !== refs.data.length) return invalid();
  if (card.competitionId === null) {
    if (refs.data.length || typeof card.title !== "string") return invalid();
    return parsePublic({ ...card, sources: card.sources === undefined ? [] : card.sources });
  }
  if (typeof card.competitionId !== "string") return invalid();
  const owner = index.get(card.competitionId);
  if (!owner || card.title !== undefined && card.title !== owner.title) return invalid();
  const resolved = refs.data.map(reference => owner.sources[reference] ?? invalid());
  const authored = z.array(discoveryPresentationSourceSchema).safeParse(card.sources === undefined ? [] : card.sources);
  if (!authored.success) return invalid();
  return parsePublic({ ...card, title: owner.title, sources: [...resolved, ...authored.data] });
}

function parsePublic(value: unknown): DiscoveryModelPresentationRecord {
  const parsed = presentationRecordSchema.safeParse(value);
  if (!parsed.success) throw new PresentationError("invalid_record", parsed.error.issues);
  return parsed.data;
}

/** Private flat cards move the four explicitly authored arrays, without
 * guessing, merging aliases, filling missing fields or dropping unknown keys. */
function nestFlatCard(value: unknown): ObjectValue {
  const input = object(value);
  if (input.type !== "card") return input;
  if (Object.hasOwn(input, "details")) return invalid();
  const { tasks, reasons, value: benefits, conditions, ...card } = input;
  return { ...card, details: { tasks, reasons, value: benefits, conditions } };
}

const PROFILE_FIELDS = ["summary", "background", "goals", "experience", "constraints"];
const CARD_FIELDS = ["key", "competitionId", "title", "track", "summary", "timing", "tasks", "reasons", "value", "conditions", "sources"];
const NARRATIVE_CARD_FIELDS = ["competitionId", "title", "track", "tasks", "reasons", "value", "conditions", "sourceRefs", "sources"];
const CONCLUSION_FIELDS = ["priorities", "note", "exceptions"];
type Sections = Map<string, string[]>;

/** This restricted Markdown reader only removes list separators and blank
 * paragraph boundaries. Authored wording, line breaks and qualifiers survive. */
function paragraphs(lines: readonly string[]): string[] {
  const result: string[] = [];
  let current: string[] = [];
  const flush = () => { if (current.length) result.push(current.join("\n").trim()); current = []; };
  for (const raw of lines) {
    if (/^\s*(?:```|~~~)/u.test(raw)) return invalid();
    const value = raw.trim();
    if (!value) { flush(); continue; }
    if (/^-\s+/u.test(value)) { flush(); current.push(value.replace(/^-\s+/u, "")); }
    else current.push(raw.trim());
  }
  flush();
  return result;
}
const scalar = (sections: Sections, field: string): string => (sections.get(field) ?? []).join("\n").trim();

function splitSections(lines: readonly string[], allowed: readonly string[], inline = false): Sections {
  const sections: Sections = new Map();
  let field: string | undefined;
  for (const line of lines) {
    const header = (inline ? /^\[([A-Za-z][A-Za-z0-9_]*)\](?:[ \t]+(.*))?$/u : /^\[([A-Za-z][A-Za-z0-9]*)\]$/u).exec(line.trim());
    if (header) {
      field = header[1];
      if (!allowed.includes(field) || sections.has(field)) return invalid();
      sections.set(field, header[2] === undefined ? [] : [header[2]]);
    } else if (field) sections.get(field)!.push(line);
    else if (line.trim()) return invalid();
  }
  return sections;
}
function requireFields(sections: Sections, fields: readonly string[]) {
  if (fields.some(field => !sections.has(field))) return invalid();
}
function sourceLines(lines: readonly string[]): DiscoveryPresentationSource[] {
  const result: DiscoveryPresentationSource[] = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/^-\s+/u, "");
    if (!line) continue;
    // Sources are one complete Markdown link per line, not hidden in prose.
    if (!completeSourceLink(line)) return invalid();
    const sources = extractDiscoveryMarkdownSources(line);
    if (sources.length !== 1) return invalid();
    result.push(sources[0]);
  }
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

function blockRecord(kind: string, lines: readonly string[], refs: boolean, narrative = false, cardNumber = 1): ObjectValue {
  if (kind === "PROFILE") {
    const sections = splitSections(lines, PROFILE_FIELDS, narrative);
    requireFields(sections, PROFILE_FIELDS);
    return { type: "profile", summary: scalar(sections, "summary"), groups: Object.fromEntries(PROFILE_FIELDS.slice(1).map(field => [field, paragraphs(sections.get(field)!)])) };
  }
  if (kind === "CARD") {
    const sections = splitSections(lines, narrative ? NARRATIVE_CARD_FIELDS : refs ? [...CARD_FIELDS, "sourceRefs"] : CARD_FIELDS, narrative);
    requireFields(sections, narrative ? NARRATIVE_CARD_FIELDS.filter(field => field !== "title" && field !== "sources")
      : CARD_FIELDS.filter(field => field !== "timing" && !(refs && (field === "title" || field === "sources"))));
    const sourceRefs = (sections.get("sourceRefs") ?? []).map(line => line.trim().replace(/^-\s+/u, "")).filter(Boolean).map(value => {
      if (!/^(?:0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
      return Number(value);
    });
    const timing = scalar(sections, "timing"), competitionId = scalar(sections, "competitionId");
    if (narrative && competitionId !== "null" && sections.has("title")) return invalid();
    const details = {
      tasks: paragraphs(sections.get("tasks")!), reasons: paragraphs(sections.get("reasons")!),
      value: paragraphs(sections.get("value")!), conditions: paragraphs(sections.get("conditions")!),
    };
    return {
      type: "card", key: narrative ? `r${cardNumber}` : scalar(sections, "key"), competitionId: competitionId === "null" ? null : competitionId,
      ...(sections.has("title") ? { title: scalar(sections, "title") } : {}), track: scalar(sections, "track"),
      ...(narrative ? { summary: details.reasons[0], timing: details.conditions[0] }
        : { summary: scalar(sections, "summary"), ...(timing ? { timing } : {}) }),
      details,
      sources: sourceLines(sections.get("sources") ?? []), ...(refs ? { sourceRefs } : {}),
    };
  }
  const sections = splitSections(lines, CONCLUSION_FIELDS, narrative);
  requireFields(sections, CONCLUSION_FIELDS);
  const priorities = paragraphs(sections.get("priorities")!).map(value => {
    const boundary = value.indexOf("|");
    if (boundary < 1) return invalid();
    return { cardKey: value.slice(0, boundary).trim(), reason: value.slice(boundary + 1).trim() };
  });
  return { type: "conclusion", priorities, note: scalar(sections, "note"), exceptions: paragraphs(sections.get("exceptions")!) };
}

class DiscoveryTextBlockParser implements DiscoveryProtocolParser {
  private buffer = "";
  private started = false;
  private reportEnded = false;
  private finished = false;
  private failed = false;
  private kind: string | undefined;
  private lines: string[] = [];
  private blockSize = 0;
  private state = emptyDiscoveryPresentation();
  constructor(private readonly options: {
    refs: boolean; flow?: boolean; narrative?: boolean; decode: (value: unknown) => DiscoveryModelPresentationRecord;
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
  async finish(): Promise<DiscoveryPresentationState> {
    if (this.finished || this.failed) return invalid("invalid_sequence");
    try {
      if (!this.started) throw new PresentationError("missing_marker");
      if (this.buffer.trim()) await this.acceptLine(this.buffer.replace(/\r$/u, ""));
      this.buffer = "";
      if (this.kind || !this.reportEnded || !this.state.profile || !this.state.conclusion) throw new PresentationError("incomplete_report");
      this.finished = true;
      return this.state;
    } catch (error) { this.failed = true; throw error; }
  }
  private async acceptLine(line: string) {
    const value = line.trim();
    if (this.reportEnded) { if (value) return invalid("invalid_sequence"); return; }
    if (value === REPORT_START_MARKER) return invalid("invalid_sequence");
    if (value === REPORT_END_MARKER) {
      if (this.options.flow && this.kind === "CONCLUSION") await this.closeCurrent();
      if (this.kind || !this.state.conclusion) return invalid("invalid_sequence");
      this.reportEnded = true;
      return;
    }
    const opening = /^<(PROFILE|CARD|CONCLUSION)>$/u.exec(value);
    if (opening) {
      if (this.kind) {
        const sibling = (this.kind === "PROFILE" || this.kind === "CARD")
          && (opening[1] === "CARD" || opening[1] === "CONCLUSION");
        if (!this.options.flow || !sibling) return invalid("invalid_sequence");
        await this.closeCurrent();
      }
      if (this.state.conclusion) return invalid("invalid_sequence");
      this.kind = opening[1]; this.lines = []; this.blockSize = 0;
      return;
    }
    const closing = /^<\/(PROFILE|CARD|CONCLUSION)>$/u.exec(value);
    if (closing) {
      if (!this.kind || closing[1] !== this.kind) return invalid("invalid_sequence");
      await this.closeCurrent();
      return;
    }
    if (/^<\/?[A-Z][A-Z0-9_]*(?:\s[^<>]*)?\/?>(?:\s*)$/u.test(value)) return invalid("invalid_sequence");
    if (!this.kind) { if (value) return invalid("invalid_sequence"); return; }
    this.blockSize += line.length + 1;
    if (this.blockSize > MAX_BUFFER) throw new PresentationError("response_too_large");
    this.lines.push(line);
  }
  private async closeCurrent(): Promise<void> {
    if (!this.kind) return invalid("invalid_sequence");
    const record = this.options.decode(blockRecord(this.kind, this.lines, this.options.refs, this.options.narrative, this.state.cards.length + 1));
    const next = applyDiscoveryPresentationRecord(this.state, record);
    await this.options.onRecord(record);
    this.state = next; this.kind = undefined; this.lines = []; this.blockSize = 0;
  }
}

export function createDiscoveryProtocolParser(options: {
  protocolVersion: DiscoveryProtocolVersion;
  catalog: DiscoveryCatalogSnapshot;
  onRecord: (record: DiscoveryModelPresentationRecord) => void | Promise<void>;
}): DiscoveryProtocolParser {
  const protocol = discoveryProtocolVersionSchema.parse(options.protocolVersion), features = DISCOVERY_PROTOCOL_FEATURES[protocol];
  if (!features.blocks && !features.refs) return new DiscoveryPresentationParser({ onRecord: options.onRecord });
  const sourceIndex = features.refs ? createDiscoveryProtocolSourceIndex(options.catalog) : undefined;
  const decode = (value: unknown) => {
    const record = features.flat ? nestFlatCard(value) : value;
    return sourceIndex ? resolveDiscoveryProtocolRecord(record, sourceIndex) : parsePublic(record);
  };
  if (features.markdown) return new DiscoveryMarkdownProtocolParser({ decode, onRecord: options.onRecord });
  if (features.blocks) return new DiscoveryTextBlockParser({ refs: features.refs, flow: features.flow, narrative: features.narrative, decode, onRecord: options.onRecord });
  let state = emptyDiscoveryPresentation();
  const framer = new DiscoveryJsonObjectFramer({ canEnd: () => Boolean(state.conclusion), onObject: async value => {
    const record = decode(value), next = applyDiscoveryPresentationRecord(state, record);
    await options.onRecord(record);
    state = next;
  } });
  return {
    push: delta => framer.push(delta),
    async finish() {
      await framer.finish();
      if (!state.profile || !state.conclusion) throw new PresentationError("incomplete_report");
      return state;
    },
  };
}
