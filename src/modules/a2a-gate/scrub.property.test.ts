/**
 * Generated-input test for the outbound half of the Scout gate: a private term does not cross by
 * being split, whether by an invisible character or by spaces and punctuation. Not copied by the
 * add-scout-gate skill, which does not install fast-check.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { scrubForScout } from './scrub.js';

const NAMED = ['\uFE0F', '\u034F', '\u2028', '\u2029', '\u180E', '\u115F', '\u3164'];
// No `t`, so no piece of a split term spells `dot` or `d0t`, which the host rule reads.
const termChar = fc.constantFrom(...'abcdefghijklmnopqrsuvwxyz0123456789');
// Punctuation no other rule reads: no period, at sign, slash, colon or bracket.
const separator = fc.constantFrom(' ', '-', '_', ',', ';', '!', "'", '*');

function scrub(text: string, term: string) {
  return scrubForScout(`about ${text} again`, [], { maxChars: 1500, privateTerms: [term], canaries: [] });
}

/** Insert each separator after the character at its index; indexes 0 to 5 split a 7-character prefix the same way. */
function split(term: string, cuts: Array<[number, string]>): string {
  const after = new Map(cuts);
  return [...term].map((ch, i) => ch + (after.get(i) ?? '')).join('');
}

describe('scrubForScout, generated terms', () => {
  it('refuses a term with a named invisible code point inside it, as invisible', () => {
    let inside = 0;
    fc.assert(
      fc.property(
        fc.string({ unit: termChar, minLength: 4, maxLength: 16 }),
        fc.nat(),
        fc.constantFrom(...NAMED),
        (term, at, cp) => {
          const i = at % (term.length + 1);
          if (i > 0 && i < term.length) inside += 1;
          expect(scrub(term.slice(0, i) + cp + term.slice(i), term)?.rule).toBe('invisible');
        },
      ),
      { seed: 110, numRuns: 1000 },
    );
    console.log('scrubForScout property: code point inside the term', inside);
    expect(inside).toBeGreaterThan(0);
  });

  it('refuses a term of 8 or more split by spaces or punctuation, and lets the same split of 7 cross', () => {
    let splitTerms = 0;
    fc.assert(
      fc.property(
        fc.string({ unit: termChar, minLength: 8, maxLength: 16 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), separator), { minLength: 1, maxLength: 4 }),
        (term, cuts) => {
          const text = split(term, cuts);
          if (text !== term) splitTerms += 1;
          expect(scrub(text, term)?.rule).toBe('private-term');
          const short = term.slice(0, 7);
          expect(scrub(split(short, cuts), short)).toBeNull();
        },
      ),
      { seed: 110, numRuns: 1000 },
    );
    console.log('scrubForScout property: split terms', splitTerms);
    expect(splitTerms).toBeGreaterThan(0);
  });
});
