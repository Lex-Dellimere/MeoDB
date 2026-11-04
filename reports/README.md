# Reports

Known bugs and missing features. Add an entry when you find one, and mark it
fixed (with the commit) instead of deleting it.

| File | What |
|---|---|
| [bugs.md](bugs.md) | Defects, risks and untested paths in MeoDB |
| [missing.md](missing.md) | Features MeoDB does not have yet |

Mettle changes MeoDB needs are filed in `~/Projects/mettle/reports/` (the single
Mettle report set). The earlier ones (release loop hang, mutex timeout restarts,
condition variable and rwlock, std/net poll and errno, positional file IO,
analyser thread hand-off) are fixed and removed.

Entry fields: an id, the area, what happens, why it matters, where to look,
and its status (`open`, `fixed <commit>`, `wontfix: reason`).
