# MeoDB roadmap

Milestones in build order, with one exception: the network server (M7, without remote subscribe) comes straight after M2, because flux_orm reaches MeoDB over the network instead of compiling it in. Remote subscribe follows M4. A milestone is done when every exit criterion is checked by a `[bin.*]` test that passes in debug and release with zero warnings. Layer numbers refer to `docs/ARCHITECTURE.md`.

Direction: MeoDB is used the way PostgreSQL is used from Elixir. Apps reach the `meodb` server through flux_orm (our Ecto, with its own connection pool); the server is the product, and shared data is never opened by embedding the library (the file lock allows one process, the server). mist_plot and raize_web read and subscribe through the server like any other client. Underneath: one ordered storage engine with every data model as a layer (tables, documents, graph, key-value, time series, search) in one transaction system and one change feed; realtime from a committed-change stream over the wire (like logical replication) and live queries; many connections from alph processes (one per connection, supervised); concurrent writers from row-level MVCC; fault tolerance and scale from Raft replication and shards as alph actors. Techniques come from systems that proved them: PostgreSQL (row MVCC, constraints, row-level security), SQLite (WAL), FoundationDB and TigerBeetle (deterministic simulation), CockroachDB and TiKV (range sharding, Raft per range), Materialize and RethinkDB (live queries), Firebase (client sync, security rules), Neo4j (graph model). Order: wire subscribe and streaming scans (M7), the server on alph (M12), concurrent writers (M16), then replication and failover (M8, M9), live queries (M11), documents and relational integrity (M13), sharding (M10), more models (M6, M15). Every feature ships with a wire operation flux_orm can call.

## M0 — Storage (done)
Pager, freelist, page format, key encoding, B+ tree insert/seek/next, rollback journal.
- [x] 12 bins green debug + release, 0 warnings (commit afae010).

## M1 — Phase-3 gate (done)
The b-tree is proven on top of the journal before tables depend on it.
- [x] `phase3` bin: a commit is durable after reopen; a rollback restores the exact pre-txn key set and page_count; a forked child that dies after the journal fsync leaves the pre-txn tree on reopen; the same crash after a root split leaves a tree that passes `meo_btn_check` with the pre-txn keys; a small journal cap gives `-MEO_ERR_NOSPC`, and rollback then leaves the tree intact.

## M2 — Embedded relational core + typed query API
Layers 3, 4a, 5. Consumer: flux_orm.
- [x] B-tree delete; a 20k-op random insert/delete/seek/next run matches a sorted-array oracle at n_frames=8.
- [x] Typed calls, no query text: create a table from column definitions (if not exists), insert one or many rows, select a column subset with ANDed filters (`=`, `<>`, `<`, `<=`, `>`, `>=`, in-list, is null, is not null), order by several columns asc/desc, limit, offset, update with filters and assignments, delete with filters. Each call reports affected rows and the last inserted rowid. Data survives close/reopen.
- [x] A query is reusable: reset, replace its values, run again.
- [x] Every query shape flux_orm's builder, persistence and migrations produce runs through the typed API (`flux_shapes` bin).
- [x] NULL, int64 min/max, float64 (-0.0, NaN bits), text, blob round-trip exactly.
- [x] Nested begin and commit/rollback with no txn give `-MEO_ERR_TX`. A crash mid-transaction shows pre-txn data after reopen.
- [x] Duplicate PK/UNIQUE gives `-MEO_ERR_CONFLICT`, NOT NULL gives `-MEO_ERR_CONSTRAINT`, and a flipped byte gives `-MEO_ERR_CORRUPT`.
- [x] 64 threads on one handle, mixed insert/select, 500 ops each: no lost row, no deadlock.
- [x] README has a create/insert/select example with `meo_q_*` that compiles.

## M3 — Storage v2 + mistplot range scan
- [x] Overflow pages: rows up to 16 MiB round-trip; `MEO_REC_MAX` now only limits in-leaf records and index keys (`ovf_self`, `rowbig_self`). Over TCP a row is also bounded by the frame limit (16 MiB by default).
- [ ] B-tree merge/rebalance; emptied pages go back to the freelist (file size is stable under insert/delete churn).
- [ ] Index creation on an existing table, composite and non-unique indexes; inner and left joins for flux_orm's join builder. Named, non-unique, single-column indexes on existing tables are done (`index_self`); composite indexes and joins are not.
- [x] Range predicates (`<`, `<=`, `>`, `>=`, BETWEEN) use the rowid or a unique index (`range_self`).
- [x] `meo_q_scan_xy` / `meo_q_scan_xyg` stream (x, y) float64 pairs over an x window without materializing the table (`range_self`). Filling an `MpSeries` from 1M rows is mistplot's to check.
- [ ] Opt-in streaming select: memory stays constant while reading all of a 1M-row table.
- [x] Opening a database takes an exclusive lock on the file; a second process (a second server, or an embedded open) gets BUSY instead of corrupting it (`flock_self`).

## M4 — Change feed + in-process real-time
Layer 6. Consumers: mistplot live push, raize notifications.
The pager commit hook, persisted `commit_seq` and `src/feed/feed.mettle` came first, below the table layer, and mistplot uses them. Table writes are now captured too, with the row as a value; the `meo_feed_*` and `MeoChange` names and meanings are unchanged (new fields are appended). Catalog changes are not reported yet.
- [x] Every committed insert/update/delete emits one event (table id, op, rowid, new row) with a 64-bit commit sequence, in commit order (`feed_table`).
- [x] A rolled-back transaction emits nothing (`feed_table`).
- [ ] `meo_feed_subscribe(db, table, ring)` delivers into a bounded ring per subscriber. A slow subscriber gets an "overrun, resync from seq N" marker and never blocks the writer.
- [ ] Callbacks run on a feed thread, never under the db lock (asserted). A mistplot demo calls `mp_live_push` from the feed thread under its own app lock.
- [x] A ring-overrun GAP event carries the last commit time, not 0, and that time can be read directly (`feed_table`).
- [x] `meo_key_int` has an inverse, so consumers don't decode keys by hand (`key_self`).
- [x] `meo_peek_commit_seq` tells a transient CORRUPT (autocommit flush mid-write) apart from real damage (`feed_self`).

## M5 — WAL + MVCC concurrent readers
Layer 4b. Consumer: raize_web read-heavy load.
- [x] A write-ahead log (`<db>-wal`) with checkpointing; the rollback journal stays as a mode (`wal_self`, `wal_sync_self`, `wal_pager_self`).
- [x] Readers take snapshots and do not take the writer's lock: 63 readers and 1 writer run with no reader blocking, and every reader sees a consistent snapshot (`wal_mt`, `wal_snap_self`, `wal_db_self`).
- [ ] The pager frame table is thread-safe (striped locks); reader throughput at 8 threads is at least 4x that at 1 thread. Readers share a striped page cache (`pcache_self`); release reaches 3.4x (debug 5.4x), about 1.7M point reads/s at 8 threads (`wal_scale`, which requires 3x). The rest is per-statement snapshot overhead (bugs.md B23).
- [x] Crash at every WAL write point (fork test) recovers to the last committed txn (`wal_crash`, 612 crash runs).
- [x] Group commit: concurrent commits share one fsync, so committed writes per second rise well above the ~200 of one fsync per commit (`wal_group`, `srv_wal`).

## M6 — Graph engine
Layer 7.
- [ ] Node and edge tables on layer 3, with an adjacency index keyed (src, label, dst).
- [ ] `meo_graph_neighbors`, BFS, and weighted shortest path; results match a reference on a 1M-edge graph.
- [ ] Graph writes go through the same transactions and the change feed.

## M7 — Network server + remote real-time
Layers 8 and 11. Consumer: flux_orm, which reaches MeoDB over TCP instead of compiling it in. Remote subscribe comes after M4.
- [x] A `meodb` binary serves one database file over TCP, bound to 127.0.0.1 by default, one thread per connection, up to 64 connections. Further connections get a BUSY frame and are closed.
- [x] Length-prefixed binary frames: HELLO (version check, optional token), PING, BEGIN, COMMIT, ROLLBACK, QUERY (a typed statement with typed values), BYE. A result comes back whole, with affected rows and the last rowid.
- [x] The frame codec round-trips every frame kind and value exactly. Every truncated or corrupted frame is refused without a crash or an out-of-bounds read (`wire_self`).
- [x] `meo_cli_` passes the M2 query suite and every flux_orm query shape remotely, with the same results as embedded (`srv_e2e`).
- [x] 64 clients on loopback, mixed insert/select, some in explicit transactions: no lost row, no deadlock (`srv_mt`).
- [x] A client killed mid-transaction: its writes are gone, and another connection gets the lock within 1 s. A client that hangs mid-transaction is cut off after the transaction idle timeout (`srv_kill`).
- [x] An oversize frame gets TOOBIG, a wrong version gets VERSION, a wrong token gets AUTH, and a result over the frame limit gets TOOBIG with the connection still usable (`srv_limits`).
- [x] Stopping the server rolls back open transactions. Reopening shows only committed data (`srv_stop`).
- [x] flux_orm's network adapter passes its tests against a running server (flux_orm `tests/live_meodb.mettle`).
- [x] After M4: remote `SUBSCRIBE` pushes events within 50 ms p99 on localhost (`srv_sub`: about 3 ms WAL, 9 ms rollback in debug; 8 ms and 26 ms in release), with table filters, resume from a commit, window flow control and heartbeats (`cli_sub`). Relaying to browsers is raize's side. Events carry the row, commit order, commit sequence and GAP markers, like the in-process feed.
- [x] A streaming `SCAN_XY` / `SCAN_XYG` operation sends (x, y) pairs in chunks over one snapshot and reports that snapshot's commit sequence, so mist_plot charts server data without embedding the engine (`srv_scan`, `cli_sub`).

## M7b — Authentication and access control
Layer 8d. Consumers: every network client (flux_orm, raize_web apps). Hashing, key derivation and encryption come from a separate Mettle security library; MeoDB calls it and implements no crypto of its own.
- [ ] Users live in a system table in the database file. Passwords are stored only as salted, slow hashes from the security library. Creating, changing and removing users is an admin operation.
- [ ] HELLO carries a user name and a credential (a protocol minor version bump). The shared token stays as the bootstrap credential for the first admin. A wrong user or password returns AUTH after the same delay as today, with no hint which part was wrong.
- [ ] Permissions per user: read and write per table, and admin for DDL and user management. A denied query returns AUTH, non-fatal, and leaves the transaction state unchanged.
- [ ] Repeated failed logins from one address are slowed down, then refused for a while. Logins and denials are logged.
- [ ] Encrypted transport through the security library, required for any non-loopback bind.
- [ ] Later: encryption at rest for the database file and journal, with keys from the security library.

## M8 — Replication + fault tolerance (log shipping)
Layer 9, step 1.
- [ ] The primary ships WAL frames to followers; followers apply them and serve read-only queries.
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
- [ ] Tables are partitioned by hash or by key range across Raft groups; a router sends each query to its shard.
- [ ] Single-shard reads and writes have the same semantics as M2.
- [ ] Cross-shard reads (scatter-gather) are correct; cross-shard writes use two-phase commit, and a coordinator crash resolves every in-doubt txn.
- [ ] Rebalancing moves a range between groups while it serves traffic.

## M11 — Live queries
Layer 6b. Consumers: raize_web, mistplot dashboards. Copies Materialize / RethinkDB changefeeds.
- [ ] A client subscribes to a typed SELECT and gets the initial result, then only inserts, updates and removals of result rows, in commit order.
- [ ] Results are maintained incrementally from the change feed; a subscription never re-runs its query on every commit.
- [x] Remote subscribe over TCP; a slow subscriber is resynced, never blocks the writer (`srv_sub`).

## M12 — Server on alph
Layer 8b. Each connection is an alph session actor; the storage engine is one bound actor under a static supervisor; blocking I/O goes through an alph pool.
- [ ] Same wire behaviour and test results as the thread server (`srv_*` tests pass unchanged).
- [ ] A crashed session is restarted or cleaned up by its supervisor without touching other sessions.

## M13 — Documents and relational integrity
Layers 3 and 5. Consumers: raize_auth (users and credentials), flux_orm apps. Copies PostgreSQL.
- [ ] A JSON document column type with path reads and indexes on paths, in the same rows and transactions as relational columns.
- [ ] Foreign keys (with ON DELETE actions), CHECK constraints, column defaults.
- [ ] Inner and left joins, GROUP BY with COUNT/SUM/MIN/MAX/AVG.
- [ ] Composite indexes.

## M14 — Deterministic simulation and fuzzing
Shared with alph. Copies FoundationDB and TigerBeetle.
- [ ] The engine runs against a simulated disk, clock and network; any failing seed replays exactly.
- [ ] Fuzzers for the wire codec, page, record and catalog decoders.
- [ ] Thousands of simulated crash and partition runs per day with no lost committed write.

## M15 — More models
Layer 7. Each model is a layer over the same tables and transactions.
- [ ] Key-value with expiry (sessions, rate limits).
- [ ] Time series retention and downsampling.
- [ ] Full-text search (inverted index, BM25) and vector search (HNSW).

## M16 — Concurrent writers (row-level MVCC)
Layers 4b and 5. Copies PostgreSQL. Today writes are serialized (one writer at a time, sharing fsyncs).
- [ ] Rows carry versions; readers see their snapshot's version, so readers and writers never block each other.
- [ ] Transactions that touch different rows commit concurrently; two transactions updating the same row: the second waits or fails with CONFLICT, never a lost update (fault-injection and Jepsen-style tests).
- [ ] Old row versions are reclaimed in the background (vacuum) without blocking writers.
- [ ] Write throughput at 16 connections is several times that at 1 connection.
