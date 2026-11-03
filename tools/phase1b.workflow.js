// dacor phase 1, second half — pager || integration harness, then the
// pager-dependent tests, then the gate.
//
//   S1  LANE C: src/pager/pager.mettle + tests/c_self.mettle
//       LANE D: tests/tinytest.mettle + tests/phase1.mettle (T1-T3, X1, X3)
//   S2  pager-dependent tests (T4-T7, X2, X4, X5) + wire src/main.mettle
//   S3  gate: PHASE1-RESULT.md
//
// Everything is an mbuild project now (mbuild.toml, src/, tests/, [bin.*]).
// During the parallel stage the lanes must NOT run mbuild -- build/ and
// .mbuild/stamps are shared, so two concurrent mbuild runs race. Lanes compile
// their own entry with ./tools/mettle into build/laneX/; the orchestrator runs
// the mbuild gate between stages, when both lanes are idle.
//
// Launch: subagent({ workflow: "./tools/phase1b.workflow.js" })

const CWD = "/home/nox/Projects/mettle/dacor";
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";
const HEAD = "/home/nox/Projects/mettle/raize/mettle-build/bin/mettle";

const RULES = `
REPO: /home/nox/Projects/mettle/dacor -- the ONLY place you may write.
It is an mbuild project: mbuild.toml at the root, engine modules under src/,
test programs under tests/, one [bin.*] per program. Read mbuild.toml first.
Language: Mettle, through the head compiler at
  /home/nox/Projects/mettle/raize/mettle-build/bin/mettle
No libc, one flat global export namespace, no generics through pointers, no
exceptions, sub-1MB unchecked stack.

READ FIRST, in full, before writing anything:
  1. PHASE1.md                    <- normative: offsets, signatures, invariants
  2. ARCHITECTURE.md sections 0, 4, 6
  3. notes/01-language.md and notes/03-gotchas.md   (03 section 7 is new)
  4. mbuild.toml and the existing src/ module you build on

HARD RULES
- Export only the symbols PHASE1.md names, with the dk_/Dk/DK_ prefixes.
- Every public declaration gets its own 'export'.
- Every int32 return is >= 0 on success and -DK_ERR_* on failure (a write
  action returns DK_OK, not a count). Never -1.
- All multi-byte byte access goes through format/bytes.mettle.
- No Mettle struct overlaid on a page. No 4096-byte page buffer on the stack.
- Imports: explicit relative paths WITH the extension ("../format/page.mettle").
- Zero compiler warnings.
- Nothing from PHASE1.md section 9 (out of scope).
- mbuild.toml is OFF LIMITS: both bins you need (c_self, phase1) already exist.
- Never return a struct literal directly from a function -- bind it to a local
  first. 'return { x: 1 };' is an ICE on this compiler (notes/03-gotchas G1).
- A test that is reported 'skipped' did not run, and mettle test still exits 0.
  Treat 'skipped' as a failure.

TOUCH ONLY THE FILES NAMED IN YOUR BRIEF.

DEFINITION OF DONE
- Every feature you finished has a test that can fail, and you have watched it
  pass. Say which mutation you tried and what failed.
- Report: files, exact commands and output, deviations and why, test names.
`;

const BRIEF_LANE_C = `You are LANE C, the pager worker. Lane D is working at the same time on the
integration harness; you must not touch its files.

Your seam: the frame table, the page-number hash, clock eviction, pin
accounting, page allocation, and the flush that makes it durable.

Files you own (only these):
  src/pager/pager.mettle   every dk_pager_* in PHASE1.md section 5.9
  tests/c_self.mettle      the pager's own tests (replace the PENDING stub)

Everything under src/error/, src/platform/, src/format/, src/mem/ exists. Read
it and use it; do not modify it. If you find a real defect there, report it.

Build loop during this stage (NOT mbuild -- it would race lane D):
  ./tools/mettle --build tests/c_self.mettle -o build/laneC/c_self && ./build/laneC/c_self
  ./tools/mettle --release --build tests/c_self.mettle -o build/laneC/c_self.rel
  ./tools/mettle test tests/c_self.mettle
The orchestrator runs ./tools/check.sh --quick (mbuild) once both lanes are done.

Specific notes:
- Follow PHASE1.md section 6 exactly, including the 2 * n_frames scan bound. A
  pinned frame is NEVER evicted. Exhaustion is -DK_ERR_BUSY.
- Hash: open addressing, index_cap = next power of two >= 2 * n_frames, slot
  value = frame_index + 1, 0 = empty. Eviction uses backward-shift deletion. No
  tombstones: the table size is fixed, so tombstones would fill it forever.
- get on a miss: pick a victim; if dirty, write it back first (a failed write
  abandons the eviction and returns the error); then read the page and pin it.
  page_no >= page_count is -DK_ERR_RANGE unless the page is already cached.
- alloc: page_no = page_count, page_count++, zero all 4096 bytes, dirty, pin 1.
  Nothing is written until flush. Mark the meta frame dirty so page_count lands.
- flush: dirty pages with page_no > 0 ascending, then page 0 LAST, then sync,
  then mark written frames clean. Expose the order through
  dk_pager_flush_plan(p, out, cap) so a test asserts it without a mock.
- Seal a page with dk_page_seal immediately before writing it, never after.
- close flushes, syncs, closes, frees every frame buffer and the arrays, and
  reports the FIRST error without leaking on the error path. Second close DK_OK.
- Two gets of one page number return the SAME DkFrame*. alloc returns a frame
  whose 4096 bytes are all zero even if it previously held another page.
- journal/lock fields stay 0. No locking, no threads, no journal. Phase 1 has no
  atomicity and a dirty write-back is not atomic: say so at the top of the file.
- tests/c_self.mettle must cover: create/reopen, cache identity and pin,
  eviction never drops a pinned page, alloc zeroes all 4096 bytes, every row of
  the PHASE1.md section 7 table that the pager can reach, flush plan order, and
  dirty_count == 0 after flush. Use build/ for data files.
${RULES}`;

const BRIEF_LANE_D = `You are LANE D, the integration-harness worker. Lane C is working at the same
time on the pager; you must not touch its files, and you must NOT import
src/pager/pager.mettle -- the pager does not exist yet. Your tests are the ones
that need only format/, platform/, mem/ and error/.

Files you own (only these):
  tests/tinytest.mettle   dk_t_check(cond, name), dk_t_check_i64(a, b, name),
                          dk_t_check_bytes(a, b, n, name),
                          dk_t_check_false(cond, name), dk_t_report() -> int32
  tests/phase1.mettle     replace the PENDING stub with a main() that runs the
                          cases below and returns non-zero on the first failure

Cases in this stage, all from PHASE1.md section 8 plus the cross-feature list:
  T1  format round-trip, pure: exact cell offsets after allocating 5 cells of
      1, 7, 2, 33, 64 bytes; free_end == 4096 - 107; the nine page checks;
      defrag idempotence; a flipped byte in each header field rejected by
      dk_page_verify; the CRC-32 vector 0xCBF43926; varint round-trips over
      0, 127, 128, 300, 4294967295, 18446744073709551615 and zigzag over
      -1, 0, 1, min/max int64.
  T2  open/create/reopen: create, write three pages directly through the file
      surface (there is no pager yet), flush by dk_file_sync, close, reopen,
      assert page_count-derived size and the page bytes.
  T3  cache identity and pin: SKIP -- it is a pager test, lane C owns it.
  X1  format + platform: build a page in memory, seal it, write it at a page
      offset through dk_file_write_at, read it back through dk_file_read_at,
      assert dk_page_verify and every byte.
  X3  platform: the file size is exactly page_count * 4096 after writing N
      pages, and a read past the end returns 0.

Leave T4..T7 and X2/X4/X5 for the next stage; write the harness so adding a
case later is one function plus one call.

Build loop during this stage (NOT mbuild -- it would race lane C):
  ./tools/mettle --build tests/phase1.mettle -o build/laneD/phase1 && ./build/laneD/phase1
  ./tools/mettle --release --build tests/phase1.mettle -o build/laneD/phase1.rel
  ./tools/mettle test tests/phase1.mettle
The orchestrator runs ./tools/check.sh --quick (mbuild) once both lanes are done.

Specific notes:
- These are programs, not @test functions: they need real files. Use build/.
- Every case must be able to fail. For each one write a comment naming the bug
  it catches, and where you can prove it: break the engine, watch it fail,
  revert, say so.
- The harness prints 'PASS <case>' / 'FAIL <case>: <detail>' and returns
  non-zero on the first failure; dk_t_report() returns the exit code.
${RULES}`;

const BRIEF_COMPLETE = `You are the completion worker for dacor phase 1. The pager and the harness are
both merged and green. Close the remaining test gaps and wire the smoke entry.

Files you own:
  tests/phase1.mettle    add T4..T7, X2, X4, X5 (keep T1, T2, X1, X3 working)
  tests/tinytest.mettle  only if the harness itself needs a fix
  src/main.mettle        extend the smoke entry to use the pager: create a
                         database, allocate pages, write patterns, flush, close,
                         reopen, read back, verify

Cases to add:
  T4  eviction never drops a pinned page: with n_frames = 8 hold seven pinned,
      get an eighth, get a ninth -> 0 with dk_pager_err == DK_ERR_BUSY and no
      pinned frame's page_no changed; unpin one -> success.
  T5  alloc zeroes: alloc 64 pages, fill each frame with 0xFF, flush, close,
      reopen, alloc 8 more over reused frames, assert ALL 4096 bytes are zero
      before touching them; page_count advanced by exactly 8; file size exact.
  T6  corruption matrix: every row of PHASE1.md section 7 the pager can reach,
      each asserting its specific DK_ERR_*; a foreign 4096-byte text file ->
      -DK_ERR_NOT_A_DB. No crash on any row.
  T7  flush plan order: dirty pages 5, 1, 3 and the meta -> [1, 3, 5, 0].
  X2  format + pager: write the meta through dk_meta_write into the page-0
      frame, flush, reopen, dk_meta_check passes, roots and page_count survive.
  X4  crash-shaped: write 8 pages, flush, flip one byte inside page 5 on disk
      behind the pager's back; a fresh pager must reject page 5 with
      -DK_ERR_CORRUPT and still verify pages 1..4 and 6..8.
  X5  survives reopen with the same content and no stale bytes anywhere.

Build and test (both lanes are idle now, mbuild is safe):
  ./tools/check.sh --quick
  ./tools/mettle test tests/phase1.mettle
  ./tools/mettle --build tests/phase1.mettle -o build/phase1 && ./build/phase1
${RULES}`;

const BRIEF_GATE = `You are the phase-1 gate worker. Your job is to decide, in writing, whether
phase 1 is done, and to close the remaining gaps minimally.

Files you own:
  PHASE1-RESULT.md   the gate report
  any file under src/, tests/, mbuild.toml -- only for defects the gate finds

Run all of this and record the exact output:
  1. ./tools/check.sh                    (mbuild: check, build x2, test, run every bin x2, probes)
  2. ./tools/mettle test src/main.mettle (unit tests in the engine's own modules)
  3. ./tools/mettle --safe --build tests/phase1.mettle -o build/gate/p1.safe ; ./build/gate/p1.safe
     PHASE1.md does not require --safe to pass; the report must say whether it
     does and why not.
  4. The corruption matrix from PHASE1.md section 7: which row has a test, which
     has only a manual check, which has no evidence.
  5. Zero-warning check across the mbuild logs in build/logs/.

PHASE1-RESULT.md must contain, in this order:
  - GATE: PASS or FAIL, one line.
  - What was built: module -> file -> what it owns, as a table.
  - Evidence: each command and its actual output (trimmed), debug and release.
  - Invariants 1..14 of PHASE1.md section 6b: proven / unproven / needs a test.
  - Boundary table of section 7: test name per row, or 'no evidence'.
  - Known gaps, and the one thing most likely to break in phase 2.
  - What phase 2 (b-tree) needs from phase 1 that does not exist yet.

Do not claim a gate passes on evidence you did not produce in this run.
${RULES}`;

const ORCH_HEAD = `You are the phase-1 ORCHESTRATOR for a relational storage engine written in
Mettle. You are ONE agent watching a sequence of workers; you are resumed after
every stage and after every fix, so keep a running picture in context.

Rules for you:
- You must NOT write or edit any file. Do not create progress.md or context.md.
- You may read anything and run any command, including mbuild.
- Judge against PHASE1.md, not against your taste. Quote the clause violated.
- Be adversarial about tests that cannot fail: an assertion that asserts nothing,
  the same expression on both sides, a skipped body, a test that catches its own
  failure, a case whose setup makes the check vacuous.
- The repo is git. 'git -C REPO status --short' and 'git diff --stat' tell you
  what a stage actually changed.
- mbuild's build/ and .mbuild/stamps are shared: run mbuild only when no lane is
  working. You always run it between stages, which is when it is safe.

Every reply has EXACTLY this shape. The DIRECTIVES are fed verbatim into the
next worker's brief, so make them instructions, not observations.

STATUS: <one line: what you verified and what you found>
VERDICT: PASS   (or FAIL)
DEFECTS:
  1. <file:line> -- <PHASE1.md clause> -- <what is wrong>
DIRECTIVES:
  - <imperative instruction for the next stage's worker>
NEXT: <what the next stage must produce>

If there are no defects, write 'DEFECTS: none' and still write DIRECTIVES that
point the next stage at the risk you consider highest.

`;

const ORCH_S1 = `REPO is /home/nox/Projects/mettle/dacor. Two lanes worked concurrently with
disjoint files.

LANE C: src/pager/pager.mettle, tests/c_self.mettle
LANE D: tests/tinytest.mettle, tests/phase1.mettle

Both lanes are done, so the tree is quiet: mbuild is safe now.
1. cd REPO && ./tools/check.sh --quick      (capture output and warning count)
2. ./tools/mettle test src/main.mettle
3. ./tools/mettle --build tests/c_self.mettle -o build/orch/c && ./build/orch/c
4. ./tools/mettle --build tests/phase1.mettle -o build/orch/p1 && ./build/orch/p1
5. Read src/pager/pager.mettle against PHASE1.md sections 5.9, 6, 6b, 7:
   clock bounded by 2*n_frames and pinned never evicted; -DK_ERR_BUSY on
   exhaustion; index_cap a power of two >= 2*n_frames; backward-shift deletion
   and no tombstones; same DkFrame* for the same page; no re-read of a cached
   page; alloc zeroes all 4096 bytes and increments page_count once; -DK_ERR_NOSPC
   at DK_MAX_PAGES without incrementing; flush_plan ascending then page 0 last;
   one sync after the writes; dirty_count == 0 after flush; seal before write;
   every section 7 row returns its exact code; no 'repair' of a size/page_count
   mismatch; close does not leak on an error path; second close DK_OK; journal
   and lock fields are 0.
6. Read tests/phase1.mettle: for T1, T2, X1, X3, does each assert what its
   paragraph says with exact offsets and exact codes? Name the bug each catches.
   Flag every tautology and every check that cannot fail.
7. 'git status --short' and 'git diff --stat' -- did either lane touch a file it
   did not own, or mbuild.toml?
Then reply in the required shape.`;

const ORCH_S2 = `STAGE 2 (completion) is done: tests/phase1.mettle gained T4..T7, X2, X4, X5,
and src/main.mettle now uses the pager.

1. cd REPO && ./tools/check.sh            (full, including probes)
2. ./tools/mettle --build tests/phase1.mettle -o build/orch/p1 && ./build/orch/p1
3. ./tools/mettle --release --build tests/phase1.mettle -o build/orch/p1r && ./build/orch/p1r
4. ./tools/mettle test src/main.mettle ; ./tools/mettle test tests/phase1.mettle
5. Check each new case against PHASE1.md section 8 and the cross-feature list:
   T4 must actually exhaust the frame table (seven pinned of eight, then two
   more gets); T5 must check all 4096 bytes of a REUSED frame; T6 and X4 must
   assert specific DK_ERR_* codes and cover every row they name; X4 must show
   pages 1..4 and 6..8 still verify after page 5 is corrupted; T7 must assert
   [1, 3, 5, 0] exactly.
6. Is any engine path only 'tested' by a test that computes its expectation with
   the same helper under test? Say which.
Then reply in the required shape.`;

const ORCH_S3 = `STAGE 3 (gate) is done: PHASE1-RESULT.md plus minimal fixes.

Verify the gate, do not take it on trust:
1. cd REPO && ./tools/check.sh
2. ./tools/mettle test src/main.mettle
3. ./tools/mettle --safe --build tests/phase1.mettle -o build/orch/p1.safe ; ./build/orch/p1.safe
4. Read PHASE1-RESULT.md. For each of the 14 invariants and each row of the
   section 7 boundary table, confirm the cited evidence exists and says what is
   claimed. Flag any claim with no evidence from this run.
5. 'git status --short' -- is the tree clean of stray artifacts?
Then reply in the required shape, and make the LAST directive the single thing
phase 2 must do first.`;

const ORCH_FIX = (stage) => `A fix pass just ran for ${stage}. Re-run the checks you ran for that stage, and
also confirm nothing it did not touch broke: rerun ./tools/check.sh (mbuild is
safe now, the lanes are idle) and the other test programs. Then reply in the
required shape. If the same defect is still present, say so plainly and make it
the first DIRECTIVE with a concrete change.`;

const FIX = (directives) => `You are the fix worker for dacor phase 1.

The orchestrator reviewed the last stage and issued these directives. Apply them
minimally, inside the existing design. You may edit any file under the repo
except PHASE1.md -- if a contract clause itself is wrong, stop and report it.

Fix causes, not symptoms. Do not weaken a test to make it pass: if a test is
wrong, say why and fix the test; if an assertion is what is wrong, say that.
Touch only files relevant to the directives.

Then run ./tools/check.sh and ./tools/mettle test src/main.mettle, and report the
output plus a one-line note per directive and how it was closed.

ORCHESTRATOR OUTPUT FOLLOWS.

${directives}
`;

// --------------------------------------------------------------- stage 1 ----
const lanes = await runs.all([
  {
    key: "laneC",
    label: "Lane C: the pager",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: BRIEF_LANE_C,
  },
  {
    key: "laneD",
    label: "Lane D: integration harness and format tests",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: BRIEF_LANE_D,
  },
]);

let m1 = await runs.run("orch-1", {
  label: "Orchestrator: verify both lanes",
  agent: "scout",
  model: MODEL,
  cwd: CWD,
  output: false,
  task: ORCH_HEAD + ORCH_S1,
});
let d1 = m1.output;

if (d1.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-1", {
    label: "Fix lane defects",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: FIX(d1),
  });
  m1 = await runs.run("orch-1b", { resume: m1.runId, task: ORCH_FIX("stage 1, the two lanes") });
  d1 = m1.output;
}

// --------------------------------------------------------------- stage 2 ----
await runs.run("s2", {
  label: "Close the test gaps and wire main",
  agent: "worker",
  model: MODEL,
  cwd: CWD,
  task: BRIEF_COMPLETE + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d1,
});

let m2 = await runs.run("orch-2", { resume: m1.runId, task: ORCH_S2 });
let d2 = m2.output;

if (d2.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-2", {
    label: "Fix completion defects",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: FIX(d2),
  });
  m2 = await runs.run("orch-2b", { resume: m2.runId, task: ORCH_FIX("stage 2, the completion pass") });
  d2 = m2.output;
}

// --------------------------------------------------------------- stage 3 ----
await runs.run("s3", {
  label: "Run the phase-1 gate",
  agent: "worker",
  model: MODEL,
  cwd: CWD,
  task: BRIEF_GATE + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d2,
});

const m3 = await runs.run("orch-3", { resume: m2.runId, task: ORCH_S3 });

return {
  stage1: d1.slice(-2500),
  stage2: d2.slice(-2500),
  gate: m3.output.slice(-3500),
};
