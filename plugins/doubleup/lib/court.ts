// Court lifecycle for the mod: /doubleup serve, join, court, leave, finish.
// Pure builders and parsers; the hooks module does the fetching.

import type { HttpRequest } from './api'
import type { DoubleUpState, SeatJson } from '../types/state'

export interface MatchJson {
  id: number
  title: string
  state: 'waiting' | 'live' | 'finished'
  rally_cap: number
  volley_count: number
  seats: SeatJson[]
}

export type CourtResult =
  | { kind: 'match'; match: MatchJson; inviteToken?: string }
  | { kind: 'refused' }
  | { kind: 'not_found' }


export type ServeTarget = { kind: 'link' } | { kind: 'email'; email: string }

// "alex@x.test" invites by email; anything else makes a shareable link.
export function parseServeTarget(arg: string): ServeTarget {
  const trimmed = arg.trim()
  if (trimmed.includes('@')) return { kind: 'email', email: trimmed }
  return { kind: 'link' }
}

export function serveRequest(
  base: string,
  token: string,
  title: string,
  repoRemote: string | null,
  target: ServeTarget,
  harness: string,
): HttpRequest {
  const invite =
    target.kind === 'email'
      ? { email: target.email }
      : { link: true }
  return {
    url: `${base}/api/v1/matches`,
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        title,
        repo_remote: repoRemote ?? '',
        invite,
        harness,
      }),
    },
  }
}

// A join takes the match id from a link (/courts/42?invite=tok) or a bare id.
export function parseJoinArg(arg: string): { matchId: number; token?: string } | null {
  const idInUrl = arg.match(/courts\/(\d+)/)
  const matchId = Number.parseInt(idInUrl ? idInUrl[1] : arg.trim(), 10)
  if (!Number.isInteger(matchId) || matchId <= 0) return null
  const token = arg.match(/[?&]invite=([A-Za-z0-9_-]+)/)?.[1]
  return token ? { matchId, token } : { matchId }
}

// The joiner's local repo rides along: each side records the repo it works
// in, so both sides see both remotes on the court.
export function joinRequest(base: string, token: string, matchId: number, inviteToken: string | undefined, repoRemote: string | null): HttpRequest {
  const url = `${base}/api/v1/matches/${matchId}/join`
  return {
    url: inviteToken ? `${url}?token=${encodeURIComponent(inviteToken)}` : url,
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ repo_remote: repoRemote ?? '' }),
    },
  }
}

// The engine puts a dropped prompt back in the box — a person's typing is
// never lost to a refusal — and that restore lands as a prompt.change with
// origin 'engine'. A >> chat already landed on the court, so the mod watches
// for the restore of what it dropped and empties the box then. The window
// stays short so a coincidental identical write later is never eaten.
export const DROP_RESTORE_WINDOW_MS = 5000

export interface DroppedDraft { text: string; at: number }

export function isDroppedDraftRestore(text: string, dropped: DroppedDraft | null, now: number): boolean {
  if (dropped === null) return false
  return now - dropped.at <= DROP_RESTORE_WINDOW_MS && text === dropped.text
}

export function isMatchJson(value: unknown): value is MatchJson {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Partial<MatchJson>
  return typeof m.id === 'number' && typeof m.title === 'string' &&
    (m.state === 'waiting' || m.state === 'live' || m.state === 'finished') &&
    typeof m.rally_cap === 'number' && typeof m.volley_count === 'number' &&
    Array.isArray(m.seats)
}

export function chatRequest(
  base: string,
  token: string,
  matchId: number,
  body: string,
  clientEventId: string,
): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/events`,
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ kind: 'chat', body, client_event_id: clientEventId }),
    },
  }
}

// The agent's voice: serve, status, and ace events, with refs the mod has
// pre-filled from git and any the agent named.
export function eventRequest(
  base: string,
  token: string,
  matchId: number,
  kind: 'serve' | 'status' | 'ace',
  body: string,
  refs: unknown[],
  clientEventId: string,
): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/events`,
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ kind, body, refs, client_event_id: clientEventId }),
    },
  }
}

// A status event is also the seat's status line.
export function statusRequest(base: string, token: string, matchId: number, seatId: number, text: string): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/seats/${seatId}/status`,
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ status: text }),
    },
  }
}

// The whole court in one read: the match row.
export function courtDigestRequest(base: string, token: string, matchId: number): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}`,
    init: { headers: authHeaders(token) },
  }
}

// One client_event_id per utterance; retries with the same id land once.
export function newClientId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function autoReturnRequest(base: string, token: string, matchId: number, seatId: number, on: boolean): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/seats/${seatId}`,
    init: {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ auto_return: on }),
    },
  }
}

export function finishRequest(base: string, token: string, matchId: number): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/finish`,
    init: { method: 'POST', headers: authHeaders(token) },
  }
}

export function presenceRequest(base: string, token: string, matchId: number, seatId: number, online: boolean): HttpRequest {
  return {
    url: `${base}/api/v1/matches/${matchId}/seats/${seatId}/presence`,
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ online }),
    },
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

// Serve and join both answer the match JSON at the top level (merged with
// invite_token on a link invite). 401 means the token died mid-flight.
export function parseCourtResult(status: number, body: unknown): CourtResult {
  if (status === 404) return { kind: 'not_found' }
  if (status === 401) return { kind: 'refused' }
  if (status >= 400) return { kind: 'refused' }
  if (!isMatchJson(body)) return { kind: 'refused' }
  const token = (body as { invite_token?: unknown }).invite_token
  const inviteToken = typeof token === 'string' ? token : undefined
  return { kind: 'match', match: body, inviteToken }
}

// The court state after serve or join: what the mod keeps in its atom.
export function courtFromMatch(match: MatchJson): Pick<DoubleUpState, 'matchId' | 'seats' | 'matchState' | 'volleyCount' | 'rallyCap'> {
  return {
    matchId: match.id,
    seats: match.seats,
    matchState: match.state,
    volleyCount: match.volley_count,
    rallyCap: match.rally_cap,
  }
}
