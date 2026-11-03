#!/bin/sh
# dacor's gate, on top of mbuild.
#
#   ./tools/check.sh            typecheck + build + test + run everything, debug and release
#   ./tools/check.sh --quick    skip the language probes
#
# mbuild selects the compiler; dacor needs head, so this script exports
# MBUILD_METTLE_LINUX unless you already set it or pass --mettle.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here" || exit 1

MBUILD="${MBUILD:-/home/nox/Projects/mettle/mbuild/build/bootstrap/mbuild}"
HEAD="${MBUILD_METTLE_LINUX:-/home/nox/Projects/mettle/raize/mettle-build/bin/mettle}"
export MBUILD_METTLE_LINUX="$HEAD"
[ -x "$MBUILD" ] || { echo "error: mbuild not found at $MBUILD (set MBUILD=...)" >&2; exit 127; }

quick=0
[ "${1:-}" = "--quick" ] && quick=1
status=0
out="$here/build/logs"
mkdir -p "$out"

run() {  # run <label> <command...>
  label=$1; shift
  if "$@" >"$out/$label.log" 2>&1; then
    warn=$(grep -c 'warning\[' "$out/$label.log" || true)
    if [ "${warn:-0}" != 0 ]; then
      # Zero warnings is a phase gate, not a preference: the compiler reports a
      # circular import as warning[E0006] while still succeeding, so a warning
      # left in the log is a defect that GATE PASS would otherwise hide.
      echo "FAIL $label ($warn warnings; the gate requires zero)"
      grep 'warning\[' "$out/$label.log" | head -5 | sed 's/^/     /'
      status=1
    else
      echo "ok   $label (0 warnings)"
    fi
  else
    echo "FAIL $label"; sed 's/^/     /' "$out/$label.log" | head -40; status=1
  fi
}

run_allow_warnings() {
  label=$1; shift
  if "$@" >"$out/$label.log" 2>&1; then
    warn=$(grep -c 'warning\[' "$out/$label.log" || true)
    echo "ok   $label (${warn:-0} warnings, allowed)"
  else
    echo "FAIL $label"; sed 's/^/     /' "$out/$label.log" | head -40; status=1
  fi
}

run typecheck "$MBUILD" check
run build-debug "$MBUILD" build
run build-release "$MBUILD" build -r
run unit-tests "$MBUILD" test

# Every declared bin must run and exit 0, in both profiles. The list is
# derived from mbuild.toml, not written out here: a bin declared there and
# left out of this loop is a suite that never runs, and both key_self and
# freelist_self were declared and skipped that way.
bins=$(grep -o '^\[bin\.[a-z0-9_]*\]' mbuild.toml | sed 's/^\[bin\.//;s/\]$//')
if [ -z "$bins" ]; then
  echo "FAIL bins: no [bin.*] declared in mbuild.toml"
  status=1
fi
for b in $bins; do
  run "run-debug-$b" "$MBUILD" run "$b"
  run "run-release-$b" "$MBUILD" run "$b" -r
done

# A skipped @test is a test that did not run; mbuild test still exits 0.
if [ -f "$out/unit-tests.log" ] && grep -q 'skipped' "$out/unit-tests.log"; then
  echo "FAIL unit-tests: a test was SKIPPED (did not run)"
  grep 'skipped' "$out/unit-tests.log" | head -5 | sed 's/^/     /'
  status=1
fi

if [ "$quick" = 0 ] && [ -d "$here/probe" ]; then
  ( cd "$here/probe" && MBUILD_METTLE_LINUX="$HEAD" "$MBUILD" build >"$out/probes.log" 2>&1 ) \
    && echo "ok   probes build" || { echo "FAIL probes"; sed 's/^/     /' "$out/probes.log" | head -20; status=1; }
fi

[ "$status" = 0 ] && echo "GATE PASS" || echo "GATE FAIL"
exit $status
