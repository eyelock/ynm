---
"@ynm/service": patch
"@ynm/cli": patch
---

ynm's ynh harness is now named `ynm-memory`, so installing it writes `~/.ynh/bin/ynm-memory` and no longer a `ynm` launcher that shadows the ynm CLI on a PATH with `~/.ynh/bin` first (ynm #130). A harness installed under the old name is reported by `ynm status` with the steps to replace it (`ynh uninstall ynm`, then `ynh install github.com/eyelock/ynm --path integrations/ynh`), and `ynh update` takes the new name.
