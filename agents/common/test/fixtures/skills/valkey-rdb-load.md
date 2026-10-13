---
name: rdb-load-entry-points
description: "Use when reviewing a PR that touches src/rdb.c, src/replication.c or src/debug.c and changes an RDB load entry point, an emptyDB call or how replication info is restored after a load. Does NOT apply to RDB save paths or AOF rewrite."
---

## Use when

The diff adds or changes a caller of `rdbLoad`, `rdbLoadRio` or `replicaLoadPrimaryRDBFromSocket`, touches an `emptyDB(...)` call, or changes how `server.primary` is restored after a load.

## Confidence ladder

- Post HIGH: a cited line in the diff drops `RDB_INCOMPATIBLE` handling, or flushes the dataset before a load that can still fail.
- Post MEDIUM: an `emptyDB` call that ignores `lazyfree-lazy-user-flush`, shown at a cited line.
- Drop LOW: a new load path whose error handling you could not trace to its caller.

## Always-on checks

- Run `git grep -n RDB_INCOMPATIBLE -- src/` and compare it with the `rdbLoad*` callers in the diff. A new caller missing from that output has not handled the status.

## Patterns

### Load status collapsed to success or failure

The diff looks OK but is wrong when: a caller treats `rdbLoad` as returning only `C_OK` or `C_ERR`.
Reviewer memory: `rdbLoadRio` returns `RDB_OK`, `RDB_NOT_EXIST`, `RDB_INCOMPATIBLE` or `RDB_FAILED`, and `RDB_INCOMPATIBLE` must reach the caller distinct from `RDB_FAILED`.
Skip unless: the diff adds or edits a call to `rdbLoad`, `rdbLoadRio` or `VM_RdbLoad`.

### Flush before a load that can fail

The diff looks OK but is wrong when: `emptyDB(-1, EMPTYDB_NO_FLAGS, NULL)` runs before a load that can still fail, or the flush ignores `server.lazyfree_lazy_user_flush`.
Reviewer memory: `emptyDB` must respect `lazyfree_lazy_user_flush`, and a failed load must not leave the dataset flushed.
Skip unless: the diff touches an `emptyDB(...)` call in `src/replication.c`, `src/debug.c` or `src/db.c`.

### Replication info restore on debug loadaof

The diff looks OK but is wrong when: `debug loadaof` on a replica calls `replicationCachePrimaryUsingMyself` unconditionally.
Reviewer memory: overwriting `server.primary` releases the cached primary; `loadSingleAppendOnlyFile` callers must skip the restore on an existing replica.
Skip unless: the diff touches `src/debug.c` or a caller of `replicationCachePrimaryUsingMyself`.

A typical new entry point, for orientation only:

```c
int rdbLoadFromSomething(rio *rdb, rdbSaveInfo *rsi, int flags);
static void exampleHelper_DoNotCite(void);
```

## Do NOT flag

- `loadSingleAppendOnlyFile` callers in `src/aof.c` that skip replication-info restore: intentional, AOF loads never cache a primary.
- `REPL_STATE_*` changes outside `src/replication.c`: other files only read the state.
- Code that still uses `dict` and `dictEntry` around `src/dict.c`: callers keep the old names on purpose.

_(graduated from concern record_id=8f0c5e1a-2b7d-4c1e-9a3f-6d2e4b8c1f07)_
