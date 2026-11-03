// dacor phase 1 — two lanes, one orchestrator, tests at every seam.
//
//   S0  error/status                      (single writer: everything needs the codes)
//   S1  LANE A: format/       ||  LANE B: platform/ + mem/     (disjoint files)
//   S2  pager/ + main.mettle              (needs both lanes)
//   S3  integration tests                 (T1..T7 + cross-feature)
//   S4  full gate + phase report
//
// Between every stage the orchestrator (a scout: bash but no edit tool) runs the
// builds itself and emits a VERDICT plus DIRECTIVES. Its directives are threaded
// into the next stage's brief, so it is steering, not just auditing.
//
// Writer isolation: lanes write strictly disjoint paths and build into disjoint
// output dirs (build/a, build/b), so neither can observe the other's half-written
// file. There is no shared file in S1 -- not even an entry point.
//
// Launch:  subagent({ workflow: "./tools/phase1.workflow.js" })

const CWD = "/home/nox/Projects/mettle/dacor";
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";

const RULES = `
REPO: /home/nox/Projects/mettle/dacor -- the ONLY place you may write.
Language: Mettle, through ./tools/mettle (head compiler, Linux x86-64). No libc,
one flat global export namespace, no generics through pointers, no exceptions,
sub-1MB unchecked stack.

READ FIRST, in full, before writing anything:
  1. PHASE1.md                    <- normative: offsets, signatures, invariants
  2. ARCHITECTURE.md sections 0, 4, 6
  3. notes/01-language.md and notes/03-gotchas.md
  4. notes/02-stdlib.md if you touch std/io or std/mem

HARD RULES
- Export only the symbols PHASE1.md names, with the dk_/Dk/DK_ prefixes. An
  unprefixed export (open, close, get, put, free, init) breaks the whole program.
- Every public declaration gets its own 'export'.
- Every int32 return is >= 0 on success and -DK_ERR_* on failure. Never -1.
- All multi-byte byte access goes through format/bytes.mettle. No other module
  may index a uint8* to build or read a u16/u32/u64.
- No Mettle struct overlaid on a page. No 4096-byte page buffer on the stack.
- Little-endian only, decided in exactly one module.
- Imports: explicit relative paths WITH the extension, e.g.
      import "../format/page.mettle";
      import "file_linux.mettle";
- Zero compiler warnings. Read every diagnostic.
- Nothing from PHASE1.md section 9 (out of scope).

TOUCH ONLY THE FILES NAMED IN YOUR BRIEF. Other workers own the rest; the tree
is shared. If a file you need is missing, it belongs to a later stage -- say so
instead of creating a stand-in.

DEFINITION OF DONE
- The build and test commands in your brief exit 0.
- Every feature you finished has a test that can fail, and you have seen it pass.
- Report: files created/changed, exact commands and their output, every
  deviation from PHASE1.md and why, the test names you added, and what the next
  stage must know.
`;

const BRIEF_S0 = `You are the first worker on a relational storage engine written in Mettle.

Your seam: the error codes. Everything else returns them, so they come first.

Files you own (only these):
  error/status.mettle   DK_OK and every DK_ERR_* from PHASE1.md section 2,
                        DkStatus, dk_status_name, dk_status_ok, dk_status_str
  tests/_s0_self.mettle a main() that asserts dk_status_ok and dk_status_name
                        for every code, returning non-zero on failure

Notes:
- The codes and their numeric values are fixed by PHASE1.md section 2. Do not
  add, remove, renumber or reorder them; later stages depend on the values.
- dk_status_name returns a static literal per code ("OK", "IO", "CORRUPT", ...).
  It must never allocate and never return an interpolated string.
- dk_status_str forms "corrupt(4) arg=12" and DOES allocate; document that the
  caller frees s.chars. Keep it separate from dk_status_name for that reason.
- An unknown code is USAGE, named "UNKNOWN{code}" -- and that one allocates too,
  so say so.
- Keep it small. There is no logic here, only a contract.

Build and test:
  ./tools/mettle --build tests/_s0_self.mettle -o build/s0 && ./build/s0
  ./tools/mettle test tests/_s0_self.mettle
  ./tools/check.sh --quick
${RULES}`;

const BRIEF_LANE_A = `You are LANE A, the format worker, on a relational storage engine written in
Mettle. Lane B is working at the same time in a different directory of the same
tree; you must not touch its files.

Your seam: the bytes on the page and in the file format. Offsets, checksums,
variable-length integers, the page header and the meta page.

Files you own (only these):
  format/bytes.mettle   dk_get_u16le/u32le/u64le, dk_put_u16le/u32le/u64le,
                        dk_bytes_zero/copy/equal/compare          (the ONLY endian home)
  format/crc32.mettle   dk_crc32, dk_crc32_update  (CRC-32/ISO-HDLC)
  format/varint.mettle  LEB128: dk_varint_len/put/get, dk_zigzag_enc/dec
  format/page.mettle    every dk_page_* in PHASE1.md section 5.7
  format/meta.mettle    DkMeta, dk_meta_read/check/write/root/set_root
  tests/_a_self.mettle  a main() that exercises all of the above and returns
                        non-zero on the first failure

You may READ error/status.mettle. You must not write it.

Order of work, with a test after each: bytes -> crc32 -> varint -> page -> meta.
Do not move on until the previous piece passes its own test.

Notes:
- Exact offsets matter. Section 3.1 is the header table: write each offset as a
  named constant and use it everywhere.
- CRC-32: implement it BITWISE. No 256-entry table, no module global, no init,
  no lazy flag. dk_crc32("123456789", 9) must be 0xCBF43926 -- assert it.
- dk_page_init zeroes all 4096 bytes, writes the header and seals. For
  DK_PAGE_META use DK_META_BODY (128) as free_start; every other type uses
  DK_PAGE_HDR + 2 * n_cells.
- dk_page_check enforces the nine relationships in section 3.2. It cannot know
  cell lengths, so it checks offset range and ordering only. Say that in a
  comment instead of pretending it validates more.
- dk_page_alloc moves free_end down by n, returns the new free_end, and returns
  -DK_ERR_FULL without changing the page when n exceeds the gap.
- dk_page_free_cell removes the pointer from the dense array (shift down) and
  STRANDS the body: it does not extend the free gap. Say so in the comment.
- dk_page_defrag compacts downward preserving pointer order; idempotent.
- dk_page_seal writes crc32 over [0,12) then [16,4096) -- the four checksum
  bytes are excluded, so sealing twice is stable.
- dk_meta_read returns a zeroed DkMeta with valid=false on bad magic, version or
  page size. It does not fail; dk_meta_check is what fails.
- tests/_a_self.mettle is the LEADING underscore on purpose: the shared gate
  skips it until you are done. Assert exact offsets after allocating 5 cells of
  sizes 1, 7, 2, 33, 64 with known bytes; defrag idempotence; a flipped byte in
  each header field rejected by dk_page_verify; meta round-trip; meta rejected
  on bad magic, bad version, bad page size.

Build and test (your own output dir, never build/):
  ./tools/mettle --build tests/_a_self.mettle -o build/a/self && ./build/a/self
  ./tools/mettle --release --build tests/_a_self.mettle -o build/a/self.rel
  ./tools/mettle test tests/_a_self.mettle
${RULES}`;

const BRIEF_LANE_B = `You are LANE B, the I/O worker, on a relational storage engine written in
Mettle. Lane A is working at the same time in a different directory of the same
tree; you must not touch its files.

Your seam: how bytes reach the operating system, and the scratch allocator.

Files you own (only these):
  platform/file.mettle        DkFile struct and DK_OPEN_* flags only.
                              No functions -- this file is the data contract.
  platform/file_linux.mettle  dk_file_open/close/read_at/write_at/sync/size/
                              truncate/rename over syscall(2/3/17/18/74/77)
  mem/arena.mettle            DkArena, dk_arena_new/alloc/alloc_zeroed/reset/free
  tests/_b_self.mettle        a main() that exercises all of the above and
                              returns non-zero on the first failure

You may READ error/status.mettle. You must not write it.

Order of work, with a test after each: file.mettle (types) -> file_linux ->
arena. Do not move on until the previous piece passes its own test.

Notes:
- Raw syscalls are verified working on this machine: open(2) with
  O_RDWR|O_CREAT|O_TRUNC = 66 and mode 420 (0644), pread64(17), pwrite64(18),
  fsync(74), ftruncate(77), close(3). Write a throwaway probe first if it helps.
- syscall() returns a negative errno on failure. Map it to DK_ERR_IO /
  DK_ERR_NOMEM / DK_ERR_USAGE and let nothing above you ever see an errno.
- dk_file_write_at must write all len bytes or return -DK_ERR_IO. A short write
  means the file system is lying; do not report success.
- dk_file_read_at returns bytes read, 0 at EOF, negative on error. A caller that
  needs len bytes compares; do not loop inside to pad.
- dk_file_close on an already-closed handle is DK_OK.
- Arena: a new chunk when the current one cannot serve n; oversized requests get
  a dedicated chunk; answers 0 on failure; dk_arena_reset keeps the first chunk.
  There is no per-object free and no thread safety -- say both in a comment.
- tests/_b_self.mettle is the LEADING underscore on purpose: the shared gate
  skips it until you are done. Use build/b/ for its data files. Test real I/O:
  write 8192 bytes at offset 0 and 4096 at offset 8192, read back, assert
  content; assert read past EOF returns 0; assert size; assert fsync returns 0;
  assert close-then-close is DK_OK; test arena alloc/zeroed/reset/free and that
  an allocation larger than the chunk still succeeds.

Build and test (your own output dir, never build/):
  mkdir -p build/b
  ./tools/mettle --build tests/_b_self.mettle -o build/b/self && ./build/b/self
  ./tools/mettle --release --build tests/_b_self.mettle -o build/b/self.rel
  ./tools/mettle test tests/_b_self.mettle
${RULES}`;

const BRIEF_PAGER = `You are the pager worker on a relational storage engine written in Mettle.

Both lanes are merged. Your seam: the frame table, the page-number hash, clock
eviction, pin accounting, page allocation, and the flush that makes it durable.
You are the last thing between the engine and the file.

Files you own (only these):
  pager/pager.mettle   every dk_pager_* in PHASE1.md section 5.9
  main.mettle          the smoke entry: create a database, allocate pages, write
                       patterns, flush, close, reopen, read back, and verify
  tests/_c_self.mettle the pager's own tests (open/create/reopen, identity and
                       pin, eviction, alloc-zeroes, boundary errors)

Everything under error/, platform/, format/, mem/ exists. Read it, use it, do
not modify it. If you find a real defect there, report it rather than working
around it silently.

Notes:
- Follow PHASE1.md section 6 exactly, including the 2 * n_frames scan bound. A
  pinned frame is NEVER evicted. Exhaustion is -DK_ERR_BUSY, never a silent
  eviction of somebody's buffer.
- Hash: open addressing, index_cap = next power of two >= 2 * n_frames, slot
  value = frame_index + 1, 0 = empty. Eviction uses backward-shift deletion. No
  tombstones: the table size is fixed, so tombstones would fill it forever.
- get on a miss: pick a victim; if dirty, write it back first (a failed write
  abandons the eviction and returns the error); then read the page and pin it.
  page_no >= page_count is -DK_ERR_RANGE unless the page is already cached.
- alloc: page_no = page_count, page_count++, zero all 4096 bytes, dirty, pin 1.
  Nothing is written until flush. Mark the meta frame dirty so page_count lands.
- flush: dirty pages with page_no > 0 ascending, then page 0 LAST, then
  dk_file_sync, then mark written frames clean. Expose the order through
  dk_pager_flush_plan(p, out, cap) so a test can assert it without a mock.
- Seal a page with dk_page_seal immediately before writing it, never after.
- close flushes, syncs, closes, frees every frame buffer and the arrays, and
  reports the FIRST error without leaking on the error path. A second close is
  DK_OK.
- Two gets of one page number return the SAME DkFrame*. alloc returns a frame
  whose 4096 bytes are all zero even if it previously held another page.
- Keep the reserved journal/lock fields at 0. No locking, no threads, no
  journal. Phase 1 has no atomicity and a dirty write-back is not atomic: put
  that in a comment at the top of the file.

Build and test:
  mkdir -p build/c
  ./tools/mettle --build tests/_c_self.mettle -o build/c/self && ./build/c/self
  ./tools/mettle --release --build tests/_c_self.mettle -o build/c/self.rel
  ./tools/mettle --build main.mettle -o build/dacor && ./build/dacor
  ./tools/mettle test main.mettle
  ./tools/check.sh --quick
${RULES}`;

const BRIEF_INTEG = `You are the integration-test worker on dacor phase 1. Every module is written;
your job is to prove the pieces work together, and to fail loudly and
specifically where they do not.

Files you own (only these):
  tests/tinytest.mettle  dk_t_check(cond, name), dk_t_check_i64(a, b, name),
                         dk_t_check_bytes(a, b, n, name),
                         dk_t_check_false(cond, name), dk_t_report() -> int32
  tests/phase1.mettle    main() running PHASE1.md section 8 tests T1..T7, plus
                         the cross-feature tests below

Nothing else. Do NOT modify the engine to make a test pass. If a test finds a
real bug, report it: a failing test is the correct artifact.

Cross-feature tests (the point of this stage -- each feature alone is already
tested by its owner; here they must hold together):
  X1  format + platform: build a page in memory, seal it, write it at a page
      offset through dk_file_write_at, read it back through dk_file_read_at,
      and assert dk_page_verify passes and every byte matches.
  X2  format + pager: alloc pages, write a meta page through dk_meta_write into
      the page-0 frame, flush, reopen, dk_meta_check passes and the roots and
      page_count survive.
  X3  pager + platform: a 3-page database flushed, closed, reopened read-only;
      the file size is exactly page_count * 4096 and every page verifies.
  X4  all three, crash-shaped: write 8 pages, flush, then flip one byte inside
      page 5 on disk behind the pager's back; a fresh pager must reject page 5
      with -DK_ERR_CORRUPT on get (or on a full read-back pass) and must not
      crash, while pages 1..4 and 6..8 still verify.
  X5  all three, alloc/free-shaped: alloc 64 pages, fill each frame with 0xFF,
      flush, close, reopen, alloc 8 more over the reused frames and assert all
      4096 bytes are zero before touching them.

Notes:
- These are programs, not @test functions: they need real files. Use build/t/.
- Every case must be able to fail: for each, name the bug it catches. Where you
  can, prove it -- temporarily break the engine, watch the test fail, revert,
  and say whether you did that.
- T6 (corruption) and X4 assert the specific DK_ERR_* from PHASE1.md section 7,
  not merely "some error".
- The harness returns non-zero on the first failure and prints which case.

Build and test:
  mkdir -p build/t
  ./tools/mettle --build tests/phase1.mettle -o build/t/phase1 && ./build/t/phase1
  ./tools/mettle --release --build tests/phase1.mettle -o build/t/phase1.rel
  ./build/t/phase1.rel
  ./tools/check.sh
${RULES}`;

const BRIEF_GATE = `You are the phase-1 gate worker. The implementation and the tests exist; your
job is to decide whether phase 1 is actually done, in writing, and to close the
remaining gaps.

Files you own:
  PHASE1-RESULT.md   the gate report (see below)
  any file under error/, platform/, mem/, format/, pager/, tests/, main.mettle
                     -- but only for defects the gate finds, and minimally

Do all of this and record the exact output of each:
  1. ./tools/check.sh            (full: engine, tests, probes)
  2. ./tools/mettle --release --build main.mettle -o build/gate/dacor.rel
     ./build/gate/dacor.rel      (release must agree with debug)
  3. ./tools/mettle test main.mettle      (unit tests, compile-time interpreter)
  4. ./tools/mettle --safe --build tests/phase1.mettle -o build/gate/p1.safe
     then run it and record what happens. PHASE1.md does not require --safe to
     pass, but the gate must say whether it does and why not if it does not.
  5. The corruption matrix from PHASE1.md section 7: confirm each row has a test
     or a recorded manual check, and list any row with no evidence.
  6. Zero-warning check: grep the build logs for 'warning[' and report.

PHASE1-RESULT.md must contain, in this order:
  - GATE: PASS or FAIL, one line.
  - What was built (module -> file -> what it owns), as a table.
  - Evidence: each command and its actual output (trimmed), debug and release.
  - Invariants 1..14 from PHASE1.md section 6b: proven / unproven / needs a test.
  - Boundary table from section 7: test name per row, or "no evidence".
  - Known gaps and the one thing most likely to break in phase 2.
  - What phase 2 needs from phase 1 that does not exist yet.

Do not claim a gate passes on evidence you did not produce in this run.
${RULES}`;

// ----------------------------------------------------------- orchestrator ----
const ORCH_HEAD = `You are the phase-1 ORCHESTRATOR for a relational storage engine written in
Mettle. You are ONE agent watching a sequence of workers; you are resumed after
every stage and after every fix, so keep a running picture in context.

Rules for you:
- You must NOT write or edit any file. Do not create progress.md or context.md.
- You may read anything and run read-only commands, including builds and tests.
- Judge against PHASE1.md, not against your taste. Quote the clause violated.
- Be adversarial about tests that cannot fail: a check that asserts nothing, an
  assertion with the same expression on both sides, a skipped body, a test that
  catches its own failure.
- The repo is a git repository now. 'git -C REPO status --short' and
  'git -C REPO diff --stat' tell you what a stage actually changed.

Every reply has EXACTLY this shape, and the DIRECTIVES are fed verbatim into the
next worker's brief, so make them instructions, not observations:

STATUS: <one line: what you verified and what you found>
VERDICT: PASS   (or FAIL)
DEFECTS:
  1. <file:line> -- <PHASE1.md clause> -- <what is wrong>
  ...
DIRECTIVES:
  - <imperative instruction for the next stage's worker>
  - <...>
NEXT: <what you expect the next stage to produce>

If there are no defects, write 'DEFECTS: none' and still write DIRECTIVES that
keep the next stage pointed at the risk you consider highest.

`;

const ORCH_S0 = `REPO is /home/nox/Projects/mettle/dacor.

STAGE 0 (error/status.mettle) is complete. Verify it:
1. cd REPO && ./tools/mettle --build tests/_s0_self.mettle -o build/s0 && ./build/s0
2. ./tools/mettle test tests/_s0_self.mettle
3. ./tools/check.sh --quick
4. Read error/status.mettle. Check every code and value against PHASE1.md
   section 2 exactly; dk_status_name must not allocate; dk_status_str must
   document that the caller frees the result.
Then reply in the required shape.`;

const ORCH_S1 = `Two lanes worked concurrently and their files are disjoint by construction.
LANE A: format/bytes.mettle, format/crc32.mettle, format/varint.mettle,
        format/page.mettle, format/meta.mettle, tests/_a_self.mettle
LANE B: platform/file.mettle, platform/file_linux.mettle, mem/arena.mettle,
        tests/_b_self.mettle

Verify BOTH lanes, independently, and say which lane owns each defect:
1. cd REPO && ./tools/mettle --build tests/_a_self.mettle -o build/a/self && ./build/a/self
2. ./tools/mettle --build tests/_b_self.mettle -o build/b/self && ./build/b/self
3. ./tools/mettle test tests/_a_self.mettle ; ./tools/mettle test tests/_b_self.mettle
4. ./tools/mettle --release --build tests/_a_self.mettle -o build/a/self.rel
   ./tools/mettle --release --build tests/_b_self.mettle -o build/b/self.rel
5. Read every file in both lanes. Check against PHASE1.md sections 3, 4, 5.3-5.8:
   exact header offsets; free_start == 16 + 2*n_cells and DK_META_BODY for meta;
   all nine dk_page_check relationships; -DK_ERR_FULL leaves the page unchanged;
   free_cell strands the body; defrag idempotent and order-preserving; seal
   excludes the four checksum bytes; meta_read never fails; no errno escapes;
   write_at cannot succeed on a short write; the arena has no per-object free.
6. Flag any @test whose expected values are computed with the same helper under
   test -- that is a tautology, not a test.
7. 'git -C REPO status --short' -- does the diff touch only the files above?
Then reply in the required shape.`;

const ORCH_S2 = `STAGE 2 (pager) is complete: pager/pager.mettle, main.mettle,
tests/_c_self.mettle.

Verify:
1. cd REPO && ./tools/mettle --build tests/_c_self.mettle -o build/c/self && ./build/c/self
2. ./tools/mettle --build main.mettle -o build/dacor && ./build/dacor
3. ./tools/mettle test main.mettle
4. ./tools/check.sh --quick
5. Read pager/pager.mettle against PHASE1.md sections 5.9, 6, 6b, 7:
   clock bounded by 2*n_frames; pinned never evicted; exhaustion is -DK_ERR_BUSY;
   index_cap is a power of two >= 2*n_frames; backward-shift deletion and no
   tombstones; get returns the same DkFrame* and does not re-read a cached page;
   alloc zeroes all 4096 bytes and increments page_count exactly once;
   -DK_ERR_NOSPC at DK_MAX_PAGES without incrementing; flush_plan ascending then
   page 0 last; one sync after the writes; dirty_count == 0 after flush; seal
   before write; every row of the section 7 table returns its exact code; no
   "repair" of a size/page_count mismatch; close does not leak on an error path;
   second close is DK_OK; journal/lock fields are 0.
6. 'git -C REPO status --short' -- confirm nothing outside stage 2 changed.
Then reply in the required shape.`;

const ORCH_S3 = `STAGE 3 (integration tests) is complete: tests/tinytest.mettle,
tests/phase1.mettle.

Verify:
1. cd REPO && ./tools/mettle --build tests/phase1.mettle -o build/t/phase1 && ./build/t/phase1
2. ./tools/mettle --release --build tests/phase1.mettle -o build/t/phase1.rel
   ./build/t/phase1.rel
3. ./tools/check.sh
4. Read tests/phase1.mettle. For T1..T7 and X1..X5: does each assert what its
   paragraph says, with the exact offsets and exact DK_ERR_* codes? Name the bug
   each case would catch. Flag every tautology, every assertion with the same
   expression on both sides, every setup that makes a check vacuous, and any
   case that cannot fail.
5. Specifically: T5 must check all 4096 bytes of a REUSED frame, not a prefix.
   T4 must hold enough pages pinned to force exhaustion. T6 and X4 must cover
   every row they name and assert specific codes. X4 must show pages 1..4 and
   6..8 still verify after page 5 is corrupted.
6. Is anything in the engine only "tested" by a test that also uses the same
   path to produce its expectation? Say which.
Then reply in the required shape.`;

const ORCH_S4 = `STAGE 4 (gate) is complete: PHASE1-RESULT.md plus any minimal fixes.

Verify the gate itself, do not take it on trust:
1. cd REPO && ./tools/check.sh            (full run, capture output)
2. ./tools/mettle --release --build main.mettle -o build/gate/dacor.rel && ./build/gate/dacor.rel
3. ./tools/mettle test main.mettle
4. ./tools/mettle --safe --build tests/phase1.mettle -o build/gate/p1.safe ; ./build/gate/p1.safe
5. Read PHASE1-RESULT.md. For each of the 14 invariants and each row of the
   section 7 boundary table, confirm the evidence it cites exists and says what
   is claimed. Flag any claim with no evidence produced in this run.
6. 'git -C REPO status --short' and 'git -C REPO diff --stat'.
Then reply in the required shape, and make the LAST directive the single thing
phase 2 must do first.`;

const ORCH_FIX = (stage) => `A fix pass just ran for ${stage}. Re-verify the same checks you ran for that
stage, and confirm the fix did not break anything it did not touch (rerun the
other lanes' self tests and the full ./tools/check.sh). Then reply in the
required shape. If the same defect is still present after this second pass, say
so plainly in STATUS and make it the first DIRECTIVE with a concrete change.`;

const FIX = (directives) => `You are the fix worker for dacor phase 1.

The orchestrator reviewed the last stage and issued these directives. Apply them
minimally, inside the existing design. You may edit any file under the repo
except PHASE1.md -- if a contract clause itself is wrong, stop and report that
instead of editing it.

Fix causes, not symptoms. Do not weaken a test to make it pass: if a test is
wrong, say why and fix the test; if an assertion is what is wrong, say that.
Touch only files relevant to the directives; other stages' files are reviewed
and must not drift.

Then run:
  ./tools/check.sh
  ./tools/mettle test main.mettle
and report the output plus a one-line note per directive and how it was closed.

ORCHESTRATOR OUTPUT FOLLOWS.

${directives}
`;

// ------------------------------------------------------------------ flow ----
const s0 = await runs.run("s0", {
  label: "Write status codes",
  agent: "worker",
  model: MODEL,
  cwd: CWD,
  task: BRIEF_S0,
});

let orch = await runs.run("orch-0", {
  label: "Orchestrator: verify stage 0",
  agent: "scout",
  model: MODEL,
  cwd: CWD,
  output: false,
  task: ORCH_HEAD + ORCH_S0,
});

let d0 = orch.output;

// --------------------------------------------------- stage 1: two lanes -----
const lanes = await runs.all([
  {
    key: "laneA",
    label: "Lane A: page format and encodings",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: BRIEF_LANE_A + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d0,
  },
  {
    key: "laneB",
    label: "Lane B: file I/O and arena",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: BRIEF_LANE_B + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d0,
  },
]);

let m1 = await runs.run("orch-1", { resume: orch.runId, task: ORCH_S1 });
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

// -------------------------------------------------------- stage 2: pager -----
const s2 = await runs.run("s2", {
  label: "Write the pager",
  agent: "worker",
  model: MODEL,
  cwd: CWD,
  task: BRIEF_PAGER + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d1,
});

let m2 = await runs.run("orch-2", { resume: m1.runId, task: ORCH_S2 });
let d2 = m2.output;

if (d2.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-2", {
    label: "Fix pager defects",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: FIX(d2),
  });
  m2 = await runs.run("orch-2b", { resume: m2.runId, task: ORCH_FIX("stage 2, the pager") });
  d2 = m2.output;
}

// ------------------------------------------------- stage 3: integration -----
const s3 = await runs.run("s3", {
  label: "Write integration tests",
  agent: "worker",
  model: MODEL,
  cwd: CWD,
  task: BRIEF_INTEG + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d2,
});

let m3 = await runs.run("orch-3", { resume: m2.runId, task: ORCH_S3 });
let d3 = m3.output;

if (d3.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-3", {
    label: "Close test gaps",
    agent: "worker",
    model: MODEL,
    cwd: CWD,
    task: FIX(d3),
  });
  m3 = await runs.run("orch-3b", { resume: m3.runId, task: ORCH_FIX("stage 3, the integration tests") });
  d3 = m3.output;
}

// -------------------------------------------------------- stage 4: gate -----
const s4 = await runs.run("s4", {
  label: "Run the phase-1 gate",
  agent: "worker",
  model: MODEL,
  cwd: CWD,
  task: BRIEF_GATE + "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n" + d3,
});

const m4 = await runs.run("orch-4", { resume: m3.runId, task: ORCH_S4 });

return {
  stage0: d0.slice(-1500),
  stage1: d1.slice(-2500),
  stage2: d2.slice(-2500),
  stage3: d3.slice(-2500),
  gate: m4.output.slice(-3000),
};
