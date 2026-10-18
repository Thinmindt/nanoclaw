/**
 * The inbound side of the Scout gate: a pure function over one answer.
 *
 * The Scout reads the open web, so its answers are the one place where a
 * page's words reach an agent that holds private code. The Architect treats
 * an answer as data by rule; this function makes the host enforce the part
 * a rule cannot: an answer arrives as bounded plain text. Attachments are
 * dropped, invisible and control characters are removed (the carriers for
 * hidden text and reordered display), HTML and XML tags are removed (a
 * `<system>` block is the usual costume for a planted instruction), a line
 * that reads like a role marker or an "ignore your instructions" phrase is
 * replaced by a note saying so, and the text is cut at a fixed length. A
 * header line tells the reader what was done, so a trimmed answer is never
 * mistaken for a complete one.
 *
 * No model call; every rule is a regular expression, readable in full here.
 * Known limit: an instruction phrased as ordinary prose, with no marker,
 * crosses as text. That is what the Architect's own rule is for; this layer
 * removes the shapes that are built to be mistaken for the harness.
 */

/** Longest answer text that may arrive, in characters. Three questions with sources fit; a page dump does not. */
export const MAX_ANSWER_CHARS = 8000;

export interface SanitizedAnswer {
  text: string;
  /** What changed, for the header line and the log. */
  removed: { attachments: number; tags: number; invisibles: number; lines: number };
  truncated: boolean;
}

// Control characters (except tab and newline), soft hyphen, zero-width and
// joiner characters, bidi controls, the byte-order mark, interlinear
// annotation, and the tag block used to hide text inside emoji sequences.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- the control characters are the point of the rule
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;

// An HTML or XML tag, comment, or processing instruction, up to a sane length.
const TAG = /<\/?[a-z!?][^<>]{0,200}>/gi;

// A line that opens with a role or instruction marker, or carries the
// override phrase anywhere. Checked on the compatibility-folded line so
// full-width letters do not slip past.
const ROLE_MARKER = /^[\s>*#_-]*(?:system|assistant|user|human|developer|tool|instructions?|prompt)\s*[:：]/i;
const OVERRIDE =
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompts?|guidance)\b/i;

const REMOVED_LINE = '[a line that read like an instruction was removed by the gate]';

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Reduce an answer to bounded plain text. Idempotent: a sanitized answer passes through unchanged. */
export function sanitizeAnswer(rawText: string, attachments: number, maxChars = MAX_ANSWER_CHARS): SanitizedAnswer {
  const invisibles = countMatches(rawText, INVISIBLE);
  let text = rawText.replace(INVISIBLE, '');
  const tags = countMatches(text, TAG);
  text = text.replace(TAG, '');

  let lines = 0;
  text = text
    .split('\n')
    .map((line) => {
      const folded = line.normalize('NFKC');
      if (line === REMOVED_LINE || (!ROLE_MARKER.test(folded) && !OVERRIDE.test(folded))) return line;
      lines += 1;
      return REMOVED_LINE;
    })
    .join('\n');

  // The cut leaves room for the marker, so a cut answer stays under the cap
  // and a second pass changes nothing.
  const truncated = text.length > maxChars;
  if (truncated) {
    const marker = `\n[truncated by the gate at ${maxChars} characters]`;
    text = text.slice(0, maxChars - marker.length) + marker;
  }

  return { text, removed: { attachments, tags, invisibles, lines }, truncated };
}

/** The one-line header the reader sees first. */
export function describeSanitized(from: string, result: SanitizedAnswer): string {
  const { attachments, tags, invisibles, lines } = result.removed;
  const notes = [
    attachments > 0 ? `${attachments} attachment${attachments === 1 ? '' : 's'} dropped` : '',
    tags > 0 ? `${tags} tag${tags === 1 ? '' : 's'} removed` : '',
    invisibles > 0 ? `${invisibles} invisible character${invisibles === 1 ? '' : 's'} removed` : '',
    lines > 0 ? `${lines} instruction-like line${lines === 1 ? '' : 's'} removed` : '',
    result.truncated ? 'truncated' : '',
  ].filter(Boolean);
  return `[gate: answer from ${from}, plain text${notes.length > 0 ? `; ${notes.join(', ')}` : ', nothing removed'}]`;
}
