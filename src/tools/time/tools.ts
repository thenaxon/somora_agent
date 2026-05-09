// Time tool — current date, time, and timezone-aware formatting. Cheap
// and always available; serves the "what's today's date" use case that
// the model would otherwise hallucinate from its training cutoff.

import { z } from 'zod';
import type { ToolDefinition } from '../types.ts';

const NowInput = z
  .object({
    timezone: z
      .string()
      .min(1)
      .optional()
      .describe(
        'IANA timezone name (e.g., "Europe/Vienna", "UTC", "America/Los_Angeles"). ' +
          'Defaults to the server\'s local timezone if omitted.',
      ),
  })
  .strict();

interface NowOutput {
  iso: string;
  date: string;
  time: string;
  timezone: string;
  day_of_week: string;
  week_number: number;
  unix_ms: number;
}

function isoWeekNumber(d: Date): number {
  // Standard ISO-8601 week number: week starts Monday, week 1 contains
  // the year's first Thursday. We copy the date so we don't mutate the
  // caller's value.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

export const timeNow: ToolDefinition<z.infer<typeof NowInput>, NowOutput> = {
  name: 'time_now',
  toolset: 'time',
  description:
    'Returns the current date AND time, with day-of-week and ISO week number. ' +
    'NEVER answer date/time questions from your own memory — your training cutoff ' +
    'means you do not know what "today" is. Use this whenever you need today\'s date, ' +
    'the current time, or to compute relative dates (yesterday, last week, in 3 days). ' +
    'Pass an optional IANA `timezone` like "Europe/Vienna" or "America/Los_Angeles"; ' +
    'omit it to use the server\'s local timezone. Returns ISO-8601 plus broken-out ' +
    'date/time strings, day_of_week, week_number, and unix_ms for arithmetic.',
  inputSchema: NowInput,
  jsonSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'IANA timezone name (e.g., "Europe/Vienna", "UTC", "America/Los_Angeles"). ' +
          'Defaults to the server\'s local timezone if omitted.',
      },
    },
    additionalProperties: false,
  },
  async handler(input): Promise<NowOutput> {
    const now = new Date();
    const tz = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Validate the timezone by trying to use it. Intl throws RangeError
    // on unknown TZ names — translate to a clear tool error.
    let dateParts: Intl.DateTimeFormatPart[];
    try {
      dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        weekday: 'long',
      }).formatToParts(now);
    } catch (err) {
      if (err instanceof RangeError) {
        throw new Error(
          `unknown timezone: '${tz}'. Use an IANA name like 'Europe/Vienna' or 'UTC'.`,
        );
      }
      throw err;
    }

    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      dateParts.find((p) => p.type === type)?.value ?? '';

    const year = part('year');
    const month = part('month');
    const day = part('day');
    let hour = part('hour');
    // Some locales render midnight as "24" with hour12:false — normalize.
    if (hour === '24') hour = '00';
    const minute = part('minute');
    const second = part('second');
    const dayOfWeek = part('weekday');

    return {
      iso: now.toISOString(),
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}:${second}`,
      timezone: tz,
      day_of_week: dayOfWeek,
      week_number: isoWeekNumber(now),
      unix_ms: now.getTime(),
    };
  },
};

export function timeTools(): ToolDefinition[] {
  return [timeNow] as ToolDefinition[];
}
