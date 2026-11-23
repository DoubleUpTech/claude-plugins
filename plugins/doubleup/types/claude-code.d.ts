// Ambient shapes for the claude-code mod API this plugin uses. The runtime
// (and `claude plugin test`) provide the real implementations; these
// declarations keep `tsc --noEmit` honest without a package install.
// This file is ambient on purpose: it must not become a module.
declare module 'claude-code' {
  export type Shaped<T> = T

  export interface Register {
    (on: (event: string, matcher?: unknown, handler?: unknown) => unknown): void
  }

  export interface Dollar {
    command: {
      register(spec: { name: string; description: string }): Promise<unknown>
      run(spec: { command: string; args?: string }): Promise<unknown>
    }
    http: { fetch(url: string, init?: HttpInit): Promise<HttpFetchResult> }
    clock: { sleep(ms: number): Promise<void>; now(): Promise<number> }
    process: {
      run(argv: string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
      spawn(argv: string[], init?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>
    }
    tool: {
      register(spec: { name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }): Promise<unknown>
      call(input: { tool: string } & Record<string, unknown>): Promise<unknown>
    }
    session: { start(opts?: { cwd?: string; surface?: string; isInteractive?: boolean }): Promise<unknown> }
    prompt: { submit(spec: { text: string }): Promise<unknown>; compose(spec?: Record<string, unknown>): Promise<unknown> }
    audio: { play(spec: { asset?: string; url?: string; base64?: string; shouldLoop?: boolean; gain?: number }): Promise<unknown> }
    ui: {
      toast(text: string): void
      invalidate(event: string): Promise<unknown>
      panes(): Promise<{ id: string; title: string; isShown: boolean; isFocused: boolean }[]>
      notify(text: string): void
      open(spec: { id: string; title: string; focus?: boolean }): Promise<unknown>
      resolve(e: unknown): {
        Box: AnyComponent
        Text: AnyComponent
        Button: AnyComponent
        Input: AnyComponent
        Select: AnyComponent
        Link: AnyComponent
        Code: AnyComponent
        Markdown: AnyComponent
        Svg: AnyComponent
        Progress: AnyComponent
      }
      mount(el: unknown): Promise<Mounted>
    }
  }

  // $.http.fetch answers cross the sandbox boundary as plain data.
  export interface HttpFetchResult {
    status: number
    body?: unknown
    json?(): Promise<unknown>
  }

  export type AnyComponent = (props: Record<string, unknown>) => unknown

  export interface Mounted {
    find(query: { type: string; text?: RegExp }): Promise<{ text?: string } | undefined>
    unmount(): Promise<void>
  }

  // Phantom type: the runtime atom is opaque, but it carries the value's
  // type so read/update stay checked at call sites.
  export interface Atom<T> {
    readonly __value: T
  }

  export function atom<T>(
    id: { plugin: string; key: string },
    defaultvalue: T,
    opts?: { shape?: string },
  ): Atom<T>
  export function read<T>($: Dollar, a: Atom<T>): Promise<T>
  export function update<T>($: Dollar, a: Atom<T>, fn: (value: T) => T): Promise<T>
}

// A stub event carries whatever the test wants to hand a hook; common fields
// are named so stubs stay readable without casts.
declare module 'claude-code/testing' {
  export interface StubEvent {
    args?: string
    url?: string
    method?: string
    body?: string
    cwd?: string
    [key: string]: unknown
  }
  export type Stub = (d: import('claude-code').Dollar, e: StubEvent) => unknown
  export type OnStub = (event: string, fn: Stub) => unknown

  export function test(
    name: string,
    fn: ($: import('claude-code').Dollar, on: OnStub) => void | Promise<void>,
  ): void
  export function expect(actual: unknown): {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    readonly not: { toBe(expected: unknown): void; toEqual(expected: unknown): void; toContain(expected: unknown): void }
  }
}
