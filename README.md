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

The single-node storage layer is built. Distribution, concurrency, real-time
access and the SQL layer are not built yet.

| Done | Module |
|---|---|
| Page format, CRC checksums, page-0 metadata | `src/format/` |
| Page cache with eviction and pinning | `src/pager/pager.mettle` |
| On-disk freelist | `src/pager/freelist.mettle` |
| Rollback journal and crash recovery | `src/pager/journal.mettle` |
| Order-preserving key encoding | `src/types/key.mettle` |
| B+ tree for tables and indexes (no delete or rebalance yet) | `src/btree/` |

Still missing from phase 3: `tests/phase3.mettle`, an end-to-end test of
commit, rollback and crash recovery through the b-tree.

## Naming

Exported names use one flat namespace: `meo_` for functions, `Meo` for types,
`MEO_` for constants. Database files start with the magic bytes `MEOP`, and
journals with `MEOJ`.

## Build

MeoSQL needs the head Mettle compiler; the v0.17.0 release has no `syscall()`.

```
export MBUILD_METTLE_LINUX=/home/nox/Projects/mettle/Mettle/bin/mettle
MB=/home/nox/Projects/mettle/mbuild/build/bootstrap/mbuild
$MB check && $MB test && $MB build -r
$MB run meosql        # smoke test of the whole stack
$MB run phase2 -r     # one test program, release build
```

Every `[bin.*]` in `mbuild.toml` is a test program, and each should print
`PASS` in both debug and release with zero compiler warnings.
