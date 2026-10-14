/**
 * HTTP through the credential gateway.
 *
 * The container holds no tokens. NanoClaw's gateway puts HTTPS_PROXY and its CA
 * in the agent's environment, and swaps the placeholder Authorization header
 * for the real token on the way out. The tools only ever see "placeholder".
 */
import { readFileSync } from 'fs';

import { ToolError } from './mcp.js';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The header the gateway replaces. Never a real credential. */
export const PLACEHOLDER_AUTH = 'Bearer placeholder';

/** fetch, routed through the gateway proxy and trusting its CA when they are set. */
export function gatewayFetch(env: Record<string, string | undefined> = process.env): Fetch {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  const caFile = env.SSL_CERT_FILE ?? env.NODE_EXTRA_CA_CERTS;
  let ca: string | undefined;
  if (caFile) {
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch {
      // Fall back to Bun's own trust store; the request fails loudly if that is wrong.
    }
  }
  return (url, init) =>
    fetch(url, {
      ...init,
      ...(proxy ? { proxy } : {}),
      ...(ca ? { tls: { ca } } : {}),
    } as RequestInit);
}

/** Call a JSON API and turn HTTP failures into a short message the agent can act on. */
export async function requestJson(
  doFetch: Fetch,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: PLACEHOLDER_AUTH, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await doFetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 500);
    if (res.status === 401 || res.status === 403) {
      throw new ToolError(
        `${method} ${new URL(url).host} was refused (${res.status}). The credential may be missing, expired ` +
          `or not granted to this agent, or the request was denied at approval. Mention it in the digest. ${detail}`,
      );
    }
    throw new ToolError(`${method} ${new URL(url).pathname} failed with ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}
