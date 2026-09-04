# Run drain-20260904T153101Z

Postal 3.3.7, profile `primary`, run class **scored**, kind **drain**.

> **Queue draining only** was measured: the queue was filled in advance, ingress was silent,
> and all the hardware went to the workers. Ingress is not measured in this run at all.


## Run parameters

| | |
|---|---|
| Postal image (requested) | `undetermined: the fact cache is empty, see the actually running image` |
| Postal image (actually running) | `ghcr.io/postalserver/postal@sha256:e54b4a7eb106ee15eda5664311c4b9415546d4196f5c4336d23a78d6ce57b819` |
| Image reference | `3.3.7` |
| MariaDB image | `mariadb:11.4` |
| Worker replicas | 2 |
| Threads per worker | 2 (effective concurrency 4) |
| Main DB connection pool | 25 |
| IP pools (running) | enabled, 6 outbound addresses |
| | **The configuration says `postal_use_ip_pools=False` while the running container says `true`.** Postal was not redeployed after the variable changed. The row above reports what actually ran. |
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
| aux | load_generators, monitoring, postal_load_balancers, postfix_sinks, test_dns |

## Results

| Metric | Value |
|---|---|
| Queue at the moment of the start | **14455** rows |
| of which ready to send | 14455 |
| of which deferred | 0 |
| **Queue drain rate** | **46.0** recipients/s |
| Delivered to the sink | 14578 |
| Accepted by the sink over the whole run | 15000 |
| Of them distinct recipients | 15000 |
| Drain time | 317 s |
| Drain mode | `exhaust` |
| Ready rows exhausted | yes |
| Left in the queue | 0 (of which in flight 0) |

The rate is computed over the ready rows: the worker will not take deferred ones until
`retry_after` expires, and including them in the dividend would mean dividing work
by a time during which it could not have been done.


### Source addresses seen by the sink

Which outbound addresses the deliveries actually came from. With a pool configured, a single
address here means the pool is not in use at all; a strong skew means part of it is not.

| Address | Connections |
|---|---|
| `10.1.0.14` | 2504 |
| `10.1.0.15` | 2400 |
| `10.1.0.16` | 2479 |
| `10.1.0.17` | 2420 |
| `10.1.0.18` | 2387 |
| `10.1.0.3` | 2502 |
### Throttling by the receiver

The sink imposed no per-IP limits: it accepted every session and every message from a single
address. That is an upper bound for Postal, not a forecast — no recipient provider behaves
this way. Everything below is reported for completeness.

| Metric | Value |
|---|---|
| Refusals recorded by the sink | 0 |
| Delivery attempts (all outcomes) | 14692 |
| Of them delivered | 14692 |
| **Retry amplification** | 1.0 attempts per delivered recipient |
| Attempt rate | 46.3 attempts/s |
| **Goodput** | 46.3 recipients/s delivered |
| Time to delivery p50 | 281.3 s |
| Time to delivery p95 | 376.9 s |
| Time to delivery p99 | 379.4 s |

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
timestamps are Postal's own — the sink counted 14578 deliveries against
14692 recorded by Postal and 14692 rows used for
the percentiles. Those three should agree; a gap between the first two means the sink and the
database were not asked about the same window.


| Attempt outcome | Count |
|---|---|
| Sent | 14692 |






## Reconciliation

```
accepted = (terminal states) + queued
15000 = 15000 + 0
```

| Bucket | Recipients |
|---|---|
| Sent | 15000 |
| In the queue | 0 |
| In flight | 0 |
| **Unaccounted for** | **0** (0.0 %) |

`Pending`, `SoftFail` and `Error` are not part of the terminal side of the identity. None of
them is a finished delivery: the message still holds its queue row, and adding it to the queue
remainder as well would count it twice. `SoftFail` and `Error` matter as soon as the receiver
starts refusing — both go through `retry_later`, which puts the row back with `retry_after` in
the future. A message never ends its life in `SoftFail`: at the attempt ceiling Postal writes
`HardFail` and removes the row.


Independent delivery check: the sink recorded 14578 `status=sent`
lines, Postal counts
15000 as sent. Discrepancy
-422.


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
- The queue was filled with 14455 rows, and the result
  applies to exactly that length. Transferring it to another length is invalid: both
  hot worker queries are not covered by indexes, so the cost of processing
  a message depends on how many rows sit in the table.
- The domain distribution is quadratic rather than Zipf: the share of the hottest
  domain is lower than it would be with a true Zipf, which means Postal's batching
  is exercised less.
- The queue sampler runs a `COUNT(*)` over `queued_messages` every
  5 s on the same MariaDB as the system under test — that is
  the measuring apparatus's own load.
- The run lasted 533 s. Extending it to a full day is extrapolation: the cost of
  processing a message grows with the accumulated volume.
