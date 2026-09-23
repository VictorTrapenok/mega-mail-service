# Testing: how the Postal benchmark proves its own numbers

A load test can be wrong without showing it. The run finishes, the report fills in and the
number is off, because the generator was the bottleneck, messages were lost, or a limit
limited nothing. This project was built around catching exactly those failures. This page
lists every check, what it guards against and where it lives. The long story of the
failures that made each check necessary is in
[docs/engineering-log.md](docs/engineering-log.md).

## Summary

| Check | Guards against | Where | When |
|---|---|---|---|
| Lint and syntax | Broken YAML, Ansible or inventory | [.github/workflows/lint.yml](.github/workflows/lint.yml) | every push |
| Postal's rspec suite on our build | A change to Postal that breaks its behaviour | [.github/workflows/postal-image.yml](.github/workflows/postal-image.yml), `playbooks/rspec.yml` | every push; on demand |
| Build identity | Measuring an older build than the one in the tree | `playbooks/build.yml`, the report | every measurement |
| Smoke test | Mail not flowing, or mail leaking to the internet | `playbooks/smoke.yml` | after deploy |
| Deploy-time limit proof | A receiver limit that refuses nothing | `roles/postfix_sink` | every sink deploy |
| Calibration | The sink being slower than Postal | `playbooks/calibrate.yml` | before a series |
| Reconciliation | Lost or double-counted messages passing as speed | `roles/bench_report` | every run |
| Duplicate detection | At-least-once delivery inflating the rate | `roles/bench_report` | every drain run |

## Continuous integration

**Lint** runs `yamllint`, `ansible-lint`, parses every inventory and syntax-checks every
playbook. There is no full benchmark in CI: runners are too small, and GitHub blocks
outbound TCP/25.

**The Postal image workflow** runs Postal's own test suite against our fork in
`vendor/postal/` (812 examples, 0 failures at the last change, including two examples that
pin the batch-collection change). Only when it passes does it publish the image to GHCR,
tagged with the same source identity that the bench computes locally. A published image and
a benchmark report can therefore be matched exactly. Details are in
[docs/custom-builds.md](docs/custom-builds.md).

The suite needs Ruby, MySQL and Docker at once, so for local iteration it also runs on a test
host:

```bash
ansible-playbook -i inventories/distributed playbooks/rspec.yml
```

## Checks inside every measurement

**Which build ran.** The image is tagged by git's tree id for `vendor/postal/`, the id is
baked into the image as a label, and it is read back from the *running* container before and
after the run. A container that was not recreated would otherwise produce a clean, reconciled
report for the previous build.

**Containment.** Three independent layers, each sufficient on its own: internal DNS without
forwarders, nftables rules with a counter on outbound SMTP, and a sink with no service able to
open an outbound connection. `smoke.yml` sends a marked message to the lab domain and one to a
real public domain. It passes only if the first arrives, the second arrives nowhere, and the
counter on every host stays at zero.

**Limits that actually limit.** Twice the throttling sink was configured and refused nothing.
The first time, Postfix exempted the senders' own network. The second time, the `anvil`
service was missing. Both runs looked throttled. The sink now proves each configured limit at
deploy time from a non-exempt address, and refuses to deploy if nothing is refused.

**Calibration.** Postfix defaults throttle a sink well before Postal tops out, and the
slowdown looks like a Postal result. `calibrate.yml` proves the auxiliary chain is ahead of
the target before a series.

**Reconciliation.** Every run must close this identity from the Postal database:

```
accepted = sent + hard_failed + held + queued + in_flight
```

If it misses by more than 1 % (`bench_reconcile_tolerance`), the playbook fails and the run
is not a result. The receiver's log is counted independently and compared with `sent`, and
any gap is named in the report. Without this, a build that "got faster" by losing messages is
indistinguishable from a real optimisation.

**Duplicates.** The drain report compares messages the sink accepted with distinct
recipients it saw. Postal's delivery is at-least-once, and the difference is reported rather
than hidden.

## What is not tested

- **Repeatability.** Reference results are single runs, so the spread between repeats is
  unknown.
- **The SMTP submission path.** Load enters through the HTTP API.
- **Hard failures and bounces.** The sink models acceptance and temporary refusal only.
- **The bench's own Ansible roles have no unit tests.** They are exercised end to end by the
  smoke test and by every measurement.

These are listed with their priority in [roadmap.md](roadmap.md).
