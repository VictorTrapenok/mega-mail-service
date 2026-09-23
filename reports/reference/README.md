# Reference runs

Two **pairs** of runs. Within a pair the two differ in exactly one thing — what the receiving
side does — and everything else is identical, which is what makes the pair comparable.

The pairs themselves are **not** comparable with each other. They were measured before and
after the bench started exercising what production actually runs: `send_limit` left set,
tracking on, webhooks on. See "What changed between the pairs" below.

### Pair 1 — the stock upstream image, production features off

| File | Receiver | Delivered | Attempts per delivered |
|---|---|---|---|
| `baseline-unlimited-receiver.md` | accepts everything | 47 recipients/s | 1.00 |
| `provider-per-ip-limits.md` | 120 messages/min per address | 13 recipients/s | 5.32 |

### Pair 2 — our build, production features on

| File | Receiver | Delivered | Attempts per delivered |
|---|---|---|---|
| `baseline-unlimited-receiver-production-features.md` | accepts everything | 8.6 recipients/s | 1.00 |
| `provider-per-ip-limits-production-features.md` | 120 messages/min per address | 2.0 recipients/s | 8.24 |

Read each pair in that order. The interesting quantity is not either number on its own but the
gap between the attempt rate and the delivery rate in the second one: Postal did more work and
delivered less, and a delivery-rate figure alone cannot show that.

## What changed between the pairs

Three things at once, which is why no single-cause conclusion can be drawn from the fivefold
drop between them:

- **Tracking is on.** Every link in every message is rewritten and a row is written to
  `links`; the open-tracking image is inserted.
- **Webhooks are on.** `Delivery#create` queues a `WebhookRequest`, and
  `ProcessWebhookRequestsJob` sends it from the **same worker process** that sends mail — so
  each delivery costs an HTTP round trip on top of the SMTP one.
- **`send_limit` is set** rather than cleared, so the per-delivery `UPDATE servers` happens.
  That is one of the three serialisation points in the shared database.

Two further differences run the other way or are neutral, and neither can explain the drop:
pair 2 ran **our build** rather than the upstream image, and pair 2 ran with IP pools
**disabled** where pair 1 had six outbound addresses — which by this project's own
measurement makes delivery faster, not slower.

Attributing the cost to one of the three needs a run per feature and has not been done. It is
in [roadmap.md](../../roadmap.md).

**Both runs in pair 2 are single runs**, and the baseline one did not empty its queue: it
delivered 9331 of 14 865 rows in the 900 s allowed and reported `Ready rows exhausted: NO`.
The rate is still the rate it sustained; the queue simply outlasted the timeout.

The rest of the runs this project produced are deliberately not committed. Most are
iterations whose numbers were later found to be wrong — the reasoning that discarded them is
in [docs/engineering-log.md](../../docs/engineering-log.md), which is the honest record. A repository holding thirty
mutually contradictory runs would tell a reader less than two that are explained.

## How to reproduce

Pair 2 was produced by exactly these commands; pair 1 additionally passed
`-e postal_image_source=upstream -e postal_image_ref=3.3.7` and ran before the profile flags
above were turned on.

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
