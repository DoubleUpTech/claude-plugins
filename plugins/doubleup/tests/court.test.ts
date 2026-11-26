import { test, expect } from 'claude-code/testing'
import { isDroppedDraftRestore, DROP_RESTORE_WINDOW_MS } from '../lib/court'
import { parseMeResponse } from '../lib/api'

// The engine puts a dropped >> prompt back in the box; the matcher decides
// whether a prompt.change write is that put-back, worth emptying.
test('a put-back matches only the dropped text, only inside the window', () => {
  const dropped = { text: '>> lunch in 10?', at: 1000 }
  expect(isDroppedDraftRestore('>> lunch in 10?', dropped, 1000)).toBe(true)
  expect(isDroppedDraftRestore('>> lunch in 10?', dropped, 1000 + DROP_RESTORE_WINDOW_MS)).toBe(true)
  expect(isDroppedDraftRestore('>> lunch in 10?', dropped, 1000 + DROP_RESTORE_WINDOW_MS + 1)).toBe(false)
  expect(isDroppedDraftRestore('something else', dropped, 1000)).toBe(false)
  expect(isDroppedDraftRestore('>> lunch in 10?', null, 1000)).toBe(false)
})
// The account's matches, as a restart reads them to retake a court.
test('parseMeResponse reads matches, drops junk rows', () => {
  const me = parseMeResponse(200, { matches: [{ id: 9, state: 'waiting' }, { id: 12, state: 'live' }, { nope: true }, { id: 3, state: 'garbage' }] })
  expect(me.kind).toBe('me')
  if (me.kind === 'me') {
    expect(me.matches).toEqual([{ id: 9, state: 'waiting' }, { id: 12, state: 'live' }])
  }
})

test('parseMeResponse answers unauthorized and error for anything else', () => {
  expect(parseMeResponse(401, { error: 'invalid_token' }).kind).toBe('unauthorized')
  expect(parseMeResponse(500, null).kind).toBe('error')
  expect(parseMeResponse(200, { nope: true }).kind).toBe('error')
})
