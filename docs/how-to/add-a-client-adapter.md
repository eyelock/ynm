# Add a client adapter

Goal: teach `ynm client install` about a new agent client. An adapter is one file plus tests.
Background: [ADR-013](../adr/013-client-integrations.md).

## The seam

Adapters live in `packages/service/src/clients/`, one file per client. Each exports a
`ClientAdapter` (see `types.ts`):

- `name`: the client's name as typed on the command line.
- `detect({ cwd, home })`: is the client present, and where.
- `plan(target)`: returns the `Change`s to make and touches nothing. A change is a `write` of a
  whole file, a `merge-json` patch into a JSON file, or a `command` to run. `target` carries the
  working directory, the home directory, the scope (`project` or `user`) and the transport, which
  is either stdio (`ynm serve`) or an HTTP URL with an optional bearer token.
- `status({ cwd, home })`: is ynm configured for this client, and where. `ynm client status` and
  `ynm doctor` call it.

`applyChanges` in `index.ts` performs the plan; commands run only with `--yes`, otherwise they
are printed. Reuse the helpers: `stdioServerEntry` for the common MCP shape,
`delimitedBlockChange` with `agentsMdBlock()` for guidance in an `AGENTS.md`, and
`claudeMdBlock()` for a `CLAUDE.md`. Guidance text is single-sourced in `@ynm/model`, so every
client tells the agent the same thing, and a delimited block is rewritten in place on reinstall.

`opencode.ts` is the shortest complete example to copy.

## Steps

1. Write `packages/service/src/clients/<client>.ts` with the adapter. Handle both transports and
   both scopes, or say in `plan` why a scope does not apply. Make `plan` idempotent: on a second
   run it should return only what is still missing.
2. Add it to `CLIENT_ADAPTERS` and export it in `packages/service/src/clients/index.ts`. The
   registry is what `ynm client` reads its allowed names from, so the command picks it up with no
   other change.
3. Test it in `adapters.test.ts` beside the others: apply a plan into temporary `cwd` and `home`
   directories, check `status` before and after, and compare each file written with a golden file.
   Goldens live in `packages/service/test/golden/clients/`; write them with
   `YNM_WRITE_GOLDEN=1 pnpm --filter @ynm/service test` and review the diff. Include a case that
   an existing config with other servers survives the merge.
4. If the client needs generated, checked-in artefacts (as Pi's extension and ynh's plugin do),
   generate them in `scripts/gen-clients.mjs` and run `pnpm gen:clients`. A test fails when the
   checked-in files drift from the generator.
5. Add the client to the list in the `ynm client` command description and to the
   [connect an agent tutorial](../tutorial/07-connect-an-agent.md).
6. Run `pnpm check`, `pnpm typecheck` and `pnpm test`.

## Conventions

- Never overwrite a user's config: merge, and touch only the `ynm` entry.
- Never write secrets you were not given. A bearer token goes in only when `--token` is passed.
- Keep `plan` free of side effects; the CLI shows it before applying.
