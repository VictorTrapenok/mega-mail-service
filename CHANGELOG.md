# CHANGELOG

## 2026-09-05

### The bench now exercises what production does

- **`send_limit` is no longer cleared by the seeding.** With the column nil,
  `Server#send_limit_exceeded?` returns immediately and the whole check is skipped —
  including the `UPDATE` of the `servers` row that happens on every message, one of the three
  serialisation points of an installation. It is now set high enough never to hold a message,
  so the cost of the check is reproduced without its effect.
- **The `tracking` and `webhooks` profile flags now do something, and are on.** Seeding
  creates a `TrackDomain` (with `dns_status: "OK"`, which is both what `MessageParser` looks
  for and what skips the CNAME check) and a `Webhook`. Webhook POSTs go to a fixed-204
  frontend added to the bench HAProxy, so the receiver adds no latency of its own.
  `bench_reset` now truncates `webhook_requests`, and the single-host inventory gained a
  `postal_load_balancers` host because that is where the webhook sink runs.
  **Numbers from these profiles are not comparable with `reports/reference/`**, which were
  measured with both features off.
- **Found while turning webhooks on: Postal blocks them to private addresses.**
  `Postal::HTTP::AddressGuard` refuses any outbound webhook whose destination resolves into
  an RFC1918, loopback or link-local range, as SSRF protection. It fails quietly in the way
  that matters — the request row is created, retried and recorded, and the only sign is
  `error` reading `Code received was -4`. The bench now sets
  `POSTAL_ALLOWED_REQUEST_DESTINATIONS` for its own sink, and the behaviour is written up in
  `docs/postal-internals.md`, because any installation with an internal webhook endpoint hits
  it.
- Verified on the bench rather than assumed: `send_limit` is 10000000 on the seeded server,
  the track domain exists with `dns_status: OK`, and a message carrying an HTML link came out
  with `tracked_links: 2`, `tracked_images: 1` and two rows in `links`, while HAProxy logged
  the matching webhook POSTs answered 204.

### Scope and framing

- The source in `vendor/postal/` is treated as ours: references to the upstream repository,
  its commit and the procedure for tracking it are gone. `postal_build_upstream_*` collapsed
  into a single `postal_version`, the image label is `bench.postal.version`, and the
  `upstream` image source is kept only because the runs in `reports/reference/` were made on
  it and have to remain re-measurable.
- What needs hardware we do not have moved out of `roadmap.md` and into a README section,
  **"What still needs the customer's infrastructure"** — the query plan on real data, filling
  the queue to 10^5-10^6 rows, the composite index, pacing and provider tiers, and sharding
  across installations. It states plainly that we are waiting for access.
- The IP-pool finding is stated as what our changes target rather than as a fault of the
  customer's configuration: the larger the pool, the more work Postal does per message, and
  the more there is to recover in the code.
- Dropped from the roadmap as not wanted for the MVP: the campaign/noise-floor work, the
  `local`-vs-`upstream` comparison, tying a report to a git commit, and the STARTTLS gap.

## 2026-09-04

### Running the test suite

- Role `postal_specs` and `playbooks/rspec.yml`: build the `ci` target on a host that has
  Docker and run Postal's rspec suite against a throw-away MariaDB, then tear it down. It
  ships the same deterministic archive the image build uses, so a suite result and a
  benchmark result carry the same source digest.
- Result of the first run: **812 examples, 0 failures**, and both new examples confirmed to
  run by name rather than inferred from the total. The batch-key
  patch is correct; nothing about its speed has been measured.
- New `postal_specs` inventory group in both inventories. In the measurement inventory it
  points at `aux`, not the system under test: the build is a two-core bundle install, and on
  `sut` it would compete with a measurement and be squeezed by the memory the Postal stack
  already holds (measured: 597 MB available on sut against 3198 on aux).

### CI and image handover

- `.github/workflows/postal-image.yml`: every push computes the source digest, runs Postal's
  rspec suite against a `ci` build, and on success pushes the `full` image to GHCR as
  `ghcr.io/<owner>/<repo>/postal` tagged `src-<digest>`, `sha-<commit>`, `latest` on the
  default branch and `v*` from git tags. Publishing is gated on the suite.
- **The source identity is now git's tree object id for `vendor/postal`**, taken through a
  throw-away index so it describes the working tree. It replaced a hash of a
  metadata-stripped tar archive, which was not in fact deterministic: it depended first on
  the checkout umask and then, after that was normalised, on the tar version — GNU tar 1.34
  and 1.35 hashed a byte-identical tree to `52733cbabb11` and `722b34598b73`, so the first
  published image carried a tag the bench would never produce. Caught by comparing the CI
  run against the local one. The build context is now exported from the same tree id with
  `git archive`, and the image label is `bench.source.tree`.
- `vendor/` excluded from yamllint and ansible-lint — the fork is a Rails application and
  every finding in it would be noise against the diff we own.

### First optimisation in the fork

- `QueuedMessage#batchable_messages` now also filters on the indexed `domain` column. For an
  outgoing message `batch_key` is `"outgoing-" + domain` and both columns are written from
  the same value, so the predicate changes no result — it gives MySQL
  `index_queued_messages_on_domain` to seek on instead of scanning the table by primary key
  once per delivered message. **No schema change**, so it can be deployed and rolled back on
  a live installation by swapping the image.
- Two specs added for the new path; the existing upstream specs use a batch key that does not
  satisfy the invariant, so they exercise the unchanged path unmodified.
- `docs/optimisations.md`: the patch log for the fork. This change is recorded as a
  hypothesis — it has not been measured, and the bench cannot yet reach the regime where it
  would show (a queue of 10^5+ rows, a pool of many addresses).

### Our own build of Postal

- Postal 3.3.7 forked into `vendor/postal/` (upstream commit `d038eaa`), edited in this
  working tree — no submodule, no second remote.
- `postal_image` split into two paths behind `postal_image_source`: `upstream` resolves the
  official ghcr.io image to a digest as before, `local` (the new default) builds the fork.
- The local image is tagged by a SHA-256 of a deterministic archive of the source, so the
  tag changes if and only if the code does. An unchanged tree resolves to an image that
  already exists and the build is skipped.
- `playbooks/build.yml`: build, deploy, migrate the schema, then assert that the running
  worker carries the source digest of the working tree. Imported by `benchmark.yml`,
  `ingress.yml` and `drain.yml` before the reset, so a run always measures the current
  source (`postal_build_before_run=false` to skip).
- The report names the build in its headline and prints the source digest as built and as
  read back off the running container, with a warning row when the two disagree or the
  label is absent.
- `docs/custom-builds.md`: the edit-and-measure loop, adding an index as a migration,
  refreshing the fork from upstream, and what this setup does not do.

## 2026-09-03

### Requirements revision

- `postal-benchmark-ansible-task.md`, revision 2 — based on reading the
  Postal 3.3.7 sources. Technically unachievable requirements were removed
  (hosts file entries instead of DNS, Route53, HAProxy for SMTP), the reconciliation
  identity was corrected, the unit of load was pinned to recipients, idempotency
  was moved from the acceptance criteria to the wish list, and the metric set was reduced
  to the minimum.

### The bench

- The Ansible project skeleton: `ansible.cfg`, collection pins, two inventories,
  shared variables in `group_vars/all`.
- Host preparation roles: `common`, `docker_host`, `containment`.
- Infrastructure roles: `test_dns` (CoreDNS, an authoritative `.test` zone
  without forwarders), `mariadb` with settings pinned and read back.
- System-under-test roles: `postal_image` (resolving the reference to a digest),
  `postal_app` (three processes and a runner on the host network), `postal_schema`,
  `postal_seed` (seeding through `rails runner`).
- Measurement environment roles: `postfix_sink`, `loadgen` (k6, open
  model), `bench_run`, `bench_report`, `bench_reset`.
- Playbooks: `site`, `seed`, `smoke`, `calibrate`, `benchmark`, `reset`.
- Documentation: `README.md`, `ARCHITECTURE.md` with a glossary,
  `docs/postal-internals.md`, `roadmap.md`. CI: yamllint, ansible-lint,
  inventory parsing and syntax checks.

### Fixes after the adversarial review

A review through six independent lenses, with every finding verified, found 52 defects.
Most of them belonged to the class "the run completes successfully but the numbers in the
report are made up", so they are listed separately:

- **Frozen time.** All window timestamps were taken from `ansible_date_time` —
  a snapshot made during fact gathering, not a clock. The window always came out
  as exactly `-bench_warmup_s` seconds, the reconciliation query found no rows,
  and the report nevertheless rendered without errors. Replaced by reading `date` on the
  main DB host at the moment of each timestamp.
- **The warm-up in the result.** The k6 summary covered both phases while the window and the
  reconciliation covered only the working one, which overstated the rate by roughly 20 % and
  made the reconciliation impossible to satisfy in principle. The warm-up and the load were
  split into two separate generator invocations.
- **403 from Rails.** Postal does `config.hosts << web_hostname`, and a non-empty
  `config.hosts` enables host authorization: a request by IP got a 403.
  A `Host` header was added to the generator, the smoke test and the web healthcheck.
- **NAT broke delivery.** The sink published a port, so the nftables rule
  in the forward chain saw a translated destination address and rejected the mail,
  while Postfix saw a translated source address and answered `554 relay denied`.
  The sink and the DNS were moved to host networking.
- **Calibration measured nothing.** `smtp-source` did not run at all —
  it was swallowed by the image's ENTRYPOINT; the check counted log lines
  cumulatively and compared a count rather than a rate. It was rewritten: an explicit
  `--entrypoint`, counters before and after, computation of the rate, and the
  filter precedence in Jinja was fixed.
- **Checks that could not fail.** The smoke test grepped the log without a marker
  and passed on any bench that had ever delivered anything; the leak counter
  was read on one host but reset on another; the "no outbound delivery services"
  guard compared fields separated by a slash that does not appear in the `postconf -M`
  output. All three were tied to specific data.
- **Variables out of scope.** Paths and ports lived in role defaults
  and were undefined in playbooks that do not include those roles.
  They were moved to `group_vars/all/15-paths.yml`.
- **Port collision.** The base of the worker health servers sat right next
  to the SMTP port: from the second replica onwards the check polled a foreign process
  and passed. The bases were spread apart.
- Other items: a double prefix in the verification TXT record; `bench_run_id`
  as a play variable was not visible to the next play; a silently swallowed
  drain timeout; unapplied generator limits; artifacts left behind
  on remote hosts; `maillog_file_permissions`, which does not exist in Postfix;
  a sink memory limit below the size of its own tmpfs; repeated addresses between
  phases; a reconciliation tolerance that was declared but never checked.

Verified locally: the syntax of 12 combinations of playbooks and inventories, rendering of
all templates with real Ansible, `docker compose config` for all four
compose files, yamllint with no warnings.

### Separate measurement of ingress and queue draining

The first run produced 49.9 rcpt/s on a 2-vCPU VPS — three times higher than the best public
measurements of Postal. Analysing the cause showed that the number was not throughput
but the ingress rate against a growing queue.

- The headline metric of a combined run is **sustained throughput**
  (delivered over the window and the drain). On the data of the first run that is
  21.9 rcpt/s instead of 49.9.
- `playbooks/ingress.yml`: ingress only, workers stopped; the queue growth
  is reconciled against what was accepted.
- `playbooks/drain.yml`: draining of a pre-filled queue only. The roles
  `bench_prefill` (filling the normal way through the API, deferred share),
  `bench_drain`, `bench_workers`, `bench_samplers`.
- The `bench_prefill_recipients` variable was implemented; the previous
  `prefill_recipients` in the profile was read by no role at all.
- `docs/postal-internals.md`: the queue mechanics were clarified. The claim query
  without `ORDER BY` stops at the first suitable row and only becomes expensive
  when the head of the table is not ready; linear growth comes from `batchable_messages(100)`,
  which, without an index on `batch_key`, runs to the end of the table for every message.
- The generator: a message body from a dictionary instead of a repeated byte, multipart
  with an HTML part, a `burst` mode for filling, and the VU ceiling raised from ×10 to ×30 —
  at ×10 the generator itself limited the rate as soon as the ingress latency
  reached 10 s.
- The queue sampler counts rows as ready by the same condition as the worker
  (`retry_after < now - 30 s`) rather than by `now`.
- The `wide_domains` profile (100,000 domains) for checking the cost of the batch query.

Verified locally: playbook syntax, rendering of the report in all three modes
on test data, line lengths and the absence of trailing whitespace.

### Fixing the report: the role never once ran to completion

The very first run of the new playbooks showed that `bench_report` had never
executed successfully — the previous `micro-summary.md` was not produced by that role.
Six defects were found and fixed, all of which predated the separate measurements:

- `bench_run_seconds` was not defined anywhere in the project. It is now computed
  from the start of the warm-up using a live clock rather than from the sum of the timeouts —
  the latter would have captured the logs of the previous run.
- A failure on `Decimal`: `SUM()` returns a DECIMAL, which the module cannot
  serialise when `no_log` is enabled. It did not show up while the queue stayed
  empty and `SUM` returned `NULL`. All `SUM` calls were wrapped in `CAST(… AS SIGNED)`.
- The `Pending` bucket was counted both in the terminal states and in the queue remainder —
  double counting. It was masked by the fact that with a completed drain `Pending` = 0.
- `postal_image_resolved` lives only in the fact cache, and an empty cache failed the run.
  The report reads the actually running image via `docker inspect` anyway.
- The p50 and p99 latencies were printed as zeros: in the k6 summary the median sits under the
  `med` key, and p99 is not computed at all by default. `summaryTrendStats` was added.
- The reconciliation identity was not suitable for stopped workers: what was accepted is
  counted over the window, whereas the queue remainder was taken over the whole table
  together with the warm-up messages.

### The generator turned out to be the bottleneck instead of Postal

- The k6 module scope is executed anew for EVERY virtual user.
  A pool of 16 bodies of 100 KB was reassembled character by character on every VU and consumed
  both generator cores (199.5 % against a 200 % limit), and once the CPU bottleneck was removed
  the same pool caused an OOM at 1740 VUs. The body is now the same for all messages — as
  in a real mailing, where the addressee and the headers differ — and the init of one VU
  takes 0.37 ms instead of ~100 ms.
- The body budget was counted in characters rather than bytes: with non-ASCII text 144 KB
  went over the wire instead of the declared 100, and quoted-printable would have inflated
  that threefold in the database.
  The dictionary is now predominantly ASCII with 6.8 % non-ASCII, and the budget is in bytes.
- The generator memory limit was raised to 2 GB: by Little's law the number of VUs equals
  the rate multiplied by the ingress latency.

### First separate results on the 2-vCPU bench

Profile: MIME 100 KB multipart, 1 recipient, 1000 domains, no retries and no TLS.

- **Ingress — 14.8 recipients/s**, latency p50 49 ms, p95 61 ms, p99 68 ms,
  zero rejections, queue growth exactly equal to what was accepted. The limiter is
  the CPU of the web process: 92.5 % under a limit of exactly 1.0 core.
- **Queue draining — 20.8 recipients/s**, the reconciliation added up in both directions
  (sink 5000 = Postal 5000). The limiter is not CPU: the worker holds 89.2 %
  under a 200 % limit, i.e. less than one core. It is bound by concurrency and the GVL.
- **The bottleneck on this bench is ingress, not the workers.** This contradicts
  the customer's original hypothesis about the speed of the Ruby workers.
- **A dependency of draining on queue length was not confirmed**: 4851 and 9938 rows
  gave the same 20.8/s. The threshold is above the available range; a bulk prefill is needed.
- Cost per message: ingress 62 ms of CPU, draining 43 ms, MariaDB about 20 ms.
  From this, 5M/day (57.9/s) requires roughly 7.2 cores of continuous load.

### Ingress replicas behind HAProxy

MRI Ruby has a GVL, so a single Puma process does not perform CPU-bound work
(building multipart, quoted-printable, DKIM signing) on more than one core.
Ingress therefore scales by processes, and adding cores to one process achieves nothing.

- `postal_web_replicas`: web is now a set of replicas on consecutive ports,
  by analogy with the workers. `remove_orphans` was added to `postal_app`, otherwise the
  previous single `web` container would keep running and holding its port.
- The `postal_lb` role: HAProxy for the HTTP API only. It waits not for the fact of
  startup but for the number of live backends, otherwise a run would silently measure
  fewer processes than the report records. Balancing SMTP remains forbidden.
- It runs on the auxiliary machine rather than on the SUT: there it would steal cores
  from what is being measured.
- `postal_api_addr`: the generator and the smoke test go through the balancer as soon as
  it appears in the inventory; talking to the first process would measure one process.

### Measured scaling on 2 vCPU

| Configuration | Rate | p50 | p99 | Dropped | CPU of the SUT |
|---|---|---|---|---|---|
| Ingress, 1 process, target 58 | 14.9/s (overload) | 18,700 ms | — | 3571 | 110 % |
| Ingress, 2 processes, target 30 | 29.3/s | 42 ms | 67 ms | 0 | 98 % |
| Ingress, 2 processes, target 58 | **56.7/s** | 49.6 ms | 163 ms | 0 | 142 % |
| Draining, 1 worker | 20.8/s | — | — | — | 108 % |
| Draining, 2 workers | **48.5/s** | — | — | — | 169 % |

- **The target of 58 recipients/s for ingress was reached on two cores** with headroom.
  HAProxy split the load evenly: 3601 and 3600 requests, CPU 56.8 % and 56.8 %.
- Ingress scales ×1.98 by processes, draining ×2.33 — both practically linearly.
- **The earlier cost estimate was inflated twofold.** The figure of 62 ms was taken from an
  overloaded run, where Puma spends CPU managing 1740 connections and on GC: 14.9/s was
  not the ceiling of a process but its behaviour while choking. On clean runs the cost is
  **25 ms per message for ingress including the DB** and **35 ms for draining**, 60 ms for
  the full cycle. 5M/day therefore needs about 3.5 cores of continuous load, i.e.
  8 vCPU with headroom rather than the 16 estimated earlier.

### A realistic sink latency, and what it revealed

`postfix_sink_response_delay_ms` delays outgoing packets from port 25 with tc netem.
The network is shaped rather than Postfix altered, so the sink stays a real Postfix with a
queue and a discard transport. Unmatched traffic goes through the default band without delay —
otherwise the run would take SSH down with it. The delay is printed in the report, and the
"what this run does not prove" section changes accordingly.

**A sink answering instantly overstated draining sevenfold.** At 75 ms per response the
rate fell from 48.5 to 7.1 recipients/s, while worker CPU dropped from 73.5 % to 19.7 %:
563 ms of wall-clock per message against roughly 35 ms of compute. The worker spends about
90 % of its time waiting for the recipient. Draining is not a compute task — its ceiling is
concurrency divided by the delivery latency.

### Concurrency scales almost linearly

A series at a 75 ms delay, two worker replicas, `MAIN_DB_POOL_SIZE` 40:

| Concurrency | Rate | Workers | MariaDB | Total CPU | CPU/message |
|---|---|---|---|---|---|
| 4 (2×2) | 7.1/s | 39.1 % | 6.5 % | 47.5 % | 67 ms |
| 8 (2×4) | 15.1/s | 67.4 % | 10.4 % | 79.4 % | 53 ms |
| 16 (2×8) | 27.8/s | 99.9 % | 13.8 % | 115.2 % | 41 ms |
| 32 (2×16) | **51.3/s** | 141.5 % | 18.4 % | 161.8 % | 32 ms |

- Eight times the concurrency yielded 7.2 times the rate — 90 % scaling efficiency. The
  tail-off comes from approaching the CPU ceiling of the machine, not from serialisation.
- **51.3 recipients/s is 4.43M messages per day on a two-core VPS** with a realistic network
  delay. The customer's claim of being unable to scale past 1M/day therefore describes a
  particular configuration, not Postal itself.
- Cost per message falls as concurrency grows (67 → 32 ms): the fixed overhead of idle
  polling and healthchecks is spread over more messages.
- MariaDB grows slowly (6.5 → 18.4 %) and is not the limiter over this range.

### IP pools cannot be measured on this bench

Additional addresses are not routed: the provider hands out a `/32`, and a secondary address
gets 100 % packet loss. Seeding of pools exists in `postal_seed`, but there is no role that
assigns addresses to the interface, and a multi-address pool needs addresses from the provider.

This does not affect the conclusion above. A pool cannot raise throughput on the bench at all:
our sink accepts from any address with `smtpd_client_connection_count_limit: 0`, so a pool only
adds work — `allocate_ip_address` per message and a filter on `ip_address_id`. Its purpose in
production is different: recipient providers cap concurrent sessions per address, so the
concurrency of 32 measured here is unreachable from a single IP against real MX hosts. The pool
removes an external limit rather than speeding delivery up.

### IP pools across several addresses of one host

Five extra private addresses per host were assigned in the provider's console; a locally
invented address is not routed, so the provider must know them first.

- The `postal_sending_ips` role assigns the addresses to the interface, persists them in a
  netplan drop-in (without it a reboot removes them and the share of the queue bound to them
  stops being processed, silently), and verifies them. It runs after the sink, because the
  verification needs something listening on port 25.
- The inventory lists six outbound addresses with HELO names `mta1`–`mta6`. That single list
  drives the address assignment, the `ip_addresses` rows and the A records in the DNS zone,
  so the host and the database cannot drift apart.
- `postfix_sink_client_connection_limit` caps simultaneous connections per client address.
  Without it a pool can only look like overhead on the bench: nothing here limits per-source
  concurrency the way real recipient providers do.
- The report prints the pool state, the address count, the sink cap, and for drain runs a
  breakdown of the source addresses the sink actually saw.
- Both sink-realism knobs moved to `group_vars`: the report runs on the DB host, where a
  default of the sink role is invisible, and it printed zeros regardless of the real value.

**The first pool run hard-failed 83 % of the messages, and that was a defect in the bench,
not in Postal.** The pool worked: the messages spread across all six addresses, and exactly
one sixth — those bound to the primary address — were delivered. The other five connected
successfully and were then refused at `RCPT TO` with `554 Access denied`, because the sink
only relays for clients in `mynetworks`, and that list was built from service addresses only.
`stand_cidr` now includes every worker's outbound addresses.

The verification in the role was the wrong shape and is now fixed: a TCP connect succeeded
from all six addresses, which is exactly why it missed a protocol-level relay denial. It now
performs a real `MAIL FROM` / `RCPT TO`. Three distinct failures matter here — an address
absent from the host, an address the router does not know, and an address the sink will not
relay for — and only the last one needs an SMTP transaction to detect.

### Measured: what an IP pool costs, and what one address delivers

All at a 75 ms sink response delay, 2 worker replicas x 16 threads, queue ~2.6-2.8k rows,
1000 destination domains. Connections counted as `disconnect from` lines: Postfix writes
`client=` per message rather than per connection, and `grep -c 'connect from'` also matches
`disconnect from`, so both naive counts are wrong.

| Configuration | Rate | Connections / 3000 messages | Messages per session |
|---|---|---|---|
| No pool, one address | 50.0/s | 896 | 3.35 |
| Pool of 6 addresses | 34.1/s | 2114 | 1.42 |

- The pool spreads evenly: 403-480 deliveries per address out of 3000, taken from Postal's own
  `deliveries.details` rather than from the sink log.
- **A pool costs about a third of the throughput.** `batchable_messages` filters on
  `ip_address_id` as well as `batch_key`, so six addresses thin out the batch candidates and
  sessions become 2.4x more numerous. A pool is a deliverability requirement with a throughput
  price, not a scaling mechanism.
- **Per session, one address delivers 1.6-1.9 recipients/s** at this delay. That is the number
  that matters for a single IP: its capacity is the sessions the recipient permits multiplied
  by roughly 1.7. On the bench one address reached 50 recipients/s and stopped at our CPU, not
  at the address.
- The per-IP connection cap could not be demonstrated: at a cap of 10 there was not one
  rejection, because the effective simultaneous session count stayed below it — worker threads
  spend much of their time in the database rather than on the network. Enabling the cap did
  cost throughput anyway (50.0 to 27.8 without a pool, zero rejections), which points at the
  single-process anvil being consulted per connection. Single runs; treat the cause as probable.

### The per-IP limits of the receiver, and why they had never bound

The bench could configure a per-IP connection cap but had never enforced one. Two independent
defects produced the identical symptom — a deployment that looks throttled and refuses
nothing — and the second one explains a conclusion recorded here earlier.

- **`smtpd_client_event_limit_exceptions` defaults to `$mynetworks`.** Every sending address
  has to be in `mynetworks` to be allowed to relay at all, so the caps were exempt for exactly
  the clients they were meant to limit. Fixed previously; the exemption is now the loopback
  plus the load generator, which is the measuring instrument rather than a sender under test.
- **`master.cf` had no `anvil` service.** The `smtpd_client_*_limit` parameters are not
  implemented inside smtpd — they are a query to `private/anvil`. Without the service the cap
  applies to nobody while every connection still pays for the failed lookup. That is both
  halves of what was recorded here as "at a cap of 10 there was not one rejection… enabling
  the cap did cost throughput anyway (50.0 to 27.8), which points at the single-process anvil
  being consulted per connection". Anvil was not being consulted; it was not running. The
  throughput cost was the failed lookup, not the service. **The earlier conclusion should be
  read as withdrawn**, and the cost of anvil itself is still unmeasured.

Verified rather than assumed: 11 simultaneous connections against a cap of 10 now yield one
`421` from a worker host and none from the exempt loopback.

- The sink role proves the caps at deploy time, from a worker host, and fails if nothing is
  refused. A probe from the sink host or the loopback would pass against an unenforced sink.
- It also refuses to deploy when an exempt address is also a sending address — the normal
  state of the single-host layout, where the generator and the workers are one machine.
- The three volume limits are now variables rather than hardcoded zeros, together with
  `anvil_rate_time_unit`. The concurrency cap alone was measured as ineffective at 10: worker
  threads spend much of their time in the database and never reach it. Volume limits bind at
  any concurrency.

### Sink profile as an axis, and what a throttled run measures

`bench_sink_profile` selects the receiver's policy independently of the frozen load profile:
`unlimited` (the default, an upper bound for Postal) or `provider`. The limit values are an
ASSUMPTION — no destination mix or observed throttling has been supplied — and the report
labels them as such on every run.

Read out of the Postal 3.3.7 sources and now documented in `docs/postal-internals.md`:

- `HasLocking#retry_later` sets `retry_after = now + (1.3 ** attempts) * 5 minutes`. The base
  period is hardcoded; the first retry is five minutes out and 18 attempts span ~31 hours.
  A throttled arm therefore has to run on a prefilled queue, or it measures the retry ladder
  instead of the receiver.
- At the attempt ceiling Postal writes `HardFail`, drops the queue row and adds the recipient
  to the suppression list, so `Held` above zero stops being a sign of a broken bench.
- `SMTPSender` parses "N seconds" / "N minutes" out of the remote reply and uses it as the
  retry delay. Postfix's anvil rejections carry no such hint, but this is the lever a future
  policy-service sink would use to compress a throttled run into a short window.

**The reconciliation would have double-counted every deferred message.** It treated every
status except `Pending` as terminal, while a deferred message keeps its queue row *and*
carries a status, so it was counted on both sides of the identity. `SoftFail` and `Error` are
now classified as in-queue — both go through `retry_later` — and an unknown status fails the
run rather than being silently assumed terminal. This was invisible until the sink began
refusing, because without throttling `SoftFail` is always zero.

The drain gained a `window` mode, selected automatically under a throttling profile: once a
refused row returns to the queue, "no ready rows left" means "everything is either delivered
or deferred" and the rate divided by the starting row count divides by work that was never
going to be done.

New in the report: which limit was hit, refusals by source address, retry amplification
(attempts per delivered recipient), the attempt rate against goodput, time to delivery
p50/p95/p99 — a different quantity from ingress latency, and the one the recipient
experiences — and an estimate of how many sending addresses the target rate needs. That estimate is printed only
when something was actually refused; without refusals it would describe Postal's ceiling while
reading as the provider's.

A duplicate detector came with it: distinct `to=` addresses at the sink against messages
accepted. Both sides are counted over the whole log and only against each other — the
delivered figure used for the rate is a delta across the measured window, and comparing the
two would report every delivery made while the workers were still starting as a duplicate.

**A window misalignment in the drain arm, pre-existing and now fixed.** The sink counters were
read before the workers were started while the clock was recorded after they became ready, so
everything delivered during startup landed inside the sink delta and outside every window the
database was asked about. It surfaced as more recipients delivered than attempts made — 232
against 190 — which is impossible, and was the only reason it was noticed at all. All the
counters are now read after the clock.

The report also reads `POSTAL_USE_IP_POOLS` back from the running container instead of
printing the variable. The two disagreed on the first throttled run: the report said pools
were disabled while six outbound addresses were plainly at work in the refusal breakdown.

**Two of the four limits are indistinguishable in the reply, and the first draft of the
profile measured the wrong one.** smtpd answers `421 ... too many connections` for both the
concurrency cap and the connection RATE cap, so a breakdown built from the reply Postal stored
files every rate rejection under concurrency — which is exactly what the first throttled run
reported. The breakdown now comes from the log warnings, which name the limit outright, and
the same run re-read that way turned out to be 608 connection-rate rejections and not one
concurrency rejection.

That also mis-tuned the profile. Postal reuses an SMTP session for only 1.4 to 3.35 messages,
so a connection-rate cap of 30/min permits about 42 messages a minute and bound at a third of
the 120/min message rate: delivery over the measured window fell to zero and the arm measured
how often Postal opens a socket rather than how much volume the receiver allows. The
connection rate is now set high enough not to bind, so the volume limit is the one that does —
which is what a provider actually meters.

**The delivery-time percentiles were all coming out equal, and the query looked right.**
Putting `COUNT(*)` in the same SELECT as `PERCENTILE_CONT(...) OVER ()` does not do what it
appears to: the aggregate collapses the set to one row first, and the window functions then
run over that single row. p50, p95 and p99 all read 26.6 s against a real spread of 13.8 to
29.9 s. Computed in a subquery and aggregated afterwards they read 25.7 / 29.4 / 29.6.

Counting details that cost nothing to get wrong and everything to notice: the four anvil
warning strings and the reply texts were read out of the `smtpd` binary, not guessed. Postfix
says `450 4.7.1 Error: too much mail`, not "too many messages", and logs the client as
`unknown[10.1.0.2]` rather than as a bare address — the first draft of both greps returned
zero against a log that did contain the events.

### Measured: what a throttling receiver does to Postal

Two arms, identical but for the sink profile: 6 outbound addresses, 75 ms sink response
delay, 2 worker replicas x 2 threads. The `provider` profile caps each source address at 120
messages per 60 s, i.e. 2.0 recipients/s per address, 12/s across the six.

The throttled arm needs a bigger prefill than the baseline and that is not incidental: under a
binding cap a refused row leaves the ready pool for five minutes exactly as a delivered one
leaves it for good, so the queue has to cover the ATTEMPT rate for the whole window. A first
attempt at 15 000 ran dry inside the window and understated goodput by a third (8.0 against
13.0). The report now detects that and says so; the numbers below are from 25 000, where the
pool never emptied.

The numbers below are the two runs kept in [reports/reference/](reports/reference/), so this
table and those reports cannot drift apart. Earlier iterations of the same pair gave 47.0 and
13.0; the spread between repeats has not been measured, so treat differences of that size as
noise rather than as results.

| | Baseline (`unlimited`) | Provider limits |
|---|---|---|
| Queue at start | 14 455 | 24 557 |
| Delivery attempts per second | 46.3 | 68.5 |
| **Goodput, recipients/s** | **46.3** | **13.3** |
| Retry amplification | 1.00 | 5.17 |
| Refusals recorded by the receiver | 0 | 16 900 |
| Reconciliation discrepancy | 0 % | 0 % |

**Postal worked HARDER under the cap and delivered a quarter as much.** The attempt rate rose
from 46 to 69 per second because a refusal is cheaper than a delivery — `450` arrives at
`MAIL FROM` and the message body is never transferred — so the worker cycles faster while
5.17 attempts are spent per recipient that lands. None of that is visible in the drain rate,
which counts only what arrived, and that gap is the reason this arm exists.

Which limit bound: message rate 16 921 rejections, concurrency 8, connection rate 0. The
volume cap dominates as intended; the concurrency cap still cannot bind at this delivery
concurrency, consistent with every earlier run.

**The addresses reached their quota: 2.06 recipients/s each against an allowance of 2.0.**
That is what makes the extrapolation legitimate, and the report only prints it in that case —
**about 29 sending addresses for the target of 58 recipients/s**, i.e. 5M per day. The limits
it rests on are an assumption, and the figure inherits that: read it as the shape of the
answer — capacity is bought in addresses, not in cores — rather than as a procurement number.

The reference run also caught nine recipients delivered twice out of 4310. The worker
containers have distinct hostnames, so this is not a broken deployment but at-least-once
delivery: the receiver took the message and the acknowledgement did not get back, so Postal
recorded a failure and retried. Postal carries no delivery-attempt identifier that would let a
receiver drop the second copy, and the more a receiver refuses, the more of this there is.

The earlier, understated run is still instructive: at 15 000 prefilled the addresses reached
only 65 % of their allowance while attempting four times it, because the receiver meters over
60 s and Postal defers a refusal by a hardcoded five minutes. It empties the window's quota in
a burst, is refused for the rest of it, and the refused work parks for five minutes rather
than the seconds until the quota rolls over. Pacing output to the receiver's rate is therefore
worth more than raising delivery concurrency, which was already several times the allowance
and bought nothing. That is a concrete target for our own build: Postal has no per-destination
rate accounting and no backoff shorter than the five-minute ladder.
