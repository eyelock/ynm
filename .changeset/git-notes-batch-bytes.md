---
"@ynm/store": patch
---

A git-notes store now reads a shard holding non-ASCII text (an em dash, curly quotes, an accent) correctly. The reader measured each shard in characters where git counts bytes, so it ran past the shard's end into the next one: `ynm doctor` reported a store that was fine as corrupt (`invalid JSON: Unexpected token 'r', "refs/no"`), and in some layouts the shards read after it could be misread. Nothing was written wrongly; stores need no repair.
