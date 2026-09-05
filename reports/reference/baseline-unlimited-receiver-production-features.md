# Run drain-20260905T140133Z

Postal 3.3.7, our build, source `250f8d03cec2`, profile `primary`, run class **scored**, kind **drain**.

> **Queue draining only** was measured: the queue was filled in advance, ingress was silent,
> and all the hardware went to the workers. Ingress is not measured in this run at all.


## Run parameters

| | |
|---|---|
| Postal image (requested) | `postal-bench/postal:src-250f8d03cec2` |
| Postal image (actually running) | `postal-bench/postal:src-250f8d03cec2` |
| Image source | `local` — built from the source in vendor/postal |
| Postal version | `3.3.7` |
| Source tree (built) | `250f8d03cec23787f61bc0a8808202e91d61aa6c` |
| Source tree (running) | `250f8d03cec23787f61bc0a8808202e91d61aa6c` |
| MariaDB image | `mariadb:11.4` |
| Worker replicas | 2 |
| Threads per worker | 2 (effective concurrency 4) |
| Main DB connection pool | 25 |
| IP pools (running) | disabled |
| Sink profile | `unlimited` |
| Sink per-IP concurrent sessions | unlimited |
| Sink per-IP connection rate | unlimited |
| Sink per-IP message rate | unlimited |
| Sink per-IP recipient rate | unlimited |
| Queue batching | enabled |
| Worker limits | 2.0 CPU / 1g |
| SMTP limits | 2.0 CPU / 1g |
| MariaDB limits | 2.0 CPU / 2g |
| Domain verification | through the bench DNS |

### Effective MariaDB variables

The values were read back from `information_schema.GLOBAL_VARIABLES` after startup:
a setting the server did not accept silently stays at its default, and the run then
measures something other than what the configuration records.

| Variable | Value |
|---|---|

### Load profile

| | |
|---|---|
| Target rate | 58 recipients/s |
| Recipients per message | 1 |
| MIME size | 100 KB |
| Destination domains | 1000 (zipf) |
| Warm-up / load | 180 s / 900 s |
| Sink response delay | 75 ms per response |

The warm-up runs as a separate generator invocation and is not part of the result:
the numbers below relate to the working phase only.

### Host roles

| Host | Groups |
|---|---|
| sut | postal_admin, postal_main_db, postal_message_db, postal_smtp, postal_web, postal_workers |
| aux | load_generators, monitoring, postal_load_balancers, postal_specs, postfix_sinks, test_dns |

## Results

| Metric | Value |
|---|---|
| Queue at the moment of the start | **14865** rows |
| of which ready to send | 14865 |
| of which deferred | 0 |
| **Queue drain rate** | **8.6** recipients/s |
| Delivered to the sink | 9331 |
| Accepted by the sink over the whole run | 9445 |
| Of them distinct recipients | 9438 |
| Drain time | 1080 s |
| Drain mode | `exhaust` |
| Ready rows exhausted | NO |
| Left in the queue | 5487 (of which in flight 27) |

The rate is computed over the ready rows: the worker will not take deferred ones until
`retry_after` expires, and including them in the dividend would mean dividing work
by a time during which it could not have been done.

> **Over the whole run the sink accepted 9445 messages but only 9438
> distinct recipients, a difference of 7.** The same addressee was
> delivered more than once, so throughput above is overstated by that proportion.
>
> Two causes produce this and they are told apart by the size of the difference. A large one
> means two worker containers share a hostname and are picking up each other's batches, which
> is a broken deployment. A handful means delivery is at-least-once: the receiver accepted the
> message but the acknowledgement never got back — a reset or a timeout after `DATA` — so
> Postal recorded a failure and tried again. Postal has no delivery-attempt identifier that
> would let a receiver discard the second copy, so this is inherent rather than a defect, and
> it gets more likely the more the receiver refuses.

### Throttling by the receiver

The sink imposed no per-IP limits: it accepted every session and every message from a single
address. That is an upper bound for Postal, not a forecast — no recipient provider behaves
this way. Everything below is reported for completeness.

| Metric | Value |
|---|---|
| Refusals recorded by the sink | 0 |
| Delivery attempts (all outcomes) | 9400 |
| Of them delivered | 9400 |
| **Retry amplification** | 1.0 attempts per delivered recipient |
| Attempt rate | 8.7 attempts/s |
| **Goodput** | 8.7 recipients/s delivered |
| Time to delivery p50 | 652.4 s |
| Time to delivery p95 | 1148.4 s |
| Time to delivery p99 | 1228.8 s |

Retry amplification is the work Postal did divided by the work that landed, and the gap
between the two rates above is the same thing per second. Every attempt beyond the first is a
full dequeue cycle — the claim query, the batch assembly, the MIME read, the SMTP session —
spent on a message that was refused. That is the cost of throttling which the drain rate alone
does not show: the worker can be saturated while goodput sits far below it.

Time to delivery is measured from acceptance to the delivery record, not from the HTTP call.
It is a different quantity from the ingress latency above: under throttling the two diverge
by the length of the retry ladder, and it is this one that the recipient experiences.
**In a drain run it is not a production figure and must not be quoted as one.** The queue was
filled in advance with the workers stopped, so the clock on the first message starts when the
prefill created it and runs through the whole fill before delivery even begins. What it
measures here is queue residency under a synthetic backlog. It is comparable between two runs
filled the same way, and to nothing else.
 Both
timestamps are Postal's own — the sink counted 9331 deliveries against
9400 recorded by Postal and 9427 rows used for
the percentiles. Those three should agree; a gap between the first two means the sink and the
database were not asked about the same window.


| Attempt outcome | Count |
|---|---|
| Sent | 9400 |




> **The ready rows were not exhausted within 900 s**,
> 5599 left. This is a result, not a failure: draining a queue of this
> length is slower than the time allotted.


## Reconciliation

```
accepted = (terminal states) + queued
15000 = 9560 + 5428
```

| Bucket | Recipients |
|---|---|
| Pending | 5440 |
| Sent | 9560 |
| In the queue | 5428 |
| In flight | 22 |
| **Unaccounted for** | **12** (0.08 %) |

`Pending`, `SoftFail` and `Error` are not part of the terminal side of the identity. None of
them is a finished delivery: the message still holds its queue row, and adding it to the queue
remainder as well would count it twice. `SoftFail` and `Error` matter as soon as the receiver
starts refusing — both go through `retry_later`, which puts the row back with `retry_after` in
the future. A message never ends its life in `SoftFail`: at the attempt ceiling Postal writes
`HardFail` and removes the row.


Independent delivery check: the sink recorded 9331 `status=sent`
lines, Postal counts
9560 as sent. Discrepancy
-229.


## Containment

The counter of outbound SMTP attempts leaving the bench, summed across
2 hosts: **0**.
A non-zero value means a message tried to escape to the public internet.

## What this run does not prove

- The sink answers with an artificial delay of 75 ms per
  response, which models the network latency of a real MX.
- The sink imposes no per-IP limits: unlimited concurrent sessions and unlimited volume from
  a single address, which no recipient provider allows. Retries, deferred delivery and
  suppression are therefore not exercised — the profile contains 100 % successful responses.
  Set `bench_sink_profile=provider` to measure against a receiver that refuses.
- In particular, the effective delivery concurrency reached here is not attainable from one
  address in production, and any conclusion about IP pools drawn from this run describes a
  receiver that does not throttle.
- The queue was filled with 14865 rows, and the result
  applies to exactly that length. Transferring it to another length is invalid: both
  hot worker queries are not covered by indexes, so the cost of processing
  a message depends on how many rows sit in the table.
- The domain distribution is quadratic rather than Zipf: the share of the hottest
  domain is lower than it would be with a true Zipf, which means Postal's batching
  is exercised less.
- The queue sampler runs a `COUNT(*)` over `queued_messages` every
  5 s on the same MariaDB as the system under test — that is
  the measuring apparatus's own load.
- The run lasted 1279 s. Extending it to a full day is extrapolation: the cost of
  processing a message grows with the accumulated volume.
