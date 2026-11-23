---
"@ynm/store": patch
---

The store lock is no longer broken because it is old: a holder on this host is judged by whether its process is alive, and age counts only for a holder on another host. The lock carries a token and a holder unlinks only its own, and `sync` takes the lock only for its local ref updates, not across `git fetch` and `git push` (ynm #166).
