# Add a client adapter

Goal: teach `ynm init` and `ynm client install` about a new agent client. An adapter is one file
plus tests. Background: [ADR-013](../adr/013-client-integrations.md) and
[ADR-016](../adr/016-agent-guidance-delivery.md).

## The seam

Adapters live in `packages/service/src/clients/`, one file per client. Each exports a
`ClientAdapter` (see `types.ts`):

- `name`: the client's name as typed on the command line.
- `detect({ cwd, home, env })`: is the client present, from three signals: its executable on
  `PATH` (from `env`), its user-level footprint under `home`, and its project footprint under
  `cwd`. Call `detectBySignals` with the three; it scans PATH without running anything and names
  the signals that fired in `detail`. `ynm init` configures every client whose `detect` says
  installed, so choose footprints that mean this client and no other.
- `plan(target)`: returns the `Change`s to make and touches nothing. A change is a `write` of a
  whole file, a `merge-json` patch into a JSON file, a `command` to run, or a `note` (a next step
  to show). `target` carries the working directory, the home directory, the scope (`project` or
  `user`), the transport, which is either stdio (`ynm serve`) or an HTTP URL with an optional
  bearer token, and `hooks` (false for `--no-hooks`). Give a `write` or `merge-json` a short
  `label` (`3 hooks`, `skill`) when its path would read badly in init's one-line summary.
- `status({ cwd, home })`: is ynm configured for this client, and where, plus `guidance` (is the
  guidance block or skill present) and `hooks` (are ynm's hooks installed; leave it out for a
  client ynm installs no hooks in). `ynm client status` and `ynm doctor` call it, and warn when
  the server is registered but guidance or hooks are missing.

`applyChanges` in `index.ts` performs the plan; commands run only with `--yes`, otherwise they
are printed. `ynm init` runs the project-scope plan of every detected client through
`configureClients`: it applies only the changes inside the work tree, skips those that would
leave a file as it is, and turns the rest (commands, files under the home directory) into `run:`
lines. Reuse the helpers: `stdioServerEntry` for the common MCP shape, `delimitedBlockChange`
with `agentsMdBlock()` for guidance in an `AGENTS.md`, `claudeMdBlock()` for a `CLAUDE.md`, and
`claudeHooksChange` for Claude Code's hook settings. Guidance text is single-sourced in
`@ynm/model`, so every client tells the agent the same thing, and a delimited block is rewritten
in place on reinstall.

## Hooks

If the client runs command hooks at session start, prompt submit or turn end, register
`ynm hook session-start`, `ynm hook prompt` and `ynm hook stop` in its own format. They read
Claude Code's hook JSON on stdin and answer in its shape; a client with a different contract
needs a new event mapping in `packages/service/src/hooks/`. Add a hook only where the client
really fires it: Copilot CLI has none because its hooks do not fire in untrusted folders.

`opencode.ts` is the shortest complete example to copy.

## Steps

1. Write `packages/service/src/clients/<client>.ts` with the adapter. Handle both transports and
   both scopes, or say in `plan` why a scope does not apply. Make `plan` idempotent: on a second
   run it should return only what is still missing.
2. Add it to `CLIENT_ADAPTERS` and export it in `packages/service/src/clients/index.ts`. The
   registry is what `ynm client` reads its allowed names from, so the command picks it up with no
   other change.
3. Test it in `adapters.test.ts` beside the others: apply a plan into temporary `cwd` and `home`
   directories, check `status` (including `guidance` and `hooks`) before and after, check
   `detect` with an `env` whose `PATH` holds a fake executable, and compare each file written
   with a golden file.
   Goldens live in `packages/service/test/golden/clients/`; write them with
   `make golden` and review the diff. Include a case that
   an existing config with other servers survives the merge.
4. If the client needs generated, checked-in artefacts (as Pi's extension and ynh's plugin do),
   generate them in `scripts/gen-clients.mjs` and run `make gen`. A test fails when the
   checked-in files drift from the generator.
5. Add the client to the list in the `ynm client` command description, to the signals and
   files tables in [Install ynm](install.md#set-up-your-agent-clients), and to the
   [connect an agent tutorial](../tutorial/07-connect-an-agent.md).
6. Run `make check`, `make typecheck` and `make test`.

## Conventions

- Never overwrite a user's config: merge, and touch only the `ynm` entry.
- Never write secrets you were not given. A bearer token goes in only when `--token` is passed.
- Keep `plan` free of side effects; the CLI shows it before applying.
