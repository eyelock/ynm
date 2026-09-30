---
name: ynm-build
description: Build, lint, typecheck and run the ynm test suite from a clean checkout; use before any commit.
---

# build

```bash
make install
make build          # all packages via turbo; dist/ is gitignored
make check          # biome; `make fix` rewrites
make typecheck
make test           # tier 1; no keys, no Docker
```

Biome reformats code after edits, so an exact-string edit that was made before running `make fix`
can stop matching; re-read the file before a second edit. `make build-pkg P=<pkg>` builds one
package (`make test-pkg P=<pkg>` tests one). Regenerate checked-in artefacts after touching tool specs or client adapters: `make gen`.
