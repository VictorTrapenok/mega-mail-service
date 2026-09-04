# CHANGELOG

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
