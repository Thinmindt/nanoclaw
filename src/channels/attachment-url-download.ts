/**
 * Download for attachments that arrive as a URL only.
 *
 * Some Chat SDK adapters (Discord) hand each attachment over with a public CDN
 * `url` and no `fetchData()`. The bridge downloads only through `fetchData()`,
 * so without this helper such files reach the agent as a name with no content.
 *
 * The bridge calls `downloadAttachmentByUrl` when `fetchData` is absent. The
 * download happens on the host, outside the agent sandbox and its gateway, so
 * the host allowlist below is the boundary: https only, Discord's CDN hosts
 * only, a size cap, and every redirect hop re-checked before it is requested.
 */
import { log } from '../log.js';

/** Hosts whose attachment URLs the host may fetch directly, without credentials. */
const DIRECT_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** Largest attachment fetched by URL; anything bigger reaches the agent as metadata only. */
export const MAX_URL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Redirect hops followed for one attachment before giving up. */
const MAX_ATTACHMENT_REDIRECTS = 3;

/**
 * Decide whether an attachment URL may be fetched: https, a known CDN host,
 * and a declared size within the cap. Anything else returns null, so a
 * platform payload cannot point the host at an arbitrary address.
 */
export function attachmentFetchUrl(att: { url?: unknown; size?: unknown }): string | null {
  if (typeof att.url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(att.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !DIRECT_ATTACHMENT_HOSTS.has(parsed.hostname)) return null;
  if (typeof att.size === 'number' && att.size > MAX_URL_ATTACHMENT_BYTES) return null;
  return parsed.toString();
}

/**
 * Download an approved URL. Redirects are followed by hand so every hop passes
 * `attachmentFetchUrl` again; a redirect anywhere else is refused before any
 * request reaches the new address.
 */
export async function fetchAttachmentByUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= MAX_ATTACHMENT_REDIRECTS; hop++) {
    const res = await fetchImpl(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      const next = location ? attachmentFetchUrl({ url: new URL(location, current).toString() }) : null;
      if (!next) throw new Error(`redirect to a disallowed location: ${location ?? '(none)'}`);
      current = next;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_URL_ATTACHMENT_BYTES) throw new Error(`too large: ${buffer.length} bytes`);
    return buffer;
  }
  throw new Error(`more than ${MAX_ATTACHMENT_REDIRECTS} redirects`);
}

/**
 * The bridge's entry point for an attachment with no `fetchData()`. Returns
 * base64 data, or null when the URL is not allowed or the download fails;
 * either way the attachment still reaches the agent as metadata.
 */
export async function downloadAttachmentByUrl(att: {
  url?: unknown;
  size?: unknown;
  type?: unknown;
  name?: unknown;
}): Promise<string | null> {
  const url = attachmentFetchUrl(att);
  if (!url) {
    log.warn('Attachment has no download path; passing metadata only', { type: att.type, name: att.name });
    return null;
  }
  try {
    return (await fetchAttachmentByUrl(url)).toString('base64');
  } catch (err) {
    log.warn('Failed to download attachment', { type: att.type, err });
    return null;
  }
}
