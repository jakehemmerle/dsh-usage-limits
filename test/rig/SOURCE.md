# Vendored rig

| File | Source |
|---|---|
| `upstream/rig.mjs`, `upstream/mock-llm.mjs` | nix-config `skills/new-dsh-plugin/scripts/` at `2d658d4` (identical at `6a7e613`), byte for byte |
| `mock-llm.mjs` | identical to `upstream/mock-llm.mjs` |
| `rig.mjs` | `upstream/rig.mjs` + `rig.local.patch` |

Tests import `./rig/rig.mjs` and `./rig/mock-llm.mjs` by relative path only; nothing imports from
`~/.agents` or the nix-config checkout. `test/rig.provenance.test.js` fails if the copies drift from the
recorded patch. To update: copy the new upstream files into `upstream/`, re-apply the patch
(`patch -p1 -d test/rig < test/rig/rig.local.patch` after copying), regenerate it with
`diff -u upstream/rig.mjs rig.mjs` from this directory, and record the new commit here.
