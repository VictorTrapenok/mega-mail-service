# Roadmap

## Not completed in the current iteration

Deliberately deferred in order to obtain the baseline sooner. The order roughly
corresponds to priority.

### Measurements

- **Queue composition profiles besides the deferred share.** The share of rows
  with `retry_after` in the future is implemented. Not reproduced: a foreign `ip_address_id`
  (requires pools enabled and several addresses) and the distribution of `attempts`,
  which affects the retry intervals.
- **Stepped load** for finding the maximum sustained rate:
  at the moment the rate is set by hand. The practical need is confirmed: the ingress
  limit on the current bench lies between 15 and 58 rcpt/s, and it was found
  by two blind runs.
- **Calibration does not check the generator, only the sink.** `calibrate.yml`
  drives `smtp-source` — a cheap C program — straight into Postfix and draws a conclusion
  about the auxiliary chain's headroom. But the load is applied by k6, which serialises
  a hundred-kilobyte JSON per message, and calibration does not measure its own ceiling
  at all. In a run this looked like a Postal result: the generator
  topped out on its two cores at 27 rcpt/s. A second calibration arm is needed —
  the generator running the target profile into a knowingly fast sink, refusing to
  start a run if the generator itself cannot sustain the target with twofold headroom.

### Our own build

- **Measuring the batch-collection patch.** `batchable_messages` now filters on the indexed
  `domain` column (`docs/optimisations.md`). Nothing about it has been measured yet, so it
  is a hypothesis in the tree until the arm below exists.
- **An arm with a large IP pool.** Our changes are aimed at installations that send from a
  large pool of addresses: the more addresses a pool has, the rarer it is for batch
  collection to reach its `LIMIT 100`, and the more often the query runs to the end of the
  table instead. That is the regime where the patch is expected to pay, and it is the regime
  the bench cannot yet reproduce — `postal_sending_ips` assigns six addresses. What is needed
  is N addresses generated onto a dummy interface, still proved with a real `MAIL FROM`, plus
  the matching `ip_addresses` rows and DNS names, and then a curve across N.
- **Running the suite without a server.** `playbooks/rspec.yml` closes the CI round trip for
  anyone with a test host, but the suite still cannot run on a workstation: it needs Ruby
  3.4.6, a MySQL server and Docker at once. A devcontainer would close that too. Lower
  priority now that a one-line patch can be checked in a few minutes against a test host.
- **The var-naming skip in `.ansible-lint`.** `var-naming[no-role-prefix]` is skipped because
  it fires 113 times and the convention it wants is wrong for roles that publish facts other
  plays consume. The genuinely role-local registers among those 113 could still be renamed,
  which would let the rule come back on; it is a mechanical change across every role with a
  real chance of missing a reference, so it waits for a quiet moment.
- **Signing the published image.** The handover currently rests on a label, which proves
  which source an image was built from but not who built it. cosign or GitHub attestations
  if provenance ever has to survive an argument.

### Credibility

- **The limit values are an assumption.** `bench_sink_profiles.provider` holds typical
  numbers for a large MX because the customer has supplied neither the destination-domain mix
  nor the throttling actually observed. Every figure derived from them, above all the count of
  sending addresses needed for the target rate, inherits that status and the report says so.
- **Per-destination throttling state in the sender.** Postal has none: no per-domain or
  per-IP rate accounting, no backoff shorter than the five-minute ladder, no memory that a
  destination just refused it. That is the concrete gap the pacing work would fill.
- **A rate limit that binds without the concurrency cap doing the work.** The concurrency cap
  alone was measured as ineffective at 10: worker threads spend much of their time in the
  database and the effective session count never reached it. The volume limits are what bind
  at any concurrency, and the two have not yet been varied separately.
- **SMTP fault injection beyond throttling.** Permanent rejections `550/551/552`, a slow
  banner, a dropped connection, an ambiguous drop after `DATA`. Temporary
  rejections are now exercised by the sink profile, but the hard-failure and bounce paths
  still are not.
- **The duplicate detector only covers the primary profile.** The drain arm now compares the
  messages the sink accepted with the distinct `to=` addresses it saw, which catches a
  recipient delivered twice. With more than one recipient per message that comparison stops
  being meaningful and the check has to move to distinct `X-Postal-MsgID` values.
- **A full load matrix**: MIME sizes of 10 KB / 1 MB, 10 and 50 recipients
  per message, domain cardinality 1 / 10,000, tracking and webhooks.
- **The MariaDB binlog is disabled**, so disk writes are roughly half those of any
  installation with replication. It is not limiting at present, but it understates the I/O profile.
- **Effective concurrency is well below the configured one.** A series across concurrency was
  run (4/8/16/32 giving 7.1/15.1/27.8/51.3 rcpt/s), but at a per-IP cap of 10 there were no
  rejections at all, which means fewer than ten sessions were actually open at once out of the
  32 configured. Worker threads spend a large share of their time in the database rather than
  on the network. How large is unmeasured, and it is the number that decides how many threads
  are worth configuring.

### Diagnostics

- **Ruby profiling.** rbspy from the host rather than from the container: `bin/postal`
  does not `exec`, so PID 1 is bash, and `--pid` from
  `docker inspect` is needed together with `--subprocesses`. Take into account that rbspy sees only
  the thread holding the GVL and therefore systematically underestimates threads
  blocked on I/O.
- **MariaDB diagnostics**: a slow-log window with `log_slow_verbosity=query_plan,explain`,
  `performance_schema` (whose consumers can only be set via startup options),
  the `SUM_ROWS_EXAMINED / COUNT_STAR` ratio for the digest of the queue claim
  query — direct falsifiable evidence of a full scan.
- **Prometheus and exporters** — once six numbers stop being enough.
  Separately: an SQL exporter instead of the CSV sampler.

### Bench capabilities

- **IP pools across several hosts.** Implemented for one host: the `postal_sending_ips` role
  assigns six addresses, verifies them with a real `MAIL FROM` / `RCPT TO`, and the report
  shows the delivery breakdown per address. Not covered: a pool spanning several worker hosts
  (each host may only bind its own addresses, so the queue partitions by host and an idle host
  cannot help a busy one), priorities other than equal, and address rotation during a run.
- **Building our own images** — done for a single machine: the Postal source lives in
  `vendor/postal/`, `postal_image` builds it, the tag is a hash of the source and the running
  container is checked against it (see [docs/custom-builds.md](docs/custom-builds.md)).
  What remains:
  - **A local registry.** Every Postal host currently builds from the same archive on its
    own. Both inventories place all Postal groups on one machine, so nothing is broken yet,
    but with the workers spread over several hosts the builds could drift apart: the base
    tag `ruby:3.4.6-slim-bookworm` moves and the build is not bit-reproducible. Build once,
    push, pull — and only then can a multi-host run claim the hosts ran the same code.
  - **Pinning the base image by digest.** `postal_build_pull` is off so a series is not
    rebased mid-flight, but the first build on a fresh host takes whatever the tag pointed
    at that day. The Dockerfile has to carry a digest.
- **Handling of failures and returns** (bounce, return-path): at the moment the sink
  discards everything, and the inbound path is not exercised at all.

## Known limitations of the current implementation

Found by review and deliberately left open — each of them either does not prevent obtaining
the baseline or requires hardware that is not available yet.

- **Runs are not serialised.** Nothing prevents launching two `benchmark.yml`
  runs simultaneously on one bench, or a run without prior calibration.
  A file lock and a calibration freshness marker are needed.
- **The queue sampler creates load itself**: a `COUNT(*)` over `queued_messages`
  every 5 seconds on the same MariaDB as the system under test. On a long
  queue this is a full scan. It is noted in the report as a caveat; the proper
  solution is a separate exporter with a cheaper query.
- **More carries over between runs than is reset.** `bench_reset`
  clears the queue, the suppressions, the message database and the logs, but does not equalise
  the buffer pool warmth, the tablespace layout and the AUTO_INCREMENT values.
  For a series of five repeats this must be closed by restoring the MariaDB
  volume from a snapshot.
- **IP pools have not been verified end to end.** The mechanics are accounted for (host networking,
  seeding of pools, HELO in the zone), but the roles for assigning addresses to the interface
  and for checking the "address in the DB ↔ address on the host" correspondence do not exist yet.
- **The report prints variables rather than the actual container configuration.**
  The digest of the running image and the MariaDB variables are read back from the hosts,
  everything else comes from `group_vars`. A discrepancy is possible if someone
  edited the configuration by hand.
- **The domain distribution is quadratic rather than Zipf**: the share of the hottest
  domain is lower than with a true Zipf, so Postal's batching is exercised
  less than in reality. It is called by its name in the report.

## Open questions for the customer

1. Where exactly was the current limit measured: Postal ingress, queue growth, connection
   attempts, or confirmed responses from remote MX hosts? That determines whether
   we are reproducing the ingress limit or the delivery limit.
2. The production feature mix: tracking, DKIM, webhooks, the number of mail servers,
   the p95 MIME size, recipients per message. This pins down the primary profile.
3. Storage: 5M recipients at a MIME size of 100 KB is about 500 GB of raw data
   per day. What retention is required.
