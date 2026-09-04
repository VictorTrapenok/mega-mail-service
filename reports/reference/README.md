# Reference runs

Two runs that differ in exactly one thing: what the receiving side does. Everything else —
hardware, image digest, load profile, queue composition, sink response delay, number of
outbound addresses — is identical, which is what makes them comparable.

| File | Receiver | Delivered | Attempts per delivered |
|---|---|---|---|
| `baseline-unlimited-receiver.md` | accepts everything | 47 recipients/s | 1.00 |
| `provider-per-ip-limits.md` | 120 messages/min per address | 13 recipients/s | 5.32 |

Read them in that order. The interesting quantity is not either number on its own but the gap
between the attempt rate and the delivery rate in the second one: Postal did more work and
delivered less, and a delivery-rate figure alone cannot show that.

The rest of the runs this project produced are deliberately not committed. Most are
iterations whose numbers were later found to be wrong — the reasoning that discarded them is
in [CHANGELOG.md](../../CHANGELOG.md), which is the honest record. A repository holding thirty
mutually contradictory runs would tell a reader less than two that are explained.

## How to reproduce

```bash
ansible-playbook -i inventories/distributed playbooks/site.yml
ansible-playbook -i inventories/distributed playbooks/seed.yml
ansible-playbook -i inventories/distributed playbooks/calibrate.yml

# baseline
ansible-playbook -i inventories/distributed playbooks/drain.yml \
  -e bench_prefill_recipients=15000 -e postfix_sink_response_delay_ms=75

# with per-IP limits: the sink has to be redeployed, the limits live in its configuration
ansible-playbook -i inventories/distributed playbooks/site.yml --limit aux \
  -e bench_sink_profile=provider
ansible-playbook -i inventories/distributed playbooks/drain.yml \
  -e bench_sink_profile=provider -e bench_prefill_recipients=25000 \
  -e bench_drain_window_s=300 -e postfix_sink_response_delay_ms=75
```

The throttled arm needs the larger queue on purpose. Under a binding cap a refused row leaves
the ready pool for five minutes exactly as a delivered one leaves it for good, so the prefill
has to cover the attempt rate for the whole window rather than the delivery rate. If it does
not, the report says so and the numbers are understated.
