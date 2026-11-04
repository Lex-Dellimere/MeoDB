# MeoSQL roadmap

Milestones in build order. A milestone is done when every exit criterion is checked by a `[bin.*]` test that passes in debug and release with zero warnings. Layer numbers refer to `docs/ARCHITECTURE.md`.

## M0 — Storage (done)
Pager, freelist, page format, key encoding, B+ tree insert/seek/next, rollback journal.
- [x] 12 bins green debug + release, 0 warnings (commit 65b533f).

## M1 — Phase-3 gate (done)
The b-tree is proven on top of the journal before SQL depends on it.
- [x] `phase3` bin: K1 commit is durable after reopen; K2 rollback restores the exact pre-txn key set and page_count; K3 a forked child dies after the journal fsync, and reopen shows the pre-txn tree; K4 the same crash after a root split, and the tree passes `meo_btn_check` with pre-txn keys; K5 a small journal cap gives `-MEO_ERR_NOSPC`, then rollback leaves the tree intact.

## M2 — Embedded relational core + SQL v1
Layers 3, 4a, 5. Consumer: flux_orm.
- [ ] B-tree delete; a 20k-op random insert/delete/seek/next run matches a sorted-array oracle at n_frames=8.
- [ ] CREATE TABLE IF NOT EXISTS, INSERT (multi-row), SELECT with WHERE `=`/`IN`/`IS [NOT] NULL`/`AND`, ORDER BY, LIMIT, OFFSET, UPDATE, DELETE. Data survives close/reopen (AC S3, S5).
- [ ] NULL, int64 min/max, float64 (-0.0, NaN bits), text, blob round-trip exactly (S6).
- [ ] Nested begin and commit/rollback with no txn give `-MEO_ERR_TX`. A crash mid-transaction shows pre-txn data after reopen (S7).
- [ ] Duplicate PK/UNIQUE gives `-MEO_ERR_CONFLICT`, NOT NULL gives `-MEO_ERR_CONSTRAINT`, and a flipped byte gives `-MEO_ERR_CORRUPT` (S8).
- [ ] 64 threads on one handle, mixed insert/select, 10k ops each: no lost row, no deadlock (I6).
- [ ] README has a 15-line create/insert/select example that compiles (D1).

## M3 — Storage v2 + mistplot range scan
- [ ] Overflow pages: rows up to 16 MiB round-trip; `MEO_REC_MAX` is lifted.
- [ ] B-tree merge/rebalance; emptied pages go back to the freelist (file size is stable under insert/delete churn).
- [ ] `CREATE INDEX`, composite and non-unique indexes; JOIN / LEFT JOIN as flux_orm emits them.
- [ ] Range predicates (`<`, `<=`, `>`, `>=`, BETWEEN) use an index.
- [ ] `meo_tbl_scan_range(db, table, x_col, lo, hi, cb)` streams (x, y) float64 pairs. mistplot fills an `MpSeries` from 1M rows without a full-table materialization.
- [ ] Streaming SELECT cursor: memory stays constant for a 1M-row SELECT *.

## M4 — Change feed + in-process real-time
Layer 6. Consumers: mistplot live push, raize notifications.
Started early, below the table layer: the pager commit hook, persisted `commit_seq` and `src/feed/feed.mettle` (capture through `meo_feed_insert`) are built, and mistplot uses them. M4 moves capture up to `table/` so SQL writes are reported too, keeping the existing `meo_feed_*` and `MeoChange` names and meanings (new fields are appended).
- [ ] Every committed insert/update/delete emits one event (table id, op, rowid, new row) with a 64-bit commit sequence, in commit order.
- [ ] A rolled-back transaction emits nothing.
- [ ] `meo_feed_subscribe(db, table, ring)` delivers into a bounded ring per subscriber. A slow subscriber gets an "overrun, resync from seq N" marker and never blocks the writer.
- [ ] Callbacks run on a feed thread, never under the db lock (asserted). A mistplot demo calls `mp_live_push` from the feed thread under its own app lock.
- [ ] A ring-overrun GAP event carries the last commit time, not 0, and that time can be read directly.
- [ ] `meo_key_int` has an inverse, so consumers don't decode keys by hand.
- [ ] `meo_peek_commit_seq` tells a transient CORRUPT (autocommit flush mid-write) apart from real damage.

## M5 — WAL + MVCC concurrent readers
Layer 4b. Consumer: raize_web read-heavy load.
- [ ] A write-ahead log (`<db>-wal`) with checkpointing; the rollback journal stays as a mode.
- [ ] Readers take snapshots and do not take the writer's lock: 63 readers and 1 writer run with no reader blocking, and every reader sees a consistent snapshot.
- [ ] The pager frame table is thread-safe (striped locks); reader throughput at 8 threads is at least 4x that at 1 thread.
- [ ] Crash at every WAL write point (fork test) recovers to the last committed txn.

## M6 — Graph engine
Layer 7.
- [ ] Node and edge tables on layer 3, with an adjacency index keyed (src, label, dst).
- [ ] `meo_graph_neighbors`, BFS, and weighted shortest path; results match a reference on a 1M-edge graph.
- [ ] Graph writes go through the same transactions and the change feed.

## M7 — Network server + remote real-time
Layers 8 and 11.
- [ ] `meo_srv_` serves a length-prefixed frame protocol (prepare/bind/step/finalize, begin/commit) with thread-per-connection.
- [ ] `meo_cli_` passes the M2 SQL suite remotely.
- [ ] Remote `SUBSCRIBE table` pushes M4 events over TCP within 50 ms p99 on localhost; raize can relay them to browsers.
- [ ] 64 concurrent connections; a killed client never leaves the db lock held (server-side timeout + rollback).

## M8 — Replication + fault tolerance (log shipping)
Layer 9, step 1.
- [ ] The primary ships WAL frames to followers; followers apply them and serve read-only SQL.
- [ ] A follower that restarts catches up from its last LSN.
- [ ] Manual failover: a follower is promoted with no committed txn lost when sync mode is on.
- [ ] Kill -9 of primary or follower at random points (fork test) never corrupts either.

## M9 — Consensus (automatic failover)
Layer 9, step 2.
- [ ] Raft over the M7 transport: leader election, log replication, quorum commit.
- [ ] A 3-node cluster survives the loss of any one node with no lost acknowledged write (fault-injection test, 1000 runs).
- [ ] Membership change (add/remove node) without downtime.

## M10 — Sharding / distribution
Layer 10.
- [ ] Tables are partitioned by hash or by key range across Raft groups; a router sends each statement to its shard.
- [ ] Single-shard reads and writes have the same semantics as M2.
- [ ] Cross-shard reads (scatter-gather) are correct; cross-shard writes use two-phase commit, and a coordinator crash resolves every in-doubt txn.
- [ ] Rebalancing moves a range between groups while it serves traffic.
