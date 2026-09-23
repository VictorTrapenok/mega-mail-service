# Changelog

What was done and when, one line per item. The findings are in [RESULTS.md](RESULTS.md).
The full story, including every measurement that turned out wrong and how it was caught, is
in [docs/engineering-log.md](docs/engineering-log.md).

## v1.0.0 — 2026-09-23: phase 1 complete

- Project documentation finalised: results-first README, Postal performance FAQ, Postal
  tuning checklist, [TESTING.md](TESTING.md), MIT licence, LinkedIn contact links,
  GitHub Pages configuration.
- Corrected the SMTP reply classification in the docs: `500–504` and `530–535` are soft
  failures in Postal, while `553` is a hard failure.
- Methodology documents moved to `docs/`, and the detailed log moved out of this file.

## 2026-09-05

- Second pair of reference runs with production features on (`send_limit`, tracking,
  webhooks): 8.6 recipients/s with an accepting receiver, 2.0 under per-IP limits.
- Throttling figures made consistent. Refusals by limit, by address and in total are now
  read from one snapshot of the sink log and cover the same window.
- Plan check for the batch-collection patch now explains the `UPDATE` the worker actually
  runs.
- The bench runs production features: `send_limit` kept, tracking and webhooks wired in.
- Found that Postal silently blocks webhooks to private addresses (`Code received was -4`).
- Build identity switched to git's tree id for `vendor/postal/`. The previous tar-based hash
  depended on the tar version.
- CI green: lint, Postal's rspec suite, image published to GHCR.
- README rewritten; operational detail moved to `docs/running.md`.

## 2026-09-04

- Our own Postal build from `vendor/postal/`, tagged by source hash and verified on the
  running container.
- First optimisation: index-seekable batch collection in
  `QueuedMessage#batchable_messages`, with no schema change. 812 examples, 0 failures.
- CI builds, tests and publishes the image. `playbooks/rspec.yml` runs the suite on a test
  host.

## 2026-09-03

- Requirements revised against the Postal 3.3.7 source. The unit of load is the recipient.
- Ansible bench: single-host and distributed inventories, DNS, MariaDB, Postal, Postfix
  sink, k6 generator, report; three-layer containment.
- Adversarial review: 52 defects fixed, most of them "the run completes and the numbers are
  wrong".
- Ingress and queue drain measured separately after the first figure turned out to be
  ingress (49.9/s), not throughput (21.9/s).
- Generator bottleneck in k6 found and fixed; calibration added.
- Measured: ingress scales by processes (Ruby GVL), drain scales with concurrency
  (7.1 → 51.3 recipients/s from 4 → 32), and drain rate does not depend on queue length up to
  10k rows.
- Measured: six sending IPs deliver a third less than one (34.1 against 50.0/s).
- Measured: per-IP receiver limits cut delivery 3.5× (13.3 against 46.3/s) at 5.17
  attempts per delivered recipient.
- Withdrew a wrong conclusion about the cost of a concurrency cap: the sink had no `anvil`
  service. The sink now proves its limits at deploy time.
