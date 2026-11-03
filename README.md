# MeoSQL

A relational database written in Mettle, and the storage backend for
[flux_orm](../flux_orm).

## Goals

- **Distributed**: data spread across, and replicated between, several nodes.
- **Concurrent**: many readers and writers at once.
- **Fault tolerant**: no committed data lost or corrupted by a crash, a torn
  write or a failed node.
- **Real-time access**: low-latency reads and writes, and changes visible to
  clients as they happen.
- **flux_orm**: the API flux_orm's adapter is written against.

## Status

The single-node storage layer is built, and real-time access has started: an
in-process change feed reports committed b-tree writes (see
[Change feed](#change-feed)). Distribution, concurrency (beyond one writer and
concurrent feed readers), remote real-time access and the SQL layer are not
built yet.

| Done | Module |
|---|---|
| Page format, CRC checksums, page-0 metadata | `src/format/` |
| Page cache with eviction and pinning | `src/pager/pager.mettle` |
| On-disk freelist | `src/pager/freelist.mettle` |
| Rollback journal and crash recovery | `src/pager/journal.mettle` |
| Order-preserving key encoding | `src/types/key.mettle` |
| B+ tree for tables and indexes (no delete or rebalance yet) | `src/btree/` |
| Persisted commit counter (`commit_seq`) and pager commit hook | `src/format/meta.mettle`, `src/pager/pager.mettle` |
| In-process committed-change feed | `src/feed/feed.mettle` |

Still missing from phase 3: `tests/phase3.mettle`, an end-to-end test of
commit, rollback and crash recovery through the b-tree.

## Change feed

`src/feed/feed.mettle` tells a consumer (MistPlot's live charts, for one)
**what** changed and **when**, and only ever reports changes whose transaction
committed. It does not carry values: MeoSQL maps a key to a `uint64` rowid and
has no row payloads yet, so a consumer re-queries on change. `MeoChange` is laid
out so a payload field can be appended later without breaking callers.

```
var f: MeoFeed* = meo_feed_new(4096);          // ring of 4096 committed events
meo_feed_attach(p, f);                         // p: MeoPager*, no txn open
meo_pager_begin(p);
meo_feed_insert(f, p, table_id, &root, &meo_key_compare, key, rowid);
meo_pager_commit(p);                           // events published here

var cur: MeoFeedCursor;                        // zeroed: from the start
meo_feed_cursor_end(f, &cur);                  // or: only what comes next
var n: int32 = meo_feed_read(f, &cur, out, 64, keybuf, MEO_FEED_MAX_KEY);
```

What an event reports: a global event `seq` (1, 2, 3..., never reused in the
process), the `commit_seq` of its commit, the commit time `time_us`
(CLOCK_REALTIME microseconds, clamped to never go backwards), the caller's
`table_id`, a `kind`, the key bytes, the `rowid` and `old_rowid`. Kinds:
`MEO_CHANGE_INSERT` (new key), `MEO_CHANGE_REPLACE` (existing key, `old_rowid`
set), `MEO_CHANGE_ROOT_MOVED` (the tree's root page changed: `rowid` is the new
root, `old_rowid` the old one) and `MEO_CHANGE_GAP` (events were lost: reload
fully, then continue). `meo_feed_read` copies key bytes into the caller's
buffer, so `out[i].key` lives as long as that buffer.

Semantics:

- **Commit.** Events captured by `meo_feed_insert` wait in a pending buffer.
  They are published together, in capture order, after the commit is durable
  (the journal is gone), all with the same `commit_seq` and `time_us`. Only
  writes made through `meo_feed_insert` are captured; any commit still advances
  `meo_feed_last_commit`.
- **Rollback.** An explicit rollback, a close with a transaction open and a free
  with a transaction open all discard the pending events: nothing is published.
- **Crash.** A transaction interrupted before its journal is removed is undone
  by recovery at the next open and was never published. Recovery calls nothing:
  there is no hook before open returns, and a feed is in-process, so the new
  process starts with an empty feed.
- **Gaps.** A reader that falls behind the ring gets exactly one GAP and its
  cursor jumps to the oldest retained event. A transaction that captures more
  than the pending cap (`MEO_FEED_PENDING_MAX`, adjustable down with
  `meo_feed_set_pending_max`) or more than the ring holds is published as one
  GAP instead of partial data, and so is the first commit after anything the
  feed could not see (attaching with unflushed changes, a detach, a rollback
  that failed).
- **Autocommit.** A successful `meo_pager_flush` (or the flush inside
  `meo_pager_close`) with no transaction open and with changes made since the
  last flush also counts as a commit: it bumps `commit_seq` and publishes. It is
  not atomic: it is the plain in-place write, so a crash can leave any mix.
- **Threads.** One writer thread per pager: the pager is not thread-safe, and
  `meo_feed_insert` and the commit hook run on that thread. Readers
  (`meo_feed_read`, `meo_feed_pending_for`, `meo_feed_last_commit`,
  `meo_feed_cursor_end`) may run on any thread at the same time; they take the
  feed's spin lock only for the copy.

**Other processes.** Page 0 holds a persisted `commit_seq` (offset 56, carved
from the reserved area, so older files read 0 and the format version is
unchanged). It goes up by exactly one per successful commit and is written
inside the transaction, so a rollback or crash reverts it.
`meo_pager_commit_seq(p)` reads it from an open pager;
`meo_peek_commit_seq(path, &seq)` reads it straight from disk with no pager,
validating page 0 like an open does. It answers `MEO_OK`, or `1` when a journal
sits beside the database (a transaction is open, committing or died hot, so the
value may not be committed yet: poll again). A page 0 caught mid-write is
`-MEO_ERR_BUSY` while a journal exists; without one (an autocommit flush) it can
be a transient `-MEO_ERR_CORRUPT`, so retry before believing it.

Limits: values are not included until rows have payloads; `table_id` is assigned
by the caller until a catalog exists, and must stay the same when the root moves
(the root page number is not an identity); capture covers `meo_feed_insert`
only, since the b-tree has no delete yet.

## Naming

Exported names use one flat namespace: `meo_` for functions, `Meo` for types,
`MEO_` for constants. Database files start with the magic bytes `MEOP`, and
journals with `MEOJ`.

## Build

MeoSQL needs the head Mettle compiler; the v0.17.0 release has no `syscall()`.

```
export MBUILD_METTLE_LINUX=/home/nox/Projects/mettle/Mettle/bin/mettle
MB=/home/nox/Projects/mettle/mbuild/build/linux/release/mbuild
$MB check && $MB test && $MB build -r
$MB run meosql        # smoke test of the whole stack
$MB run phase2 -r     # one test program, release build
```

Every `[bin.*]` in `mbuild.toml` is a test program, and each should print
`PASS` in both debug and release with zero compiler warnings.
