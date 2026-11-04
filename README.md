# MeoDB

A database written in Mettle. Apps use it through
[flux_orm](https://github.com/Lex-Dellimere/FluxORM), which talks to the `meodb`
server over TCP, the way an Elixir app uses PostgreSQL through Ecto. The
embedded `meo_*` API below is the engine the server is built on; use it
directly only for a database file that one program owns.

## Goals

- **Distributed**: data spread across, and replicated between, several nodes.
- **Concurrent**: many readers and writers at once.
- **Fault tolerant**: no committed data lost or corrupted by a crash, a torn
  write or a failed node.
- **Real-time access**: low-latency reads and writes, and changes visible to
  clients as they happen.
- **flux_orm**: the API flux_orm's adapter is written against.

## Status

MeoDB has no SQL language. Programs call a typed query API (`meo_q_*`): a
query is built with function calls and run with `meo_q_step`.

Built: the single-node engine. Tables with INTEGER, REAL, TEXT and BLOB
columns, PRIMARY KEY, NOT NULL and UNIQUE; rows up to 16 MiB; insert, select
(filters, IN, NULL tests, ranges, ORDER BY, LIMIT/OFFSET), update, delete and
count; unique and non-unique indexes, also created on existing tables; range
scans on the rowid or an index; transactions with crash recovery in two journal
modes (see [Journal modes](#journal-modes)); one writer at a time, and in WAL
mode readers that never wait for it. An in-process change feed reports
committed writes (see [Change feed](#change-feed)).

The `meodb` server serves one database over TCP for flux_orm and other
clients (see [Server](#server)). Not built yet: joins, composite indexes,
distribution and replication.

| Module | What it does |
|---|---|
| `src/format/`, `src/pager/` | Pages with CRC checksums, page cache, freelist, rollback journal |
| `src/btree/`, `src/types/key.mettle` | B+ tree with delete, order-preserving keys |
| `src/record/` | Row values and the record format |
| `src/catalog/`, `src/table/` | Table schemas stored in the file, rows and indexes |
| `src/db/`, `src/conc/` | Database handle, transactions, the thread lock |
| `src/query/` | The typed query API |
| `src/feed/feed.mettle` | In-process committed-change feed |

`src/meo_core.mettle` imports the engine without the query layer;
`src/meodb.mettle` imports everything.

## Using MeoDB

The normal path is flux_orm against a running `meodb` server (see
[Server](#server)). The rest of this section is the embedded engine API.

Import `src/meodb.mettle`. Every call returns `MEO_OK` (0), `MEO_ROW` /
`MEO_DONE` from a step, or a negative `-MEO_ERR_*` code; checks are left out
here.

```
var db: MeoDb* = 0;
meo_db_open(path, MEO_OPEN_CREATE | MEO_OPEN_READ | MEO_OPEN_WRITE, 0, &db);
var q: MeoQuery* = 0;
meo_q_create(db, "users", &q);
meo_q_column_def(q, "id", MEO_T_INT, MEO_COL_PK);   // INTEGER PRIMARY KEY: the rowid
meo_q_column_def(q, "name", MEO_T_TEXT, MEO_COL_NOT_NULL);
meo_q_step(q);                                     // MEO_DONE
meo_q_free(q);
var ann: string = "ann";
var bob: string = "bob";
var v: MeoValue;
var ins: MeoQuery* = 0;
meo_q_insert(db, "users", &ins);
meo_q_into(ins, "name");                           // id left out: 1, 2, ...
meo_value_set_text(&v, ann.chars, 3);
meo_q_value(ins, &v);                              // values are copied
meo_value_set_text(&v, bob.chars, 3);
meo_q_value(ins, &v);                              // a second row
meo_q_step(ins);
meo_q_free(ins);
var sel: MeoQuery* = 0;
meo_q_select(db, "users", &sel);
meo_q_pick(sel, "id");
meo_q_pick(sel, "name");
meo_value_set_int(&v, 1);
meo_q_where(sel, "id", MEO_Q_GT, &v);
while (meo_q_step(sel) == MEO_ROW) {
  var name: string = str_from_cstr((cstring)meo_q_column_text(sel, 1));
  println("{meo_q_column_int64(sel, 0)} {name}");    // 2 bob
}
meo_q_free(sel);
meo_db_close(db);
```

Values are passed in a `MeoValue`; each value a builder takes gets the next
slot, so a query can be run again with `meo_q_reset` and `meo_q_set_value`.
Write queries report `meo_q_changes` and `meo_q_last_insert_rowid`. Explicit
transactions use `meo_db_begin`, `meo_db_commit` and `meo_db_rollback`.

## Journal modes

A database is in one of two modes, stored in page 0:

- **WAL** (`MEO_OPEN_WAL`, the server's default). Commits append page frames to
  `<db>-wal`. Readers (SELECT, COUNT, `meo_q_scan_xy`) read a snapshot of the
  last durable commit and never take the writer's lock. Concurrent commits
  share one fsync (group commit). Committed frames are copied back into the
  database file by a checkpoint, automatically every 1000 frames
  (`meo_db_wal_autocheckpoint`) or on demand (`meo_db_checkpoint`), and the log
  restarts from the beginning once nothing needs it. Closing the database
  checkpoints and removes the log.
- **Rollback** (`MEO_OPEN_NO_WAL`, the embedded default for new files). Each
  transaction saves the original pages in `<db>-journal`; readers share the
  database-wide lock with the writer.

Opening without either flag keeps the file's mode; either flag converts it. A
failed fsync in WAL mode stops writes until the database is reopened; readers
keep their last snapshot.

## Server

```
build/linux/release/meodb --db data.meo              # 127.0.0.1:5490
build/linux/release/meodb --db data.meo --port 0     # any free port
build/linux/release/meodb --db data.meo --listen 0.0.0.0:5490 --token-file token
```

`--journal wal|rollback` picks the mode (default `wal`). It prints the port it bound, serves until SIGINT or SIGTERM, and rolls back
any open transaction when a client disconnects, goes idle, or the server stops.
A non-loopback address needs a token. `--help` lists the limits and timeouts.
The wire format is in [docs/PROTOCOL.md](docs/PROTOCOL.md); `src/client/` is a
client library for Mettle programs.

## Change feed

`src/feed/feed.mettle` tells a consumer (MistPlot's live charts, for one)
**what** changed and **when**, and only ever reports changes whose transaction
committed. It does not carry values: MeoDB maps a key to a `uint64` rowid and
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
validating page 0 like an open does, and in WAL mode reading the newest commit
in the log. It takes no file lock. It answers `MEO_OK`, `MEO_PEEK_HOT` (1) when
a journal sits beside the database (the value may not be committed yet: poll
again), or `MEO_PEEK_TRANSIENT` (2) when page 0 was caught mid-write (retry).
A negative answer means real damage. In WAL mode the feed publishes a commit
only once it is durable, in commit order.

Limits: table writes carry the row as a value, but an event whose key and row
exceed `MEO_FEED_MAX_KEY` (4096 bytes) is published as a GAP; catalog changes
are not reported.

## Naming

Exported names use one flat namespace: `meo_` for functions, `Meo` for types,
`MEO_` for constants. Database files start with the magic bytes `MEOP`, and
journals with `MEOJ`.

## Build

MeoDB needs the head Mettle compiler (the v0.17.0 release has no `syscall()`)
and mbuild 0.2 or later, which reads `mbuild.mettle`.

```
export MBUILD_METTLE_LINUX=/home/nox/Projects/mettle/Mettle/bin/mettle
MB=mbuild
$MB check && $MB test && $MB build -r
$MB run smoke         # the whole storage stack in one run
$MB run phase2 -r     # one test program, release build
```

Apart from `meodb` and `smoke`, every `mb_bin` in `mbuild.mettle` is a test
program, and each should print `PASS` in both debug and release with zero
compiler warnings.

## License

Apache License 2.0. See [LICENSE](LICENSE).
