# Mettle: release-only miscompile of a loop that advances a pointer field

Status: open, filed as Mettle report 038 (`../Mettle/reports/038-release-loop-pointer-field-hang.md`). Compiler: `/home/nox/Projects/mettle/Mettle/bin/mettle` (reports v0.17.0).

An outer `while` that reads a field through a pointer (`lx->pos`) hangs under `--release` when one branch has an inner `while` advancing the same field and another branch leaves the loop. Debug builds are correct. `--release --verify` reports OK.

Repro: [mettle-release-miscompile.mettle](mettle-release-miscompile.mettle).

```
mettle --build mettle-release-miscompile.mettle -o rd && ./rd            # pos 5 (want 5), exit 0
mettle --build --release mettle-release-miscompile.mettle -o rr && timeout 3 ./rr   # hangs, exit 124
```

With `--release`, each of these changes makes it pass:
- replace the inner `while` with `lx->pos += 4;`
- use a loop flag (`while (go && ...)`, with `go = false;` in the exit branch)
- run the inner loop on a local index, then store it back into `lx->pos`

Replacing `break` with `return` still hangs, so the trigger is the inner loop on the pointer field plus an exit branch, not `break` itself.

MeoDB avoids the pattern; the lexer it was found in has since been removed.
