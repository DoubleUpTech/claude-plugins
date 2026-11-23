import { test, expect } from 'claude-code/testing'
import { ACTIVE_MS, nextInterval } from '../lib/ladder'

test('work resets the ladder to active', () => {
  expect(nextInterval(60000, true)).toBe(ACTIVE_MS)
})

test('idle climbs the ladder and holds at the top', () => {
  expect(nextInterval(3000, false)).toBe(15000)
  expect(nextInterval(15000, false)).toBe(60000)
  expect(nextInterval(60000, false)).toBe(60000)
})
