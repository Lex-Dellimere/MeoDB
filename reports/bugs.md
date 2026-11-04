# Bugs and risks

## Open

| Id | Area | What happens | Why it matters | Where | Status |
|---|---|---|---|---|---|
| B1 | conc | A waiter can wait longer than `busy_ms`: the runtime mutex restarts the full timeout after every wake-up. | Under heavy contention a client may see BUSY late. | `src/conc/lock.mettle` | open |
| B2 | conc | A thread that exits while holding the db lock leaves it held forever; thread ids can be reused. | Only reachable by an embedded caller that exits mid-transaction; the server always rolls back first. | `src/conc/lock.mettle` | open |
| B3 | query | A DROP TABLE that fails partway inside an explicit transaction marks the table dead from the first freed page and poisons the transaction until rollback. Not tested. | The table looks gone until rollback reloads it. | `src/catalog/catalog.mettle` (`meo_cat_drop_table`) | open |
| B4 | catalog | Dropping a table can grow the file by one page when the freelist needs a new trunk page. | Minor; the test allows it. | `src/pager/freelist.mettle` | open |
| B5 | table | An UPDATE that swaps unique values between two rows returns CONFLICT. | Valid swaps need two statements or a temporary value. | `src/table/table.mettle` (`meo_tbl_check_update`) | open |
| B6 | btree | Nodes are never merged, so space from emptied leaves is not reclaimed. | Files only shrink by dropping tables. | `src/btree/btree.mettle` | open |
| B7 | btree | Byte-balanced splits keep rows to 1280 encoded bytes; a larger row returns TOOBIG. | Apps must cap text sizes until overflow pages exist. | `src/catalog/schema.mettle` (`MEO_REC_MAX`) | open |
| B8 | pager | No file locking: two processes on one database file corrupt it. | Run exactly one `meosql` per file. | `src/platform/file_linux.mettle` | open |
| B9 | perf | Every commit fsyncs, about 5 ms on disk, so roughly 200 committed writes per second. `query_mt` runs on `/dev/shm` to stay fast. | Write-heavy apps must batch writes in transactions. | `src/pager/pager.mettle` | open |
| B10 | perf | COUNT and filters on non-indexed columns are full scans under the db lock. `srv_mt` takes about 2 minutes. | Slow lookups stall every client. | `src/query/exec.mettle` | open |
| B11 | wire | A decoded result can take about 40 times its frame size in memory (40 bytes per cell, 1 byte for a NULL on the wire). | A client with a large `max_frame` can be made to allocate a lot. | `src/wire/msg.mettle` | open |
| B12 | server | One open transaction blocks every other connection, reads included, until it ends or `tx_idle_ms` cuts it. | Long transactions stall a whole web app. | `src/server/session.mettle` | open |
| B13 | server | A 64-worker raize pool uses every connection slot. | A 65th client gets BUSY. | `src/server/server.mettle` (`max_conns`) | open |
| B14 | net | EINTR retries and send-timeout expiry are untested. IPv4 only. | Rare signals or slow peers may surface as IO errors. | `src/net/sock.mettle` | open |
| B15 | pager | Not tested: a crash in the middle of a page write (torn write), and a crash between commit preparation and journal removal. | Recovery in those windows is unproven. | `tests/phase3.mettle` | open |
| B16 | btree | Delete has not run inside a killed-process crash test. | Recovery after a crash mid-delete is unproven. | `tests/phase3.mettle`, `tests/query_crash.mettle` | open |
| B17 | db | Transaction poisoning after a real IO failure is only tested with a faked error code. `meo_db_close` returning BUSY with a live query is untested. | Error paths that rarely run. | `tests/catalog_self.mettle` | open |
| B18 | server | `meo_srv_free` on its own after a missed stop deadline is untested (the analyser rejects using the server after a free call). | Only a second stop is covered. | `tests/srv_stop.mettle` | open |
| B19 | feed | A ring-overrun GAP event has `time_us = 0`, and the last commit time can't be read. | mistplot can't timestamp a gap. | `src/feed/feed.mettle` | open |
| B20 | feed | `meo_peek_commit_seq` can't tell a transient CORRUPT (an autocommit flush mid-write) from real damage. | mistplot retries up to 8 times. | `src/pager/pager.mettle` | open |
| B21 | feed | Writes through the typed query API are not reported by the change feed; only `meo_feed_insert` writes are. | mistplot live charts can't follow app tables yet. | `src/feed/feed.mettle`, `src/table/table.mettle` | open |
| B22 | tests | Some red-check failure messages print the real value as both sides (for example "2500 rows, want 2500"). | Cosmetic. | `tests/table_self.mettle`, `tests/draft.mettle` | open |

## Fixed

| Id | What | Fixed in |
|---|---|---|
| F1 | A multi-row insert checked one row at a time, so a duplicate in row 3 could leave rows 1-2 committed, and NULL ids all got the same rowid. | `b5bd042` |
| F2 | A table created and rolled back could hand its id to the next table. | `e267700` |
| F3 | A failed catalog reload could later save a header-only catalog. | `e267700` |
| F4 | After a stop that missed its deadline, the server could never be freed. | `40e83b4` |
| F5 | PING in an aborted transaction answered OK instead of `ERROR TX`. | `40e83b4` |
| F6 | `meo_tbl_delete` dropped index root changes instead of saving them. | `268d81b` |
| F7 | mistplot decoded integer keys by hand; `meo_key_int_decode` now exists. | `2938ddc` |
