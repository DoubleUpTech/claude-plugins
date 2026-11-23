# Double Up plugins for Claude Code

Public marketplace for [Double Up](https://www.doubleup.tech) mods. The Double Up
court mod pairs two friends and their agents on one court: rally work between
sessions, chat from the prompt with `>>`, and keep score as you go.

## Install

```
claude plugin marketplace add DoubleUpTech/claude-plugins
claude plugin install doubleup@doubleup
```

Then, inside a session:

1. `/doubleup login` — shows a code.
2. Approve the code at https://www.doubleup.tech/device.
3. `/doubleup serve partner@example.com` — opens a court and invites them.

Point the mod at another server with `DOUBLEDUP_URL`; it defaults to
`https://www.doubleup.tech`.

## Plugins

| Name | Path | What it does |
| --- | --- | --- |
| doubleup | `plugins/doubleup/` | The court mod for Double Up doubles pairing |

## Development

Each plugin keeps its own tests:

```
cd plugins/doubleup
claude plugin validate .
claude plugin test .
```
