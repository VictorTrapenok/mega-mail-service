# Postal Load Testing Bench

An Ansible project that deploys an isolated Postal environment and captures a
reproducible performance baseline against which the gains of optimised builds
are measured.

The task requirements are in [postal-benchmark-ansible-task.md](postal-benchmark-ansible-task.md),
the methodology and optimisation plan in [POSTAL_OPTIMIZATION_GUIDE.md](POSTAL_OPTIMIZATION_GUIDE.md),
and the confirmed Postal internals with paths into the sources in
[docs/postal-internals.md](docs/postal-internals.md).

## What it has found so far

**[RESULTS.md](RESULTS.md) is the short version** — the findings, the numbers behind them, and
an explicit list of what has not been established. Reference runs are in
[reports/reference/](reports/reference/).

In one paragraph: on a 2 vCPU machine the stock Postal 3.3.7 image delivered 47-51 recipients
per second — 4.1-4.4 million per day — with the reconciliation closing exactly. What binds is
not Postal but the receiving side: under per-IP volume limits the same build on the same
hardware delivered a quarter as much while making *more* delivery attempts, because five of
every six were refused. Throughput then scales with the number of sending addresses rather
than with cores, and an IP pool turns out to cost throughput rather than add it — Postal binds
the outbound address to a message when the message is accepted, and batching requires a match
on that address as well as on the recipient domain.

Every run states its own limits in a "what this run does not prove" section, and the
reconciliation identity has to close within 1 % or the run is not reported as a result.

## What still needs the customer's infrastructure

The machines available for this work are 2 vCPU / 4 GB. Everything in this section is sized
beyond them, and every item is a measurement rather than an opinion — which is exactly why it
cannot be replaced by an estimate. **We are waiting for access to the customer's servers, or
to a copy of that environment, to run them.**

### Verifying the query plan on real data

The one technical claim behind our change to batch collection is that it removes a full table
scan per delivered message (see [docs/optimisations.md](docs/optimisations.md)). Whether MySQL
actually seeks on `index_queued_messages_on_domain` is a property of the optimiser and of the
data, and it is settled by one query:

```sql
EXPLAIN SELECT id FROM queued_messages
 WHERE batch_key = 'outgoing-example.com' AND domain = 'example.com'
   AND ip_address_id = 42
   AND locked_by IS NULL AND locked_at IS NULL
   AND (retry_after IS NULL OR retry_after < NOW())
 LIMIT 100;
```

`key` must read `index_queued_messages_on_domain`.

**An accurate answer needs production data, or at least a copy of it.** The optimiser is
cost-based: on the few thousand queue rows a small bench holds it will choose a full scan
whatever the indexes say, and the result proves nothing either way. What decides the plan is
the real queue length, the real distribution of recipient domains and the real index
statistics. A read-only replica or a dump of `queued_messages` is enough — no message bodies
are needed.

### Filling the queue to 10^5-10^6 rows

`bench_prefill` fills the queue the normal way, through the API with the workers stopped, so
it is limited by the ingress rate: a hundred thousand rows take about an hour and a million
close to a day. That is the honest reason the batch-collection change is still unmeasured —
the effect it removes grows with queue length and is invisible below roughly 10^5 rows, which
the bench has already demonstrated (4851 and 9938 rows gave the same 20.8 recipients/s).

Reaching those lengths needs a bulk path through SQL that reproduces the `messages` row, the
two longblob rows of the per-day raw table and the queue row with all its associations, plus
a check that delivery afterwards proceeds normally and the reconciliation adds up. On larger
hardware it is a day of work and then a real number instead of a model.

### A composite index led by `ip_address_id`

The change already made deliberately touches no schema, because a schema change is exactly
what cannot be tried cheaply on a live installation. The proper fix for the largest recipient
domains is a composite index on `queued_messages` led by `ip_address_id`, and it should be
measured on realistic data before it is proposed for production.

### Pacing, provider tiers, greylisting

The two-arm run showed the sender attempting four times its allowance per address and still
using only 65 % of the quota: the receiver meters over 60 seconds while Postal defers a
refusal by a hardcoded five minutes, so the quota goes unused while the work sits parked.
Raising concurrency cannot fix this and was measured not to. What is needed is a sender that
paces to the receiver's rate — first as a bench variant that proves the ceiling is reachable,
then in our own build. Postal has no per-destination throttling state at all today: no
per-domain or per-IP rate accounting, no backoff shorter than the five-minute ladder, no
memory that a destination has just refused it.

Alongside it, the sink models one uniform per-IP limit for every destination. A real mix is a
handful of large providers with hard limits and a long tail with looser ones, and the
aggregate ceiling of such a mix is not the ceiling measured against one uniform limit.
Greylisting is not modelled either, and it changes the shape of a first-contact delivery
completely.

### Sharding across N independent installations

Both confirmed serialisation points — the single global `statistics` row and the shared queue
— live at the installation level, so adding workers and nodes does not relieve them. Running
several independent installations side by side may therefore turn out to be the cheapest way
to reach the target rate, and it is worth measuring before anything in the worker is
rewritten.

## Requirements

- Control machine: `ansible-core >= 2.17`, Python 3.10+.
- Target hosts: Ubuntu 24.04 LTS x86_64, SSH access with `sudo` rights.
- At least one host for debugging, two for measurements.

```bash
ansible-galaxy collection install -r requirements.yml
```

## Topology

| Machine role | What runs on it |
|---|---|
| **A (SUT)** | MariaDB + Postal `web` / `smtp` / `worker` |
| **B (aux)** | CoreDNS + Postfix sink + load generator |

Splitting them is mandatory for measurements: if the generator and the sink run on the same
hardware, they compete with the system under test, and its slowdown is indistinguishable from
their own. The bench detects this by itself and marks such runs as `debug`.

Ports: Postal SMTP ingress is `2525`, the sink is `25`. An MX record does not carry a port
number, so 25 must be taken by the sink, while ingress can be moved.
Thanks to this, one layout works both on a single machine and on several.

## Commands

> The measurement playbooks need the seeding results, which live in the Ansible fact cache and
> expire (`fact_caching_timeout` in `ansible.cfg`). If a run stops on "the seeding results are
> not in the fact cache", run `playbooks/seed.yml` and repeat — the seeding is idempotent.

Debug environment on a single machine:

```bash
ansible-playbook -i inventories/single-host playbooks/site.yml
ansible-playbook -i inventories/single-host playbooks/smoke.yml
```

Measurement environment:

```bash
ansible-playbook -i inventories/distributed playbooks/site.yml
ansible-playbook -i inventories/distributed playbooks/smoke.yml
ansible-playbook -i inventories/distributed playbooks/calibrate.yml
ansible-playbook -i inventories/distributed playbooks/benchmark.yml
ansible-playbook -i inventories/distributed playbooks/reset.yml
```

The report appears in `reports/<run_id>.md`.

### Which build is measured

By default a run tests **our own build**, compiled from the Postal source in
[vendor/postal/](vendor/postal/). Every measurement playbook builds the image before
resetting state, so the run always measures the source currently in the working tree:

```bash
$EDITOR vendor/postal/app/lib/worker/jobs/process_queued_messages_job.rb
ansible-playbook -i inventories/distributed playbooks/benchmark.yml
```

The build is skipped when nothing was edited — the image is tagged by a digest of the
source, so an unchanged tree resolves to an image that already exists. The report prints
that digest twice, once as built and once as read back off the running container, which is
what proves the run measured the edit rather than the previous build.

Switching to the official image for a baseline, and other build controls:

```bash
# the reference ghcr.io image instead of our source
ansible-playbook -i inventories/distributed playbooks/benchmark.yml \
  -e postal_image_source=upstream -e postal_image_ref=3.3.7

# build and deploy without measuring anything
ansible-playbook -i inventories/distributed playbooks/build.yml

# rebuild even though the source is unchanged
ansible-playbook -i inventories/distributed playbooks/build.yml -e postal_build_force=true
```

Postal's own test suite runs against our source on demand. It needs Ruby 3.4.6, a MySQL
server and Docker together, so it runs on a host that has them — never on the workstation:

```bash
# the whole suite
ansible-playbook -i inventories/distributed playbooks/rspec.yml

# one file, while iterating on a change
ansible-playbook -i inventories/distributed playbooks/rspec.yml \
  -e postal_specs_args=spec/models/queued_message_spec.rb

# anything with a space must go as JSON: "-e key=value" splits on whitespace and would
# deliver only the first token while looking like it worked
ansible-playbook -i inventories/distributed playbooks/rspec.yml \
  -e '{"postal_specs_args": "spec/models/queued_message_spec.rb --format documentation"}'
```

The `postal_specs` inventory group says where. It points at the auxiliary machine rather
than the system under test: the image build is a two-core bundle install and has no business
competing with a measurement.

Every push builds our source, runs Postal's test suite against it and — if the suite passes —
publishes the image to the GitHub Container Registry as
`ghcr.io/<owner>/<repo>/postal:src-<digest>`. That `src-` tag is the same string the report
prints as "Source tree", which is what makes an image handed to a customer checkable
rather than merely asserted. See
[.github/workflows/postal-image.yml](.github/workflows/postal-image.yml).

Details — how to add an index as a migration, how to hand the image over — are in
[docs/custom-builds.md](docs/custom-builds.md). What we have changed in Postal so far is in
[docs/optimisations.md](docs/optimisations.md).

Changing the target rate:

```bash
ansible-playbook -i inventories/distributed playbooks/benchmark.yml \
  -e bench_target_rate=120
```

### Separate measurements

Ingress and queue draining are measured separately, and this is the main way to understand
which of the two halves falls short of the target. In a combined run they
compete for the same cores and the same DB, while the queue between them hides the fact that
ingress accepts faster than delivery manages to hand off.

```bash
# Ingress only: workers stopped, the queue only grows
ansible-playbook -i inventories/distributed playbooks/ingress.yml

# Draining only: the queue is filled in advance, ingress is silent
ansible-playbook -i inventories/distributed playbooks/drain.yml \
  -e bench_prefill_recipients=200000
```

Both playbooks are self-contained: `ingress.yml` returns the workers to service and the bench
drains the accumulated queue on its own, while `drain.yml` fills its queue the normal
way — through the API with the workers stopped, not by inserting rows into the DB.

Queue length is the main multiplier of the cost of draining, because neither of
the two hot worker queries is covered by an index
(see [docs/postal-internals.md](docs/postal-internals.md)). Hence it makes sense to measure
a series of lengths rather than a single one:

```bash
for n in 10000 50000 200000; do
  ansible-playbook -i inventories/distributed playbooks/drain.yml \
    -e bench_prefill_recipients=$n
done
```

The composition of the queue is set separately from its length. The deferred share reproduces
queue degeneration in production: messages with a temporary rejection stay at the head of the
table with their former `id`, and the claim query has to walk through all of them.

```bash
ansible-playbook -i inventories/distributed playbooks/drain.yml \
  -e bench_prefill_recipients=200000 -e bench_prefill_deferred_share=0.9
```

Domain cardinality is switched by profile: `wide_domains` gives 100,000
domains instead of 1000, which means a batch almost never collects its 100 rows
and the query runs to the end of the table for every message.

```bash
ansible-playbook -i inventories/distributed playbooks/drain.yml \
  -e bench_profile=wide_domains
```

### Measuring against a receiver that refuses

The sink profile is a separate axis from the load profile: it sets what the RECEIVER does,
not what is sent. `unlimited` is the default and accepts anything from one address, which no
real provider does; `provider` applies per-IP caps on concurrent sessions and on volume.

```bash
ansible-playbook -i inventories/distributed playbooks/site.yml --limit aux \
  -e bench_sink_profile=provider
ansible-playbook -i inventories/distributed playbooks/drain.yml \
  -e bench_sink_profile=provider -e postfix_sink_response_delay_ms=75
```

The sink must be redeployed for the profile to take effect — the limits live in its
configuration. Deployment proves them rather than trusting them: it opens one connection more
than the cap, from a worker host, and fails if nothing is refused. Two earlier attempts at
this configured a cap that applied to nobody, and both looked like successful throttled runs.

Use `drain.yml` for this, not `benchmark.yml`. The combined run waits for the queue to empty,
and under a binding cap it never does — the run would spend its whole drain timeout and report
a queue that did not clear, which is true but says nothing about the receiver.

Two things change under a throttling profile, both automatically:

- The drain switches to `window` mode. A refused message returns to the queue with
  `retry_after` five minutes out, so "no ready rows left" no longer means the work is done,
  and the rate is measured over a fixed window instead. Set `bench_drain_window_s` to change it.
- The queue must be prefilled, which `drain.yml` already does. Postal's first retry is five
  minutes away, so a throttled run on an empty queue measures the retry ladder rather than
  the receiver.

The report then carries a throttling section: which limit was hit, refusals by source address,
retry amplification, the attempt rate against goodput, time to delivery, and an estimate of how
many sending addresses the target rate needs. That last figure only appears if something was
actually refused — without refusals it would describe Postal's ceiling while reading as the
provider's.

Read the "which limit was hit" table first. The four limits are not independent: Postal reuses
an SMTP session for only 1.4 to 3.35 messages, so a connection-rate cap binds well below the
message-rate one unless it is set several times higher. A run dominated by `Connection_rate`
is measuring how often Postal opens a socket, not how much volume the receiver allows.

**The limit values are an assumption**, not a measurement: nobody has supplied the real
destination mix or the throttling actually observed in production. The report says so on every
run. Replace them in `bench_sink_profiles` when real numbers exist.

## What each playbook does

| Playbook | Purpose | Repeatable |
|---|---|---|
| `site.yml` | deploy the bench from scratch | yes |
| `seed.yml` | create the organisation, server, domain and credentials; publish the DNS records and verify the domain | yes |
| `smoke.yml` | prove the end-to-end path of a message and the absence of leaks | yes |
| `calibrate.yml` | prove that the auxiliary chain is ahead of the target | no |
| `benchmark.yml` | ingress and queue draining together, one report | no |
| `ingress.yml` | ingress rate only, workers stopped | no |
| `drain.yml` | drain rate of a pre-filled queue only | no |
| `reset.yml` | bring the state to an identical start | no |

`calibrate`, `benchmark`, `ingress`, `drain` and `reset` are non-idempotent **by design**: the
build comparison protocol requires an identical starting state before every
run, so making `reset` repeatable would quietly break the comparison.

## Containment

No test message can escape to the internet, and this is ensured by three
independent lines of defence — each sufficient on its own:

1. Internal DNS without forwarders: external domains do not resolve at all.
2. `nftables`: outbound SMTP is allowed only to the bench hosts, and attempts
   are counted by a named counter.
3. The sink's `master.cf`: the `smtp`, `relay`, `lmtp`, `local` and `virtual` services
   are not there, meaning no process capable of opening an outbound connection
   exists in the system.

`smoke.yml` checks both sides, tying itself to a specific sent
message: that the lab message reached the sink **and** that a message to a real
public domain reached nowhere, while the leak counter on all hosts stayed
at zero. External MX records do not resolve at all, so delivery breaks before
any connection — the nftables counter catches the second line of defence, in case
the first one is bypassed.

## Secrets

The lab passwords are kept in `group_vars/all/90-lab-credentials.yml` in plain
text deliberately: the bench is isolated, there is nothing to protect, and pinning the keys is
exactly what makes the runs of a series comparable.

What does not go into the repository: deploy keys, registry
credentials, production DKIM keys, production dumps.

## What the bench does not do yet

The deferred items are listed in [roadmap.md](roadmap.md). In short: there is no Prometheus and
no exporters (the six numbers needed are captured by samplers into CSV), no Ruby and MariaDB
profiling, and no full load matrix. Temporary rejections are now exercised by the sink
profile, but permanent failures, bounces and greylisting are not, and the per-IP limits are
uniform across destinations where a real mix has tiers.
