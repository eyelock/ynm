---
"@ynm/service": patch
---

The derived `.ynm/index/` folder, and the default `.ynm/wiki/` folder, now hold a `.gitignore` of `*` that ynm writes when it opens the index or builds the wiki, and when an existing folder lacks one. They ignore themselves in every clone, not only the one where `ynm init` wrote `.git/info/exclude`, so a clone that never ran init no longer shows `.ynm/index/project.sqlite` as untracked.
