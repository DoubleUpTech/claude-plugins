// The types contract: engine state Double Up owns, named for the validator
// and for any mod that lists this plugin under dependencies. Self-contained
// on purpose — a contract imports nothing. Keep the shapes in step with
// types/state.ts.
declare module 'claude-code' {
  interface PluginState {
    doubleup: {
      state: {
        token?: string
        matchId?: number
        mySeatId?: number
        lastEventId: number
        seenEventIds: number[]
        turnCount: number
        lastBranch: string | null
        injectedEventIds: number[]
        inbox: { id: number; kind: string; body: string; side: string; role: string; name: string | null; created_at: string }[]
        seats: {
          id: number
          side: string
          role: string
          display_name: string
          status: string | null
          status_at: string | null
          last_seen_at: string | null
          presence: string
          auto_return: boolean
          harness: string | null
        }[] | null
        matchState: 'waiting' | 'live' | 'finished' | null
        volleyCount: number
        rallyCap: number
      }
      poll: { interval: number }
    }
  }
}
