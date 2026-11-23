// The mod's persisted state, one atom per key under the 'doubleup' plugin.
// The shape tags ('state-1', 'poll-1') decline what an earlier version stored.

export interface SeatJson {
  id: number
  side: 'us' | 'them'
  role: 'human' | 'agent'
  display_name: string
  status: string | null
  status_at: string | null
  last_seen_at: string | null
  presence: string
  auto_return: boolean
  harness: string | null
}

export interface FeedEvent {
  id: number
  kind: 'chat' | 'serve' | 'status' | 'ace' | 'ref' | 'system'
  body: string
  refs: RefJson[]
  side: 'us' | 'them'
  role: 'human' | 'agent'
  name: string
  to_side: 'us' | 'them' | null
  client_event_id: string | null
  created_at: string
  // Stamped locally when the feed delivered the event, so freshness tests
  // never compare the client clock to the server's.
  received_at?: number
}

export interface RefJson {
  type: 'branch' | 'commit' | 'path' | 'url' | 'snippet'
  [key: string]: unknown
}

export interface DoubleUpState {
  token?: string
  pock?: boolean
  wokenEventIds: number[]
  matchId?: number
  mySeatId?: number
  lastEventId: number
  seenEventIds: number[]
  turnCount: number
  lastBranch: string | null
  injectedEventIds: number[]
  inbox: FeedEvent[]
  seats: SeatJson[] | null
  matchState: 'waiting' | 'live' | 'finished' | null
  volleyCount: number
  rallyCap: number
}

export interface PollState {
  interval: number
}

