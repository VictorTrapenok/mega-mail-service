# Architecture of the Postal load-testing bench

How the bench that measures [Postal](https://github.com/postalserver/postal) mail server
performance is put together, the principles behind it, and the glossary. This file is also
the table of contents for the project documentation: details live in separate files, and here
there are only links and general principles.

## Documents

| Document | What it covers |
|---|---|
| [README.md](README.md) | What this is, the key results, and how to get in touch |
| [RESULTS.md](RESULTS.md) | Postal benchmark results, with what each one does and does not establish |
| [docs/postal-performance-faq.md](docs/postal-performance-faq.md) | Postal performance questions and answers, each linked to its evidence |
| [docs/postal-tuning-checklist.md](docs/postal-tuning-checklist.md) | What to check in a production Postal installation, in order |
| [docs/postal-internals.md](docs/postal-internals.md) | Confirmed Postal internals with paths into the source |
| [docs/optimisations.md](docs/optimisations.md) | Our changes to Postal: what each one does, why it is safe, and whether it has been measured |
| [docs/custom-builds.md](docs/custom-builds.md) | Our Postal source in `vendor/postal/`, how it is built and how a run proves which build it measured |
| [docs/postal-optimization-guide.md](docs/postal-optimization-guide.md) | Measurement methodology and the optimisation sequence |
| [docs/bench-requirements.md](docs/bench-requirements.md) | Bench requirements and acceptance criteria |
| [docs/running.md](docs/running.md) | Deploying the bench and taking a measurement |
| [TESTING.md](TESTING.md) | Every check that keeps the numbers honest, and where it lives |
| [reports/reference/](reports/reference/README.md) | The reference runs behind the published numbers |
| [docs/engineering-log.md](docs/engineering-log.md) | The detailed history, including every wrong turn |
| [CHANGELOG.md](CHANGELOG.md) | A brief list of what was done and when |
| [roadmap.md](roadmap.md) | What comes next and why |

## What the bench consists of

The deployment is described in Ansible; the placement of services is determined **only**
by the inventory. Two examples: `single-host` for debugging and `distributed` on at least
two machines for measurements.

```
Generator (k6, open model)
    │ HTTP API
    ▼
Postal: web / smtp-server / worker   ← MariaDB (main + message DB, the queue)
    │ SMTP, MX from the internal DNS
    ▼
Postfix sink → discard
```

The roles are grouped by purpose:

- **Host preparation** — `common`, `docker_host`, `containment`.
- **Infrastructure** — `test_dns`, `mariadb`.
- **System under test** — `postal_image` (resolves the official image OR builds ours from
  `vendor/postal/`, depending on `postal_image_source`), `postal_app`, `postal_schema`,
  `postal_seed`.
- **Measurement environment** — `postfix_sink`, `loadgen`, `bench_samplers`,
  `bench_report`, `bench_reset`.
- **Checking our own build** — `postal_specs` (Postal's rspec suite against our source, on a
  host with Docker; the `postal_specs` inventory group deliberately points away from the
  system under test).
- **Measurements** — `bench_run` (ingress and draining together), `bench_ingress` (ingress
  only), `bench_prefill` + `bench_drain` (draining only), `bench_workers`
  (moving the workers to the required state).

## Principles

**The unit of load is a recipient, not a message.** Postal creates a separate
message for each addressee and stores a copy of the MIME for each. All counters
and reports count recipients.

**Ingress and queue draining are measured separately.** In a single run they compete
for the same cores and the same DB, while the queue between them hides the difference: while it
grows, ingress accepts faster than delivery hands off, and dividing what was accepted by the
window length passes a backlog off as completed work. The headline number of a combined run is
**sustained throughput**, which counts what was delivered over the whole time
including the drain. Separate runs give two independent numbers and immediately
show which of the halves falls short of the target.

**The length and composition of the queue are measurement parameters, not background.** Neither
of the two hot worker queries is covered by an index, which suggests that
the cost of processing a message grows with the queue length. Over a range of up to ten thousand
rows the measurement did not show this: the drain rate is the same. The threshold beyond which
an uncovered scan starts to dominate lies higher — and until it is found,
the queue size in a run should be set and stated explicitly in the report
rather than treated as background. Details and numbers are in
[docs/postal-internals.md](docs/postal-internals.md).

**Containment is provided by three independent lines of defence**, each sufficient
on its own: DNS without forwarders (external MX records do not resolve at all),
nftables rules with an attempt counter, and the absence of outbound delivery services
in the sink configuration. The smoke test checks each line separately
and ties itself to a specific message rather than to the log content in general.

**Only the configuration playbooks are idempotent.** `reset`, `calibrate`
and `benchmark` are non-idempotent by design: the comparison protocol requires
an identical starting state before every run.

**Numbers without reconciliation do not count as a result.** A build that "sped up"
thanks to silently lost messages is indistinguishable in the report from a genuine optimisation,
so reconciliation by state buckets is part of every run.

**A run must prove which build produced it.** Our build comes from the source in
`vendor/postal/` and is tagged by a hash of that source, so the tag cannot fall behind the
code. That digest is also baked into the image as a label and read back off the *running*
container, both by `build.yml` before the run and by the report after it. The reason is that
the alternative failures — a compose file that did not change, a container that was not
recreated, a tag pointing at an older layer — all produce a run that completes normally,
reconciles cleanly and measures the previous build. Nothing in the numbers reveals it.
Details in [docs/custom-builds.md](docs/custom-builds.md).

**A limit that is not enforced is worse than no limit at all.** Twice now the sink has been
configured to throttle and has throttled nothing: once because Postfix exempts `$mynetworks`
from client limits and every sending address must be in `mynetworks` to relay, once because
`master.cf` had no `anvil` service, without which those limits are not implemented at all.
Both fail silently and both produce a run that looks throttled, refuses nothing, and reads as
"Postal copes with provider limits". So every such knob is proved by exercising it at deploy
time, from a non-exempt address, the way `postal_sending_ips` proves an address with a real
`MAIL FROM` rather than a ping. The same rule covers the log greps: their patterns are read
out of the `smtpd` binary, because a wrong one counts zero forever without ever looking broken.

**Throttling and queue degeneration are the same phenomenon.** A refused message goes back
into the queue with `retry_after` in the future and keeps its small `id`, which is exactly the
head-of-table condition that turns the claim query from O(1) into a full scan. So a throttling
receiver is an honest generator of a degenerate queue, where `bench_prefill_deferred_share`
is a synthetic one. It also fixes how such an arm must be shaped: Postal's first retry is five
minutes out, so a throttled run on an empty queue measures the retry ladder rather than the
receiver, and has to be measured on a prefilled queue instead.

**The auxiliary chain is calibrated before a run.** The Postfix defaults limit
ingress before Postal tops out, and the slowdown looks like a measurement result for
Postal.

## Glossary

| Term | Meaning |
|---|---|
| **recipients** | Addressees with their own delivery state. The main metric is `recipients/s` |
| **messages** | Unique logical messages (MIME). In the primary profile they coincide with recipients |
| **accepted** | Postal answered `250` or with a successful HTTP response |
| **attempted** | The worker started a delivery attempt |
| **delivered** | The next SMTP server answered successfully. On the bench this is counted independently, from the sink log |
| **deferred** | A temporary error, a retry is expected. In Postal this is `SoftFail` |
| **held** | The message is held: the suppression list, `send_limit`, the server mode or its suspension |
| **in_flight** | A queue row has been claimed by a worker (`locked_at` is not empty) but is not yet finished |
| **run_class** | `debug` — the components share hardware, unsuitable for comparing builds; `scored` — they are split apart |
| **reference image** | The published Postal image from ghcr.io, pinned to a digest. `postal_image_source=upstream`; the runs in `reports/reference/` were made on it |
| **our build** | Compiled from the source in `vendor/postal/`. The default, `postal_image_source=local` |
| **source tree** | git's tree object id for `vendor/postal/`. It names the image tag, is baked into the image as a label, and is read back off the running container so a run can prove which code produced its numbers |
| **sink** | The mail sink: Postfix that accepts over SMTP in the normal way and discards via `discard` |
| **open model** | The generator keeps its sending schedule regardless of the system's response. A closed one understates the latency tail |
| **ingress rate** | How many recipients per second Postal writes to the DB and enqueues. Measured by `ingress.yml` with the workers stopped |
| **drain rate** | How many recipients per second the workers take out of the queue and deliver. Measured by `drain.yml` on a pre-filled queue |
| **sustained throughput** | What was delivered over the whole run time, including the drain. The only number that can be extrapolated to a full day; the ingress rate is not suitable for that |
| **deferred share** | The part of the queue with `retry_after` in the future. Reproduces queue degeneration in production: not-ready rows at the head of the table turn the claim from O(1) into a full scan |
| **burst mode** | Filling the queue with the generator at maximum speed, without a schedule. Latency in it measures the generator itself and does not feed conclusions |
| **sink profile** | The policy of the receiving side, an axis independent of the load profile: per-IP limits on concurrent sessions and on volume. `unlimited` is the upper bound for Postal, `provider` models a large MX |
| **throttled** | The receiver refused a delivery temporarily because a per-IP limit was reached. In Postal this becomes a SoftFail and a deferral, not a loss |
| **goodput** | Distinct recipients delivered per second. Differs from the delivery rate as soon as anything is retried, and it is the only one of the two that can be extrapolated |
| **retry amplification** | Delivery attempts divided by recipients delivered. The share of the worker's work spent on messages that were refused |
| **time to delivery** | From acceptance by Postal to the delivery record. Under throttling it is set by the retry ladder rather than by Postal's speed, and it is what the recipient experiences. Not the same as ingress latency |
| **batch collection** | After claiming a message, the worker gathers up to 100 more for the same destination and outbound IP to send in one SMTP session. Our first optimisation makes that query index-seekable |
| **retry ladder** | Postal's schedule for retrying a deferred message: `1.3 ^ attempts × 5 minutes`, with a hardcoded five-minute base |
| **serialisation point** | A single database row that every message updates, such as the global `statistics` row. It does not get faster with more nodes |
| **per-IP rate** | Recipients per second one outbound address sustains against a throttling receiver. Capacity is bought in addresses, not in cores |
