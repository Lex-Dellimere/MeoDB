// dacor phase 3 — one write chokepoint, then the rollback journal, then the
// gate. The order is the contract (PHASE3.md): a journal that covers two of
// three writers covers nothing.
//
// Launch: subagent({ workflow: "./tools/phase3.workflow.js" })

const CWD = "/home/nox/Projects/mettle/dacor";
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";

const RULES = `
REPO: /home/nox/Projects/mettle/dacor -- the ONLY place you may write.
mbuild project: mbuild.toml, engine under src/, test programs under tests/, one
[bin.*] per program (the bin you need already exists). Mettle, head compiler at
/home/nox/Projects/mettle/raize/mettle-build/bin/mettle.

READ FIRST, in full: PHASE3.md (normative), PHASE2.md and PHASE1.md for what it
inherits, notes/03-gotchas.md (section 7 is the incident log) and
notes/04-build.md section 6b (mutation-testing discipline).

HARD RULES
- Export only what the contract names, prefixed dk_/Dk/DK_. One flat namespace.
- int32 returns: >= 0 success, -DK_ERR_* failure. Actions answer DK_OK.
- Multi-byte byte access only through format/bytes.mettle.
- No struct overlaid on a page. No 4096-byte page buffer on a stack.
- Imports: explicit relative paths WITH the extension. No circular imports -- a
  cycle is warning[E0006] and the gate now FAILS on any warning.
- Zero compiler warnings. ./tools/check.sh must stay GATE PASS.
- mbuild.toml is off limits unless your brief says otherwise.
- Never return a struct literal directly (ICE).
- Mutant sources and binaries go to /tmp/<stage>mut/, NEVER inside the repo: a
  stale .orig of a live module inside build/ is a trap someone restores by
  reflex. Bound every mutant with 'timeout 15' and restore after each.
- A test 'skipped' did not run: treat it as a failure.

TOUCH ONLY THE FILES NAMED IN YOUR BRIEF.
`;

const BRIEF_3A = `You are the write-chokepoint worker.

Files you own:
  src/pager/pager.mettle    add the chokepoint, route all three writers through it
  tests/j_self.mettle       replaces the PENDING stub (or add to tests/c_self.mettle
                            if the bin does not exist -- report which you chose)

PHASE3.md 3A is exact: one private function dk_pager_write_page(p, page_no, page)
that seals, will later append a before-image when p->journal != 0, and writes
exactly DK_PAGE_SIZE bytes at page_no * DK_PAGE_SIZE all-or-error. Three call
sites today (eviction write-back around :340, and the two in flush around
:407/:415) collapse into it. Sealing moves in there, so nothing else can write an
unsealed page.

Acceptance, in the same commit:
- grep -c dk_file_write_at src/pager/pager.mettle is exactly 1.
- A counter (dk_pager_write_count(p)) proves an eviction write-back and a flush
  both pass through the chokepoint; a test asserts the counter grows for each.
- Every existing suite still passes in debug, --release and --safe.

This is a refactor: the observable behaviour must not change. If it does, that is
a bug in the refactor, not an improvement.
${RULES}`;

const BRIEF_3B = `You are the journal worker. 3A is merged: every page write now goes through one
function.

Files you own:
  src/pager/journal.mettle  the journal FILE FORMAT and record append/read, over
                            raw bytes (it must NOT import pager.mettle -- same
                            layering rule the freelist needed in phase 2)
  src/pager/pager.mettle    begin/commit/rollback, the before-image hook in
                            dk_pager_write_page, recovery at open
  tests/journal_self.mettle replaces the PENDING stub
  tests/c_self.mettle       only assertions that assumed no journal

PHASE3.md 3B has the header layout, the 4100-byte record, and the fsync ordering.
Follow it exactly: header fsync before any data-page write, before-image appended
and fsynced before the page it protects is written, journal removed last on
commit, replay idempotent and before anything else at open, checksum checked
before any replay, capacity derived from the constants (not guessed) and NOSPC
rather than a dropped before-image.

J2..J7 in PHASE3.md 3C are required. J4 (crash: begin, overwrite, exit without
commit, reopen -> old content) is the case that matters. For J4 the child process
must really die without running atexit paths; fork is not available in this
runtime, so use a small second bin that calls _exit via syscall(60) and have the
parent run it -- or say plainly why you used a different mechanism.

Build loop (the orchestrator runs mbuild between stages):
  ./tools/mettle --build tests/journal_self.mettle -o build/laneJ/j && ./build/laneJ/j
  ./tools/mettle --build tests/c_self.mettle -o build/laneJ/c && ./build/laneJ/c
  ./tools/mettle --release --build tests/journal_self.mettle -o build/laneJ/j.rel
${RULES}`;

const BRIEF_GATE = `You are the phase-3 gate worker. Everything is merged.

Files you own:
  tests/phase3.mettle   a new integration program; add [bin.phase3] to mbuild.toml
  PHASE3-RESULT.md      the gate report
  any file, minimally, for a defect the gate finds

The integration program must prove the seams:
  K1  a 1000-key b-tree transaction: begin, insert 500 more keys, commit, reopen,
      walk all 1500 ascending.
  K2  the same, rolled back: begin, insert 500, rollback, reopen, walk 1000 --
      and page_count is the pre-transaction value.
  K3  the same, crashed: begin, insert 500, exit without commit, reopen, walk
      1000 and page_count unchanged.
  K4  a crash during a b-tree split (kill mid-transaction after the new sibling
      page was allocated and the parent was updated): reopen, walk, and the tree
      must be the pre-transaction one, with the freelist not double-counting the
      sibling.
  K5  journal capacity: a transaction touching more than DK_JRN_MAX_RECORDS
      distinct pages answers NOSPC and leaves the db unchanged after reopen.

Then record, for real:
  ./tools/check.sh
  ./tools/mettle test src/main.mettle
  debug, --release and --safe runs of tests/phase3.mettle

PHASE3-RESULT.md: GATE line; what was built; evidence per command; J1..J7 and
K1..K5 each marked proven/unproven with the test that proves it; the known gaps
stated (no WAL, no checkpoint, single-process, no catalog crash-consistency);
and what phase 4 needs that does not exist. Do not claim evidence you did not
produce in this run.
${RULES}`;

const ORCH_HEAD = `You are the phase-3 ORCHESTRATOR for a relational storage engine written in
Mettle. ONE agent, resumed after every stage and every fix; keep your running
picture in context.

- You must NOT write or edit any file. Do not create progress.md or context.md.
- You may read anything and run commands, including mbuild.
- Judge against PHASE3.md, then PHASE2.md/PHASE1.md. Quote the clause violated.
- Be adversarial about tests that cannot fail, and about evidence that is not the
  command it claims to be.
- 'git status --short' and 'git diff --stat' show what a stage changed and whether
  it touched a file it did not own.
- Run mbuild only between stages, when no worker is live.

Reply in EXACTLY this shape; DIRECTIVES are fed verbatim to the next worker.

STATUS: <what you verified and found>
VERDICT: PASS   (or FAIL)
DEFECTS:
  1. <file:line> -- <clause> -- <what is wrong>
DIRECTIVES:
  - <imperative instruction for the next stage>
NEXT: <what the next stage must produce>
`;

const ORCH_1 = `STAGE 3A (write chokepoint) is done.

1. cd REPO && ./tools/check.sh
2. grep -c dk_file_write_at src/pager/pager.mettle   -- must be exactly 1
3. ./tools/mettle --build tests/c_self.mettle -o build/orch/c && ./build/orch/c
4. Read the refactor: does dk_pager_write_page seal the page before writing? Are
   all three former sites routed through it? Did observable behaviour change
   anywhere (that would be a refactor bug)?
5. Does a test prove the chokepoint is not bypassable, and does it fail if a
   writer is re-added beside it? Say which.
Then reply in the required shape.`;

const ORCH_2 = `STAGE 3B (journal + recovery) is done.

1. cd REPO && ./tools/check.sh
2. ./tools/mettle --build tests/journal_self.mettle -o build/orch/j && ./build/orch/j
3. ./tools/mettle --build tests/c_self.mettle -o build/orch/c && ./build/orch/c
4. Check PHASE3.md 3B clause by clause: header layout and offsets; 4100-byte
   record; header fsync before any data-page write; before-image appended and
   fsynced before the page it protects; journal removed LAST on commit; replay
   idempotent and before anything else at open; checksum validated before any
   replay; capacity derived, NOSPC not a dropped before-image; no circular
   import between journal.mettle and pager.mettle.
5. Is J4 real? Did a process actually die without committing, and did the reopen
   produce the pre-transaction database? Quote the mechanism it used.
6. Is replay genuinely idempotent -- is there a test that runs it twice?
Then reply in the required shape.`;

const ORCH_3 = `STAGE 3 (integration + gate) is done.

Verify the gate, do not take it on trust:
1. cd REPO && ./tools/check.sh
2. ./tools/mettle --build tests/phase3.mettle -o build/orch/p3 && ./build/orch/p3
   and again under --release and --safe.
3. Read PHASE3-RESULT.md. For J1..J7 and K1..K5, confirm the cited evidence exists
   and says what is claimed. Flag any claim with no evidence from this run.
   K4 (crash during a b-tree split) is the case that justifies 3A+3B together --
   verify it really kills mid-transaction after the sibling page was allocated.
4. 'git status --short' -- is the tree clean of stray artifacts, especially any
   .orig or .mut inside the repo?
Then reply in the required shape, and make the LAST directive the single thing
phase 4 (the catalog as a table) must do first.`;

const ORCH_FIX = (stage) => `A fix pass just ran for ${stage}. Re-run that stage's checks plus
./tools/check.sh, confirm nothing it did not touch broke, and reply in the
required shape. If the same defect is still present, say so plainly and make it
the first DIRECTIVE with a concrete change.`;

const FIX = (d) => `You are the fix worker for dacor phase 3.

Apply the orchestrator's directives below, minimally, inside the existing design.
You may edit any file under the repo except PHASE1.md, PHASE2.md and PHASE3.md --
if a contract clause itself is wrong, stop and report it instead.

Fix causes, not symptoms. Never weaken a test to make it pass. Touch only files
relevant to the directives. Then run ./tools/check.sh and report its output plus
one line per directive.

ORCHESTRATOR OUTPUT FOLLOWS.

${d}
`;

const NOTE = "\n\nORCHESTRATOR DIRECTIVES FROM THE PREVIOUS STAGE:\n";

await runs.run("s3a", { label: "Write the chokepoint", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_3A });

let m = await runs.run("orch-1", {
  label: "Orchestrator: verify the chokepoint",
  agent: "scout",
  model: MODEL,
  cwd: CWD,
  output: false,
  task: ORCH_HEAD + ORCH_1,
});
let d = m.output;

if (d.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-1", { label: "Fix chokepoint defects", agent: "worker", model: MODEL, cwd: CWD, task: FIX(d) });
  m = await runs.run("orch-1b", { resume: m.runId, task: ORCH_FIX("stage 3A, the write chokepoint") });
  d = m.output;
}

await runs.run("s3b", { label: "Write the journal and recovery", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_3B + NOTE + d });

let m2 = await runs.run("orch-2", { resume: m.runId, task: ORCH_2 });
let d2 = m2.output;

if (d2.indexOf("VERDICT: PASS") === -1) {
  await runs.run("fix-2", { label: "Fix journal defects", agent: "worker", model: MODEL, cwd: CWD, task: FIX(d2) });
  m2 = await runs.run("orch-2b", { resume: m2.runId, task: ORCH_FIX("stage 3B, the journal") });
  d2 = m2.output;
}

await runs.run("s3", { label: "Integration and phase-3 gate", agent: "worker", model: MODEL, cwd: CWD, task: BRIEF_GATE + NOTE + d2 });

const m3 = await runs.run("orch-3", { resume: m2.runId, task: ORCH_3 });

return {
  chokepoint: d.slice(-1500),
  journal: d2.slice(-2000),
  gate: m3.output.slice(-3000),
};
