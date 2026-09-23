# Postal mail server performance: benchmark, bottlenecks and optimisation

[![lint](https://github.com/VictorTrapenok/mega-mail-service/actions/workflows/lint.yml/badge.svg)](https://github.com/VictorTrapenok/mega-mail-service/actions/workflows/lint.yml)
[![postal-image](https://github.com/VictorTrapenok/mega-mail-service/actions/workflows/postal-image.yml/badge.svg)](https://github.com/VictorTrapenok/mega-mail-service/actions/workflows/postal-image.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![LinkedIn: Victor Trapenok](https://img.shields.io/badge/LinkedIn-Victor%20Trapenok-0A66C2)](https://www.linkedin.com/in/victor-trapenok/)

**How fast can [Postal](https://github.com/postalserver/postal) actually send email, and what
slows it down?** This repository answers that with measurements rather than opinions. It
contains a reproducible load-testing bench for the Postal mail server (Ansible, k6, MariaDB,
a Postfix sink), the results it produced, an analysis of Postal's delivery queue confirmed
against the source code, and our own Postal build with the first optimisation in it.

> **Status: complete (phase 1, September 2026).** The bench, the reference measurements and
> the first code change are done and documented. The remaining work needs production-size
> hardware or production data and is listed in [roadmap.md](roadmap.md).
>
> **Running Postal and hitting a ceiling?** I take on Postal performance work on an hourly
> basis. **[Contact me on LinkedIn](https://www.linkedin.com/in/victor-trapenok/)**.

## Key results

- **Stock Postal 3.3.7 delivers 46–51 recipients per second on 2 vCPU**: 4.0–4.4 million
  emails a day, with every message accounted for. Postal's raw speed is rarely what stops a
  modest server from sending five million emails a day.
- **The receiving side decides the rate.** Under per-IP volume limits of the kind large
  mailbox providers impose, the same Postal on the same hardware delivered **3.5× less**
  (13.3 against 46.3 recipients/s) while making *more* delivery attempts: 5.17 attempts per
  delivered recipient. Capacity is bought in sending IP addresses, not in CPU cores.
- **Production features cost more than the receiver does.** With `send_limit`, click/open
  tracking and webhooks switched on, delivery fell from 46.3 to **8.6 recipients/s**, a
  fivefold drop, without a single extra attempt. The three were switched on together, so
  which one dominates is not yet separated.
- **A larger IP pool makes Postal slower per message.** Postal binds an outbound IP to a
  message at random when it is accepted, and only batches messages that share both domain and
  IP. Six addresses instead of one meant 2.4× more SMTP sessions and **a third less
  throughput** (34.1 against 50.0 recipients/s).
- **Default worker settings are the usual ceiling.** `WORKER_THREADS` defaults to 2: at a
  realistic 75 ms remote response time, 4 concurrent deliveries gave 7.1 recipients/s and 32
  gave 51.3, on the same two cores.
- **The delivery queue query is not index-covered.** Batch collection scans `queued_messages`
  to the end of the table once per delivered message whenever the IP pool is large. Our build
  fixes it with **no schema change**; Postal's own test suite passes (812 examples, 0
  failures).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/postal-throughput-receiver-limits-dark.svg">
  <img alt="Postal throughput under receiver limits: with an accepting receiver 46.3 delivery attempts and 46.3 delivered recipients per second; with a per-IP cap of 120 messages per minute 68.5 attempts but only 13.3 delivered recipients per second." src="docs/images/postal-throughput-receiver-limits-light.svg" width="800">
</picture>

Full numbers, with what each one does and does not establish, are in [RESULTS.md](RESULTS.md).

## Who this is for

- **You run Postal and the queue keeps growing**, or sending stalls at around a million emails
  a day, and adding servers did not help.
- **You are planning capacity** for millions of emails a day and need to know how many
  sending IPs, worker threads and cores that takes.
- **You maintain a Postal fork** and want to know whether a change made it faster, measured
  the same way every time.
- **You are evaluating self-hosted email infrastructure** and want real throughput figures
  for Postal instead of marketing numbers.

## What was built

| Part | What it does |
|---|---|
| **Load-testing bench** ([ARCHITECTURE.md](ARCHITECTURE.md)) | Deploys Postal, MariaDB, internal DNS, a k6 generator and a Postfix sink from one Ansible inventory, on one host or several. Mail cannot leak: three independent containment layers, each checked by a smoke test |
| **Measurement method** ([docs/postal-optimization-guide.md](docs/postal-optimization-guide.md)) | Counts recipients rather than messages, measures ingress and queue drain separately, and refuses to report a run whose delivered, deferred and failed counts do not add up |
| **Receiver models** ([docs/running.md](docs/running.md)) | An accepting sink and a sink with per-IP concurrency and volume limits, each limit proven at deploy time |
| **Postal internals** ([docs/postal-internals.md](docs/postal-internals.md)) | How the queue, batching, IP binding, the retry ladder and webhooks really work, with paths into the source |
| **Our Postal build** ([docs/optimisations.md](docs/optimisations.md), [docs/custom-builds.md](docs/custom-builds.md)) | A fork in `vendor/postal/`, built, tested and published to GHCR by CI. Every report proves which build produced it |
| **Reference runs** ([reports/reference/](reports/reference/)) | The reports behind every number above |

## The optimisation: index-seekable batch collection

After claiming a message, a Postal worker collects up to a hundred more for the same SMTP
session. The query matches on `batch_key` and `ip_address_id`, and neither is indexed. With a
large IP pool it almost never finds a hundred rows, so it scans to the end of
`queued_messages` for every message delivered, and does so twice.

For an outgoing message `batch_key` is `"outgoing-" + domain`, and both columns are written
from the same value. Adding the redundant, already-indexed `domain` predicate changes no
result and lets MySQL/MariaDB seek instead of scan. The change needs no migration and is
rolled back by swapping the image. The worst possible outcome is a message that was not
batched, never one lost or sent twice. The mechanism, the safety argument and the `EXPLAIN`
that verifies it on real data are in [docs/optimisations.md](docs/optimisations.md).

Its throughput gain cannot be measured honestly on 2 vCPU. The cost it removes only shows
beyond roughly 10^5 queued rows and with hundreds of IPs. The bench deliberately reports it
as a hypothesis rather than a number.

## Postal performance FAQ

Short answers. Each one links to the evidence, and the full list is in
[docs/postal-performance-faq.md](docs/postal-performance-faq.md).

**How many emails per second can Postal send?**
About 46–51 recipients/s on 2 vCPU with an accepting receiver and default-sized messages
(100 KB). That is 4.0–4.4 million a day. Real receivers, tracking and webhooks bring it well
below that. See [RESULTS.md](RESULTS.md).

**Why is my Postal queue growing?**
Usually not because Ruby is slow. The common causes are too little delivery concurrency
(`WORKER_THREADS` × worker replicas), a database pool smaller than the thread count, receivers
throttling your IPs, and webhooks sent from the same worker that delivers mail. See the
[tuning checklist](docs/postal-tuning-checklist.md).

**How many sending IP addresses do I need for 5 million emails a day?**
Under typical large-provider limits, about 28–29 addresses for 58 recipients/s. The figure
comes from the receiver's policy, not from Postal's speed. See
[RESULTS.md](RESULTS.md#what-this-says-about-capacity-planning).

**Why does Postal wait five minutes after a `421`?**
The first retry is hardcoded at five minutes, growing 30 % per attempt. A receiver that
meters over one minute leaves most of its quota unused while refused mail sits parked. See
[docs/postal-internals.md](docs/postal-internals.md#the-retry-ladder).

**Will adding more workers or servers make Postal faster?**
Only up to a point. Postal writes to three single rows (global statistics, `send_limit` and
raw message sizes) on every message, in the shared database. Running several independent
installations side by side scales further than adding nodes to one.

**Why are my Postal webhooks failing with `Code received was -4`?**
Postal blocks webhooks to private, loopback and link-local addresses as SSRF protection, and
fails quietly. See [docs/postal-internals.md](docs/postal-internals.md#webhooks-are-blocked-to-private-addresses).

## Work with me

This project was built and documented by **Victor Trapenok**
([LinkedIn](https://www.linkedin.com/in/victor-trapenok/)). I am available for hourly
consulting and contract work on Postal and high-volume email delivery, and open to job offers
in this area:

- **Performance audit of a Postal installation**: queue and query plans on your data (a
  read-only replica is enough), worker and database settings, where the ceiling really is.
- **Capacity planning** for a target volume: IP pool size, concurrency, hardware and storage.
- **Changes to Postal itself**: queue and batching, pacing against receiver limits, cheaper
  statistics writes, with tests and a rollback path.
- **Load testing your own build** on this bench, with reports that prove which build they
  measured.
- **Scaling out**: sharding across independent installations, IP pools across hosts.

**[→ Contact me on LinkedIn](https://www.linkedin.com/in/victor-trapenok/)** for consulting, contract work or a job offer.
Mention your daily volume, number of sending IPs and the symptom. The list of questions I
start from is in [docs/postal-optimization-guide.md](docs/postal-optimization-guide.md#questions-that-still-have-to-be-answered).

## Quick start

```bash
ansible-galaxy collection install -r requirements.yml
ansible-playbook -i inventories/distributed playbooks/site.yml
ansible-playbook -i inventories/distributed playbooks/smoke.yml
ansible-playbook -i inventories/distributed playbooks/benchmark.yml
```

The report appears in `reports/<run_id>.md`. Every measurement playbook builds the Postal
image from [vendor/postal/](vendor/postal/) first, then proves from a label on the running
container that the worker runs exactly that source. To measure the stock image instead, pass
`-e postal_image_source=upstream`. Requirements, topology and every playbook are described in
[docs/running.md](docs/running.md). How the bench itself is tested is in
[TESTING.md](TESTING.md).

## Documentation

| Document | What it covers |
|---|---|
| [RESULTS.md](RESULTS.md) | Postal benchmark results, and what each one does not establish |
| [docs/postal-performance-faq.md](docs/postal-performance-faq.md) | Postal performance questions and answers |
| [docs/postal-tuning-checklist.md](docs/postal-tuning-checklist.md) | What to check in your own Postal installation, in order |
| [docs/optimisations.md](docs/optimisations.md) | Our changes to Postal, why each is safe, whether it is measured |
| [docs/postal-internals.md](docs/postal-internals.md) | Postal internals confirmed in the source code |
| [docs/postal-optimization-guide.md](docs/postal-optimization-guide.md) | Methodology and the optimisation sequence |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the bench is built, its principles, the glossary |
| [TESTING.md](TESTING.md) | How correctness is checked: smoke, reconciliation, Postal's rspec suite, CI |
| [docs/running.md](docs/running.md) | Deploying the bench and taking a measurement |
| [docs/engineering-log.md](docs/engineering-log.md) | Every wrong turn, and how it was caught |
| [CHANGELOG.md](CHANGELOG.md) · [roadmap.md](roadmap.md) | What was done · what comes next |

## What this does not claim

- **No speed-up figure is attached to our change.** It is a mechanism with a safety argument
  and a green test suite. Measuring it needs a queue of 10^5–10^6 rows and hundreds of IPs.
- **The receiver's limits are modelled** on typical large-provider values, not observed
  production throttling. Figures derived from them, such as the IP count, show the shape of
  the answer rather than a procurement number.
- **Single runs.** The spread between repeats is unknown, so small differences are not results.

## License

[MIT](LICENSE). The Postal fork in [vendor/postal/](vendor/postal/) keeps its upstream
[MIT licence](vendor/postal/MIT-LICENCE). Postal is a project of its own authors; this
repository is not affiliated with it.
