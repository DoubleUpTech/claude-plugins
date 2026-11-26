// The Double Up device API, split for the mod sandbox: the hooks module
// calls $.http.fetch itself with the request these builders return, and
// hands the parsed response back to these parsers. Nothing here touches $.

import type { FeedEvent, SeatJson } from '../types/state'
import type { DoubleUpState } from '../types/state'

export interface HttpRequest {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
}

export interface Authorization {
  user_code: string
  device_code: string
  verification_url: string
  interval: number
}

export type TokenResult =
  | { kind: 'token'; token: string }
  | { kind: 'pending' }
  | { kind: 'expired' }

export interface Feed {
  events: FeedEvent[]
  seats: SeatJson[]
  volley_count: number
  rally_cap: number
  wake: boolean
}

// $.http.fetch answers cross the sandbox boundary as plain data: body as
// an object or a JSON string, never a Response with methods. Real engine
// answers and kit stubs both land here.
// The runtime answers { status, headers, text }; the kit stubs answer
// { status, body }. Accept both so live sessions and tests share one path.
export async function bodyOf(res: { status: number; json?: unknown; body?: unknown; text?: unknown }): Promise<unknown> {
  if (typeof res.json === 'function') return res.json()
  const raw = typeof res.text === 'string' ? res.text : res.body
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw ?? null
}

export type FeedResult =
  | { kind: 'feed'; feed: Feed }
  | { kind: 'not_modified' }
  | { kind: 'unauthorized' }
  | { kind: 'gone' }
  | { kind: 'error' }

export function baseUrl(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.DOUBLEDUP_URL || 'https://www.doubleup.tech'
}

export function authorizeRequest(base: string): HttpRequest {
  return { url: `${base}/api/v1/device/authorize`, init: { method: 'POST' } }
}

export function parseAuthorizeResponse(status: number, body: unknown, base: string): Authorization {
  if (status !== 201) throw new Error(`authorize failed (HTTP ${status})`)
  if (typeof body !== 'object' || body === null || !('user_code' in body) || typeof body.user_code !== 'string' ||
      !('device_code' in body) || typeof body.device_code !== 'string') {
    throw new Error('authorize returned an unexpected body')
  }
  const url = 'verification_url' in body && typeof body.verification_url === 'string'
    ? body.verification_url
    : `${base}/device`
  const interval = 'interval' in body && typeof body.interval === 'number' ? body.interval : 5
  return { user_code: body.user_code, device_code: body.device_code, verification_url: url, interval }
}

export function tokenRequest(base: string, deviceCode: string, name: string): HttpRequest {
  return {
    url: `${base}/api/v1/device/token`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: deviceCode, name }) },
  }
}

export function parseTokenResponse(status: number, body: unknown): TokenResult {
  if (status === 200 && typeof body === 'object' && body !== null && 'token' in body &&
      typeof body.token === 'string') {
    return { kind: 'token', token: body.token }
  }
  const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined
  // Only a spent code is terminal: a 5xx or any other 400 variant retries.
  if (error === 'expired_token') return { kind: 'expired' }
  return { kind: 'pending' }
}

// The account's matches, so a restart can find the court again.
export function meRequest(base: string, token: string): HttpRequest {
  return {
    url: `${base}/api/v1/me`,
    init: { headers: { Authorization: `Bearer ${token}` } },
  }
}

export type MeMatch = { id: number; state: 'waiting' | 'live' | 'finished' }

export type MeResult =
  | { kind: 'me'; matches: MeMatch[] }
  | { kind: 'unauthorized' }
  | { kind: 'error' }

export function parseMeResponse(status: number, body: unknown): MeResult {
  if (status === 401) return { kind: 'unauthorized' }
  const matches = typeof body === 'object' && body !== null ? (body as { matches?: unknown }).matches : undefined
  if (status !== 200 || !Array.isArray(matches)) {
    return { kind: 'error' }
  }
  const list: MeMatch[] = []
  for (const raw of matches) {
    if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'number') continue
    const state = raw.state
    if (state === 'waiting' || state === 'live' || state === 'finished') {
      list.push({ id: raw.id, state })
    }
  }
  return { kind: 'me', matches: list }
}

export function feedRequest(base: string, token: string, matchId: number, after: number): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/events?after=${after}`,
    init: { headers: { Authorization: `Bearer ${token}` } },
  }
}

export function parseFeedResponse(status: number, body: unknown): FeedResult {
  if (status === 304) return { kind: 'not_modified' }
  if (status === 401) return { kind: 'unauthorized' }
  if (status === 404) return { kind: 'gone' }
  if (status !== 200) return { kind: 'error' }
  if (typeof body !== 'object' || body === null || !('events' in body) || !Array.isArray(body.events) ||
      !('seats' in body) || !Array.isArray(body.seats)) {
    return { kind: 'error' }
  }
  return {
    kind: 'feed',
    feed: {
      events: body.events,
      seats: body.seats,
      volley_count: 'volley_count' in body && typeof body.volley_count === 'number' ? body.volley_count : 0,
      rally_cap: 'rally_cap' in body && typeof body.rally_cap === 'number' ? body.rally_cap : 0,
      wake: 'wake' in body && body.wake === true,
    },
  }
}

// The events index does not carry the match row, so the mod derives court
// state from what the feed shows: a human seated across the net means the
// rally is live, the "Match over." system line means it is finished.
export function deriveMatchState(events: FeedEvent[], seats: SeatJson[]): 'waiting' | 'live' | 'finished' {
  if (events.some(e => e.kind === 'system' && e.body.startsWith('Match over.'))) return 'finished'
  const themHuman = seats.some(seat => seat.side === 'them' && seat.role === 'human')
  return themHuman ? 'live' : 'waiting'
}

// Fold one feed into the mod's state: advance the cursor, cap the inbox and
// seen-id memory, and refresh the band's seat and rally snapshot.
export function applyFeed(s: DoubleUpState, feed: Feed): DoubleUpState {
  const top = feed.events.length > 0 ? feed.events[feed.events.length - 1].id : s.lastEventId
  return {
    ...s,
    lastEventId: Math.max(s.lastEventId, top),
    seenEventIds: [...s.seenEventIds, ...feed.events.map(e => e.id)].slice(-500),
    inbox: [...s.inbox, ...feed.events.map(ev => ({ ...ev, received_at: Date.now() }))].slice(-50),
    seats: feed.seats,
    matchState: deriveMatchState([...s.inbox, ...feed.events], feed.seats),
    volleyCount: feed.volley_count,
    rallyCap: feed.rally_cap,
  }
}
