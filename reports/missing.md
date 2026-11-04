# Missing features

Milestones refer to [docs/ROADMAP.md](../docs/ROADMAP.md).

| Id | Feature | Who needs it | Milestone | Status |
|---|---|---|---|---|
| M1 | CREATE INDEX / DROP INDEX: named, multi-column and non-unique indexes (today only single-column PK/UNIQUE declared in CREATE TABLE). The server answers UNSUPPORTED. | flux_orm migrations, example_sass (listing entries by user) | M3 | open |
| M2 | Rows larger than 1280 encoded bytes (overflow pages). | example_sass entries, any long text | M3 | open |
| M3 | Range scans on an ordered key for time windows. | mistplot | M3 | open |
| M4 | Change feed for typed-API writes, with row payloads, GAP times and transient-error reporting. | mistplot live charts, raize notifications | M4 | open |
| M5 | Readers that don't wait for the writer (WAL + MVCC). | raize_web, any multi-user app | M5 | open |
| M6 | Graph engine: node and edge tables with an adjacency index. | future apps | M6 | open |
| M7 | Remote SUBSCRIBE over TCP. | browser dashboards via raize | M7 (after M4) | open |
| M8 | Users, passwords, per-table permissions, login throttling, encrypted transport; hashing and encryption from a separate security library. | every network client | M7b | open |
| M9 | Encryption at rest for the database file and journal. | deployments with sensitive data | M7b (later) | open |
| M10 | Replication by log shipping, then automatic failover. | fault tolerance | M8, M9 | open |
| M11 | Sharding across nodes. | data beyond one node | M10 | open |
| M12 | Server on the alph runtime (actors, supervisors) instead of plain threads. | the distributed tiers | after alph has a scheduler and networking | open |
| M13 | Joins. flux_orm uses preload with IN instead. | apps with relational reads | M3 | open |
| M14 | Column defaults, and ADD COLUMN with NOT NULL, UNIQUE or PK. | flux_orm migrations | not scheduled | open |
| M15 | Expressions in UPDATE SET beyond `col = col + n`. | flux_orm versioned `update_all` | not scheduled | open |
| M16 | AUTOINCREMENT: rowids of deleted rows at the top end can be reused today. | apps that must never reuse ids | not scheduled | open |
| M17 | Savepoints and nested transactions. | flux_orm nested units of work | not scheduled | open |
| M18 | Streaming results or server-side cursors; results come back whole today. | large reads | M3 (embedded streaming select) | open |
| M19 | An exclusive file lock at open, so a second process on the same file gets BUSY instead of corrupting it. | example_sass, any deployment | M3 | open |
| M20 | IPv6 and host names. | non-local deployments | not scheduled | open |
| M21 | A way to run every test in one command (the old check script was deleted). | developers | not scheduled | open |
| M22 | Group commit: concurrent commits share one fsync. | write-heavy apps (example_sass F02.7) | M5 | open |
