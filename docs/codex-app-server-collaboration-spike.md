# Codex App Server Collaboration Spike

## Environment

- Date: 2026-08-05
- Project: `/Users/chelaile/.codex/worktrees/32c1/icarus`
- Desktop-bundled CLI: `codex-cli 0.146.0-alpha.9.2`
- Homebrew CLI: `codex-cli 0.144.5`
- Transport: `codex app-server --listen stdio://`
- Policy: non-ephemeral thread, `read-only` sandbox, `never` approval

## Result

The App Server-only path satisfies the Collaboration v1 requirements tested on
this host:

1. `thread/start`, `thread/name/set`, and `turn/start` created thread
   `019fd4ab-e115-71d3-91a6-4462cbcc2952` and turn
   `019fd4ab-e7c6-7560-8980-324ff18f4fac`.
2. Codex Desktop listed the task with the requested title and the exact project
   cwd. The thread was non-ephemeral and available through the normal task
   read surface without a deep link.
3. The first turn completed and returned `ICARUS_APP_SERVER_SPIKE_OK` through
   the existing `CodexAppServerClient` notification mapping.
4. A second turn was submitted from the Desktop task surface. Icarus then used
   the existing `CodexAppServerClient.recoverTask` path to read turn
   `019fd4ac-bc23-72d1-92f3-88fffc1c3bee` and obtained the completed result
   `ICARUS_DESKTOP_CONTINUATION_OK`.
5. The App Server task remained addressable after the client process exited.
   The desktop application itself was not restarted because that would disrupt
   unrelated active user tasks; restart persistence remains a manual release
   check.

The Homebrew CLI could initialize App Server but could not start a thread with
the current Desktop configuration. It failed closed while parsing the newer
agent-role configuration. The adapter treats the configured binary as a
versioned capability: its claim-time `initialize` preflight catches startup and
initialization failures, while this later `thread/start` incompatibility fails
closed during dispatch. It does not fall back to a deep link. The
Desktop-bundled binary completed the same request.

The shared App Server client rejects approval requests and interrupts the turn,
so a Codex approval request is not resumable as `WAITING_APPROVAL` in this
implementation. Protocol and Workflow executors retain the generic waiting
state for providers that can observe it. Interrupt behavior is covered by the
existing client mapping; this spike did not restart Desktop or force an
interactive approval prompt in the user's active application.

## Repeatable Check

Run against the binary that owns the Desktop configuration:

```sh
npm run spike:collaboration:codex -- \
  --binary "/Applications/ChatGPT.app/Contents/Resources/codex" \
  --cwd "$PWD"
```

The command prints the provider identity and terminal result as JSON. After a
user adds a Desktop turn, verify the same session through Icarus:

```sh
npm run spike:collaboration:codex -- \
  --binary "/Applications/ChatGPT.app/Contents/Resources/codex" \
  --cwd "$PWD" \
  --recover-thread THREAD_ID \
  --recover-turn TURN_ID
```

Desktop visibility and restart persistence cannot be proven by a standalone
stdio process. Before enabling the adapter on a new host, the local user must
confirm that the created title and cwd appear in Desktop. No fallback transport
is attempted when that confirmation or binary compatibility check fails.
`codex://threads/{thread_id}` may be used by the UI to open this already-created
task; it is navigation only and is not a dispatch fallback.
