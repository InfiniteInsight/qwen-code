# Cost tracking

The gateway prices every usage-bearing `session_update` against an operator rate
table, stores it durably, and exposes per-session / per-client / per-sub-actor /
per-model aggregates (`add-cost-tracking`).

## How it works

- **Rate table** — `~/.qwen/rc/model-rates.yaml` maps `(modelServiceId, modelId)`
  to per-million-token cent prices (`inputPerMTok`, `outputPerMTok`,
  `cachedReadPerMTok`) plus a `currencyLabel`. Built-in Qwen defaults apply when
  the file is absent; a malformed edit retains the last good table and audits
  `rate_table_parse_failed`. An unpriced model writes a row with a NULL cost
  and audits `rate_table_miss` - visibly unpriced, never silently free. The audit
  row is collapsed to one per (session, model id) per hour; the unpriced usage
  rows themselves are still written every time.
- **Model matching** - two passes. First an exact match on the model id as the
  daemon names it; if that misses, the id with one trailing `(provider)` group
  removed (`flint(openai)` is retried as `flint`). So one table entry prices every
  provider spelling of a model, and an exact entry such as `flint(openai)` still
  wins when you want a different price for one provider. Each stored row records
  the table entry that priced it (`rate_key`, e.g. `qwen/flint`) and which pass
  matched (`rate_match`: `exact` or `stripped`).
- **Cached tokens** - the daemon's `inputTokens` already INCLUDES the cached
  subset. A row is priced as `(inputTokens - cachedReadTokens) * inputPerMTok +
  cachedReadTokens * cachedReadPerMTok + outputTokens * outputPerMTok`; the stored
  `tokens_in` / `tokens_cached` keep what the daemon reported. `cachedReadPerMTok`
  is required in the table (there is no implicit fraction of the input rate).
- **Ingestion** — the always-on session-event pump (which runs whenever push OR
  cost tracking is enabled) feeds every `session_update` to the usage feeder. When
  an `agent_message_chunk` frame carries usage (`data.update._meta.usage`), a row is
  written to `~/.qwen/rc/usage.db` (`usage_events`), attributed to the prompt's
  originating client token and its bridge `sub_actor` if any. Ingestion is
  additive - it never modifies or delays the SSE frame to subscribers.
- **Model id** - the frame does not carry one (see "The live frame shape"), so the
  gateway keeps a per-session cache (`SessionModelCache`). It is seeded on first
  sight of a session from the daemon's `GET /session/:id/context` (the model
  flagged `isCurrent`, or `current.modelId`), falling back to the session
  transcript's last assistant model when the daemon cannot be read, and kept
  current by `model_switched` frames. A usage frame that arrives before the id is
  known waits in a small bounded queue (10 s, 64 frames per session) and is
  written, with its arrival time and attribution, once the id arrives. A frame
  that never gets one is written with an empty model id, i.e. visibly unpriced,
  and one `usage_model_unresolved` audit row says how many; it is not dropped.
- **Storage** — SQLite via the optional native `better-sqlite3` (same isolation as
  ranked search). If that dependency is not built, cost tracking is **disabled**
  (logged at boot) and the gateway runs normally.

## Querying

```
GET /rc/usage?since=24h&until=&group_by=session|client|sub_actor|model&format=json|csv
```

`since`/`until` accept a relative duration (`24h`, `7d`, `30m`) or ISO-8601;
`since` defaults to `24h`. **Scope filtering:** an `owner` token sees all rows;
every lesser scope (`write`/`approve`/`read`/`bridge`) sees only rows attributed
to its own token id. The filter is derived from the caller's token, never a query
param, so a caller cannot widen its own view. `format=csv` returns `text/csv` with
the header `key,displayLabel,tokensIn,tokensOut,tokensCached,costCents`.

## The live frame shape

Measured against a live `qwen serve` (Qwen-Code-Remote#160, #181), not inferred.
A model turn arrives as a `session_update` whose `data.update.sessionUpdate` is
`agent_message_chunk` and whose `_meta` holds:

```
_meta.usage = { inputTokens, outputTokens, totalTokens, cachedReadTokens }
_meta.timestamp, _meta.qwenTranscript   (no model id anywhere)
```

`buildUpdateMeta` in `acp-bridge/src/transcript-replay.ts` emits only `usage`,
`timestamp` and `qwenTranscript` (plus a few non-usage keys on other frames), so
the model id has to come from outside the frame, which is what the model cache
above does. Live model ids look like `flint(openai)` and
`qwen3.8-flash-next-trtllm(openai)`; the transcripts record the bare id
(`qwen3.8-flash-next-4s`). Rows written before the fix have `model_id = ''`, a NULL
cost and `tokens_cached = 0`; the cached counts of those old rows cannot be
recovered, the rest can be repriced (below).

Verification: the full pump → feeder → ingester → store path is covered by an
integration test that replays this exact frame against a stub daemon whose
`/context` names the model. What it cannot prove is that every future daemon
build keeps emitting the same shape.

## Live usage_tick + capability

After writing a row the ingester pushes a coalesced `usage_tick` (≤1 per 500 ms
per session) to a per-session broadcaster; each `/rc/session/:id/events` relay
registers as a listener and injects a `{ type: "usage_tick", data: { sessionId,
costCentsSessionTotal, costCentsPromptTotal, tokensInTotal, tokensOutTotal } }`
frame onto its SSE stream — with **no `id:`** so it never advances the client's
Last-Event-ID cursor. `GET /rc/capabilities` advertises
`remoteControl.costTracking { enabled, currencyLabel, rateTablePath }` (the
gateway's `/rc`-prefixed surface, since the daemon's `/capabilities` is
un-editable under the fork boundary).

## Operator CLI

```
qwen-rc usage [--since 24h] [--group-by session|client|sub_actor|model] \
              [--sub-actor <s>] [--format json|csv|table]
qwen-rc usage prune --before <iso-8601> [--yes]
qwen-rc usage reprice [--dry-run] [--db <path>] [--chats-dir <dir>]
```

Both are daemon-free — they open the same `~/.qwen/rc/usage.db` the gateway writes.
`usage` defaults to a 24h / by-session / table view; `prune` deletes rows older
than `--before` (prompting unless `--yes`) and prints `<n> rows removed`.

`reprice` is a one-shot backfill for rows written before the model-id fix: every
row with an empty model id or a NULL cost gets its model from the session
transcript (`--chats-dir` is looked in first, then every project's `chats/`
directory) and is priced with the current rate table, using the same cached-token
split and `(provider)` fallback as live ingestion. It prints how many rows it
examined, filled, priced, could not price and could not resolve. `--dry-run`
reports without writing; `--db` points at a copy of the database. Caveat: a
transcript names the session's LATEST model, so rows from a session that switched
models mid-conversation are priced at the final one. It is safe to re-run; rows it
cannot price are left untouched.

## Rate-table hot-reload

The gateway watches `~/.qwen/rc` for `model-rates.yaml`: a valid edit swaps the
live table within a 250 ms debounce (no restart); a malformed edit retains the
previous table and audits `rate_table_parse_failed`.
