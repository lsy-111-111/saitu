import {
  REPORT_START_MARKER, REPORT_END_MARKER, PresentationError, applyDiscoveryPresentationRecord, emptyDiscoveryPresentation,
  presentationRecordSchema, type DiscoveryModelPresentationRecord, type DiscoveryPresentationState,
} from "./presentation";

const MAX_PRESENTATION_BUFFER_CHARACTERS = 2_000_000;

/** Frames complete JSON objects without treating physical newlines as record
 * boundaries. It never repairs JSON or changes any value inside an object. */
export class DiscoveryJsonObjectFramer {
  private markerPrefix = "";
  private objectParts: string[] = [];
  private objectCharacters = 0;
  private collecting = false;
  private closers: string[] = [];
  private inString = false;
  private escaped = false;
  private started = false;
  private finished = false;
  private failed = false;
  private endMarkerSeen = false;
  private readonly onObject: (value: unknown) => void | Promise<void>;
  private readonly canEnd: () => boolean;

  constructor(options: { onObject: (value: unknown) => void | Promise<void>; canEnd?: () => boolean }) {
    this.onObject = options.onObject;
    this.canEnd = options.canEnd ?? (() => true);
  }

  /** Await delivery of each object before scanning a subsequent object. */
  async push(delta: string): Promise<void> {
    if (this.finished || this.failed) throw new PresentationError("invalid_sequence");
    try {
      // Only a possible split marker is concatenated. Large unfinished objects
      // retain separate chunk slices, avoiding a growing string flatten per push.
      let input = this.markerPrefix + delta;
      this.markerPrefix = "";
      if (!this.started) {
        const markerAt = input.indexOf(REPORT_START_MARKER);
        if (markerAt < 0) {
          // Only retain a possible split marker; search preambles are not reports.
          this.markerPrefix = input.slice(-(REPORT_START_MARKER.length - 1));
          return;
        }
        input = input.slice(markerAt + REPORT_START_MARKER.length);
        this.started = true;
      }
      let segmentStart = this.collecting ? 0 : -1;
      for (let offset = 0; offset < input.length; offset += 1) {
        const character = input[offset];
        if (!this.collecting) {
          if (/\s/u.test(character)) continue;
          if (this.endMarkerSeen) throw new PresentationError("invalid_sequence");
          if (character === REPORT_END_MARKER[0]) {
            const pending = input.slice(offset);
            if (pending.length < REPORT_END_MARKER.length && REPORT_END_MARKER.startsWith(pending)) {
              this.markerPrefix = pending;
              break;
            }
            if (!pending.startsWith(REPORT_END_MARKER)) throw new PresentationError("invalid_json");
            if (!this.canEnd()) throw new PresentationError("invalid_sequence");
            this.endMarkerSeen = true;
            offset += REPORT_END_MARKER.length - 1;
            continue;
          }
          if (character !== "{") {
            if (input.length - offset > MAX_PRESENTATION_BUFFER_CHARACTERS) throw new PresentationError("response_too_large");
            throw new PresentationError("invalid_json");
          }
          this.collecting = true;
          this.objectCharacters = 0;
          this.objectParts = [];
          segmentStart = offset;
          this.closers = [];
          this.inString = false;
          this.escaped = false;
        }
        this.objectCharacters += 1;
        if (this.objectCharacters > MAX_PRESENTATION_BUFFER_CHARACTERS) throw new PresentationError("response_too_large");
        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (character === "\\") this.escaped = true;
          else if (character === '"') this.inString = false;
        } else if (character === '"') this.inString = true;
        else if (character === "{") this.closers.push("}");
        else if (character === "[") this.closers.push("]");
        else if (character === "}" || character === "]") {
          if (this.closers.pop() !== character) throw new PresentationError("invalid_json");
        }
        if (!this.inString && this.closers.length === 0) {
          this.objectParts.push(input.slice(segmentStart, offset + 1));
          const json = this.objectParts.join("");
          this.objectParts = [];
          this.collecting = false;
          segmentStart = -1;
          let value: unknown;
          try { value = JSON.parse(json); }
          catch { throw new PresentationError("invalid_json"); }
          await this.onObject(value);
        }
      }
      if (this.collecting && segmentStart >= 0 && segmentStart < input.length) this.objectParts.push(input.slice(segmentStart));
    } catch (error) { this.failed = true; throw error; }
  }

  async finish(): Promise<void> {
    if (this.finished || this.failed) throw new PresentationError("invalid_sequence");
    try {
      if (!this.started) throw new PresentationError("missing_marker");
      if (this.collecting || this.markerPrefix.trim()) throw new PresentationError("invalid_json");
      this.markerPrefix = "";
      this.finished = true;
    } catch (error) { this.failed = true; throw error; }
  }
}

/** Accepts decoded final-content deltas, never reasoning or tool payloads. */
export class DiscoveryPresentationParser {
  private state = emptyDiscoveryPresentation();
  private readonly framer: DiscoveryJsonObjectFramer;

  constructor(options: { onRecord: (record: DiscoveryModelPresentationRecord) => void | Promise<void> }) {
    this.framer = new DiscoveryJsonObjectFramer({ canEnd: () => Boolean(this.state.conclusion), onObject: async value => {
      const parsed = presentationRecordSchema.safeParse(value);
      if (!parsed.success) throw new PresentationError("invalid_record", parsed.error.issues);
      const next = applyDiscoveryPresentationRecord(this.state, parsed.data);
      await options.onRecord(parsed.data);
      this.state = next;
    } });
  }

  async push(delta: string): Promise<void> {
    await this.framer.push(delta);
  }

  async finish(): Promise<DiscoveryPresentationState> {
    await this.framer.finish();
    if (!this.state.profile || !this.state.conclusion) throw new PresentationError("incomplete_report");
    return this.state;
  }
}
