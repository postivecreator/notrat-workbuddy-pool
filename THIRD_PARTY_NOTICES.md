# Third-party notices

This project **vendors** an engine that is not original to it. All of the
following are MIT-licensed. Their notices are preserved in `server/vendor/`
(see `VENDOR.json` for exact source, ref and SHA-256).

| Project | License | What was taken |
|---|---|---|
| `2861292267/DSH-Official-WorkBuddy-Credit-Proxy` (bundles `dsh-rotakit`) | MIT | the engine itself (account pool, failover, quota handling) |
| `XDTrees/dsh-workbuddy-xdpool` | MIT — author **XDTrees** | the original pool implementation that `dsh-rotakit` adapts |
| `dingminhua/dsh-connect-workbuddy` | MIT | at-rest credential decryption |
| `corrinehu/dsh-workbuddy-connect` | MIT | shim hardening and upstream error mapping |

## What was modified

Vendored files are marked `VENDORED — DO NOT EDIT BY HAND` at the top.
Local modifications are limited to:

1. repointing DSH host imports at `host-stub.js` (so the engine can run inside
   this plugin instead of inside the DSH host app), and
2. exporting three internal observability factories.

The engine logic itself is upstream's.

## Re-vendoring

```bash
node scripts/vendor-sync.mjs        # re-pull upstream and record SHA-256 in VENDOR.json
node scripts/vendor-sync.mjs --check # verify the current vendor files match VENDOR.json
```

`VENDOR.json` is the single source of truth for "which upstream commit is in
here"; if you change anything under `server/vendor/`, update it in the same
commit or `--check` will fail.
