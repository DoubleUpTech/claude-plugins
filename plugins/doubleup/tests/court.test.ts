import { test, expect } from 'claude-code/testing'
import { isDroppedDraftRestore, DROP_RESTORE_WINDOW_MS } from '../lib/court'

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
