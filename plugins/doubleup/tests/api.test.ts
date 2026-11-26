import { test, expect } from 'claude-code/testing'
import {
  applyFeed,
  authorizeRequest,
  baseUrl,
  deriveMatchState,
  feedRequest,
  parseAuthorizeResponse,
  parseFeedResponse,
  parseTokenResponse,
  tokenRequest,
} from '../lib/api'
import type { DoubleUpState, FeedEvent, SeatJson } from '../types/state'

const res = (status: number, body: unknown) => ({ status, json: async () => body })

test('the base url defaults to production and honors DOUBLEDUP_URL', () => {
  expect(baseUrl()).toBe('https://www.doubleup.tech')
})

test('authorize builds a POST and parses the code, defaulting the verify url', () => {
  const req = authorizeRequest('https://x')
  expect(req.url).toBe('https://x/api/v1/device/authorize')
  expect(req.init.method).toBe('POST')

  const az = parseAuthorizeResponse(201, { user_code: 'WTX5', device_code: 'dc' }, 'https://x')
  expect(az.user_code).toBe('WTX5')
  expect(az.verification_url).toBe('https://x/device')
  expect(az.interval).toBe(5)
})

test('authorize rejects a bad body', () => {
  let threw = ''
  try {
    parseAuthorizeResponse(201, { nope: true }, 'https://x')
  } catch (e) {
    threw = String(e).slice(0, 40)
  }
  expect(threw.length > 0).toBe(true)
})

test('the token poll reads pending, granted, and expired', () => {
  const req = tokenRequest('https://x', 'dc', 'claude-code')
  expect(req.url).toBe('https://x/api/v1/device/token')
  expect(req.init.body).toContain('"device_code":"dc"')

  expect(parseTokenResponse(400, { error: 'authorization_pending' }).kind).toBe('pending')
  const granted = parseTokenResponse(200, { token: 'tok-1' })
  expect(granted.kind).toBe('token')
  if (granted.kind === 'token') expect(granted.token).toBe('tok-1')
  expect(parseTokenResponse(400, { error: 'expired_token' }).kind).toBe('expired')
})

test('the feed sends the bearer token and the cursor, and parses statuses', () => {
  const req = feedRequest('https://x', 'tok-9', 12, 34)
  expect(req.url).toBe('https://x/api/v1/matches/12/events?after=34')
  expect(req.init.headers?.Authorization).toBe('Bearer tok-9')

  expect(parseFeedResponse(304, null).kind).toBe('not_modified')
  expect(parseFeedResponse(401, { error: 'not_found' }).kind).toBe('unauthorized')
  expect(parseFeedResponse(404, { error: 'not_found' }).kind).toBe('gone')
  expect(parseFeedResponse(500, null).kind).toBe('error')

  const out = parseFeedResponse(200, {
    events: [], seats: [], volley_count: 3, rally_cap: 10, wake: false,
  })
  expect(out.kind).toBe('feed')
  if (out.kind === 'feed') {
    expect(out.feed.volley_count).toBe(3)
    expect(out.feed.rally_cap).toBe(10)
    expect(out.feed.wake).toBe(false)
  }
})

const seat = (side: 'us' | 'them', role: 'human' | 'agent', name: string): SeatJson => ({
  id: 1, side, role, display_name: name, status: null, status_at: null,
  last_seen_at: null, presence: 'online', auto_return: false, harness: null, repo_remote: null,
})

const chat = (id: number, body: string): FeedEvent => ({
  id, kind: 'chat', body, refs: [], side: 'them', role: 'human', name: 'Alex',
  to_side: null, client_event_id: `c${id}`, created_at: '2026-11-22T12:00:00Z',
})

test('match state derives from the feed: waiting, live, finished', () => {
  expect(deriveMatchState([], [seat('us', 'human', 'Sam'), seat('us', 'agent', "Sam's agent")])).toBe('waiting')
  expect(deriveMatchState([], [seat('us', 'human', 'Sam'), seat('them', 'human', 'Alex')])).toBe('live')

  const over: FeedEvent[] = [{
    id: 9, kind: 'system', body: 'Match over.', refs: [], side: 'us', role: 'human',
    name: 'Sam', to_side: null, client_event_id: null, created_at: '2026-11-22T12:00:00Z',
  }]
  expect(deriveMatchState(over, [seat('us', 'human', 'Sam'), seat('them', 'human', 'Alex')])).toBe('finished')
})

test('applyFeed advances the cursor, caps the inbox, and refreshes the snapshot', () => {
  const s: ReturnType<typeof fresh> = fresh()
  function fresh() {
    return {
      wokenEventIds: [],
      lastEventId: 3,
      seenEventIds: [1, 2, 3],
      turnCount: 0,
      lastBranch: null,
      injectedEventIds: [],
      inbox: [chat(3, 'earlier')],
      seats: null,
      matchState: 'waiting',
      volleyCount: 0,
      rallyCap: 0,
    } satisfies DoubleUpState
  }
  const folded = applyFeed(s, {
    events: [chat(4, 'lunch in 10?'), chat(5, 'on it')],
    seats: [seat('us', 'human', 'Sam'), seat('them', 'human', 'Alex')],
    volley_count: 2,
    rally_cap: 10,
    wake: false,
  })
  expect(folded.lastEventId).toBe(5)
  expect(folded.seenEventIds).toEqual([1, 2, 3, 4, 5])
  expect(folded.inbox.length).toBe(3)
  expect(folded.matchState).toBe('live')
  expect(folded.volleyCount).toBe(2)
  expect(folded.rallyCap).toBe(10)
})
