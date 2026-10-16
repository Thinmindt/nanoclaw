/**
 * Attachments that arrive as a URL only.
 *
 * The Discord adapter gives each attachment a CDN `url` and no `fetchData()`.
 * The bridge used to download only through `fetchData()`, so a file sent to an
 * agent over Discord reached it as a name with no content. The decision of
 * whether a URL may be fetched is kept pure here; the bridge does the fetch.
 */
import { describe, expect, it } from 'vitest';

import { MAX_URL_ATTACHMENT_BYTES, attachmentFetchUrl } from './chat-sdk-bridge.js';

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
