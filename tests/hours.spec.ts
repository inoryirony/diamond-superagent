/** The hours a reminder may reach a person in, and the rule that a ticket asks about a hold at most once a night. */
import { describe, expect, it } from 'vitest'
import { localDay, localHour, nextWorkInstant, withinWorkHours } from '../src/infra/hours.ts'

/** A Shanghai wall-clock time, as an ISO instant. */
const shanghai = (iso: string) => new Date(`${iso}+08:00`)

describe('working hours', () => {
  it('reads the local hour in the deployment\'s own zone, not the host\'s', () => {
    // 09:00 in Shanghai is 01:00 UTC: a host in UTC must still read 9.
    expect(localHour(new Date('2026-11-04T01:00:00Z'))).toBe(9)
    expect(localHour(new Date('2026-11-04T11:00:00Z'))).toBe(19)
  })

  it('admits 09:00 up to but not including 19:00', () => {
    expect(withinWorkHours(shanghai('2026-11-04T08:59:00'))).toBe(false)
    expect(withinWorkHours(shanghai('2026-11-04T09:00:00'))).toBe(true)
    expect(withinWorkHours(shanghai('2026-11-04T18:59:00'))).toBe(true)
    expect(withinWorkHours(shanghai('2026-11-04T19:00:00'))).toBe(false)
    expect(withinWorkHours(shanghai('2026-11-05T02:00:00'))).toBe(false)
  })

  it('moves a due time that falls at night to the next 09:00, and leaves a working one where it is', () => {
    const working = shanghai('2026-11-04T10:30:00').toISOString()
    expect(nextWorkInstant(working)).toBe(working)
    expect(nextWorkInstant(shanghai('2026-11-04T02:00:00').toISOString())).toBe(shanghai('2026-11-04T09:00:00').toISOString())
    // An evening due time waits for the next morning, not the same one.
    expect(nextWorkInstant(shanghai('2026-11-04T21:15:00').toISOString())).toBe(shanghai('2026-11-05T09:00:00').toISOString())
  })

  it('always moves forward, so a due time in the past cannot stay in it', () => {
    const night = shanghai('2026-11-04T23:40:00').toISOString()
    expect(Date.parse(nextWorkInstant(night))).toBeGreaterThan(Date.parse(night))
  })

  it('counts one night by the local calendar day', () => {
    // 23:00 and 01:00 next day are different nights; 09:00 and 18:00 are the same one.
    expect(localDay(shanghai('2026-11-04T23:00:00'))).toBe('2026-11-04')
    expect(localDay(shanghai('2026-11-05T01:00:00'))).toBe('2026-11-05')
    expect(localDay(shanghai('2026-11-04T09:00:00'))).toBe(localDay(shanghai('2026-11-04T18:00:00')))
  })
})
