import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { JsonDocumentStream } from './json-stream.js';

function feed(chunks: string[]): unknown[] {
  const stream = new JsonDocumentStream();
  return chunks.flatMap((chunk) => stream.push(chunk));
}

describe('JsonDocumentStream', () => {
  it('keeps returning documents after a stray closing brace', () => {
    expect(feed(['}', '{"a":1}', '{"b":{"c":2}}'])).toEqual([{ a: 1 }, { b: { c: 2 } }]);
  });

  it('returns every document in order, whatever the chunking and the garbage before each', () => {
    const seen = { midString: 0, strayBrace: 0 };
    // Garbage holds no opening brace and no double quote; those still stall the stream (see json-stream.ts).
    const garbage = fc.string({ unit: fc.constantFrom('}', ']', ' ', '\n', 'x', ':', '\\') });
    const entry = fc.record({ garbage, doc: fc.dictionary(fc.string(), fc.jsonValue()), pretty: fc.boolean() });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 5 }), fc.array(fc.nat()), (entries, cutsAt) => {
        const text = entries.map((e) => e.garbage + JSON.stringify(e.doc, null, e.pretty ? 2 : undefined)).join('');
        const cuts = [...new Set(cutsAt.map((n) => n % (text.length + 1)))].sort((a, b) => a - b);
        const chunks = [0, ...cuts].map((from, i) => text.slice(from, cuts[i] ?? text.length));
        if (entries.some((e) => e.garbage.includes('}'))) seen.strayBrace += 1;
        // A cut inside a string literal: an odd number of unescaped quotes before it.
        if (cuts.some((c) => (text.slice(0, c).replace(/\\./g, '').match(/"/g)?.length ?? 0) % 2 === 1)) {
          seen.midString += 1;
        }
        expect(feed(chunks)).toEqual(entries.map((e) => JSON.parse(JSON.stringify(e.doc))));
      }),
      { seed: 110, numRuns: 1000 },
    );
    console.log('JsonDocumentStream property:', seen);
    expect(seen.midString).toBeGreaterThan(0);
    expect(seen.strayBrace).toBeGreaterThan(0);
  });
});
