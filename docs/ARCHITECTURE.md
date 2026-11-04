# MeoDB architecture

MeoDB is one database built as a stack of layers. Each layer depends only on the layers below it, and each layer is optional above the one it needs. A small embedded program imports the bottom of the stack. A server imports more. Nothing is compiled that is not imported.

Build order: [ROADMAP.md](ROADMAP.md).

## The stack

| # | Layer | Module path | API prefix | Depends on | Consumer that needs it | Status |
|---|---|---|---|---|---|---|
| 0 | Platform, page format | `src/platform/`, `src/format/`, `src/error/`, `src/mem/` | `meo_file_`, `meo_page_`, `meo_meta_`, `meo_varint_`, `meo_status_`, `meo_arena_` | Mettle std, raw `syscall` | everything | built |
| 1 | Pager + rollback journal | `src/pager/` | `meo_pager_`, `meo_jrn_`, `meo_free_` | 0 | everything | built (crash-tested in M1) |
| 2 | B-tree + key encoding | `src/btree/`, `src/types/key.mettle` | `meo_bt_`, `meo_btn_`, `meo_key_` | 1 | tables, indexes, graph | built; delete in M2 |
| 3 | Records, catalog, tables, db handle | `src/record/`, `src/catalog/`, `src/table/`, `src/db/` | `meo_rec_`, `meo_cat_`, `meo_tbl_`, `meo_db_` | 2, 4a | mistplot (data mapping), flux_orm via 5 | M2 |
| 4a | Concurrency v1: db-wide lock | `src/conc/` | `meo_lock_` | std/thread | raize_web (64 threads) | M2 |
| 5 | Typed queries (no query language) | `src/query/` | `meo_q_` | 3 | the server (flux_orm), embedded apps | M2 |
| 4b | Concurrency v2: WAL, snapshot readers, group commit | `src/pager/wal.mettle`, `src/pager/pcache.mettle`, `src/db/` | `meo_wal_`, `meo_pcache_`, `meo_pager_snap_`, `meo_db_snap_` | 1, 2 | raize_web read-heavy load | built (M5) |
| 6 | Change feed | `src/feed/` | `meo_feed_` | 1 (pager commit hook), 3 | mistplot live push, raize notifications | built for pager-level writes (`meo_feed_insert`); table writes in M4 |
| 7 | Graph | `src/graph/` | `meo_graph_` | 3 (node/edge tables, adjacency index) | apps that model relations | later (M6) |
| 8a | Wire protocol (frame codec) | `src/wire/` | `meo_wire_` | 0, record values | server and client | M7 |
| 8b | Server | `src/net/`, `src/server/` | `meo_sock_`, `meo_srv_` | 5, 8a | flux_orm over TCP, tools | M7 |
| 8c | Client | `src/client/` | `meo_cli_` | 8a, `src/net/` | MeoDB's own tests; reference for other clients | M7 |
| 8d | Auth and access control | `src/auth/` | `meo_auth_` | 3, 8b, the separate security library | every network client | later (M7b) |
| 9 | Replication + fault tolerance | `src/repl/`, `src/raft/` | `meo_repl_`, `meo_raft_` | 4b (WAL is the log), 8 | high availability | later (M8, M9) |
| 10 | Distribution / sharding | `src/shard/` | `meo_shard_` | 8, 9 | data beyond one node | later (M10) |
| 11 | Real-time access over the network | `src/server/` (push frames) | `meo_sub_` | 6, 8 | mistplot, browser dashboards via raize | later (M7, after M4) |

The layer numbers show dependency, not build order. 4b is built after 6, for example.

## Import roots

A consumer imports exactly one root file through `mettle.deps`:

| Root | Contains | For |
|---|---|---|
| `src/meo_core.mettle` | layers 0-4a | embedded storage and tables, no query layer |
| `src/meodb.mettle` | meo_core + layer 5 | flux_orm, most apps |
| `src/meo_server.mettle` | meodb + 8a, 8b (later 6, 11) | the `meodb` server, or a program that embeds one |
| `src/meo_client.mettle` | 8a, 8c, no engine | programs that talk to a server |

Rules: no circular imports (E0006 fails the build), no lower layer imports a higher one, nothing imports a root. Exports are global across the import graph in Mettle, so every export carries the `meo_`/`Meo`/`MEO_` prefix.

## What the M2 layers do

- **Records.** A row is a varint column count, one type tag per column, then the bodies. Ints are zigzag varints, reals are 8 IEEE bytes, and text/blob are a length plus bytes.
- **Tables.** One b-tree per table. The leaf key is the 8-byte rowid followed by the row bytes. Parents keep only the 8-byte rowid. Max encoded row is 1280 bytes until overflow pages (M3).
- **Indexes.** Each UNIQUE column and each non-integer PRIMARY KEY gets one b-tree, value -> rowid. CREATE INDEX adds a named single-column index to an existing table: UNIQUE uses the same layout, non-unique keys are value ++ rowid. NULLs are not indexed. The catalog row stores each column's index name after the per-column fields.
- **Catalog.** Schemas live in a table tree at `meta.catalog_root`. They are loaded at open.
- **Queries.** There is no query language. A caller builds a query with function calls (`meo_q_select`, `meo_q_where`, `meo_q_order`, ...) and passes values as `MeoValue`. A planner picks a rowid lookup, an index lookup or a full scan. A select result is built at the first `meo_q_step` and then read row by row or as a whole. flux_orm translates its own query struct into these calls.
- **Concurrency v1.** One lock per db handle, built on the runtime's futex mutex and re-entrant for its owner. One thread works inside the engine at a time. An explicit transaction holds the lock until it ends.

## The network server

- **Process.** The `meodb` binary owns one database file. One thread accepts connections and each connection gets its own thread, up to 64. Bound to 127.0.0.1 unless told otherwise; an optional shared token is checked at HELLO. No users, permissions or encrypted transport yet; those come in M7b, with hashing and encryption from a separate security library.
- **Transactions.** A connection that runs BEGIN holds the db lock until its COMMIT or ROLLBACK, so other connections wait (and get BUSY after the busy timeout). If the client disconnects, hangs past the transaction idle timeout or the server stops, the server rolls the transaction back on that connection's thread and the lock is free.
- **Protocol.** Little-endian frames with a 12-byte header (length, kind, request id). A QUERY carries the same statement shape flux_orm builds: kind, table, columns, filter terms, order, limit, offset, typed values. Results come back whole; there are no server-side cursors.
- **Clients.** flux_orm writes its own small codec from the protocol spec and does not compile MeoDB. `src/client/` is MeoDB's reference client.

## How later layers fit Mettle's limits

| Limit (Mettle today) | Effect | Plan |
|---|---|---|
| No poll/epoll wrapper in std/net | no event loop from the stdlib | M7 starts thread-per-connection with blocking `accept`, as raize does. An epoll loop through raw `syscall` (epoll_create1 291, epoll_ctl 233, epoll_wait 232) is an option behind the same `meo_srv_` API. |
| Atomics are int32 only (CAS, xchg, inc, dec) | no 64-bit LSN or txn counter can be updated atomically | 64-bit counters change only under a lock. Lock-free readers use a seqlock: an int32 sequence plus two 32-bit halves. |
| No condition variables in std/thread | no blocking wait/notify | Feed and WAL waiters use futex wait/wake through `syscall(202)` on an int32 word. pthread condvars (std/thread_posix) collide with std/net_posix, so they are avoided. |
| No thread-local storage | no per-thread error slot | Errors and counters live on the statement (`meo_q_changes(q)`), never on the handle. |
| No fork/exec in std | no process-per-connection, no helper processes | Threads only. Tests use raw `syscall(57)` fork for crash cases, before any thread starts. |
| No DNS | no hostnames | Node addresses are IPv4 literals in config. |
| IPv4 TCP/UDP only | no IPv6 | Fine for a cluster; revisit when std/net grows. |
| No file locking in use | two processes on one file corrupt it | v1 supports one process per database file. M7 makes the server the single owner, and remote clients go through it. |

## Rules every layer keeps

- int32 returns: `>= 0` success (`MEO_ROW` 100 and `MEO_DONE` 101 are successes), `-MEO_ERR_*` failure. Status codes are append-only (1-12 fixed, 13+ appended).
- All multi-byte reads and writes go through `format/bytes.mettle`. No struct is laid over a page, and no page-sized buffer goes on the stack.
- Imports are relative and include the extension. Zero warnings, debug and release.
- No pager frame stays pinned when a public call returns, and no user callback runs under the db lock.

## Lock order

Never take an earlier lock while holding a later one: the db lock, then the WAL sync lock, then the WAL checkpoint lock, then leaf locks (WAL header, page-cache stripes, the feed ring, the db's catalog-snapshot and view-pool locks). No two leaf locks are held at once, and readers only take leaf locks.
