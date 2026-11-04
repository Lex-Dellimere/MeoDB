# MeoDB wire protocol v1

The byte-exact contract between the `meodb` server and any client. A client can be written from this page alone. The reference codec is `src/wire/`; where this page and that code disagree, the code wins and this page is the bug.

This page covers major 1, minor 1. Minor 1 adds SUBSCRIBE (a push stream of row changes) and SCAN (streamed points); both are announced in HELLO_OK caps and a minor-0 client never meets them.

## Basics

- TCP. Default `127.0.0.1:5490`. Both sides set `TCP_NODELAY`.
- Little-endian, fixed-width integers. No varints.
- One request, then exactly one response with the same `rid`, in order. No pipelining: send the next request only after the reply. The exceptions: SCAN is answered by one or more SCAN_ROWS frames (read until `last` = 1), and a SUBSCRIBED session also receives EVENTS pushes with rid 0.
- Each frame (header + payload) is sent with one write.
- QUERY results arrive whole. There are no cursors. Page large reads with `limit`/`offset`. SCAN is the streamed read.

## Frame header (12 bytes)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 4 | len | u32 | payload bytes after the header, 0 .. receiver's max_frame |
| 4 | 1 | kind | u8 | see Kinds |
| 5 | 1 | flags | u8 | 0; nonzero -> PROTO |
| 6 | 2 | rsv | u16 | 0; nonzero -> PROTO |
| 8 | 4 | rid | u32 | client: nonzero, starts at 1, +1 per request; response echoes it; 0 = server-initiated |

`len` over the receiver's max_frame -> `ERROR TOOBIG` fatal. The body is not read.

## Kinds

| Kind | Name | Dir | Payload | Reply |
|---|---|---|---|---|
| 0x01 | HELLO | C->S | hello | HELLO_OK or ERROR |
| 0x02 | PING | C->S | empty | OK (`ERROR TX` in ABORTED) |
| 0x03 | BEGIN | C->S | u8 mode | OK |
| 0x04 | COMMIT | C->S | empty | OK |
| 0x05 | ROLLBACK | C->S | empty | OK |
| 0x06 | QUERY | C->S | stmt | RESULT |
| 0x07 | BYE | C->S | empty | OK, then the server closes |
| 0x08 | SUBSCRIBE | C->S | subscribe | SUB_OK or ERROR (caps bit2) |
| 0x09 | ACK | C->S | u64 seq | none (caps bit2) |
| 0x0A | UNSUBSCRIBE | C->S | empty | OK (caps bit2) |
| 0x0B | SCAN | C->S | scan | SCAN_ROWS, one or more, or ERROR (caps bit3) |
| 0x0C..0x3F | reserved | | | `ERROR PROTO` fatal |
| 0x40 | OK | S->C | empty | |
| 0x41 | HELLO_OK | S->C | hello_ok | |
| 0x42 | ERROR | S->C | error | |
| 0x43 | RESULT | S->C | result | |
| 0x44 | SUB_OK | S->C | sub_ok | |
| 0x45 | SCAN_ROWS | S->C | scan_rows | |
| 0x46..0x7F | reserved | | | |
| 0x80 | EVENTS | S->C | events (rid 0) | none; only to a SUBSCRIBED session |
| 0x81..0xFF | push | S->C | reserved (rid 0) | never sent to a client that has not subscribed |

Any request before a successful HELLO, a second HELLO, or an unknown or response kind sent by a client -> `ERROR PROTO` fatal. Any request may also be answered with ERROR. Kinds 0x08..0x0B are requests only when HELLO_OK caps has their bit set; a client must not send them otherwise, and a server without the bit answers them as reserved kinds, `ERROR PROTO` fatal.

## Building blocks

| Name | Layout | Rule |
|---|---|---|
| str16 | u16 n, then n bytes | a NUL byte anywhere -> PROTO. UTF-8 is not checked |
| val | u8 tag, then body | see Values |
| bool byte | u8 | 0 or 1; anything else -> PROTO |

## Values

| Tag | Name | Body | Notes |
|---|---|---|---|
| 0 | NULL | none | |
| 1 | INT | i64 (8) | |
| 2 | REAL | u64 (8), IEEE-754 bits | bit-exact: -0.0 and NaN payloads survive |
| 3 | TEXT | u32 n + n bytes | |
| 4 | BLOB | u32 n + n bytes | |
| 5..255 | | | PROTO |

A length past the end of the payload is PROTO.

flux mapping. Sending: RcNull -> NULL; RcInt, RcTime -> INT; RcBool -> INT 0/1; RcUint -> INT, or RC_ERR_RANGE above INT64_MAX (checked client-side, nothing sent); RcFloat -> REAL; RcText -> TEXT; RcBlob -> BLOB. Receiving: INT -> RcInt, REAL -> RcFloat, TEXT -> RcText, BLOB -> RcBlob, NULL -> RcNull.

## Payloads

Every payload must be consumed exactly. Short or trailing bytes -> `ERROR PROTO` fatal. Offsets marked `+` follow a variable-length field.

### hello (C->S)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 4 | magic | bytes | `4D 45 4F 53` ("MEOS"); wrong -> VERSION |
| 4 | 2 | major | u16 | 1; anything else -> VERSION (the rest is not read) |
| 6 | 2 | minor | u16 | any; 1 today |
| 8 | 4 | max_frame | u32 | largest payload the client accepts; < 65536 -> PROTO |
| 12 | 2+n | token | str16 | n = 0: none |
| + | 2+n | name | str16 | client name for logs, <= 64 bytes, else PROTO |

### hello_ok (S->C)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 2 | major | u16 | 1 |
| 2 | 2 | minor | u16 | min(client, server); the server's is 1 |
| 4 | 4 | max_frame | u32 | largest payload the server accepts |
| 8 | 8 | session | u64 | session id, for logs |
| 16 | 4 | caps | u32 | bit0 COUNT, bit1 ASSIGN_ADD, bit2 SUBSCRIBE, bit3 SCAN; other bits 0 |
| 20 | 2+n | name | str16 | e.g. "meodb 0.1.0" |

A max_frame above 2^31-1 is read as 2^31-1.

### error (S->C)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 4 | code | i32 | positive status code (below); <= 0 -> PROTO |
| 4 | 1 | fatal | bool byte | 1: the server closes after this frame |
| 5 | 1 | tx | u8 | session state after the error: 0 none, 1 open, 2 aborted; > 2 -> PROTO |
| 6 | 2+n | message | str16 | <= 1024 bytes, else PROTO. The server cuts longer text to 1024 |

### result (S->C)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 4 | affected | i32 | rows changed |
| 4 | 8 | last_id | i64 | last inserted rowid |
| 12 | 2 | n_cols | u16 | |
| 14 | n_cols | hints | u8 each | per column: tag of its first non-NULL cell, 0 if none; > 4 -> PROTO |
| + | 4 | n_rows | u32 | > 2^31-1 -> PROTO; n_cols 0 with n_rows > 0 -> PROTO |
| + | | cells | n_rows x n_cols val | row-major. Each cell's own tag is authoritative, not the hint |

Writes and DDL return n_cols 0, n_rows 0. COUNT returns n_cols 1, hint 1, n_rows 1, one INT.

### begin (C->S)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 1 | mode | u8 | 0 DEFAULT, 1 DEFERRED, 2 IMMEDIATE (= RC_TX_*). Other values reach the db, which answers USAGE |

### subscribe (C->S)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 2 | n_tables | u16 | 0 = every table |
| 2 | n_tables x (2+n) | tables | str16 each | an unknown table -> `ERROR SCHEMA` |
| + | 8 | from_seq | u64 | 0 = start after the newest event now; else resume at that feed seq. A seq older than the ring: the first event is a GAP |
| + | 8 | from_commit | u64 | 0 = unused; else deliver exactly the events of commits > from_commit, taking precedence over from_seq. Use: SCAN, read its commit_seq S, SUBSCRIBE with from_commit S, and every later commit arrives once, with no gap and no duplicate. If the events of commit S+1 have left the ring, the first event is a GAP |
| + | 4 | window | u32 | most events sent and not yet ACKed, 1..65536, else USAGE |

The decoder takes any window. The server checks the range.

### sub_ok (S->C)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 8 | start_seq | u64 | the seq of the first event that will be sent |
| 8 | 8 | commit_seq | u64 | newest durable commit at subscribe time |
| 16 | 4 | heartbeat_ms | u32 | 15000. A client sets its read timeout to about twice this |
| 20 | 4 | n_tables | u32 | > 2^31-1 -> PROTO |
| + | | tables | n_tables x table | the schema at subscribe time, so a client can map ids |

table: `u32 table_id; str16 name; cols`.
cols: `u16 n`, then per column `str16 name; u8 type`. Type 1 INT, 2 REAL, 3 TEXT, 4 BLOB; anything else -> PROTO.

### events (S->C, rid 0)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 4 | n | u32 | events in this frame; 0 is the heartbeat. > 2^31-1 -> PROTO |
| 4 | | events | n x event | |

event:

| Size | Field | Type | Rule |
|---|---|---|---|
| 8 | seq | u64 | |
| 8 | commit_seq | u64 | |
| 8 | time_us | i64 | |
| 1 | kind | u8 | 1 INSERT, 2 UPDATE, 4 GAP, 5 DELETE, 6 SCHEMA; anything else -> PROTO |
| 4 | table_id | u32 | 0 for GAP, else PROTO |
| 8 | rowid | i64 | |
| 8 | old_rowid | i64 | UPDATE: the previous rowid |
| 2+ | n_vals, vals | u16, n_vals x val | the row, columns in table order. The INTEGER PRIMARY KEY column carries the rowid, not NULL. INSERT and UPDATE: the new row. DELETE: the deleted row. GAP and SCHEMA: 0, else PROTO |
| 2+ | n_old, old | u16, n_old x val | UPDATE only: the row before the update. Other kinds: 0, else PROTO |
| | schema | str16 table; cols | SCHEMA only; absent for every other kind |

### scan (C->S)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 2+n each | table, x, y, group | str16 x 4 | group empty = no grouping |
| + | 8 | lo | u64 | f64 bits, inclusive x window |
| + | 8 | hi | u64 | f64 bits, inclusive |
| + | 4 | chunk | u32 | most points per SCAN_ROWS frame, 1..1048576, else USAGE |

The decoder takes any chunk. The server checks the range.

### scan_rows (S->C)

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 1 | last | bool byte | 1 on the final frame |
| 1 | 1 | grouped | bool byte | |
| 2 | 8 | commit_seq | u64 | the snapshot's commit; the same in every frame of one reply |
| 10 | 4 | n | u32 | > 2^31-1 -> PROTO; n points must fit the bytes left |
| 14 | | points | n x point | grouped: `i64 group; f64 x; f64 y` (24 bytes). Else `f64 x; f64 y` (16 bytes). f64 is the IEEE-754 bits, little-endian |

ack carries `u64 seq`. UNSUBSCRIBE carries nothing.

## QUERY statement

The shape of flux's `RcStmt`, field for field. `op` and term `op` are flux's own numbers (RC_OP_*, RC_W_*), sent unchanged. Column types and column flags are not flux's numbers and must be translated (see below). `cap_*` and `n_joins` are not sent; a statement with joins is refused client-side.

| Off | Size | Field | Type | Rule |
|---|---|---|---|---|
| 0 | 1 | op | u8 | RC_OP_*; the decoder takes any value, the server checks 1..10 |
| 1 | 1 | sflags | u8 | bit0 if_not_exists (IF EXISTS for the drops), bit1 unique; other bits -> PROTO |
| 2 | 2+n | table | str16 | table name; the owning table for the index ops |
| + | 2+n | name | str16 | index name; empty when unused |
| + | 2 | n_cols | u16 | then per column: str16 name; u8 type; u8 cflags |
| + | 4 | n_rows | u32 | INSERT rows, else 0; > 2^31-1 -> PROTO |
| + | 2 | n_terms | u16 | then per term: str16 col; u8 op; u32 arg0; u32 n_args (each > 2^31-1 -> PROTO) |
| + | 2 | n_order | u16 | then per order: str16 col; bool byte desc |
| + | 8 | limit | i64 | -1 = none |
| + | 8 | offset | i64 | 0 = none |
| + | 4 | n_args | u32 | then n_args x val (flux's argv); > 2^31-1 -> PROTO |

Column `type` (CREATE and ADD_COLUMN, else 0): 1 INT, 2 REAL, 3 TEXT, 4 BLOB. flux maps RC_T_I64/BOOL/TIME/U64 -> 1, RC_T_F64 -> 2, RC_T_TEXT -> 3, RC_T_BLOB -> 4.

Column `cflags`, bits 4..7 -> PROTO:

| Bit | Value | Meaning | flux source |
|---|---|---|---|
| 0 | 1 | PRIMARY KEY | RC_F_PK (1) |
| 1 | 2 | NOT NULL | RC_F_NOT_NULL (4) |
| 2 | 4 | UNIQUE | RC_F_UNIQUE (8) |
| 3 | 8 | ADD: `col = col + value` (UPDATE only) | never set by flux v1 |

Bits 0..2 are used by CREATE and ADD_COLUMN only. Bit 3 is accepted only when HELLO_OK caps bit1 is set, else USAGE. Its SET value must be an INT.

### Ops (RC_OP_*)

| op | Name | Fields used | Server call |
|---|---|---|---|
| 1 | CREATE | table, if_not_exists, cols = definitions | `meo_q_create`, `column_def` per col |
| 2 | INSERT | table, cols = column list, n_rows, args = cells row-major | `meo_q_insert`, `into`, `value` |
| 3 | SELECT | table, cols = picked columns, terms, order, limit, offset, args = term args | `meo_q_select` |
| 4 | UPDATE | table, cols = SET columns, terms, args = SET values then term args | `meo_q_update`, `assign` / `assign_add` |
| 5 | DELETE | table, terms, args | `meo_q_delete` |
| 6 | COUNT | table, terms, args; no cols, no order, limit -1, offset 0 | `meo_q_count` |
| 7 | DROP | table, if_not_exists = IF EXISTS | `meo_q_drop` |
| 8 | ADD_COLUMN | table, cols = exactly one definition | `meo_q_add_column` |
| 9 | CREATE_INDEX | table, name, unique, if_not_exists, cols = indexed columns (type 0, cflags 0) | `meo_q_create_index`, `index_column` per col, `unique` |
| 10 | DROP_INDEX | table, name, if_not_exists = IF EXISTS | `meo_q_drop_index` |

Ops 9 and 10 reply RESULT with affected 0. CREATE_INDEX indexes the existing rows in the same statement. It takes exactly one column: more is `ERROR UNSUPPORTED` (11), and a column type or cflags other than 0 is USAGE. An index name is unique across the database, compared ASCII case-insensitively. A taken name is SCHEMA, or a no-op with if_not_exists. An unknown table or column, the rowid alias, or a column that already has an index (PRIMARY KEY, UNIQUE or a named one) is SCHEMA. With unique set, duplicate values are CONFLICT and nothing is created. A UNIQUE index is a constraint on later writes too. DROP_INDEX of a missing name, or of a name on another table, is SCHEMA, or a no-op with if_not_exists. Indexes from PRIMARY KEY or UNIQUE in CREATE have no name and cannot be dropped. COUNT needs caps bit0. Without it the client must not send COUNT (RC_ERR_UNSUPPORTED, nothing sent).

### Term ops (RC_W_*)

| op | Name | n_args |
|---|---|---|
| 0 | EQ | 1 |
| 1 | NE | 1 |
| 2 | LT | 1 |
| 3 | LE | 1 |
| 4 | GT | 1 |
| 5 | GE | 1 |
| 6 | IN | >= 1 |
| 7 | NULL | 0 |
| 8 | NOT_NULL | 0 |

A term reads `args[arg0 .. arg0 + n_args)`.

### Server checks before running (`ERROR USAGE`, non-fatal)

op in 1..10; term op in 0..8; each term `arg0 + n_args <= n_args(total)` (64-bit sum); the n_args counts in the table above; UPDATE `n_args >= n_cols`; COUNT shape as above; cflags bit3 only with caps bit1. Every other rule (names, types, shapes) belongs to the query layer, and its code comes back in ERROR.

## HELLO negotiation

1. The client connects and sends HELLO with rid 1.
2. The server checks the fields in this order:
   - Wrong magic or major != 1 -> `ERROR VERSION` fatal.
   - Malformed -> `ERROR PROTO` fatal.
   - If the server has a token and it is missing or wrong -> 200 ms delay, then `ERROR AUTH` fatal. The compare runs in constant time. A server without a token ignores any token sent.
3. If all pass, the server replies HELLO_OK. Keep its `max_frame`, which is the largest request you may send, and its `caps`.

| caps bit | Name | Meaning when set |
|---|---|---|
| 0 | COUNT | op 6 is served |
| 1 | ASSIGN_ADD | cflags bit3 is accepted on UPDATE |
| 2 | SUBSCRIBE | kinds 0x08 SUBSCRIBE, 0x09 ACK, 0x0A UNSUBSCRIBE are served |
| 3 | SCAN | kind 0x0B SCAN is served |

Any minor is accepted. The reply carries the smaller one.

## SUBSCRIBE

A subscription takes over its connection, as in Postgres logical replication: after SUB_OK the connection is a push stream, and a client that also runs queries opens a second connection.

1. Check HELLO_OK caps bit2. Send SUBSCRIBE in READY. In any other state the reply is `ERROR TX`, non-fatal. An unknown table is `ERROR SCHEMA`, a window outside 1..65536 is `ERROR USAGE`, both non-fatal and the session stays READY.
2. The server replies SUB_OK and the session is SUBSCRIBED.
3. The server sends EVENTS frames with rid 0 whenever events exist and the window allows. Events arrive in commit order, in order of `seq`. Events of one commit may span frames. A frame never exceeds the client's max_frame: an event that alone would is sent as a GAP.
4. The client sends ACK with the last `seq` it has processed. ACK has no reply and opens the window: the server stops sending once (events sent - events ACKed) >= window and resumes on ACK. An ACK beyond what was sent is `ERROR USAGE`, non-fatal.
5. UNSUBSCRIBE returns the session to READY with OK. EVENTS frames sent before the OK may still arrive: the client discards rid-0 frames until the OK. A client may instead close the connection.

While SUBSCRIBED the session accepts ACK, UNSUBSCRIBE, PING (-> OK) and BYE (-> OK, then the server closes). Anything else is `ERROR TX`, non-fatal. No transaction can be open on a subscribed session. `idle_ms` does not apply, because the client may only ACK. The server sends an empty EVENTS frame (n 0) every 15 s as a heartbeat, so a silent connection is a dead one: use a read timeout of about twice `heartbeat_ms`.

Event kinds:

| Kind | Name | Meaning |
|---|---|---|
| 1 | INSERT | `vals` is the new row |
| 2 | UPDATE | `vals` is the new row, `old` the row before. `old_rowid` is the previous rowid, equal to `rowid` unless the update moved the row |
| 4 | GAP | events were lost: the subscriber fell behind the ring, a row was too large for a frame, or the feed lost track. Reload fully (rescan), then resume. `commit_seq` is the newest durable commit, so a rescan can resubscribe with `from_commit` = that value |
| 5 | DELETE | `vals` is the deleted row |
| 6 | SCHEMA | a table this subscription covers changed; `schema` is its new shape. Reload the schema before reading later rows of `table_id` |

A GAP never blocks the writer: a slow subscriber is cut loose from the ring, never waited for.

## SCAN

SCAN reads two columns (and an optional group column) of a table as points. Check HELLO_OK caps bit3. It is allowed in READY and TX.

- The reply is one or more SCAN_ROWS frames with the request's `rid`, each with at most `chunk` points and a payload within min(server max_frame, client max_frame). The last has `last` = 1 and may have n = 0. This is the one request with more than one response frame.
- Unknown table or column names are `ERROR SCHEMA`, sent instead of the first frame. An error after the first frame is an ERROR with the same `rid` and ends the reply.
- Every frame of a reply carries the same `commit_seq`: the commit of the snapshot the scan read.
- Points follow `meo_q_scan_xy` / `meo_q_scan_xyg`: y is NaN for a NULL or non-numeric value, rows with a non-numeric x are skipped, and points come in x order when x is the rowid alias or indexed.
- In WAL mode a READY scan reads one snapshot and holds no db lock, so writers continue. In a TX it reads through the transaction, so it sees the transaction's own writes.

## Status codes

Append-only: numbers never change.

| Code | Name | Meaning |
|---|---|---|
| 1 | IO | read/write/sync failed |
| 2 | NOMEM | allocation failed |
| 3 | NOSPC | out of pages / file space |
| 4 | CORRUPT | bad checksum or structure |
| 5 | NOT_A_DB | file magic mismatch |
| 6 | VERSION | wire magic/major, or file format version |
| 7 | BUSY | lock wait passed busy_ms, or connection cap reached; retryable |
| 8 | FULL | page/array has no room |
| 9 | RANGE | page number out of range |
| 10 | USAGE | bad argument or bad state |
| 11 | UNSUPPORTED | not in this version (composite indexes, COUNT before it lands) |
| 12 | READONLY | write on a read-only db |
| 13 | CONFLICT | duplicate PRIMARY KEY / UNIQUE |
| 14 | CONSTRAINT | NOT NULL violated |
| 15 | TX | nested BEGIN, no transaction open, poisoned or aborted transaction |
| 16 | SCHEMA | unknown or duplicate table or column |
| 17 | TOOBIG | frame over max_frame, or row over the row limit |
| 18 | MISMATCH | value type does not fit |
| 19 | PROTO | malformed or out-of-order frame |
| 20 | AUTH | wrong or missing token |
| 21 | TIMEOUT | session cut off by a timeout |

## Session states and errors

| State | ERROR.tx | Accepted | Notes |
|---|---|---|---|
| HELLO | 0 | HELLO | anything else -> PROTO fatal |
| READY | 0 | all but HELLO | QUERY runs as autocommit; SUBSCRIBE and SCAN allowed |
| TX | 1 | all but HELLO | the db lock is held across frames until COMMIT/ROLLBACK; SCAN allowed, SUBSCRIBE -> `ERROR TX` |
| ABORTED | 2 | ROLLBACK -> OK and READY | PING/QUERY/BEGIN/COMMIT -> `ERROR TX` |
| SUBSCRIBED | 0 | ACK, UNSUBSCRIBE -> OK and READY, PING, BYE | entered by SUB_OK; everything else -> `ERROR TX`; EVENTS pushes with rid 0 |

- **Fatal** (`fatal = 1`): the server closes after the frame, and any open transaction is rolled back. Fatal errors are PROTO, VERSION, AUTH, TIMEOUT, TOOBIG for an oversize received header, and BUSY at the connection cap.
- **Non-fatal**: the session stays usable. This covers every query-layer error, USAGE from the server checks, UNSUPPORTED, BUSY on a lock wait, TX, and TOOBIG for a result that would not fit.
- `ERROR.tx` is the session's state after the error, and it is authoritative.
  - tx 1 after a failed write: the transaction is still open but may be poisoned. COMMIT then returns TX, and only ROLLBACK clears it.
  - tx 2: the server has already rolled back (tx_max_ms passed). Send ROLLBACK to return to READY.
- BEGIN inside a transaction, or COMMIT/ROLLBACK outside one -> `ERROR TX`, non-fatal.

## Limits and timeouts

Server flags and defaults:

| Limit | Default | Notes |
|---|---|---|
| max_frame | 16 MiB | configurable 64 KiB .. 256 MiB; applies to the payload (header excluded) |
| max-conns | 64 | the 65th connection gets `ERROR BUSY` fatal with rid 0, before any HELLO, then close |
| busy_ms | 10000 | a session waiting for another's transaction gets `ERROR BUSY` after this |
| hello_ms | 5000 | receive timeout before HELLO |
| idle_ms | 300000 | receive timeout in READY (0 = none); not applied while SUBSCRIBED |
| tx_idle_ms | 5000 | receive/send timeout in TX/ABORTED |
| tx_max_ms | 60000 | checked when a frame arrives in TX: over it -> rollback, ABORTED, `ERROR TX` |
| stop_ms | 10000 | shutdown grace; open transactions are rolled back |

- Expiry of any receive timeout -> the server rolls back if in TX, sends `ERROR TIMEOUT` fatal, then closes.
- A RESULT larger than min(server max_frame, client max_frame) -> `ERROR TOOBIG`, non-fatal. Nothing changed, and the next request works. SCAN_ROWS and EVENTS frames are cut to fit instead, so they never need it.
- A client must not send a frame over the server's max_frame. The flux adapter returns RC_ERR_UNSUPPORTED without sending.

## Connection loss and reconnect

A connection counts as lost on EOF, a socket error, a local read timeout, or a response whose kind or rid is wrong. On loss, close the socket at once, so a late reply is never read as the answer to a later request. A frame with rid 0 is never a reply. A client that has not subscribed treats it as the server's last word: read the ERROR and close. A subscribed client reads EVENTS frames as pushes. A lost subscription is not resumed by the server: reconnect, SUBSCRIBE with `from_seq` or `from_commit`, and expect a GAP if the ring has moved on.

| When lost | That call | Later calls |
|---|---|---|
| inside a transaction (after BEGIN returned OK) | RC_ERR_TX | every call except rollback returns RC_ERR_TX (commit too); rollback returns RC_OK and clears the state. The server already rolled back |
| outside a transaction | RC_ERR_CLOSED (the request may or may not have run) | the next call reconnects once (connect + HELLO) before sending; if that fails, RC_ERR_CLOSED |

Never re-send a request. Never reconnect inside a transaction: the transaction is gone.

## Security

- Default bind is loopback. The server refuses a non-loopback bind without a token unless `--no-token` is given.
- The token is 1..256 bytes, read by the server from a file.
- The token is plaintext on the wire. There is no TLS in v1: use loopback, or a TLS-terminating proxy.
