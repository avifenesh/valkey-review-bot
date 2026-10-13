---
name: glide-reconnect-backoff
description: >
  Use when reviewing a PR that touches glide-core/src/client/reconnecting_connection.rs
  or glide-core/redis-rs/redis/src/retry_strategies.rs, or changes how
  ReconnectingConnection::reconnect schedules retries. Does NOT apply to cluster
  topology refresh.
---

## Use when

The diff changes `ReconnectingConnection::reconnect`, the `ConnectionState` transitions in `glide-core/src/client/reconnecting_connection.rs`, or how `connection_retry_strategy` feeds `get_infinite_backoff_dur_iterator`.

## Confidence ladder

- Post HIGH: a cited line awaits the reconnect loop inline instead of spawning it with `task::spawn`, or sets `ConnectionState::Reconnecting` without resetting `connection_available_signal`.
- Post MEDIUM: a new early return in the retry loop that skips the `is_dropped` check, shown at a cited line.
- Drop LOW: a change to backoff numbers with no caller-visible effect.

## Patterns

### Reconnect awaited by the caller

The diff looks OK but is wrong when: the reconnect attempt is awaited by the caller instead of running in the background.
Reviewer memory: `reconnect` spawns its loop so a dropped caller task does not stop reconnection; `ReconnectReason::ConnectionDropped` also lowers the open-connections count through `Telemetry::decr_total_connections`.
Skip unless: the diff touches `reconnect` or `ReconnectReason` in `glide-core/src/client/reconnecting_connection.rs`.

### Retry loop that never stops

The diff looks OK but is wrong when: a loop over `get_infinite_backoff_dur_iterator` loses its `is_dropped` check.
Reviewer memory: the iterator never ends; the only exit is the client being dropped, so the check must stay at the top of each iteration.
Skip unless: the diff edits the loop body in `ReconnectingConnection::reconnect` or anything under `glide-core/src/client/**`.

## Do NOT flag

- `IAMTokenHandle` refreshing its token inside the loop: intentional, each retry needs a valid token.
- Language wrappers under `java/`, `python/` and `node/` that never call `reconnect` directly.

_(graduated from concern record_id=3c9b2f4e-7a1d-4e5b-8c6f-0d1a2b3c4d5e)_
