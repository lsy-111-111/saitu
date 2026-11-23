/** Pure source extraction shared by new streams and recovered report snapshots.
 * It never changes report text or implies that a URL was fetched. */
export type DiscoverySource = { url: string; title: string };

export function safeDiscoverySourceUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 8192) return null;
  try {
    const url = new URL(input);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function bareDestination(candidate: string, preceding: string): string {
  let value = candidate.replace(/['.,;:!?]+$/u, "");
  for (const marker of ["**", "__", "~~", "*", "_"]) {
    if (preceding.endsWith(marker) && value.endsWith(marker)) value = value.slice(0, -marker.length);
  }
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (value) {
    const closing = value.at(-1)!, opening = pairs[closing];
    if (!opening || value.split(closing).length <= value.split(opening).length) break;
    value = value.slice(0, -1).replace(/['.,;:!?]+$/u, "");
  }
  return value;
}

/** Preserve Markdown verbatim and recover its ordinary clickable sources.
 * Explicit destinations retain their own punctuation; bare links follow prose
 * punctuation/bracket boundaries. Code and image destinations are not sources. */
export function extractDiscoveryMarkdownSources(markdown: string): DiscoverySource[] {
  const visible = markdown.replace(/```[^]*?```|~~~[^]*?~~~/gu, "").replace(/`[^`\n]*`/gu, "");
  const found = new Map<string, DiscoverySource>(), destinations: [number, number][] = [];
  const add = (urlValue: string, title: string) => {
    const url = safeDiscoverySourceUrl(urlValue.replace(/\\([()<>])/gu, "$1"));
    if (url && !found.has(url)) found.set(url, { url, title: title.replace(/\\([\[\]])/gu, "$1").trim().slice(0, 500) || url });
  };
  // Include image destinations in the scan only to exclude them from bare URLs.
  for (const match of visible.matchAll(/(!?)\[([^\]\n]+)\]\(/gu)) {
    let at = (match.index ?? 0) + match[0].length;
    while (/[ \t]/u.test(visible[at] ?? "")) at += 1;
    if (visible[at] === "<") {
      const end = visible.indexOf(">", at + 1);
      if (end >= 0) {
        destinations.push([match.index ?? 0, end + 1]);
        if (!match[1]) add(visible.slice(at + 1, end), match[2]);
      }
      continue;
    }
    const start = at;
    let depth = 1;
    while (at < visible.length) {
      const character = visible[at];
      if (character === "\\") { at += 2; continue; }
      if (character === "(") depth += 1;
      else if (character === ")") { depth -= 1; if (!depth) break; }
      else if (/\s/u.test(character)) break;
      at += 1;
    }
    destinations.push([match.index ?? 0, at + (depth === 0 ? 1 : 0)]);
    if (!match[1] && at > start) add(visible.slice(start, at), match[2]);
  }
  const references = new Map<string, string>();
  for (const match of visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(https?:\/\/\S+))/gimu)) {
    references.set(match[1].trim().toLowerCase(), match[2] ?? match[3]);
    destinations.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  for (const match of visible.matchAll(/<(https?:\/\/[^<>\s]+)>/giu)) {
    const at = match.index ?? 0;
    if (!destinations.some(([from, to]) => at >= from && at < to)) add(match[1], match[1]);
  }
  for (const match of visible.matchAll(/(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/gu)) {
    const target = references.get((match[2] || match[1]).trim().toLowerCase());
    if (target) add(target, match[1]);
  }
  for (const match of visible.matchAll(/https?:\/\/[^\s<>"`|，。；：！？、（）【】「」『』“”‘’《》]+/giu)) {
    const start = match.index ?? 0;
    if (destinations.some(([from, to]) => start >= from && start < to)) continue;
    const value = bareDestination(match[0], visible.slice(Math.max(0, start - 2), start));
    add(value, value);
  }
  return [...found.values()];
}
