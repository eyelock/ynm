---
name: ynm-build
description: Build, lint, typecheck and run the ynm test suite from a clean checkout; use before any commit.
---

# build

```bash
pnpm install
pnpm build          # all packages via turbo; dist/ is gitignored
pnpm check          # biome; `pnpm check:fix` rewrites
pnpm typecheck
pnpm test           # tier 1; no keys, no Docker
```

Biome reformats code after edits, so an exact-string edit that was made before running `pnpm check:fix`
can stop matching; re-read the file before a second edit. `pnpm --filter @ynm/<pkg> build` builds one
package. Regenerate checked-in artefacts after touching tool specs or client adapters: `pnpm gen:clients`.
