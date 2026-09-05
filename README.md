# Postal: a measured build

A proof of concept in two halves: a reproducible bench that measures Postal honestly, and our
own Postal build with the first optimisation in it. The bench runs on 2 vCPU machines, which
is enough to establish how Postal behaves and where its cost goes, and **not** enough to
demonstrate what the optimisation is worth — that needs hardware of production size.

## Where things are

| Document | What it covers |
|---|---|
| [RESULTS.md](RESULTS.md) | What has been measured, the numbers behind it, and an explicit list of what is not established |
| [docs/optimisations.md](docs/optimisations.md) | Our changes to Postal: what each one does, why it is safe, whether it has been measured |
| [docs/running.md](docs/running.md) | Deploying the bench and taking a measurement |
| [docs/custom-builds.md](docs/custom-builds.md) | How our source becomes an image, and how a run proves which build it measured |
| [docs/postal-internals.md](docs/postal-internals.md) | Postal internals confirmed by reading the code, with paths into it |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the bench is put together, and the principles behind it |
| [POSTAL_OPTIMIZATION_GUIDE.md](POSTAL_OPTIMIZATION_GUIDE.md) | The measurement methodology and the optimisation sequence it implies |
| [roadmap.md](roadmap.md) | What is deferred and why |

The Postal source we build and modify is in [vendor/postal/](vendor/postal/). Reference runs
are in [reports/reference/](reports/reference/).

## What the bench established

On a 2 vCPU machine the stock Postal image delivered **46-51 recipients per second** — 4.0 to
4.4 million per day — with the reconciliation identity closing exactly. Postal's own speed is
therefore not what stands between a modest server and five million recipients a day.

What binds instead is the receiving side. Under per-IP volume limits the same Postal, on the
same hardware, working *harder*, delivered a quarter as much: 13.3 recipients/s against 46.3,
at 5.17 delivery attempts per delivered recipient. Capacity there is bought in sending
addresses, not in cores.

And that is where the interesting part starts, because of what Postal does with a large pool
of addresses. Full numbers and caveats in [RESULTS.md](RESULTS.md).

## What we changed, and why it should help

Postal binds an outbound address to a message when the message is *accepted*, at random from
the pool. Collecting a batch for one SMTP session then requires a match on both the recipient
domain and that address, so a pool of N addresses divides the batch candidates by roughly N —
and the query that collects them is covered by no index, so it stops either at a hundred rows
or **at the end of the table**. With a large pool a hundred is never reached, and the scan
runs to the end for every message the worker delivers. Twice, in fact: the query that reads
back what was just locked has the same problem.

Our first change makes both queries index-seekable **with no schema change at all**. For an
outgoing message `batch_key` is `"outgoing-" + domain`, and both columns are written from the
same value in the same statement, so adding a redundant predicate on the already-indexed
`domain` column changes no result while giving MySQL something to seek on. It can be deployed
and rolled back on a live installation by swapping the image, and its worst possible outcome
is a message that was not batched — never one lost or delivered twice.

Postal's own test suite passes on it: 812 examples, 0 failures, with two added examples
pinning the new behaviour. The mechanism, the safety argument and the way to verify the query
plan are in [docs/optimisations.md](docs/optimisations.md).

**Its effect on throughput is not measured, and cannot be on this hardware.** The cost it
removes grows with queue length and with pool size, and is invisible below roughly 10^5 queue
rows — which the bench has already demonstrated: a drain series at 4851 and 9938 rows gave
the same 20.8 recipients/s either way.

## Proving it needs bigger hardware

Everything below is a measurement rather than an opinion, which is exactly why an estimate
cannot replace it. **All of it is blocked on access to production-grade machines, or to a
copy of that environment.**

### The query plan, on real data

The claim behind the change is that it removes a full table scan per delivered message.
Whether MySQL actually seeks on `index_queued_messages_on_domain` is a property of the
optimiser and of the data, and one query settles it:

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

### A queue of 10^5-10^6 rows, and a large address pool

These are the two axes along which the change is supposed to pay, and the bench can reach
neither. The queue is filled through the API at the ingress rate, so a hundred thousand rows
take about an hour and a million close to a day; realistic lengths need a bulk path through
SQL. And the pool is six addresses where a production installation runs hundreds — it is the
address count that decides whether batch collection can ever reach its limit.

On larger hardware both are a day of work, and then a measured curve instead of a model.

### After that

- **A composite index led by `ip_address_id`.** The proper fix for the largest recipient
  domains. Deliberately not done first: a schema change is exactly what cannot be tried
  cheaply on a live installation, so it comes after the no-schema change has been measured.
- **Pacing.** The bench measured the sender attempting four times its allowance per address
  and still using only 65 % of the quota: the receiver meters over 60 seconds while Postal
  defers a refusal by a hardcoded five minutes, so the quota goes unused while the work sits
  parked. Raising concurrency cannot fix this and was measured not to. Postal has no
  per-destination rate accounting at all — that is the gap to fill.
- **Sharding across independent installations.** Both confirmed serialisation points — the
  single global `statistics` row and the shared queue — live at the installation level, so
  adding workers and nodes does not relieve them. Running several installations side by side
  may be the cheapest route to the target rate, and is worth measuring before anything in the
  worker is rewritten.

## Running it

```bash
ansible-galaxy collection install -r requirements.yml
ansible-playbook -i inventories/distributed playbooks/site.yml
ansible-playbook -i inventories/distributed playbooks/smoke.yml
ansible-playbook -i inventories/distributed playbooks/benchmark.yml
```

The report appears in `reports/<run_id>.md`. A run tests the source in
[vendor/postal/](vendor/postal/) as it stands in the working tree: every measurement playbook
builds the image first, then proves from a label on the running container that the worker is
executing that exact source.

Requirements, topology, the separate ingress and drain measurements, running against a
throttling receiver and what each playbook does are in [docs/running.md](docs/running.md).

## What it deliberately does not claim

Every run states its own limits, and the reconciliation identity has to close within 1 % or
the run is not reported as a result. Three limits are worth naming here:

- **The receiver's limit values are an assumption.** No destination-domain mix or observed
  production throttling has been supplied, so the sink profile holds typical values for a
  large mailbox provider. Every figure derived from them inherits that status, including the
  number of sending addresses a target rate would need.
- **Single runs.** The spread between repeats of the same build is unknown, so a small
  difference between two runs cannot be read as a result.
- **No number is attached to our change.** It is a mechanism with a safety argument, not a
  measured gain, and it stays recorded as a hypothesis until a run on adequate hardware says
  otherwise.
