/**
 * The hours a deployment may reach a person in, and how long one ticket waits between two reminders.
 *
 * A hold's reminder is the agent asking a person to settle a conflict. It arrives in their own conversation, so it is the one
 * outbound message that must not land outside their working hours: a hold that comes due at 02:00 waits for the next morning,
 * and a ticket asks at most once a night, so a long evening does not become a stream of questions.
 */

/** The zone the working hours are read in: the deployment's people are in one, so the clock is theirs rather than the host's. */
export const WORK_ZONE = 'Asia/Shanghai'
/** The first hour (inclusive) a reminder may be sent, local to `WORK_ZONE`. */
export const WORK_START_HOUR = 9
/** The hour (exclusive) a reminder must not reach: from 19:00 the day is over. */
export const WORK_END_HOUR = 19

/** The local hour of `at` in `WORK_ZONE`, 0–23. */
export function localHour(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: WORK_ZONE, hour: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  return Number(parts.find(part => part.type === 'hour')?.value ?? '0')
}
/** Whether `at` is inside the hours a reminder may be sent: 09:00–19:00 local. */
export const withinWorkHours = (at: Date): boolean => localHour(at) >= WORK_START_HOUR && localHour(at) < WORK_END_HOUR

/** The start of the working day `at` falls on, in `WORK_ZONE`, as an ISO instant: 09:00 local. */
function workStartOf(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WORK_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  // `+08:00` is the standing offset of Asia/Shanghai; the zone has no daylight saving, so the wall clock maps directly.
  return new Date(`${part('year')}-${part('month')}-${part('day')}T${String(WORK_START_HOUR).padStart(2, '0')}:00:00+08:00`).toISOString()
}

/**
 * When a reminder that came due at `due` may actually go out: `due` itself inside working hours, else the next 09:00 local.
 * The value is an ISO instant and is always later than `due`, so a due time in the past still moves forward.
 */
export function nextWorkInstant(due: string): string {
  const at = new Date(due)
  if (withinWorkHours(at)) return due
  // Before the working day starts, today's 09:00 is next; after it ends, tomorrow's is. The boundary is read in the zone's own
  // calendar, so a host in another zone cannot shift which day "tomorrow" is.
  const today = workStartOf(at)
  if (Date.parse(today) > Date.parse(due)) return today
  return workStartOf(new Date(Date.parse(today) + 24 * 60 * 60_000))
}

/** How many nights a ticket may ask about the same unresolved hold: one, so nobody is woken on a second evening about it. */
export const REMINDERS_PER_NIGHT = 1

/** The local calendar day of `at` in `WORK_ZONE`, as `yyyy-mm-dd`, which is what "one a night" counts. */
export function localDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WORK_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at)
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
