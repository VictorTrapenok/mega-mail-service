# Our changes to Postal

The patch log for the fork in [vendor/postal/](../vendor/postal/). One section per change:
what it does, why it is safe, what it is expected to buy, and — separately — whether that
has been measured. A change with no measurement is a hypothesis, and it is recorded here as
one until a run says otherwise.

`git diff` over `vendor/postal/` is the authoritative patch set; this file explains it.

| # | Change | Schema | Status |
|---|---|---|---|
| 1 | Index-seekable batch collection | none | implemented, suite green, **performance not measured** |

---

## 1. Index-seekable batch collection

**File:** [vendor/postal/app/models/queued_message.rb](../vendor/postal/app/models/queued_message.rb),
`QueuedMessage#batchable_messages`.

**Schema change: none.** It uses an index that already exists in every Postal installation.

### What the query does today

Having claimed one message, the worker collects up to 100 more that can go out in the same
SMTP session:

```sql
UPDATE queued_messages SET locked_by = ?, locked_at = ?
 WHERE batch_key = 'outgoing-example.com'
   AND ip_address_id = 42
   AND locked_by IS NULL AND locked_at IS NULL
   AND (retry_after IS NULL OR retry_after < NOW())
 LIMIT 100;
```

`queued_messages` carries exactly three indexes — `domain` (8-character prefix),
`message_id` and `server_id`. Neither `batch_key` nor `ip_address_id` is among them, so
MySQL has nothing to seek on and scans the table by primary key. `LIMIT 100` stops the scan
either at a hundred collected rows or **at the end of the table**.

A hundred is what does not get collected once an IP pool is in use. A batch candidate has to
match both the recipient domain and the outbound address, and `allocate_ip_address` picks
the address at random (`ORDER BY RAND() * priority`), so a pool of N addresses divides the
candidates by N. With a pool of 254 a hundred candidates would need roughly 25 000 queue
rows of one domain — which the head domains might have and the long tail never will. So for
most messages the query runs to the end of the table. Twice, in fact: the second query,
which reads back what was just locked, has the same predicates and the same problem.

That is per message the worker delivers, so the cost of a delivery grows with the length of
the queue multiplied by the number of worker threads competing for the same buffer pool.

### The change

`batch_key` for an outgoing message is `"outgoing-" + recipient_domain`, and `domain` is
written from the same `recipient_domain` in the same `QueuedMessage.create!`
([lib/postal/message_db/message.rb](../vendor/postal/lib/postal/message_db/message.rb),
`add_to_message_queue` and `batch_key`). Every row sharing an outgoing `batch_key`
therefore shares its `domain`, and adding

```sql
   AND domain = 'example.com'
```

changes no result while handing MySQL `index_queued_messages_on_domain` to seek on.

The predicate is added only when this row's own values satisfy the invariant
(`batch_key == "outgoing-#{domain}"`), never on the assumption that they do. Incoming batch
keys are built from the route and the endpoint and carry no relation to the domain, so they
keep the old plan.

### Why it is safe to run on a live installation

- **No schema change**, no migration, no lock on a large table, nothing to roll back in the
  database. Reverting is redeploying the previous image.
- **No new behaviour on the write path.** Nothing about how messages are created, locked,
  retried or delivered changes.
- **The worst case is a message that was not batched.** The predicate can only exclude a row
  whose `domain` disagrees with its `batch_key` — possible on a legacy or truncated row, not
  on one written by current code. Such a row is not claimed into this batch and is delivered
  in a session of its own on the next tick. It is never lost, never claimed twice and never
  delivered twice.
- The two cases are pinned by specs in
  [spec/models/queued_message_spec.rb](../vendor/postal/spec/models/queued_message_spec.rb).
  The existing upstream specs use a batch key of `"1234"`, which does not satisfy the
  invariant, so they exercise the unchanged path.

**Postal's suite passes on this tree: 812 examples, 0 failures** — both locally via
`playbooks/rspec.yml` and in CI. The two new examples were confirmed to run by
name rather than inferred from the total:

```
QueuedMessage
  #batchable_messages
    when the message is locked
      when the batch key is derived from the domain
        finds and locks messages sharing that batch key and domain
        does not find messages whose domain disagrees with the batch key

2 examples, 0 failures
```

That establishes correctness, and nothing about speed.

### What it is expected to buy, and what it will not

The win is concentrated in the long tail, which is where most messages are. A domain with
fifty rows in the queue goes from a scan of the whole table to about fifty index entries.

For a head domain it helps far less. If Gmail is 30 % of a 500 000-row queue, the index
range is still 150 000 entries, and they are then filtered by `ip_address_id`, which matches
one in 254. That is better than scanning 500 000 full rows, but it is not narrow. Fixing the
head case properly needs a composite index led by `ip_address_id` — a schema change, and the
next step once this one has been measured.

There is no expected gain at all on a short queue. The bench has already demonstrated this
regime: a drain series at 4851 and 9938 rows gave the same 20.8 recipients/s, because a scan
of ten thousand cached rows disappears against the ~96 ms a message costs.

### How to verify it before trusting it

**First, that MySQL actually uses the index.** The optimiser is free to ignore it, and if it
does the patch buys nothing:

```sql
EXPLAIN SELECT id FROM queued_messages
 WHERE batch_key = 'outgoing-example.com' AND domain = 'example.com'
   AND ip_address_id = 42
   AND locked_by IS NULL AND locked_at IS NULL
   AND (retry_after IS NULL OR retry_after < NOW())
 LIMIT 100;
```

`key` must read `index_queued_messages_on_domain`. If it reads `NULL` with `type: ALL`, the
optimiser refused: run `ANALYZE TABLE queued_messages` and look again. If it still refuses,
the patch is inert and the alternatives are in "Not done yet" below.

**Then, that it is worth anything.** On the bench, with the arms that reproduce the regime —
a queue of 10⁵ or more rows and a pool of many addresses. Neither exists yet; both are in
the [roadmap](../roadmap.md). Running this comparison at ten thousand rows and six addresses
will show nothing and prove nothing.

### Not done yet

- **Measurement.** The suite is green, but not one number about throughput has been
  produced. Whether this query was ever a bottleneck in a regime that matters remains a
  hypothesis.
- **The head-domain case**: a composite index led by `ip_address_id`. Deliberately deferred —
  a schema change is the thing that cannot be tested cheaply on a live installation.
- **Bounding the scan by primary key.** Adding `id > <this row's id>` would let MySQL start
  at the current position instead of the beginning of the table, which is the one thing that
  would help the head domains without an index. The argument that it is safe — the claim
  query takes the lowest ready row for our addresses, so ready partners on the same address
  have higher ids — rests on InnoDB scanning the primary key in ascending order, which is an
  implementation detail and not a guarantee. It is therefore a heuristic: it can miss a
  partner, and a missed partner costs one extra SMTP session and nothing else. Worth doing
  only if `EXPLAIN` shows the domain index is not enough.
