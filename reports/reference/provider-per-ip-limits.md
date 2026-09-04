# Run drain-20260904T155626Z

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
| Sink profile | `provider` — ASSUMED provider limits, not measured |
| Sink per-IP concurrent sessions | 10 |
| Sink per-IP connection rate | 200 / 60s |
| Sink per-IP message rate | 120 / 60s |
| Sink per-IP recipient rate | 120 / 60s |
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
| Queue at the moment of the start | **24557** rows |
| of which ready to send | 24557 |
| of which deferred | 0 |
| **Queue drain rate** | **12.4** recipients/s |
| Delivered to the sink | 3842 |
| Accepted by the sink over the whole run | 4310 |
| Of them distinct recipients | 4301 |
| Drain time | 311 s |
| Drain mode | `window` (fixed window of 300 s) |
| Ready rows exhausted | NO |
| Left in the queue | 20680 (of which in flight 68) |

The run was measured over a fixed window rather than to exhaustion. Under a binding per-IP
cap a refused row does not leave the queue — it returns to it with `retry_after` five minutes
out — so "no ready rows left" would mean "everything is either delivered or deferred", and a
rate divided by the starting row count would divide by work that was never going to be done
in this window. The rate above is what actually reached the sink per second of the window.

> **Over the whole run the sink accepted 4310 messages but only 4301
> distinct recipients, a difference of 9.** The same addressee was
> delivered more than once, so throughput above is overstated by that proportion.
>
> Two causes produce this and they are told apart by the size of the difference. A large one
> means two worker containers share a hostname and are picking up each other's batches, which
> is a broken deployment. A handful means delivery is at-least-once: the receiver accepted the
> message but the acknowledgement never got back — a reset or a timeout after `DATA` — so
> Postal recorded a failure and tried again. Postal has no delivery-attempt identifier that
> would let a receiver discard the second copy, so this is inherent rather than a defect, and
> it gets more likely the more the receiver refuses.

### Source addresses seen by the sink

Which outbound addresses the deliveries actually came from. With a pool configured, a single
address here means the pool is not in use at all; a strong skew means part of it is not.

| Address | Connections |
|---|---|
| `10.1.0.14` | 678 |
| `10.1.0.15` | 680 |
| `10.1.0.16` | 680 |
| `10.1.0.17` | 685 |
| `10.1.0.18` | 699 |
| `10.1.0.3` | 703 |
### Throttling by the receiver


| Metric | Value |
|---|---|
| Refusals recorded by the sink | 16900 |
| Delivery attempts (all outcomes) | 21313 |
| Of them delivered | 4124 |
| **Retry amplification** | 5.17 attempts per delivered recipient |
| Attempt rate | 68.5 attempts/s |
| **Goodput** | 13.3 recipients/s delivered |
| Time to delivery p50 | 365.6 s |
| Time to delivery p95 | 543.8 s |
| Time to delivery p99 | 547.4 s |

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
timestamps are Postal's own — the sink counted 3842 deliveries against
4124 recorded by Postal and 4125 rows used for
the percentiles. Those three should agree; a gap between the first two means the sink and the
database were not asked about the same window.


| Attempt outcome | Count |
|---|---|
| Sent | 4124 |
| SoftFail | 17189 |

#### Which limit was hit

Taken from the receiver's log rather than from the reply Postal recorded: smtpd answers
`421 ... too many connections` for both the concurrency cap and the connection RATE cap, so
the reply cannot tell them apart and a breakdown built from it files every rate rejection
under concurrency.

A run dominated by `Connection_rate` is measuring how often Postal opens a session, not how
much volume the receiver allows. Postal reuses a session for only 1.4 to 3.35 messages, so a
connection-rate cap binds well below the message-rate one unless it is set several times
higher — which is why the `provider` profile sets it high on purpose.

| Limit | Rejections |
|---|---|
| Connection_concurrency | 8 |
| Message_delivery_request_rate | 16921 |

#### Refusals per source address

Taken from the receiver's own log, so this is independent of Postal. An address that appears
here is one whose quota was exhausted; an address that does not is one with headroom left.

| Address | Refusals |
|---|---|
| `10.1.0.14` | 2846 |
| `10.1.0.15` | 2821 |
| `10.1.0.16` | 2957 |
| `10.1.0.17` | 2719 |
| `10.1.0.18` | 2775 |
| `10.1.0.3` | 2861 |

#### How many sending addresses the target rate needs

On this run 6 addresses delivered
12.4 recipients/s in total as counted by the receiver,
i.e. **2.06 recipients/s per address**, against an allowance of
2.0/s per address.

The addresses were at their quota, so throughput here is bounded by the provider rather than
by Postal, and it scales with the number of addresses rather than with cores. Reaching the
target of 58 recipients/s therefore needs
**about 29 sending
addresses**.

This figure is only as good as the limits it was measured against, and those limits are an
assumption: nobody has supplied the destination-domain mix or the throttling actually
observed in production. Read it as the shape of the answer — that capacity is bought in
addresses, not in cores — and not as a procurement number. It also assumes every destination
throttles alike, whereas a real mix has a few large providers with hard limits and a long
tail with looser ones.

Ready rows were still available when the window closed (3981 left),
which is what a window run wants: the worker never went idle, so the rate above is the rate
it sustained rather than an average diluted by an empty queue.


## Reconciliation

```
accepted = (terminal states) + queued
25000 = 4320 + 20680
```

| Bucket | Recipients |
|---|---|
| Pending | 2864 |
| Sent | 4320 |
| SoftFail | 17816 |
| In the queue | 20680 |
| In flight | 60 |
| **Unaccounted for** | **0** (0.0 %) |

`Pending`, `SoftFail` and `Error` are not part of the terminal side of the identity. None of
them is a finished delivery: the message still holds its queue row, and adding it to the queue
remainder as well would count it twice. `SoftFail` and `Error` matter as soon as the receiver
starts refusing — both go through `retry_later`, which puts the row back with `retry_after` in
the future. A message never ends its life in `SoftFail`: at the attempt ceiling Postal writes
`HardFail` and removes the row.

Deferred in this run: **17816** recipients awaiting a retry. Postal's ladder is
`(1.3 ^ attempts) x 5 minutes`, so the first retry is five minutes out and the eighteen
attempts span roughly 31 hours. None of these recipients could have been delivered inside this
run, and they are not a defect — they are what a receiver's limits do to a queue.

Independent delivery check: the sink recorded 3842 `status=sent`
lines, Postal counts
4320 as sent. Discrepancy
-478.


## Containment

The counter of outbound SMTP attempts leaving the bench, summed across
2 hosts: **0**.
A non-zero value means a message tried to escape to the public internet.

## What this run does not prove

- The sink answers with an artificial delay of 75 ms per
  response, which models the network latency of a real MX.
- The receiver's limits are an ASSUMPTION. Nobody has supplied the destination-domain mix or
  the throttling actually observed in production, so `bench_sink_profiles.provider`
  holds typical values for a large MX. Every number derived from them — above all the count of
  sending addresses — inherits that status.
- All destinations throttle identically here. A real mix is a few large providers with hard
  limits and a long tail with looser ones, and the aggregate ceiling of such a mix is not the
  ceiling measured against one uniform limit.
- Greylisting and reputation-based daily quotas are not modelled at all, and neither are
  permanent rejections: the only failures in this run are the ones the caps produced.
- The queue was filled with 24557 rows, and the result
  applies to exactly that length. Transferring it to another length is invalid: both
  hot worker queries are not covered by indexes, so the cost of processing
  a message depends on how many rows sit in the table.
- The domain distribution is quadratic rather than Zipf: the share of the hottest
  domain is lower than it would be with a true Zipf, which means Postal's batching
  is exercised less.
- The queue sampler runs a `COUNT(*)` over `queued_messages` every
  5 s on the same MariaDB as the system under test — that is
  the measuring apparatus's own load.
- The run lasted 663 s. Extending it to a full day is extrapolation: the cost of
  processing a message grows with the accumulated volume.
