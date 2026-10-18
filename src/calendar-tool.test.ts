/**
 * Calendar event tool. The property that matters most: no input can produce a
 * request that adds a guest. The planner refuses guest-like fields outright,
 * the body it builds has no attendees key, and the gateway call always sends
 * sendUpdates=none.
 */
import { describe, expect, it } from 'vitest';

import {
  CREATED_BY,
  MAX_DESCRIPTION,
  calendarRequestArgs,
  createCalendarEvent,
  planCalendarEvent,
  readCalendarToolConfig,
  type CalendarToolConfig,
} from './calendar-tool.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const TZ = 'America/Los_Angeles';

function plan(input: Record<string, unknown>) {
  return planCalendarEvent(input, NOW, TZ);
}

describe('planCalendarEvent', () => {
  it('builds a timed event from local wall-clock times', () => {
    const p = plan({ title: 'Vet: Seneca', start: '2026-10-20T15:00', end: '2026-10-20T15:30', location: 'Clinic' });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.body.start).toEqual({ dateTime: '2026-10-20T15:00:00', timeZone: TZ });
    expect(p.body.end).toEqual({ dateTime: '2026-10-20T15:30:00', timeZone: TZ });
    expect(p.body.location).toBe('Clinic');
    expect(p.body.extendedProperties.private.createdBy).toBe(CREATED_BY);
  });

  it('defaults a timed event to one hour', () => {
    const p = plan({ title: 'Call', start: '2026-10-20T15:00-07:00' });
    expect(p.ok && p.body.end).toEqual({ dateTime: '2026-10-20T23:00:00.000Z', timeZone: TZ });
  });

  it('regression: an all-day --end is the last day, inclusive (Google gets the day after)', () => {
    const p = plan({ title: 'Trip', start: '2026-11-01', end: '2026-11-03', 'all-day': true });
    expect(p.ok && p.body).toMatchObject({ start: { date: '2026-11-01' }, end: { date: '2026-11-04' } });
    const single = plan({ title: 'Holiday', start: '2026-11-26', 'all-day': 'true' });
    expect(single.ok && single.body).toMatchObject({ start: { date: '2026-11-26' }, end: { date: '2026-11-27' } });
    const sameDay = plan({ title: 'Holiday', start: '2026-11-26', end: '2026-11-26', 'all-day': true });
    expect(sameDay.ok && sameDay.body).toMatchObject({ end: { date: '2026-11-27' } });
  });

  it('carries an all-day event across a month and year end', () => {
    const p = plan({ title: 'Break', start: '2026-12-30', end: '2027-01-01', 'all-day': true });
    expect(p.ok && p.body).toMatchObject({ start: { date: '2026-12-30' }, end: { date: '2027-01-02' } });
  });

  it('refuses an all-day --end before --start', () => {
    expect(plan({ title: 'x', start: '2026-11-03', end: '2026-11-01', 'all-day': true })).toEqual({
      ok: false,
      error: '--end must not be before --start',
    });
  });

  it('keeps local wall-clock times across daylight-saving changes', () => {
    // 2026-11-01 01:30 happens twice in Los Angeles; 2027-03-14 02:30 never happens. The body passes the
    // wall-clock time and zone through unchanged and Google resolves it, so the planner must not reject or
    // shift either one.
    for (const start of ['2026-11-01T01:30', '2027-03-14T02:30']) {
      const p = plan({ title: 'x', start });
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.body.start).toEqual({ dateTime: `${start}:00`, timeZone: TZ });
    }
  });

  it('turns reminders into popup overrides', () => {
    const p = plan({ title: 'x', start: '2026-10-20T09:00', reminders: '60, 1440' });
    expect(p.ok && p.body.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 1440 },
      ],
    });
  });

  it('refuses guest-like fields with a clear reason', () => {
    for (const key of ['attendees', 'guests', 'invite', 'attendee']) {
      const p = plan({ title: 'x', start: '2026-10-20T09:00', [key]: 'someone@example.com' });
      expect(p).toEqual({ ok: false, error: expect.stringMatching(/cannot add guests/) });
    }
  });

  it('refuses any other unknown field', () => {
    const p = plan({ title: 'x', start: '2026-10-20T09:00', conferenceData: '{}' });
    expect(p).toEqual({ ok: false, error: expect.stringMatching(/unknown field --conferenceData/) });
  });

  it('never puts attendees or conference data in the body', () => {
    const p = plan({ title: 'x', start: '2026-10-20T09:00', description: 'attendees: a@b.c' });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(Object.keys(p.body)).not.toContain('attendees');
    expect(Object.keys(p.body)).not.toContain('conferenceData');
    expect(p.body.guestsCanInviteOthers).toBe(false);
  });

  it('requires a title and a start', () => {
    expect(plan({ start: '2026-10-20T09:00' })).toEqual({ ok: false, error: '--title is required' });
    expect(plan({ title: '   ', start: '2026-10-20T09:00' })).toEqual({ ok: false, error: '--title is required' });
    expect(plan({ title: 'x' })).toEqual({ ok: false, error: '--start is required' });
  });

  it('rejects malformed and impossible times', () => {
    expect(plan({ title: 'x', start: 'tomorrow 3pm' }).ok).toBe(false);
    expect(plan({ title: 'x', start: '2026-02-30', 'all-day': true }).ok).toBe(false);
    expect(plan({ title: 'x', start: '2026-10-20T10:00', end: '2026-10-20T09:00' })).toEqual({
      ok: false,
      error: '--end must be after --start',
    });
  });

  it('bounds duration, the past, and how far ahead', () => {
    expect(plan({ title: 'x', start: '2026-11-01', end: '2026-11-14', 'all-day': true }).ok).toBe(true);
    expect(plan({ title: 'x', start: '2026-11-01', end: '2026-11-15', 'all-day': true }).ok).toBe(false);
    expect(plan({ title: 'x', start: '2026-10-10T09:00' })).toEqual({ ok: false, error: '--start is in the past' });
    expect(plan({ title: 'x', start: '2027-12-01T09:00' }).ok).toBe(false);
  });

  it('caps text lengths', () => {
    expect(plan({ title: 'x'.repeat(201), start: '2026-10-20T09:00' }).ok).toBe(false);
    expect(plan({ title: 'x', start: '2026-10-20T09:00', description: 'd'.repeat(MAX_DESCRIPTION + 1) }).ok).toBe(
      false,
    );
  });

  it('caps reminders', () => {
    expect(plan({ title: 'x', start: '2026-10-20T09:00', reminders: '1,2,3,4,5,6' }).ok).toBe(false);
    expect(plan({ title: 'x', start: '2026-10-20T09:00', reminders: '-5' }).ok).toBe(false);
  });
});

describe('readCalendarToolConfig', () => {
  const full = {
    CALENDAR_TOOL_CALENDAR_ID: 'abc@group.calendar.google.com',
    CALENDAR_TOOL_CONNECTION_ID: 'conn-1',
    CALENDAR_TOOL_GATEWAY_AGENT: 'calendar-event-tool',
    CALENDAR_TOOL_AGENT_GROUPS: 'ag-1, ag-2',
    TZ: TZ,
  };

  it('reads a complete configuration', () => {
    const c = readCalendarToolConfig(full);
    expect(c?.agentGroups).toEqual(new Set(['ag-1', 'ag-2']));
    expect(c?.timeZone).toBe(TZ);
  });

  it('is unconfigured when any required key is missing', () => {
    for (const key of Object.keys(full).filter((k) => k !== 'TZ')) {
      expect(readCalendarToolConfig({ ...full, [key]: '' })).toBeNull();
    }
  });
});

const CONFIG: CalendarToolConfig = {
  calendarId: 'abc@group.calendar.google.com',
  connectionId: 'conn-1',
  gatewayAgent: 'calendar-event-tool',
  agentGroups: new Set(['ag-1']),
  timeZone: TZ,
  onecliBin: '/usr/local/bin/onecli',
};

describe('calendarRequestArgs', () => {
  it('posts to the one configured calendar with sendUpdates=none under the tool identity', () => {
    const { args, url } = calendarRequestArgs(CONFIG);
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com/events?sendUpdates=none&conferenceDataVersion=0',
    );
    expect(args.slice(0, 3)).toEqual(['run', '--agent', 'calendar-event-tool']);
    expect(args).toContain('x-onecli-connection-id: conn-1');
    expect(args.at(-1)).toBe(url);
  });
});

describe('createCalendarEvent', () => {
  const body = (() => {
    const p = plan({ title: 'x', start: '2026-10-20T09:00' });
    if (!p.ok) throw new Error(p.error);
    return p.body;
  })();

  it('sends the planned body on stdin and returns the created event', async () => {
    let sent = '';
    const run = async (_bin: string, _args: string[], stdin: string) => {
      sent = stdin;
      return '{"id":"evt1","htmlLink":"https://calendar.google.com/e/1","summary":"x","start":{},"end":{}}\n200';
    };
    const event = await createCalendarEvent(body, CONFIG, run);
    expect(event).toMatchObject({ id: 'evt1', htmlLink: 'https://calendar.google.com/e/1' });
    expect(JSON.parse(sent)).toEqual(body);
  });

  it('surfaces a gateway block or Google error', async () => {
    const run = async () => '{"error":"blocked_by_policy","message":"Blocked by OneCLI policy rule"}\n403';
    await expect(createCalendarEvent(body, CONFIG, run)).rejects.toThrow(/HTTP 403.*Blocked by OneCLI/);
  });
});
