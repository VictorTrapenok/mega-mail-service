# Roadmap

## Not completed in the current iteration

Deliberately deferred in order to obtain the baseline sooner. The order roughly
corresponds to priority.

### Measurements

- **Filling the queue beyond a hundred thousand rows.** At the moment `bench_prefill` fills
  the queue the normal way — through the API with the workers stopped, and this is limited
  by the ingress rate: a hundred thousand rows take on the order of an hour, a million
  almost a day. Profiles of millions of rows need a bulk path through SQL,
  reproducing the `messages` row, the two longblob rows of the per-day raw table
  and the queue row with all its associations, plus a mandatory check that after
  such a fill delivery proceeds normally and the reconciliation adds up. Until that exists,
  the measurable range of queue lengths is limited to roughly 10⁵.
- **Queue composition profiles besides the deferred share.** The share of rows
  with `retry_after` in the future is implemented. Not reproduced: a foreign `ip_address_id`
  (requires pools enabled and several addresses) and the distribution of `attempts`,
  which affects the retry intervals.
- **A series of runs and the noise floor.** At the moment `benchmark.yml` performs a single run.
  A `campaign.yml` is needed: alternating `baseline → candidate → baseline`,
  at least three repeats, the median and the spread, and a refusal to declare a win
  for a gain within the spread.
- **Comparison of two reports** by a script with an explicit verdict, including
  "the difference is indistinguishable from noise".
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

### Credibility

- **Provider tiers on the sink.** The per-IP limits are now uniform: every destination
  domain is throttled alike. A real mix is a handful of large providers with hard limits and
  a long tail with looser ones, and the aggregate ceiling of such a mix is not the ceiling
  measured against one uniform limit. Doing it properly needs either a policy service keyed
  on the recipient domain (`check_policy_service`, one daemon, domain-aware) or one Postfix
  instance per tier on its own address with the DNS zone handing out different MX records.
  The zone already answers the destination domains from a CoreDNS `template` block, so the
  second option is mostly addressing work.
- **Greylisting and reputation quotas.** Neither is modelled. Greylisting in particular
  changes the shape of a first-contact delivery completely and Postfix has no native support
  for it — it is a policy service too, so it shares the work above.
- **The limit values are an assumption.** `bench_sink_profiles.provider` holds typical
  numbers for a large MX because the customer has supplied neither the destination-domain mix
  nor the throttling actually observed. Every figure derived from them, above all the count of
  sending addresses needed for the target rate, inherits that status and the report says so.
- **Pacing, as a measured variant and then as an optimisation.** The two-arm run showed the
  sender attempting four times its allowance per address and still using only 65 % of the
  quota: the receiver meters over 60 s while Postal defers a refusal by a hardcoded five
  minutes, so the quota goes unused while the work sits parked. Raising concurrency cannot
  fix this and was measured not to. What is needed is a sender that paces to the receiver's
  rate — first as a bench variant that proves the ceiling is reachable, then in our own
  build. Until it exists, no address count for the target rate can be derived, and the report
  correctly refuses to print one.
- **Per-destination throttling state in the sender.** Postal has none: no per-domain or
  per-IP rate accounting, no backoff shorter than the five-minute ladder, no memory that a
  destination just refused it. That is the concrete gap the pacing work would fill.
- **A rate limit that binds without the concurrency cap doing the work.** The concurrency cap
  alone was measured as ineffective at 10: worker threads spend much of their time in the
  database and the effective session count never reached it. The volume limits are what bind
  at any concurrency, and the two have not yet been varied separately.
- **SMTP fault injection beyond throttling.** Permanent rejections `550/551/552`, a slow
  banner, a dropped connection, a TLS refusal, an ambiguous drop after `DATA`. Temporary
  rejections are now exercised by the sink profile, but the hard-failure and bounce paths
  still are not.
- **The duplicate detector only covers the primary profile.** The drain arm now compares the
  messages the sink accepted with the distinct `to=` addresses it saw, which catches a
  recipient delivered twice. With more than one recipient per message that comparison stops
  being meaningful and the check has to move to distinct `X-Postal-MsgID` values.
- **A full load matrix**: MIME sizes of 10 KB / 1 MB, 10 and 50 recipients
  per message, domain cardinality 1 / 10,000, tracking and webhooks.
- **The `tracking` and `webhooks` flags in the profile have no effect.** They are
  declared in `bench_profiles` but are wired neither into the seeding nor into the config:
  they are effectively disabled because `postal_seed` creates neither a `TrackDomain`
  nor a `Webhook`. In production, tracking writes a row into `links` for every link,
  and a webhook is an HTTP POST from the same worker, and neither path is exercised at all.
  Either implement them or remove the flags, so the report does not claim what is not there.
- **STARTTLS on outbound delivery is absent.** The sink does not advertise TLS,
  and with `ssl_mode: Auto` Postal hands the message over in the clear. Real
  delivery is almost always encrypted: that is a handshake per connection plus
  encryption of the body, on the order of 5–15 % of the worker's CPU.
- **`send_limit` is removed by the seeding** (`send_limit: nil`), so send limit
  accounting is not performed on each delivery — and that is an `UPDATE` of a single
  `servers` row per message, i.e. one of the serialisation points.
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
- **Building our own images** from a git ref with a local registry and a tag based on the commit
  SHA — an environment for comparing our own builds.
- **Sharding across N independent installations** as a control experiment.
  Both confirmed serialisation points — the global `statistics` row
  and the shared queue — sit at the installation level, so this may
  turn out to be the cheapest way to reach the target, and it is worth checking
  before any rewrite of the worker.
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
