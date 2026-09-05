# CHANGELOG

A brief record of what was done and when. The findings themselves are in
[RESULTS.md](RESULTS.md), our changes to Postal in
[docs/optimisations.md](docs/optimisations.md), and what is deferred in
[roadmap.md](roadmap.md).

## 2026-09-05 (measurement pass)

- **Suite green on the current tree**: 812 examples, 0 failures, and the two examples the
  batch-collection patch adds were confirmed by name rather than by the total. Smoke passed on
  both sides — the lab message arrived, the message to a public domain did not, and the leak
  counters on both hosts stayed at zero. The run reports carry the same source tree
  `250f8d03cec2` as built and as read back off the running container.
- **The throttling figures still did not reconcile, for a second reason.** The morning's fix
  aligned the *opening* edge of the window; the closing edge was still sampled once per figure,
  each in its own SSH round trip, while the workers went on being refused at about fifteen a
  second. A throttled run printed 4465 refusals, 4489 by limit and 4516 by address — growing
  strictly in the order the tasks ran, roughly 1.5 s apart. Both edges now take **one snapshot
  of the sink log** and every figure is read out of it. The same run then printed 4549, 4549
  and 4549, and the reconciliation identity closed at 0 unaccounted.
- **A fresh pair of reference runs on the current profiles.** With `send_limit` set and
  tracking and webhooks on, the drain rate is **8.6 recipients/s** against an accepting
  receiver and **2.0** under per-IP limits, against 46.3 and 13.3 for the earlier pair. Retry
  amplification stays at 1.00 in the accepting arm, so nothing was wasted on refusals — each
  delivery simply costs more. Three features moved at once and the runs do not separate them;
  that is now in `roadmap.md`. The capacity arithmetic survived: 28 sending addresses for the
  target rate, against 29 before, at a sixth of the throughput.

## 2026-09-05 (review pass)

- **Throttling breakdowns now cover the drain window and sum across sinks.** Both breakdowns
  — by limit and by source address — were counted over the whole sink log while the refusal
  total printed beside them in the report was a delta across the drain. The two therefore
  never had to agree, and did not: the reference run shows 16 900 refusals against a per-limit
  breakdown summing to 16 929, the difference being refusals the workers collect during their
  own startup. Each breakdown is now also taken before the drain and subtracted per key. The
  same reduction fixes a second fault that had not fired yet: the per-sink strings were joined
  end to end, so with more than one host in `postfix_sinks` a repeated key would have been
  rendered as two rows instead of one sum — which would first have happened exactly when a
  second sink was added because the first was suspected of being the bottleneck.
- **The plan check for the batch-collection patch explained the wrong statement.**
  `docs/optimisations.md` gave an `EXPLAIN SELECT`, but the worker runs `update_all` — an
  `UPDATE`, planned separately, which an obliging `SELECT` plan says nothing about. Replaced
  with `EXPLAIN UPDATE`, the second query alongside it, and `ANALYZE UPDATE` for the case
  where estimates and actual rows disagree.
- **Two documents had gone stale against the code.** `RESULTS.md` still said `send_limit` is
  cleared by the seeding and that tracking and webhooks are not wired, all three of which
  changed earlier the same day; the bullet now says what it means — that the reference runs
  were made that way and are not comparable with runs on the current profiles. `roadmap.md`
  claimed under "known limitations" that the roles for assigning sending addresses and
  checking them against the database do not exist, twenty lines below a bullet describing
  `postal_sending_ips` doing exactly that.
- **The lint job no longer advertises a secret scan it does not run.** Its header had claimed
  one since it was written. Removed, with the reason it is not trivial recorded, and the work
  itself moved to `roadmap.md`.

## 2026-09-05

- **Presentation pass.** README cut from 373 lines to 150 and rewritten as what the work is:
  a bench that measures Postal honestly, plus our own build with the first optimisation in
  it. Everything operational moved to `docs/running.md`. No document refers to anyone as
  "the customer"; the section asking for hardware is framed as what cannot be shown on 2 vCPU.
- **The source identity is now git's tree object id for `vendor/postal/`**, taken through a
  throw-away index so it describes the working tree. It replaced a hash of a
  metadata-stripped tar archive, which was not in fact deterministic: it depended first on the
  checkout umask and then on the tar version — GNU tar 1.34 and 1.35 hashed a byte-identical
  tree to `52733cbabb11` and `722b34598b73`, so the first published image carried a tag the
  bench would never produce. Caught by comparing the CI run against the local one. The build
  context is now exported from the same tree id with `git archive`.
- **The bench now exercises what production does.** `send_limit` is no longer cleared by the
  seeding — with the column nil the whole check is skipped, including the `UPDATE` of the
  `servers` row on every message, one of the three serialisation points. The `tracking` and
  `webhooks` profile flags now create a `TrackDomain` and a `Webhook` and are on; webhook
  POSTs go to a fixed-204 HAProxy frontend so the receiver adds no latency of its own.
  Verified on a live message: `tracked_links: 2`, `tracked_images: 1`, two rows in `links`,
  and the matching webhook POSTs answered 204. **Numbers from these profiles are not
  comparable with `reports/reference/`**, which were measured with both features off.
- **Found while enabling webhooks: Postal blocks them to private addresses.**
  `Postal::HTTP::AddressGuard` refuses any outbound webhook whose destination resolves into an
  RFC1918, loopback or link-local range, as SSRF protection, and it fails quietly — the
  request row is created, retried and recorded, and the only sign is `Code received was -4`.
  Written up in `docs/postal-internals.md`, because any installation with an internal endpoint
  hits it.
- **CI is green for the first time.** `yamllint` was walking `collections/`, which the job
  installs itself one step earlier, and `ansible-lint` had never been reached: it reports 113
  `var-naming[no-role-prefix]`, a convention that is wrong for roles which publish facts other
  plays consume. Skipped with that reasoning recorded; the two real findings were fixed.

## 2026-09-04

- **Our own Postal build.** The source lives in `vendor/postal/` and is edited in this working
  tree. `postal_image` builds it; the image is tagged by a hash of the source, so the tag
  changes if and only if the code does, and an unchanged tree resolves to an image that
  already exists. `playbooks/build.yml` deploys, migrates the schema and then asserts from a
  label on the **running** container that the worker executes the current working tree — the
  failure it prevents (a container that was not recreated) produces a run that looks normal
  and measures the previous build.
- **First optimisation: index-seekable batch collection.** `QueuedMessage#batchable_messages`
  now also filters on the indexed `domain` column. For an outgoing message `batch_key` is
  `"outgoing-" + domain` and both columns are written from the same value, so the predicate
  changes no result while giving MySQL something to seek on instead of scanning the table by
  primary key once per delivered message. **No schema change**, so it can be deployed and
  rolled back on a live installation by swapping the image. 812 examples, 0 failures, with two
  added examples pinning the new behaviour. Its effect on throughput is unmeasured and cannot
  be measured on this hardware.
- **CI and handover.** Every push computes the source identity, runs the rspec suite against a
  `ci` build and, on success, pushes the `full` image to GHCR tagged `src-<source>`,
  `sha-<commit>`, `latest` and `v*`. `playbooks/rspec.yml` runs the same suite on a test host,
  because it needs Ruby 3.4.6, MySQL and Docker at once.

## 2026-09-03

### Building the bench

- Requirements revised against the Postal 3.3.7 sources: technically unachievable items
  removed, the reconciliation identity corrected, the unit of load pinned to **recipients**.
- The Ansible project: two inventories, roles for host preparation, DNS, MariaDB, Postal,
  the Postfix sink, the k6 generator, the run and the report. Containment on three independent
  lines, each sufficient on its own.
- **An adversarial review found 52 defects**, most of the class "the run completes and the
  numbers in the report are made up": all window timestamps came from `ansible_date_time`, a
  snapshot rather than a clock, so the window was always exactly the warm-up length and the
  reconciliation found no rows; the warm-up was counted in the result, overstating the rate by
  ~20 %; several checks could not fail at all. Each was tied to specific data.

### What the measurements changed

- **The first number was not throughput.** 49.9 rcpt/s turned out to be the ingress rate
  against a growing queue. Sustained throughput on the same data is 21.9. Ingress and draining
  are now measured separately, by their own playbooks.
- **The generator was the bottleneck, not Postal.** k6 re-executes its module scope for every
  virtual user; a pool of 100 KB bodies consumed both generator cores and later caused an OOM.
  Fixed, and calibration now has to prove the auxiliary chain is ahead of the target.
- **Ingress scales by processes, not threads.** MRI Ruby has a GVL, so one Puma process tops
  out at 92.5 % of a single core. Web runs as replicas behind HAProxy; SMTP is deliberately
  not balanced, because a proxy would hide the outbound address Postal binds.
- **Measured scaling, 2 vCPU:** 20.8 rcpt/s with one worker replica, 48.5 with two.
  Concurrency 4/8/16/32 gives 7.1/15.1/27.8/51.3 rcpt/s.
- **Draining did not depend on queue length** over the available range: 4851 and 9938 rows
  gave the same 20.8 rcpt/s. The threshold lies above what the bench can fill.
- **An IP pool costs throughput rather than adding it.** Postal binds the address at
  acceptance, at random, and batching requires a match on both domain and address: one address
  gave 50.0 rcpt/s at 3.35 messages per SMTP session, six gave 34.1 at 1.42.
- **The receiver is what binds.** Under per-IP volume limits the same build on the same
  hardware delivered 13.3 rcpt/s against 46.3, at 5.17 attempts per delivered recipient —
  working harder for a quarter of the result. Capacity is bought in addresses, not cores.
- **A conclusion recorded here earlier was withdrawn.** "A concurrency cap costs throughput
  even when it refuses nothing" was an artefact: `master.cf` had no `anvil` service, so the
  cap applied to nobody while every connection still paid for a failed lookup. The cost was
  the failed lookup, not the service, and the cost of anvil itself remains unmeasured. The
  sink now proves its caps at deploy time, from a non-exempt address, and refuses to deploy if
  nothing is refused.
