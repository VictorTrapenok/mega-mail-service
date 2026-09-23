# Postal mail server performance FAQ

Answers to the questions people ask when a [Postal](https://github.com/postalserver/postal)
installation cannot keep up. Every answer comes from a measurement on this project's bench or
from reading the Postal source. The link after each one leads to the evidence. Figures are
for Postal 3.3.x on a 2 vCPU machine, 100 KB messages, one recipient per message, unless
stated otherwise.

If your installation shows one of these symptoms and you want it looked at,
[contact me on LinkedIn](https://www.linkedin.com/in/victor-trapenok/).

## Throughput and capacity

### How many emails per second can Postal send?

Stock Postal 3.3.7 delivered **46–51 recipients per second** on 2 vCPU when the receiving
server accepted everything, which is 4.0–4.4 million a day. That is an upper bound. With
per-IP limits on the receiving side it fell to 13.3/s. With `send_limit`, tracking and
webhooks on it fell to 8.6/s.
→ [RESULTS.md](../RESULTS.md)

### Can Postal send 1 million, or 5 million, emails a day?

Five million a day is 58 recipients/s on average, and the same load compressed into a
two-hour window is 694/s. Postal's own code reaches the daily figure on two cores. What
usually stands in the way is configuration (delivery concurrency, database pool), receiver
throttling and the cost of tracking and webhooks. None of these is a CPU shortage.
→ [postal-optimization-guide.md](postal-optimization-guide.md#the-scale-of-the-target-load)

### Why is my Postal queue growing?

In order of how often it is the cause:

1. **Too little delivery concurrency.** Each worker thread delivers one message at a time
   and spends most of that time waiting on the remote server.
2. **A database pool smaller than the number of threads**, which quietly serialises them.
3. **Receivers throttling your IPs.** Refused messages go back into the queue for five
   minutes or more.
4. **Webhooks and tracking**, which add work to every delivery on the same worker.

→ [postal-tuning-checklist.md](postal-tuning-checklist.md)

### How many worker threads should Postal run?

Delivery rate ≈ concurrent deliveries ÷ time per delivery. With a realistic 75 ms remote
response time, 4 concurrent deliveries gave 7.1 recipients/s and 32 gave 51.3, on the same
two cores. The worker's CPU sat at 20 % in the slow case. `WORKER_THREADS` defaults to **2**,
so two worker replicas at defaults can only deliver about 7 recipients/s against real
servers. Raise threads × replicas until CPU or the database becomes the limit, not before.
→ [postal-optimization-guide.md](postal-optimization-guide.md#measured-findings-on-the-2-vcpu-bench)

### What should `MAIN_DB_POOL_SIZE` be?

At least the number of threads in each process. It defaults to **5**. A pool smaller than
`WORKER_THREADS` makes the extra threads wait for a connection, and nothing reports it.
Check MariaDB's `max_connections` against the sum across all processes.

### Will more CPU cores make Postal faster?

For delivery, rarely: it waits on the network, not on the processor. For the HTTP API,
cores help only with more processes. A single Puma process tops out at one core (Ruby's
GVL). One process accepted about 28 recipients/s, and two behind a load balancer 56.7/s.
The measured CPU cost is about **25 ms per message to accept and 32–35 ms to deliver**, so
58 recipients/s needs roughly 3.5 cores in total.
→ [postal-optimization-guide.md](postal-optimization-guide.md#measured-findings-on-the-2-vcpu-bench)

### Will adding servers or worker nodes scale Postal?

Only until the shared database becomes the limit. Every message updates the single global
`statistics` row twice, updates its `servers` row when `send_limit` is set, and updates a
per-day `raw_message_sizes` row. Adding nodes does not relieve any of those. Several
independent Postal installations side by side scale further than one large one.
→ [postal-internals.md](postal-internals.md#serialisation-points)

### How much storage does high-volume Postal need?

Postal stores a separate copy of the message for every recipient. Five million recipients at
100 KB is about **500 GB of raw message data per day**, before indexes, replication and
backups. Retention matters as much as CPU when planning.

## IP addresses and deliverability

### How many sending IP addresses do I need?

Under per-IP limits typical of a large mailbox provider, each address sustained about 2
recipients/s. At 58 recipients/s that means **about 28–29 addresses**. The number comes from
the receivers' policy, not from Postal, so measure your real throttling before buying IPs.
→ [RESULTS.md](../RESULTS.md#what-this-says-about-capacity-planning)

### Do IP pools make Postal slower?

Yes, per message. Postal assigns an outbound IP to each message at random when it is
accepted, and only sends messages in one SMTP session if they share both the domain and the
IP. Six addresses instead of one produced 2.4× more SMTP connections and cut throughput from
50.0 to 34.1 recipients/s. With hundreds of addresses, batching effectively stops.
→ [RESULTS.md](../RESULTS.md#large-ip-pools-defeat-postal-batching)

### Postal with IP pools sends nothing in Docker. Why?

The worker finds its sending IPs by listing the addresses of its own network namespace. On a
Docker bridge network it sees only `172.x`, matches no row in `ip_addresses` and processes
nothing, with no error, metric or log line. Run the worker with `network_mode: host`, with
the addresses present on that host.
→ [postal-internals.md](postal-internals.md#the-outbound-ip-is-bound-to-the-worker-host)

### Does Postal rate-limit per destination domain?

No. There is no per-domain or per-IP rate accounting, token bucket or backpressure in
Postal. The only limit is `send_limit`, a per-server volume quota. Postal sends as fast as
it can, is refused, and retries later.
→ [RESULTS.md](../RESULTS.md#where-postal-cannot-help-itself)

## Retries, errors and webhooks

### Why does Postal retry a deferred message only after five minutes?

The retry delay is `1.3 ^ attempts × 5 minutes`, and the five-minute base is hardcoded. With
the default 18 attempts the ladder spans about 31 hours. A receiver that meters volume per
minute leaves most of its quota unused while the refused mail waits. If the remote reply
contains "N seconds" or "N minutes", Postal uses that instead.
→ [postal-internals.md](postal-internals.md#the-retry-ladder)

### Which SMTP errors are permanent in Postal?

Fewer than RFC 5321 suggests. Ruby's `Net::SMTP` maps `50x` replies to a syntax error and
`53x` to an authentication error, and Postal retries both. Only the remaining `5xx` replies
become `HardFail`, so **`500`–`504` and `530`–`535` are soft failures and are retried.**
After the last attempt Postal adds the recipient to the suppression list.
→ [postal-internals.md](postal-internals.md#classification-of-smtp-responses)

### Why are my Postal webhooks failing with `Code received was -4`?

Postal refuses webhooks to private, loopback and link-local addresses (`10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`) as SSRF protection. The request is still
created, retried and logged, so the only sign is that error code. Point the webhook at a
public address or a public name.
→ [postal-internals.md](postal-internals.md#webhooks-are-blocked-to-private-addresses)

### How much do tracking and webhooks slow Postal down?

Measured together with `send_limit`: delivery fell from 46.3 to 8.6 recipients/s, with no
extra attempts. Each delivery simply cost more. Webhook requests are sent from the same
worker process that sends mail. Separating the three costs is on the [roadmap](../roadmap.md).
→ [RESULTS.md](../RESULTS.md#what-tracking-webhooks-and-send_limit-cost)

### Can Postal deliver the same email twice?

Yes. Delivery is at-least-once. If the receiver accepts a message but the acknowledgement is
lost, Postal records a failure and sends it again. Under throttling this happened to 9 of
4310 deliveries.
→ [RESULTS.md](../RESULTS.md#delivery-is-at-least-once)

## The database and the queue

### Does Postal's `queued_messages` table need another index?

The two hot worker queries (claiming the next message and collecting a batch) are not covered
by any index. With a short queue that does not matter: 4851 and 9938 rows drained at the same
rate. With a long queue, or a large IP pool, batch collection scans to the end of the table
for every message delivered. Our build fixes that one without a schema change. Check it on
your data with `EXPLAIN UPDATE` before adding anything.
→ [optimisations.md](optimisations.md)

### Is MariaDB or Ruby the bottleneck in Postal?

At the scale measured here, neither on its own. Delivery waits on the network, and the
database is limited by single-row updates rather than by throughput. Profile before
rewriting anything. The diagnostics that settle it are in the
[optimisation guide](postal-optimization-guide.md#diagnostic-tooling).

## Benchmarking Postal

### How do I load test Postal properly?

Use this bench, or at least avoid its known traps:

- **Count recipients, not API calls.** Postal creates one message per recipient.
- **Measure ingress and delivery separately.** A combined run hides a growing queue: the
  first number this project produced (49.9/s) was ingress, and the sustained figure was 21.9.
- **Give the sink a realistic response delay.** An instant sink overstates delivery about
  sevenfold.
- **Check that the generator is faster than Postal.** Here it was not at first, and its limit
  looked like Postal's.
- **Prove that every limit you configure actually refuses something.**
- **Reconcile.** Accepted must equal sent + hard-failed + held + queued + in flight, and the
  receiver's own log must agree with `sent`. If it does not, the number is not a result.

→ [TESTING.md](../TESTING.md), [engineering-log.md](engineering-log.md)
