# Postal tuning checklist: what to check when Postal is slow

A practical checklist for a production [Postal](https://github.com/postalserver/postal)
installation whose queue grows or whose sending rate has hit a ceiling. The steps run from
cheapest to most invasive. Every item comes from a measurement on this project's bench or
from the Postal source. The reasoning is linked, and the measured numbers are in
[RESULTS.md](../RESULTS.md).

Variable names are from Postal 3.x ([environment variables](../vendor/postal/doc/config/environment-variables.md)).

## 1. Find out what is actually slow

Do this before changing anything. Most of the ceilings below look identical from the
outside.

- [ ] **Separate ingress from delivery.** Is Postal slow to *accept* mail (API/SMTP latency,
      clients timing out) or slow to *send* it (the queue grows)? These have different
      causes.
- [ ] **Count recipients, not messages or API calls.** Postal creates a separate message, and
      stores a separate copy, for every recipient.
- [ ] **Compare delivery attempts with successful deliveries.** If attempts clearly exceed
      deliveries, receivers are refusing you and faster sending will not help (step 4).
- [ ] **Look at worker CPU while the queue grows.** Low CPU with a growing queue means the
      workers are waiting on the network, so the fix is concurrency (step 2), not hardware.
- [ ] **Count the queue yourself.** Postal's `script/queue_size.rb` has an `AND`/`OR`
      precedence bug and counts locked rows too. Use SQL on `queued_messages` and split ready,
      locked and `retry_after`-in-the-future rows.

## 2. Delivery concurrency

- [ ] **`WORKER_THREADS`** defaults to **2**. Delivery rate ≈ concurrent deliveries ÷ time
      per delivery. At 75 ms per remote reply, 4 concurrent deliveries gave 7.1
      recipients/s and 32 gave 51.3 on the same two cores. Raise threads × worker replicas
      until CPU or the database becomes the limit.
- [ ] **`MAIN_DB_POOL_SIZE`** defaults to **5**. It must be at least the thread count of each
      process, or the extra threads silently wait for a connection.
- [ ] **MariaDB `max_connections`** must cover the pools of every web, SMTP and worker process
      together.
- [ ] **Base version of your fork.** A configurable `WORKER_THREADS` appeared in Postal 3.3.0.
      A fork from an earlier base may have concurrency fixed in code, and no hardware will
      move that ceiling.

## 3. Ingress (HTTP API and SMTP acceptance)

- [ ] **Scale the web server by processes, not threads.** Ruby's GVL keeps one Puma process
      on one core: about 28 recipients/s per process here, and 56.7 with two behind a load
      balancer.
- [ ] **Budget CPU per message:** about 25 ms to accept and 32–35 ms to deliver on the bench,
      so roughly 3.5 cores for 58 recipients/s (5 million a day).

## 4. Receiver limits and retries

- [ ] **Look for `421` and other temporary refusals** in deliveries marked `SoftFail`.
      Under per-IP limits the bench delivered 3.5× less while making more attempts.
- [ ] **Do not answer throttling with more concurrency.** It was measured not to help. Postal
      has no per-destination rate accounting, so it sends in bursts and is refused for the rest
      of the receiver's window.
- [ ] **Know the retry ladder.** The first retry is five minutes out (hardcoded) and grows
      30 % per attempt. After `POSTAL_DEFAULT_MAXIMUM_DELIVERY_ATTEMPTS` (18), the recipient is
      hard-failed **and added to the suppression list**, so sustained throttling slowly eats
      your recipient list.
- [ ] **Know which errors are retried.** `500`–`504` and `530`–`535` are soft failures in
      Postal and are retried, not rejected.
- [ ] **Size the IP pool from measured per-IP rates**, not from CPU. Under typical
      large-provider limits one address sustained about 2 recipients/s.

## 5. IP pools

- [ ] **Run workers with host networking** and the sending addresses present on that host. On
      a Docker bridge network a worker with IP pools enabled matches no address and processes
      nothing, without an error.
- [ ] **Expect fewer messages per SMTP session as the pool grows.** Postal picks an address at
      random when a message is accepted and batches only messages that share both domain and
      address. Six addresses instead of one cost a third of throughput on the bench.
- [ ] **Across several hosts, the queue partitions by host.** A worker only sends from its
      own addresses, so an idle host cannot help a busy one.

## 6. Features that cost per delivery

- [ ] **Webhooks** are sent by the same worker process that sends mail, which adds an HTTP
      round trip to each delivery. Postal refuses webhooks to private addresses (`10.x`,
      `172.16.x`, `192.168.x`, `127.x`) and fails quietly with `Code received was -4`.
- [ ] **Click and open tracking** rewrites every link and writes rows to `links`.
- [ ] **`send_limit`** adds an `UPDATE servers` for every delivery.
- [ ] Together these three took the bench from 46.3 to 8.6 recipients/s. Switch off what you
      do not use.

## 7. Operational traps

- [ ] **Set `POSTAL_QUEUED_MESSAGE_LOCK_STALE_DAYS` explicitly.** The tidy task *destroys*
      queue rows with a stale lock rather than reopening them. `bin/postal` does not `exec`
      Ruby, so `docker stop` does not reach the signal handlers and locked rows are left
      behind after every restart.
- [ ] **Health server per replica.** By default it binds `127.0.0.1` on a fixed port.
      A second replica on the same host fails to bind, logs it and carries on, so only the
      first replica exposes metrics.
- [ ] **Delivery is at-least-once.** A lost acknowledgement means a second copy. Expect a few
      duplicates under heavy throttling.

## 8. The database and the queue

- [ ] **Check the batch-collection query plan on your data** with `EXPLAIN UPDATE` and
      `ANALYZE UPDATE`. The queries are in [optimisations.md](optimisations.md). If `key` is
      `NULL` with `type: ALL`, every delivery scans the queue.
- [ ] **Watch the single-row hot spots.** Every message updates the one global `statistics`
      row twice and a per-day `raw_message_sizes` row. More nodes do not relieve them.
- [ ] **Plan storage and retention.** One copy per recipient: 5 million recipients at 100 KB
      is about 500 GB a day.

## 9. When tuning is not enough

- [ ] **Run our build**, which makes batch collection index-seekable without a schema change.
      See [optimisations.md](optimisations.md) and [custom-builds.md](custom-builds.md).
- [ ] **Shard across independent installations** before rewriting the worker. The shared
      database is where Postal stops scaling.
- [ ] **Measure every change the same way.** The bench in this repository exists for exactly
      that. See [running.md](running.md).

---

If you would rather have someone go through this on your installation,
[contact me on LinkedIn](https://www.linkedin.com/in/victor-trapenok/).
