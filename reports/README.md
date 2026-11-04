# Reports

Known bugs and missing features. Add an entry when you find one, and mark it
fixed (with the commit) instead of deleting it.

| File | What |
|---|---|
| [bugs.md](bugs.md) | Defects, risks and untested paths in MeoSQL |
| [missing.md](missing.md) | Features MeoSQL does not have yet |
| [mettle-release-miscompile.md](mettle-release-miscompile.md) | A Mettle compiler bug found while building MeoSQL |

Mettle changes MeoSQL needs are filed in `../Mettle/reports/` (that folder is
not in git): 038 release loop hang, 039 mutex timeout restarts, 040 no condition
variable or rwlock, 041 std/net has no poll and hides errno, 042 no positional
file IO / fsync / file lock, 043 analyser false positive on thread hand-off.

Entry fields: an id, the area, what happens, why it matters, where to look,
and its status (`open`, `fixed <commit>`, `wontfix: reason`).
