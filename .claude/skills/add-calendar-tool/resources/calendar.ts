import { createCalendarEvent, loadCalendarToolConfig, planCalendarEvent } from '../../calendar-tool.js';
import { register } from '../registry.js';

register({
  name: 'calendar-create-event',
  action: 'calendar.create-event',
  // No `resource`: a command without one stays reachable for agents with cli_scope=group (the guard's
  // resource whitelist applies only to commands that name a resource). Access is gated by the agent
  // groups listed in CALENDAR_TOOL_AGENT_GROUPS instead.
  access: 'open',
  description:
    'Create an event on the operator-designated calendar. No guests or invitations are possible. ' +
    'Use --title, --start (2026-10-20T15:00 local, or with an offset; a date with --all-day), optional --end ' +
    '(for --all-day, the last day, inclusive), --location, --description, ' +
    '--reminders (comma-separated minutes before, e.g. 60,1440).',
  parseArgs: (raw) => raw,
  handler: async (args, ctx) => {
    const config = loadCalendarToolConfig();
    if (!config) {
      throw new Error(
        'The calendar tool is not configured. The operator sets CALENDAR_TOOL_CALENDAR_ID, ' +
          'CALENDAR_TOOL_CONNECTION_ID, CALENDAR_TOOL_GATEWAY_AGENT and CALENDAR_TOOL_AGENT_GROUPS in .env.',
      );
    }
    if (ctx.caller === 'agent' && !config.agentGroups.has(ctx.agentGroupId)) {
      throw new Error('This agent group is not allowed to use the calendar tool.');
    }
    const plan = planCalendarEvent(args as Record<string, unknown>, new Date(), config.timeZone);
    if (!plan.ok) throw new Error(plan.error);
    return createCalendarEvent(plan.body, config);
  },
  formatHuman: (event) => `Created "${event.summary}"${event.htmlLink ? `\n${event.htmlLink}` : ''}`,
});
