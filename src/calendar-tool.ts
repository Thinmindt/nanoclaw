/**
 * Calendar event tool — lets an agent put events on ONE Google calendar
 * without ever being able to invite anyone.
 *
 * Why a host-side tool rather than a gateway rule: guests live in the request
 * body (`attendees`), and the gateway's path/method rules cannot see bodies.
 * An agent allowed to POST events directly could add an outside attendee and
 * the event — title and description included — would land on that person's
 * calendar. So the agent's own gateway identity keeps every Calendar write
 * blocked, and this tool, running on the host, is the only writer:
 *
 *   - `planCalendarEvent` (pure) accepts a fixed field set. There is no
 *     attendee field to fill, unknown fields are refused, and the body it
 *     builds never carries attendees or conference data.
 *   - `createCalendarEvent` (I/O) posts that body through the gateway under a
 *     dedicated identity whose policy allows only POST to this calendar's
 *     events, with `sendUpdates=none`.
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

export const MAX_TITLE = 200;
export const MAX_LOCATION = 500;
export const MAX_DESCRIPTION = 4000;
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 40320; // four weeks, Google's own ceiling
export const MAX_EVENT_DAYS = 14;
export const MAX_DAYS_AHEAD = 366;
/** Marker on every event this tool creates, so later edit/delete can be limited to its own events. */
export const CREATED_BY = 'nanoclaw-calendar-tool';

const ALLOWED_FIELDS = new Set(['title', 'start', 'end', 'all-day', 'location', 'description', 'reminders']);
/** Keys the CLI framework may add that carry no event data. */
const IGNORED_FIELDS = new Set(['help']);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Naive local date-time, interpreted in the configured time zone. */
const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
/** Date-time carrying its own offset or Z. */
const ZONED_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type EventTime = { date: string } | { dateTime: string; timeZone: string };

export type CalendarEventBody = {
  summary: string;
  start: EventTime;
  end: EventTime;
  location?: string;
  description?: string;
  reminders?: { useDefault: false; overrides: { method: 'popup'; minutes: number }[] };
  guestsCanInviteOthers: false;
  guestsCanSeeOtherGuests: false;
  extendedProperties: { private: { createdBy: string } };
};

export type EventPlan = { ok: true; body: CalendarEventBody } | { ok: false; error: string };

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`--${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`--${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`--${field} is required`);
  if (trimmed.length > max) throw new Error(`--${field} is longer than ${max} characters`);
  return trimmed || undefined;
}

function parseReminders(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > MAX_REMINDERS) throw new Error(`--reminders allows at most ${MAX_REMINDERS} values`);
  return parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > MAX_REMINDER_MINUTES) {
      throw new Error(`--reminders values must be whole minutes from 0 to ${MAX_REMINDER_MINUTES}`);
    }
    return n;
  });
}

/** Instant of a naive local date-time in an IANA zone (no DST ambiguity handling beyond Intl's). */
function zonedToInstant(naive: string, timeZone: string): Date {
  const asUtc = new Date(`${naive.length === 16 ? `${naive}:00` : naive}Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(asUtc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(asUtc.getTime() - (shown - asUtc.getTime()));
}

function timedValue(raw: string, field: string, timeZone: string): { time: EventTime; instant: Date } {
  if (ZONED_DATETIME_RE.test(raw)) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) throw new Error(`--${field} is not a valid date-time`);
    return { time: { dateTime: raw, timeZone }, instant };
  }
  if (NAIVE_DATETIME_RE.test(raw)) {
    const instant = zonedToInstant(raw, timeZone);
    if (Number.isNaN(instant.getTime())) throw new Error(`--${field} is not a valid date-time`);
    return { time: { dateTime: raw.length === 16 ? `${raw}:00` : raw, timeZone }, instant };
  }
  throw new Error(`--${field} must look like 2026-10-20T15:00 (local) or carry an offset like 2026-10-20T15:00-07:00`);
}

function dateValue(raw: string, field: string): Date {
  if (!DATE_RE.test(raw)) throw new Error(`--${field} must look like 2026-10-20 for an all-day event`);
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new Error(`--${field} is not a real date`);
  }
  return d;
}

/**
 * Decide whether an event may be created and build its exact request body.
 * Pure: the clock and time zone come in as arguments.
 */
export function planCalendarEvent(input: Record<string, unknown>, now: Date, timeZone: string): EventPlan {
  try {
    for (const key of Object.keys(input)) {
      if (IGNORED_FIELDS.has(key) || ALLOWED_FIELDS.has(key)) continue;
      if (/attendee|guest|invite/i.test(key)) {
        throw new Error('this tool cannot add guests or send invitations; create the event without them');
      }
      throw new Error(`unknown field --${key}; allowed: ${[...ALLOWED_FIELDS].map((f) => `--${f}`).join(', ')}`);
    }

    const summary = text(input.title, 'title', MAX_TITLE, true)!;
    const location = text(input.location, 'location', MAX_LOCATION, false);
    const description = text(input.description, 'description', MAX_DESCRIPTION, false);
    const reminders = parseReminders(input.reminders);
    const allDay = input['all-day'] === true || input['all-day'] === 'true';
    const startRaw = text(input.start, 'start', 40, true)!;
    const endRaw = text(input.end, 'end', 40, false);

    let start: EventTime;
    let end: EventTime;
    let startInstant: Date;
    let endInstant: Date;
    if (allDay) {
      startInstant = dateValue(startRaw, 'start');
      endInstant = endRaw ? dateValue(endRaw, 'end') : new Date(startInstant.getTime() + DAY_MS);
      // Google's all-day end date is exclusive; accept an inclusive end equal to start.
      if (endRaw && endInstant.getTime() === startInstant.getTime()) {
        endInstant = new Date(startInstant.getTime() + DAY_MS);
      }
      start = { date: startInstant.toISOString().slice(0, 10) };
      end = { date: endInstant.toISOString().slice(0, 10) };
    } else {
      const s = timedValue(startRaw, 'start', timeZone);
      startInstant = s.instant;
      start = s.time;
      if (endRaw) {
        const e = timedValue(endRaw, 'end', timeZone);
        endInstant = e.instant;
        end = e.time;
      } else {
        endInstant = new Date(startInstant.getTime() + 60 * 60 * 1000);
        end = { dateTime: endInstant.toISOString(), timeZone };
      }
    }

    if (endInstant.getTime() <= startInstant.getTime()) throw new Error('--end must be after --start');
    if (endInstant.getTime() - startInstant.getTime() > MAX_EVENT_DAYS * DAY_MS) {
      throw new Error(`an event may last at most ${MAX_EVENT_DAYS} days`);
    }
    if (startInstant.getTime() < now.getTime() - DAY_MS) throw new Error('--start is in the past');
    if (startInstant.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) {
      throw new Error(`--start is more than ${MAX_DAYS_AHEAD} days ahead`);
    }

    const body: CalendarEventBody = {
      summary,
      start,
      end,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      extendedProperties: { private: { createdBy: CREATED_BY } },
    };
    if (location) body.location = location;
    if (description) body.description = description;
    if (reminders)
      body.reminders = { useDefault: false, overrides: reminders.map((minutes) => ({ method: 'popup', minutes })) };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type CalendarToolConfig = {
  /** Google calendar id the tool writes to (a dedicated calendar, ideally). */
  calendarId: string;
  /** Gateway connection id for the Google account that owns that calendar. */
  connectionId: string;
  /** Gateway agent identifier the tool calls as; its policy allows only this calendar's event POSTs. */
  gatewayAgent: string;
  /** Agent groups allowed to call the tool. */
  agentGroups: Set<string>;
  timeZone: string;
  onecliBin: string;
};

/** Read the tool's settings; null when it is not configured (the command then explains how). */
export function readCalendarToolConfig(env: Record<string, string | undefined>): CalendarToolConfig | null {
  const calendarId = env.CALENDAR_TOOL_CALENDAR_ID?.trim();
  const connectionId = env.CALENDAR_TOOL_CONNECTION_ID?.trim();
  const gatewayAgent = env.CALENDAR_TOOL_GATEWAY_AGENT?.trim();
  const groups = (env.CALENDAR_TOOL_AGENT_GROUPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!calendarId || !connectionId || !gatewayAgent || groups.length === 0) return null;
  return {
    calendarId,
    connectionId,
    gatewayAgent,
    agentGroups: new Set(groups),
    timeZone: env.TZ?.trim() || 'UTC',
    onecliBin: env.ONECLI_BIN?.trim() || path.join(os.homedir(), '.local', 'bin', 'onecli'),
  };
}

export function loadCalendarToolConfig(): CalendarToolConfig | null {
  const keys = [
    'CALENDAR_TOOL_CALENDAR_ID',
    'CALENDAR_TOOL_CONNECTION_ID',
    'CALENDAR_TOOL_GATEWAY_AGENT',
    'CALENDAR_TOOL_AGENT_GROUPS',
    'ONECLI_BIN',
    'TZ',
  ];
  const file = readEnvFile(keys);
  const merged: Record<string, string | undefined> = {};
  for (const k of keys) merged[k] = process.env[k] || file[k];
  return readCalendarToolConfig(merged);
}

/** Runs a command with stdin and returns stdout; injectable for tests. */
export type Runner = (bin: string, args: string[], stdin: string) => Promise<string>;

const defaultRunner: Runner = (bin, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gateway call failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
    child.stdin?.end(stdin);
  });

/** The exact gateway invocation, separated so tests can check it carries no way to add guests. */
export function calendarRequestArgs(config: CalendarToolConfig): { args: string[]; url: string } {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events` +
    '?sendUpdates=none&conferenceDataVersion=0';
  const args = [
    'run',
    '--agent',
    config.gatewayAgent,
    '--',
    'curl',
    '-sS',
    '--max-time',
    '20',
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `x-onecli-connection-id: ${config.connectionId}`,
    '--data-binary',
    '@-',
    '-w',
    '\n%{http_code}',
    url,
  ];
  return { args, url };
}

export type CreatedEvent = { id: string; htmlLink?: string; start: unknown; end: unknown; summary: string };

export async function createCalendarEvent(
  body: CalendarEventBody,
  config: CalendarToolConfig,
  run: Runner = defaultRunner,
): Promise<CreatedEvent> {
  const { args } = calendarRequestArgs(config);
  const out = await run(config.onecliBin, args, JSON.stringify(body));
  const nl = out.lastIndexOf('\n');
  const status = Number(out.slice(nl + 1).trim());
  const payload = out.slice(0, nl);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // fall through with an empty object; the status decides
  }
  if (status < 200 || status >= 300) {
    const reason =
      (parsed.message as string) ||
      ((parsed.error as Record<string, unknown> | undefined)?.message as string) ||
      (parsed.error as string) ||
      payload.slice(0, 300);
    throw new Error(`calendar refused the event (HTTP ${status || 'unknown'}): ${reason}`);
  }
  return {
    id: String(parsed.id),
    htmlLink: parsed.htmlLink as string | undefined,
    start: parsed.start,
    end: parsed.end,
    summary: String(parsed.summary ?? body.summary),
  };
}
