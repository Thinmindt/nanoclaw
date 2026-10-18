/**
 * The Scout gate's content check: a pure function over one message.
 *
 * The gate sits on the Architect → Scout pair. The Architect reads private
 * repositories; the Scout reads the open web. Anything that crosses from the
 * first to the second is visible to whatever page the Scout later opens, so
 * the check refuses every shape that commonly carries data out: links and
 * hosts (an address can carry data in its path), file paths, mail addresses,
 * opaque blobs, and the owner's own list of private terms and canary strings.
 * A refused message costs the Architect one turn to rephrase; a leaked one
 * cannot be recalled.
 *
 * No model call. Every rule is a regular expression or a substring match, so
 * the decision is the same every time and can be read in full here. Known
 * limits, inherent to a pattern gate: a bare host on a top-level domain the
 * list does not know crosses when it has no path; a secret split across
 * several short tokens crosses; a private fact phrased in plain words that
 * match no term crosses. The term lists, the character cap, and the
 * Architect's own rule to ask generic questions are the layers against that.
 */

export interface ScrubOptions {
  /** Longest message text allowed, in characters. */
  maxChars: number;
  /** Case-insensitive substrings that must never cross. */
  privateTerms: string[];
  /** Case-insensitive substrings planted in private docs; a hit means something was lifted from them. */
  canaries: string[];
}

export interface ScrubHit {
  /** Which rule refused. `canary` hits are also logged as a tripwire. */
  rule: 'attachments' | 'size' | 'canary' | 'url' | 'host' | 'ip' | 'email' | 'path' | 'token' | 'private-term';
  /** The matched text, cut short, for the note to the sender. */
  match: string;
}

// Bare-host detection needs a list of endings; the scheme-less URL rule below
// catches any dotted name followed by a path whatever its ending. Two-letter
// endings that are also common file extensions (sh, so, in, is, it, me, to)
// are left out on purpose, so `build.sh` and `libfoo.so` cross.
const TLDS = [
  'com',
  'net',
  'org',
  'io',
  'dev',
  'ai',
  'co',
  'app',
  'us',
  'uk',
  'de',
  'fr',
  'eu',
  'info',
  'biz',
  'xyz',
  'cloud',
  'tech',
  'site',
  'online',
  'ly',
  'gg',
  'tv',
  'cc',
  'ru',
  'cn',
  'jp',
  'au',
  'ca',
  'nl',
  'se',
  'ch',
  'es',
  'br',
  'pl',
  'fm',
  'link',
  'page',
  'zip',
  'mov',
  'top',
  'store',
  'pw',
  'ws',
  'ninja',
  'test',
  'edu',
  'gov',
  'mil',
  'int',
  'invalid',
  'example',
  'onion',
  'arpa',
  'local',
  'lan',
  'internal',
  'home',
  'localhost',
];
const TLD = `(?:${TLDS.join('|')})`;

const RULES: Array<{ rule: ScrubHit['rule']; re: RegExp }> = [
  // Anything with a scheme, a bare www, or a dotted name followed by a path.
  { rule: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\/\S+/i },
  { rule: 'url', re: /\bwww\.[^\s]+/i },
  { rule: 'url', re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/\S*/i },
  // Anything that looks like a mail address.
  { rule: 'email', re: /[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i },
  // A host name: labels joined by dots ending in a known ending, or spelled out ("dot com").
  { rule: 'host', re: new RegExp(`\\b(?:[a-z0-9-]+\\.)+${TLD}\\b`, 'i') },
  { rule: 'host', re: new RegExp(`\\b[a-z0-9-]+\\s+dot\\s+${TLD}\\b`, 'i') },
  // Paths: two or more slash-separated segments anywhere, home-relative, and drive letters.
  { rule: 'path', re: /(?:^|[\s"'`(])(?:\.{1,2})?(?:\/[\w.@-]+){2,}/ },
  { rule: 'path', re: /\b[\w.-]+(?:\/[\w.@-]+){2,}\b/ },
  { rule: 'path', re: /(?:^|[\s"'`(])~\/[^\s]+/ },
  { rule: 'path', re: /\b[a-z]:[\\/][^\s]+/i },
  // Opaque blobs: long base64 runs that carry a digit or symbol, long hex runs, any long token.
  { rule: 'token', re: /(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{40,}={0,2}/ },
  { rule: 'token', re: /\b[0-9a-f]{32,}\b/i },
  { rule: 'token', re: /\S{48,}/ },
];

/** Loads a term list: one per line, blank lines and `#` comments ignored, terms under 4 characters dropped. */
export function parseTermList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && !line.startsWith('#'));
}

/**
 * Fold the spellings a message could use to hide a dot or an address from
 * the rules: compatibility forms (fullwidth letters and stops), ideographic
 * stops, and bracketed or spelled dots such as `[.]`, `(dot)`, `d0t`.
 */
export function foldText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[。｡]/g, '.')
    .replace(/\s*[[({]\s*(?:\.|dot|d0t)\s*[\])}]\s*/gi, '.')
    .replace(/\s+d0t\s+/gi, '.')
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@');
}

/** IPv4 with every octet in range, so a four-part version number crosses. */
function findIpv4(text: string): string | null {
  for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    if (m.slice(1, 5).every((octet) => Number(octet) <= 255)) return m[0];
  }
  return null;
}

/**
 * IPv6-looking: a run of hex groups with two or more colons that carries a
 * `::` or a hex letter and at least four hex characters. Clock times
 * (`12:30:45`) and scope operators (`std::vector`) cross.
 */
function findIpv6(text: string): string | null {
  for (const m of text.matchAll(/\b[0-9a-f:]{2,39}\b/gi)) {
    const s = m[0];
    const colons = (s.match(/:/g) ?? []).length;
    const hex = s.replace(/:/g, '');
    if (colons >= 2 && hex.length >= 4 && (s.includes('::') || /[a-f]/i.test(hex))) return s;
  }
  return null;
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * Returns the first hit, or null when the message may cross. Attachments and
 * size refuse before the text is read; canaries are checked next so that a
 * lifted document trips the wire whatever else it carries.
 */
export function scrubForScout(rawText: string, files: string[], opts: ScrubOptions): ScrubHit | null {
  if (files.length > 0) return { rule: 'attachments', match: clip(files.join(', ')) };
  if (rawText.length > opts.maxChars) return { rule: 'size', match: `${rawText.length} characters` };

  const text = foldText(rawText);
  const lower = text.toLowerCase();
  for (const term of opts.canaries) {
    if (lower.includes(term.toLowerCase())) return { rule: 'canary', match: clip(term) };
  }

  for (const { rule, re } of RULES) {
    const m = re.exec(text);
    if (m) return { rule, match: clip(m[0].trim()) };
  }
  const ip = findIpv4(text) ?? findIpv6(text);
  if (ip) return { rule: 'ip', match: clip(ip) };

  for (const term of opts.privateTerms) {
    if (lower.includes(term.toLowerCase())) return { rule: 'private-term', match: clip(term) };
  }
  return null;
}
