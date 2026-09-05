# What the bench measured

A summary of the findings this bench has produced so far, and — just as importantly — of what
it has not established yet. The methodology is in [ARCHITECTURE.md](ARCHITECTURE.md), the
Postal internals the conclusions rest on are in
[docs/postal-internals.md](docs/postal-internals.md), and the full narrative with every wrong
turn is in [CHANGELOG.md](CHANGELOG.md).

Reference runs are in [reports/reference/](reports/reference/). Every run in this project
carries its own "what this run does not prove" section; the claims below inherit those limits.

## The short version

Postal's own throughput is not what stands between a modest server and 5 million recipients
per day. On a 2 vCPU virtual machine the stock 3.3.7 image delivered **46–51 recipients per
second**, which is 4.0–4.4 million per day, with the reconciliation identity closing exactly.

What does bind, and what the bench was extended to measure, is the receiving side. Under
per-IP limits the same Postal, on the same hardware, working *harder*, delivered a quarter as
much. Throughput then scales with the number of sending addresses, not with cores.

## The two reference runs

Identical in everything but the receiver's policy: 6 outbound addresses, 75 ms artificial
response delay on the sink, 2 worker replicas × 2 threads, 1000 destination domains,
100 KB MIME, one recipient per message.

| | Baseline | Per-IP limits |
|---|---|---|
| Receiver policy | accepts everything | 120 messages/min per address |
| Queue at start | 14 455 | 24 557 |
| Delivery attempts per second | 46.3 | 68.5 |
| **Delivered, recipients/s** | **46.3** | **13.3** |
| Attempts per delivered recipient | 1.00 | 5.17 |
| Refusals recorded by the receiver | 0 | 16 900 |
| Reconciliation discrepancy | 0 % | 0 % |

The attempt rate *rose* under the cap, because a temporary refusal arrives at `MAIL FROM` and
the message body is never transferred, so the worker cycles faster. Five of every six dequeue
cycles bought nothing. None of this is visible in a delivery-rate figure, which counts only
what arrived — which is why the bench reports both.

Which limit bound is worth checking before any of these numbers are used: 16 921 of the
refusals were the volume cap and 8 were the concurrency cap. A concurrency cap alone does not
bind at this delivery concurrency, and the two are indistinguishable in the SMTP reply — both
answer `421 ... too many connections` — so the bench classifies them from the receiver's log
instead.

## What this says about capacity planning

Under the modelled limits each address delivered 2.06 recipients/s against an allowance of
2.0, i.e. the addresses were at their quota. On that basis the target of 58 recipients/s
needs **about 29 sending addresses**.

That number is only as good as the limits behind it, and **those limits are an assumption**.
No destination-domain mix or observed production throttling has been supplied, so the profile
holds typical values for a large mailbox provider. Read the figure as the shape of the answer
— capacity is bought in addresses, not in cores — rather than as a procurement number. The
report refuses to print it at all unless the addresses actually reached their quota during the
run, because otherwise it would describe the sender's speed while reading as the receiver's
limit.

## A large IP pool is what our changes are aimed at

This is the finding with the most operational consequence, and it is what our work on the
code targets: an installation sending from a large pool of addresses is the case Postal
handles worst, and therefore the case with the most to gain.

`QueuedMessage` binds an outbound address to a message with `before_create :allocate_ip_address`
— at the moment the message is accepted, hours before it is sent, by weighted random choice
(`ORDER BY RAND() * priority DESC`). Batching then requires a match on **both** the recipient
domain and that address:

```ruby
self.class.ready.where(batch_key: batch_key, ip_address_id: ip_address_id, ...)
```

So a pool of N addresses divides the batch candidates by roughly N. Measured, same profile:

| Configuration | Rate | Connections per 3000 messages | Messages per session |
|---|---|---|---|
| One address | 50.0/s | 896 | 3.35 |
| Pool of 6 | 34.1/s | 2114 | 1.42 |

Six addresses made SMTP sessions 2.4× more numerous and cost a third of the throughput. Each
extra session pays again for the TCP handshake, EHLO, the MAIL/RCPT/DATA round trips and at
least three uncached DNS queries.

The arithmetic extrapolates: forming a batch of K messages needs roughly K × domains ×
addresses rows in the queue. At 1000 domains and a few hundred addresses, even a batch of two
requires a queue in the hundreds of thousands — in other words, batching stops happening at
all and every message becomes its own session.

A large pool is not optional: recipient providers cap volume per source address, so the
addresses are what buys the aggregate rate. The pool is a deliverability requirement, and the
cost above is a property of Postal's implementation rather than of the pool.

That is precisely where our changes apply. The larger the pool, the rarer it is for batch
collection to find a partner and the more work Postal does per message — so the bigger the
pool, the more there is to recover in the code. The first change is described in
[docs/optimisations.md](docs/optimisations.md); measuring it needs a bench arm with many
addresses, which the hardware available so far cannot provide.

## What limits a receiver can impose, and which one binds

The four Postfix per-client limits are not independent, and choosing them carelessly measures
the wrong one. Postal reuses an SMTP session for only 1.4–3.35 messages, so a connection-rate
cap binds well below the message-rate cap unless it is set several times higher. `smtpd` also
answers `421 ... too many connections` for **both** the concurrency cap and the connection
rate cap, so the reply cannot distinguish them; the bench classifies refusals from the
receiver's log, which names the limit outright.

A concurrency cap alone was measured as unable to bind at this delivery concurrency: worker
threads spend much of their time in the database and the effective session count never
reached it. Volume limits bind at any concurrency, and they are what a provider actually
meters.

## Where Postal cannot help itself

Three properties come straight from the source and none of them is configurable:

- **No per-destination rate accounting exists.** Searching `app/` and `lib/` for throttling,
  rate limiting, token buckets or backpressure returns nothing. The only "limit" is
  `send_limit`, a per-server volume quota unrelated to destinations or addresses.
- **A refusal defers the message by five minutes**, from `(1.3 ** attempts) × 5.minutes` in
  `HasLocking#retry_later`, with the base period hardcoded. Receivers commonly meter volume
  over about a minute, so Postal empties a window's quota in a burst, is refused for the rest
  of it, and the refused work parks for five minutes instead of the seconds until the quota
  rolls over.
- **Three serialisation points live in the installation's shared database** and do not improve
  with more nodes: `Statistic.global.increment!` twice per message against a single row,
  `UPDATE servers SET send_limit_*` per delivery, and `UPDATE raw_message_sizes` per accepted
  message.

Together these are the argument for pacing output to the receiver's rate rather than raising
delivery concurrency, and for sharding an installation rather than distributing one.

## Delivery is at-least-once, and the bench can see it

On the throttled run the receiver accepted 4310 messages but only 4301 distinct recipients.
Nine recipients were delivered twice. That is not a deployment fault here — the worker
containers have distinct hostnames — but the ordinary consequence of an ambiguous outcome: the
receiver took the message and the acknowledgement did not get back, so Postal recorded a
failure and tried again. Postal carries no delivery-attempt identifier that would let a
receiver discard the second copy, so the more a receiver refuses, the more of this there is.

It is worth stating because it bounds what any throughput figure means: delivered counts are
upper bounds on distinct recipients reached, and the bench now reports both so the gap cannot
hide.

## What the bench does not establish

Stated plainly, because the numbers above are worth only as much as their limits:

- **Sustained throughput has never been measured.** Every result here is a drain run against a
  pre-filled queue. Ingress and delivery have not been run together at the target rate, and
  that combined figure is the only one that extrapolates to a full day.
- **Single runs, no repeats.** The spread between repeats of the same build is unknown, so a
  small difference between two runs cannot be read as a result.
- **The SMTP submission path is not exercised.** The generator uses the HTTP API. Postal's
  SMTP ingress, its authentication and the `credentials` table — which carries no indexes at
  all — never see load.
- **The sink is not a real MX.** No greylisting, no reputation effects, no connection
  failures, and every destination throttles identically where a real mix has tiers.
- **Queue lengths above roughly 25 000 rows are untested**, and both hot worker queries are
  uncovered by indexes.
- **`send_limit` is disabled by the seeding, the MariaDB binlog is off, tracking and webhooks
  are not wired.** Each of those is real production work that these runs do not perform.

## Open questions

1. Where exactly was the current production limit measured — ingress, queue growth, connection
   attempts, or confirmed responses from remote MX hosts? Those are different quantities.
2. The production feature mix: recipients per message, p95 MIME size, tracking, DKIM, webhooks.
3. How many outbound addresses are in use, and how many SMTP credentials exist in the
   installation.
4. Retention: 5M recipients at 100 KB is roughly 500 GB of raw message data per day.
