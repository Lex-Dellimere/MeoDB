// dacor phase 2 — page extents || key ordering, then the freelist, then the
// b-tree, then the integration gate. One retained orchestrator throughout.
//
//   S1  LANE A: cell extents (format v2)      ||  LANE B: key ordering
//   S2  freelist (needs 2A)
//   S2b b-tree (needs 2A, 2B, 2C)
//   S3  integration + phase-2 gate
//
// Normative: PHASE2.md (it overrides PHASE1.md where they disagree).
// Lanes never run mbuild concurrently: mbuild's build/ and .mbuild/stamps are
// shared. Lane-local builds go to build/laneX/; the orchestrator runs the
// mbuild gate between stages, when the tree is quiet.
//
// Launch: subagent({ workflow: "./tools/phase2.workflow.js" })

const CWD = "/home/nox/Projects/mettle/dacor";
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";

const RULES = `
REPO: /home/nox/Projects/mettle/dacor -- the ONLY place you may write.
An mbuild project: mbuild.toml at the root, engine under src/, test programs
under tests/, one [bin.*] per program. Read mbuild.toml first.
Language: Mettle, head compiler at
  /home/nox/Projects/mettle/raize/mettle-build/bin/mettle

READ FIRST, in full: PHASE2.md (normative for this phase), then PHASE1.md for
everything it inherits, then ARCHITECTURE.md sections 0/4/6, then
notes/01-language.md and notes/03-gotchas.md (section 7 is the incident log),
and notes/04-build.md section 6b (mutation-testing discipline).

HARD RULES
- Export only what the contract names, prefixed dk_/Dk/DK_. Unprefixed exports
  collide in one flat namespace and break the whole program.
- Every public declaration gets its own 'export'.
- int32 returns: >= 0 success, -DK_ERR_* failure. Actions answer DK_OK, not a
  count. Never -1.
- All multi-byte access through format/bytes.mettle. Little-endian, one place.
- No struct overlaid on a page. No 4096-byte page buffer on a stack.
- Imports: explicit relative paths WITH the extension.
- Zero compiler warnings. './tools/check.sh' must stay GATE PASS.
- mbuild.toml is OFF LIMITS: every bin you need already exists.
- Never return a struct literal directly (ICE). Bind to a local first.
- A test reported 'skipped' did not run; treat it as a failure.
- Tests: programs under tests/, not @test, when they need files. Every case
  names the bug it catches and was watched to fail under a deliberate mutation,
  bounded by 'timeout 15', with the original restored after every mutant.

TOUCH ONLY THE FILES NAMED IN YOUR BRIEF.
`;

const BRIEF_A = `You are LANE A. Lane B is working at the same time on key ordering; do not
touch its files.

Your seam: 2A in PHASE2.md -- cell extents. Phase 1's page layer cannot say how
long a cell is, so it cannot detect overlapping cells and cannot reclaim an
interior hole. You add a two-byte length prefix per cell, bump the format
version, and extend the structural checks.

Files you own:
  src/format/page.mettle    dk_page_alloc/cell_off/cell_len/free_cell/defrag/
                            free_bytes/reclaimable/check, DK_FORMAT_VERSION -> 2
  src/format/meta.mettle    only if the version constant lives there
  tests/a_self.mettle       update the exact-offset expectations to the new
                            packing (bodies now start 2 bytes lower) and add the
                            new checks
  tests/phase1.mettle       only the page-level assertions the change invalidates
                            (T1 offsets, x0/x5 body patterns). Do not restructure
                            the suite; lane D's cases stay as they are otherwise.

Read PHASE1.md sections 3.1-3.3 first, then PHASE2.md 2A. The extents spec is
exact: alloc takes n+2, writes n at the new free_end, returns free_end+2;
cell_len reads the u16 at off-2; defrag reclaims EVERY hole by walking cells in
pointer order and copying [len][body] downward from DK_PAGE_SIZE; check gains
rules 10, 11, 12 (no two cells overlap).

Build loop (NOT mbuild -- it would race lane B):
  ./tools/mettle --build tests/a_self.mettle -o build/laneA/a_self && ./build/laneA/a_self
  ./tools/mettle --build tests/phase1.mettle -o build/laneA/p1 && ./build/laneA/p1
  ./tools/mettle --release --build tests/a_self.mettle -o build/laneA/a_self.rel
  ./tools/mettle test tests/a_self.mettle

Add to tests/a_self.mettle: a cell-extent case (E1 in PHASE2.md 2E) and an
overlapping-cells case (E2) that hand-builds the corruption and expects
-DK_ERR_CORRUPT. Both must be watched failing under a mutation.
${RULES}`;

const BRIEF_B = `You are LANE B. Lane A is working at the same time on the page format; do not
touch its files.

Your seam: 2B in PHASE2.md -- an order-preserving key encoding, so a b-tree can
sort keys with a byte comparison instead of a typed callback per key type.

Files you own:
  src/types/key.mettle    dk_key_int, dk_key_rowid, dk_key_text, dk_key_null,
                          dk_key_compare, DK_KEY_* tags
  tests/key_self.mettle   replaces the PENDING stub

You may READ src/format/bytes.mettle and use dk_put_u64le/dk_get_u64le from it.
You must not write it. No other module needs to change.

The rule that matters: dk_key_int must be order-preserving for SIGNED values --
flip the sign bit, store big-endian, so -2^63 < -1 < 0 < 1 < 2^63-1 all hold
under dk_key_compare. A plain big-endian uint64 encoding gets the positives
right and every negative wrong, which is the bug this lane exists to prevent.

Build loop (NOT mbuild -- it would race lane A):
  ./tools/mettle --build tests/key_self.mettle -o build/laneB/key_self && ./build/laneB/key_self
  ./tools/mettle --release --build tests/key_self.mettle -o build/laneB/key_self.rel
  ./tools/mettle test tests/key_self.mettle

tests/key_self.mettle must cover E3 in PHASE2.md 2E: the int64 extremes in
sorted order, text ordering including the prefix case, composite concatenation,
and a cap that is one byte short answering -DK_ERR_FULL. Watch it fail with the
sign flip removed.
${RULES}`;

const BRIEF_C = `You are the freelist worker. 2A and 2B are merged and green.

Your seam: 2C in PHASE2.md -- free pages become reusable, and the freelist
survives a reopen.

Files you own:
  src/pager/freelist.mettle   dk_free_init/take/put/count
  src/pager/pager.mettle      dk_pager_alloc takes from the freelist before
                              extending; dk_pager_free_page becomes real instead
                              of -DK_ERR_UNSUPPORTED
  tests/freelist_self.mettle  replaces the PENDING stub
  tests/c_self.mettle         only the assertions that assumed free_page was
                              unsupported

Rules from PHASE2.md 2C: a freelist page is DK_PAGE_FREELIST with 4-byte cells
(a u32 page number); meta.freelist_root is the chain head, 0 = none; freeing
page 0 is -DK_ERR_USAGE; a taken page is still zeroed by alloc; the chain
survives close/reopen.

E4 in PHASE2.md 2E is the required test: take 5, free 3, close, reopen,
dk_free_count == 3, take 3 and see them come back LIFO. Mutation-test it
(remove the root write, then lose the count) with timeout 15 and restore.

  ./tools/mettle --build tests/freelist_self.mettle -o build/laneC/f && ./build/laneC/f
  ./tools/mettle --build tests/c_self.mettle -o build/laneC/c && ./build/laneC/c
${RULES}`;

const BRIEF_D = `You are the b-tree worker. 2A, 2B and 2C are merged and green.

Your seam: 2D in PHASE2.md. One tree type for tables and indexes: leaf and
inner nodes over the pager, a caller-supplied comparator, insert, lookup, and a
forward range scan.

Files you own:
  src/btree/btree.mettle    DkBtKey, DkBtCursor, dk_bt_lookup/insert/seek/next/
                            rowid/close, DK_BT_MAX_DEPTH
  src/btree/node.mettle     cell encode/decode for leaf and inner nodes, if you
                            want it separate
  tests/btree_self.mettle   replaces the PENDING stub
  src/main.mettle           extend the smoke entry: build a 1000-key tree over
                            the pager, close, reopen, walk it ascending

Non-negotiable from PHASE2.md 2D: the tree must NOT import src/types/. The
comparator is a parameter, 'fn(uint8*, int32, uint8*, int32) -> int32'. A cursor
pins exactly one leaf frame at a time and releases it before pinning the next.
An insert that splits the root returns the new root through root*. Underfull
nodes are allowed: say so, do not pretend a rebalance exists.

E5, E6, E7 in PHASE2.md 2E are required. E6 is the one that matters most: 1000
inserts with n_frames = 8, so splits force eviction and write-back, then flush,
close, reopen, walk and compare every key. A split that holds two frames without
pinning both passes at 256 frames and fails at 8.

  ./tools/mettle --build tests/btree_self.mettle -o build/laneD/b && ./build/laneD/b
  ./tools/mettle --release --build tests/btree_self.mettle -o build/laneD/b.rel
  ./tools/mettle --build src/main.mettle -o build/laneD/smoke && ./build/laneD/smoke
${RULES}`;

const BRIEF_GATE = `You are the phase-2 integration and gate worker. Everything is merged.

Files you own:
  tests/phase2.mettle     a new integration program: the whole stack in one run
  mbuild.toml             add the [bin.phase2] entry (allowed for you only)
  PHASE2-RESULT.md        the gate report
  any file, minimally, for a defect the gate finds

The integration program must exercise the seams, not the pieces:
  I1  1000-key b-tree over the real pager with 8 frames, flush, close, reopen,
      walk ascending, compare every key and rowid.
  I2  the same tree with the page format's new extents: after the walk, defrag
      every leaf and walk again -- the order and the contents must not change.
  I3  a freelist round trip interleaved with the tree: free 3 pages, reopen,
      rebuild the tree, assert page_count did not grow past the original.
  I4  corruption: flip a byte in a leaf cell's length prefix, reopen, seek into
      that leaf, and require -DK_ERR_CORRUPT rather than a wrong answer. This is
      the case that proves 2A paid for itself.

Then run and record:
  ./tools/check.sh                     (mbuild gate, full)
  ./tools/mettle test src/main.mettle
  ./tools/mettle --safe --build tests/phase2.mettle -o build/gate/p2.safe ; ./build/gate/p2.safe
  ./tools/mettle --release --build tests/phase2.mettle -o build/gate/p2.rel ; ./build/gate/p2.rel

PHASE2-RESULT.md: GATE line; module->file->ownership table; evidence per
command; each E1..E7 and I1..I4 marked proven/unproven with the test that proves
it; the known gaps (no merge, no delete, no journal) stated plainly; and what
phase 3 (journal) needs that does not exist yet. Do not claim evidence you did
not produce in this run.
${RULES}`;

const ORCH_HEAD = `You are the phase-2 ORCHESTRATOR for a relational storage engine written in
Mettle. You are ONE agent watching a sequence of workers, resumed after every
stage and after every fix, so keep a running picture in context.

Rules:
- You must NOT write or edit any file. Do not create progress.md or context.md.
- You may read anything and run any command, including mbuild.
- Judge against PHASE2.md first, PHASE1.md second. Quote the clause violated.
- Be adversarial about tests that cannot fail: an assertion that asserts
  nothing, the same expression on both sides, a setup that makes the check
  vacuous, a case that cannot distinguish a broken invariant from a working one,
  an oracle that uses the code under test to compute its expectation.
- The repo is git. 'git status --short' and 'git diff --stat' tell you what a
  stage actually changed, and whether a lane touched a file it did not own.
- mbuild's build/ and .mbuild/stamps are shared: run mbuild only between stages,
  which is when the lanes are idle.

Every reply has EXACTLY this shape; the DIRECTIVES are fed verbatim into the next
worker's brief, so write instructions, not observations.

STATUS: <one line: what you verified and what you found>
VERDICT: PASS   (or FAIL)
DEFECTS:
  1. <file:line> -- <contract clause> -- <what is wrong>
DIRECTIVES:
  - <imperative instruction for the next stage>
NEXT: <what the next stage must produce>

With no defects write 'DEFECTS: none' and still write DIRECTIVES pointing at the
highest risk.
`;

const ORCH_1 = `REPO is /home/nox/Projects/mettle/dacor. Two lanes ran concurrently with
disjoint files.

LANE A: src/format/page.mettle (+ meta version), tests/a_self.mettle, and only
        the page-level assertions in tests/phase1.mettle the change invalidated.
LANE B: src/types/key.mettle, tests/key_self.mettle.

Both are done, so mbuild is safe.
1. cd REPO && ./tools/check.sh            (full; capture output and warnings)
2. ./tools/mettle --build tests/a_self.mettle -o build/orch/a && ./build/orch/a
3. ./tools/mettle --build tests/key_self.mettle -o build/orch/k && ./build/orch/k
4. ./tools/mettle --build tests/phase1.mettle -o build/orch/p1 && ./build/orch/p1
5. Read src/format/page.mettle against PHASE2.md 2A: alloc takes n+2 and writes
   the length at the new free_end returning free_end+2; cell_len reads off-2;
   defrag reclaims EVERY hole and is idempotent; free_bytes is the gap while
   reclaimable includes dead extents; check rules 10/11/12 exist and detect an
   overlap; DK_FORMAT_VERSION is 2 and a version-1 meta is refused with VERSION.
6. Read src/types/key.mettle against 2B: is dk_key_int really order-preserving
   for signed values, and does the test prove the negatives sort below zero
   (not just that the encoding round-trips)?
7. Did either lane touch a file it did not own, or mbuild.toml? 'git status'.
Then reply in the required shape.`;

const ORCH_2 = `STAGE 2C (freelist) is done: src/pager/freelist.mettle,
src/pager/pager.mettle, tests/freelist_self.mettle, tests/c_self.mettle.

1. cd REPO && ./tools/check.sh
2. ./tools/mettle --build tests/freelist_self.mettle -o build/orch/f && ./build/orch/f
3. ./tools/mettle --build tests/c_self.mettle -o build/orch/c && ./build/orch/c
4. Check 2C: freelist pages are DK_PAGE_FREELIST with 4-byte cells; meta root is
   the chain head with 0 = none; alloc prefers the freelist; free_page is real;
   page 0 cannot be freed; the chain survives close/reopen; E4 asserts LIFO and
   the count after reopen. Is the reused page still fully zeroed?
Then reply in the required shape.`;

const ORCH_3 = `STAGE 2D (b-tree) is done: src/btree/, tests/btree_self.mettle, src/main.mettle.

1. cd REPO && ./tools/check.sh
2. ./tools/mettle --build tests/btree_self.mettle -o build/orch/b && ./build/orch/b
3. ./tools/mettle --release --build tests/btree_self.mettle -o build/orch/b.rel && ./build/orch/b.rel
4. ./tools/mettle --build src/main.mettle -o build/orch/smoke && ./build/orch/smoke
5. Check 2D: the tree does not import src/types/ (grep the imports); the
   comparator is a parameter; a cursor pins exactly one leaf and releases it
   before pinning the next; a root split returns the new root through root*;
   depth is capped at 16 with CORRUPT and no recursion crash; insert of an
   existing key replaces the rowid.
6. Is E6 real? 1000 inserts with n_frames = 8, then flush/close/reopen/walk.
   Show the frame count it actually used and say whether eviction was forced.
Then reply in the required shape.`;

const ORCH_4 = `STAGE 3 (integration + gate) is done: tests/phase2.mettle,
PHASE2-RESULT.md, mbuild.toml.

Verify the gate, do not take it on trust:
1. cd REPO && ./tools/check.sh
2. ./tools/mettle --build tests/phase2.mettle -o build/orch/p2 && ./build/orch/p2
   and the same under --release and under --safe.
3. Read PHASE2-RESULT.md. For each E1..E7 and I1..I4, confirm the cited evidence
   exists and says what is claimed. Flag any claim with no evidence from this run.
   I4 (a corrupted cell length prefix must yield CORRUPT, not a wrong answer) is
   the case that justifies 2A -- verify it actually corrupts a LENGTH PREFIX.
7. 'git status --short' -- is the tree clean of stray artifacts?
Then reply in the required shape, and make the LAST directive the single thing
phase 3 (the page-level rollback journal) must do first.`;

const ORCH_FIX = (stage) => `A fix pass just ran for ${stage}. Re-run the checks you ran for that stage, and
also rerun ./tools/check.sh to confirm nothing it did not touch broke. Then reply
in the required shape. If the same defect is still present, say so plainly and
make it the first DIRECTIVE with a concrete change.`;

const FIX = (directives) => `You are the fix worker for dacor phase 2.

The orchestrator reviewed the last stage and issued these directives. Apply them
minimally, inside the existing design. You may edit any file under the repo
except PHASE1.md and PHASE2.md -- if a contract clause itself is wrong, stop and
report it instead of editing it.

Fix causes, not symptoms. Do not weaken a test to make it pass: if a test is
wrong, say why and fix the test; if an assertion is what is wrong, say that.
Touch only files relevant to the directives.

Then run ./tools/check.sh and report the output plus a one-line note per
directive and how it was closed.

ORCHESTRATOR OUTPUT FOLLOWS.

${directives}
`;

const FIX_NOTE = "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n";

// --------------------------------------------------------------- stage 1 ----
await runs.all([
  { key: "laneA", label: "Lane A: cell extents, format v2", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_A },
  { key: "laneB", label: "Lane B: order-preserving keys", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_B },
]);

let m = await runs.run("orch-1", {
  label: "Orchestrator: verify both lanes",
  agent: "scout",
  model: MODEL,
  cwd: CWD,
  output: false,
  task: ORCH_HEAD + ORCH_1,
});
let d = m.output;

if (d.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-1", { label: "Fix lane defects", agent: "worker", model: MODEL, cwd: CWD, task: FIX(d) });
  m = await runs.run("orch-1b", { resume: m.runId, task: ORCH_FIX("stage 1, the two lanes") });
  d = m.output;
}

// --------------------------------------------------------------- stage 2 ----
await runs.run("s2", { label: "Write the freelist", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_C + FIX_NOTE + d });
let m2 = await runs.run("orch-2", { resume: m.runId, task: ORCH_2 });
let d2 = m2.output;

if (d2.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-2", { label: "Fix freelist defects", agent: "worker", model: MODEL, cwd: CWD, task: FIX(d2) });
  m2 = await runs.run("orch-2b", { resume: m2.runId, task: ORCH_FIX("stage 2C, the freelist") });
  d2 = m2.output;
}

// --------------------------------------------------------------- stage 3 ----
await runs.run("s3", { label: "Write the b-tree", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_D + FIX_NOTE + d2 });
let m3 = await runs.run("orch-3", { resume: m2.runId, task: ORCH_3 });
let d3 = m3.output;

if (d3.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-3", { label: "Fix b-tree defects", agent: "worker", model: MODEL, cwd: CWD, task: FIX(d3) });
  m3 = await runs.run("orch-3b", { resume: m3.runId, task: ORCH_FIX("stage 2D, the b-tree") });
  d3 = m3.output;
}

// --------------------------------------------------------------- stage 4 ----
await runs.run("s4", { label: "Integration and phase-2 gate", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_GATE + FIX_NOTE + d3 });
const m4 = await runs.run("orch-4", { resume: m3.runId, task: ORCH_4 });

return {
  stage1: d.slice(-2000),
  freelist: d2.slice(-2000),
  btree: d3.slice(-2000),
  gate: m4.output.slice(-3000),
};
