# Postal Load Testing Bench

An Ansible project that deploys an isolated Postal environment and captures a
reproducible performance baseline against which the gains of optimised builds
are measured.

The task requirements are in [postal-benchmark-ansible-task.md](postal-benchmark-ansible-task.md),
the methodology and optimisation plan in [POSTAL_OPTIMIZATION_GUIDE.md](POSTAL_OPTIMIZATION_GUIDE.md),
and the confirmed Postal internals with paths into the sources in
[docs/postal-internals.md](docs/postal-internals.md).

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

Changing the target rate or the build:

```bash
ansible-playbook -i inventories/distributed playbooks/benchmark.yml \
  -e bench_target_rate=120 -e postal_image_ref=3.3.7
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

What does not go into the repository: the client fork's deploy key, registry
credentials, production DKIM keys, production dumps.

## What the bench does not do yet

The deferred items are listed in [roadmap.md](roadmap.md). In short: there is no Prometheus and
no exporters (the six numbers needed are captured by samplers into CSV), no
SMTP fault injection for retries and temporary rejections, no queue
prefill, no Ruby and MariaDB profiling, no full load matrix.
