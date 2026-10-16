/**
 * Attachments that arrive as a URL only.
 *
 * The Discord adapter gives each attachment a CDN `url` and no `fetchData()`.
 * The bridge used to download only through `fetchData()`, so a file sent to an
 * agent over Discord reached it as a name with no content. The decision of
 * whether a URL may be fetched is kept pure here; the bridge does the fetch.
 */
import { describe, expect, it } from 'vitest';

import { MAX_URL_ATTACHMENT_BYTES, attachmentFetchUrl, fetchAttachmentByUrl } from './chat-sdk-bridge.js';

const CDN = 'https://cdn.discordapp.com/attachments/1/2/brief.md?ex=1&is=2&hm=3';

describe('attachmentFetchUrl', () => {
  it('regression: a Discord CDN attachment with no fetchData is fetchable', () => {
    expect(attachmentFetchUrl({ url: CDN, size: 6409 })).toBe(CDN);
  });

  it('accepts the Discord media proxy host', () => {
    const url = 'https://media.discordapp.net/attachments/1/2/photo.png';
    expect(attachmentFetchUrl({ url })).toBe(url);
  });

  it('refuses hosts outside the CDN allowlist', () => {
    expect(attachmentFetchUrl({ url: 'https://example.com/file.md' })).toBeNull();
    expect(attachmentFetchUrl({ url: 'https://cdn.discordapp.com.evil.test/x' })).toBeNull();
    expect(attachmentFetchUrl({ url: 'https://169.254.169.254/latest/meta-data' })).toBeNull();
  });

  it('refuses plain http', () => {
    expect(attachmentFetchUrl({ url: 'http://cdn.discordapp.com/attachments/1/2/a.md' })).toBeNull();
  });

  it('refuses a missing or malformed url', () => {
    expect(attachmentFetchUrl({})).toBeNull();
    expect(attachmentFetchUrl({ url: 42 })).toBeNull();
    expect(attachmentFetchUrl({ url: 'not a url' })).toBeNull();
  });

  it('refuses an attachment whose declared size exceeds the cap', () => {
    expect(attachmentFetchUrl({ url: CDN, size: MAX_URL_ATTACHMENT_BYTES + 1 })).toBeNull();
    expect(attachmentFetchUrl({ url: CDN, size: MAX_URL_ATTACHMENT_BYTES })).toBe(CDN);
  });
});

/** A fake fetch that answers from a URL → Response table and records every URL requested. */
function fakeFetch(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  }) as typeof fetch;
  return { impl, requested };
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe('fetchAttachmentByUrl', () => {
  it('returns the body of an approved URL', async () => {
    const { impl } = fakeFetch({ [CDN]: () => new Response('# brief') });
    expect((await fetchAttachmentByUrl(CDN, impl)).toString()).toBe('# brief');
  });

  it('follows a redirect that stays on an allowed CDN host', async () => {
    const media = 'https://media.discordapp.net/attachments/1/2/brief.md';
    const { impl, requested } = fakeFetch({ [CDN]: redirect(media), [media]: () => new Response('ok') });
    expect((await fetchAttachmentByUrl(CDN, impl)).toString()).toBe('ok');
    expect(requested).toEqual([CDN, media]);
  });

  it('refuses a redirect off the allowlist without requesting the new address', async () => {
    const { impl, requested } = fakeFetch({ [CDN]: redirect('http://169.254.169.254/latest/meta-data') });
    await expect(fetchAttachmentByUrl(CDN, impl)).rejects.toThrow(/disallowed location/);
    expect(requested).toEqual([CDN]);
  });

  it('refuses a redirect with no location header', async () => {
    const { impl } = fakeFetch({ [CDN]: () => new Response(null, { status: 302 }) });
    await expect(fetchAttachmentByUrl(CDN, impl)).rejects.toThrow(/disallowed location/);
  });

  it('gives up after too many redirects', async () => {
    const { impl } = fakeFetch({ [CDN]: redirect(CDN) });
    await expect(fetchAttachmentByUrl(CDN, impl)).rejects.toThrow(/redirects/);
  });

  it('rejects a non-OK response', async () => {
    const { impl } = fakeFetch({ [CDN]: () => new Response('gone', { status: 404 }) });
    await expect(fetchAttachmentByUrl(CDN, impl)).rejects.toThrow(/HTTP 404/);
  });
});
