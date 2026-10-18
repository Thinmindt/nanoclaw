import { describe, expect, it } from 'vitest';

import { foldText, parseTermList, scrubForScout } from './scrub.js';

const OPTS = { maxChars: 200, privateTerms: ['Hollyhock', 'bird-counter'], canaries: ['zebra-umbrella-42'] };

function hit(text: string, files: string[] = []) {
  return scrubForScout(text, files, OPTS);
}

describe('scrubForScout', () => {
  it.each([
    'Does Bun 1.2 honor pnpm workspace globs in package.json? Cite the docs.',
    'Which SQLite journal mode is safe across a bind mount, DELETE or WAL?',
    'Rust: is std::sync::Arc<Mutex<T>> the usual choice here? Published 2026-10-01T10:00:00Z.',
    'Meet at 12:30:45; the ratio is 3/4 and/or 5/6.',
    'Does react@18.3.1 support the new hook? Is @anthropic-ai/claude-agent-sdk@0.1.2 current?',
    'Is Java 1.8.0.292 still patched? What does build.sh usually do in a Node repo?',
    'Does AbstractSingletonProxyFactoryBeanConfiguration still exist in Spring 6?',
    'Is TCP/IP offload on by default in Linux 6.x? Compare input/output buffering.',
  ])('lets ordinary technical prose through: %s', (text) => {
    expect(hit(text)).toBeNull();
  });

  it('refuses attachments before reading the text', () => {
    expect(hit('fine', ['report.pdf'])).toEqual({ rule: 'attachments', match: 'report.pdf' });
  });

  it('refuses oversize text', () => {
    expect(hit('x'.repeat(201))?.rule).toBe('size');
  });

  it.each([
    ['https://example.com/x?y=1', 'url'],
    ['see www.example.org please', 'url'],
    ['ftp://files.internal/dump', 'url'],
    ['see exfil.ninja/q?d=secret', 'url'],
    ['see example.unknowntld/dump', 'url'],
    ['see host.example:8080/x', 'url'],
    ['the repo is at github.com', 'host'],
    ['my box is nas.local', 'host'],
    ['example dot com', 'host'],
    ['example (dot) io', 'host'],
    ['exfil[.]com', 'host'],
    ['exfil {dot} com', 'host'],
    ['exfil d0t com', 'host'],
    ['exfil。com', 'host'],
    ['ｅｘｆｉｌ.com', 'host'],
    ['server 192.168.1.20 answers', 'ip'],
    ['addr 2001:db8::1 is up', 'ip'],
    ['mac-ish 0a:1b:2c:3d:4e:5f here', 'ip'],
    ['mail owner@example.test now', 'email'],
    ['owner (at) example (.) com', 'email'],
    ['look in /home/owner/projects/thing', 'path'],
    ['file src/modules/agent-to-agent/guard.ts', 'path'],
    ['see ~/.config/app/settings', 'path'],
    ['path ~/secrets', 'path'],
    ['open C:\\Users\\owner\\file.txt', 'path'],
    ['open C:/Users/owner/file.txt', 'path'],
    ['key QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5MTIzNDU2', 'token'],
    ['sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'token'],
    [`blob ${'q'.repeat(48)}`, 'token'],
    ['the hollyhock service', 'private-term'],
    ['about BIRD-COUNTER again', 'private-term'],
    ['about Ｈollyhock again', 'private-term'],
    ['quote: zebra-umbrella-42', 'canary'],
  ])('refuses %j as %s', (text, rule) => {
    expect(hit(text)?.rule).toBe(rule);
  });

  it('reports what matched, clipped', () => {
    expect(hit('go to https://example.com/a')).toEqual({ rule: 'url', match: 'https://example.com/a' });
    const long = hit(`x ${'q'.repeat(100)}`);
    expect(long?.match.length).toBeLessThanOrEqual(60);
  });

  it('checks canaries before every other rule, so a lifted document trips the wire', () => {
    expect(hit('hollyhock zebra-umbrella-42')?.rule).toBe('canary');
    expect(hit('lifted: zebra-umbrella-42 see https://example.com/x')?.rule).toBe('canary');
  });
});

describe('foldText', () => {
  it('folds hidden dots and compatibility forms', () => {
    expect(foldText('a [.] b (dot) c {d0t} d d0t e')).toBe('a.b.c.d.e');
    expect(foldText('ｅｘ。com')).toBe('ex.com');
  });
});

describe('parseTermList', () => {
  it('keeps one term per line, drops comments, blanks and short lines', () => {
    expect(parseTermList('# names\nHollyhock\n\n  abc \n bird-counter  \n')).toEqual(['Hollyhock', 'bird-counter']);
  });
});
