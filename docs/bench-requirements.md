# Task: an Ansible bench for load testing Postal

> Revision 2. Part of the requirements of the first edition was technically unachievable — the corrections were made based on reading the Postal 3.3.7 sources, not the documentation. The rationale is collected in [docs/postal-internals.md](postal-internals.md).

## Context and goal

Build an Ansible project that deploys an isolated Postal test environment (https://github.com/postalserver/postal) and makes it possible to compare the performance of different Postal Docker images.

The immediate goal is a **reproducible baseline on upstream Postal**, against which the gains of our own optimised builds are measured. The target load reference point is **5 million recipients per day (58 rcpt/s on average)**; that is a reference point, not a hard acceptance contract.

The main requirement: the distribution of services is determined **only by the Ansible inventory**. The same playbook must work in two modes:

1. All components on a single server — for cheap debugging.
2. At least two servers (the SUT separate from the generator and the sink) — for measurements whose results are presented to someone.

Do not hardcode IP addresses, node names or the co-location of services. Dependency addresses and replica lists must be derived from `groups` and `hostvars`.

## The unit of measurement

**The headline metric is `recipients/s`, not messages, SMTP sessions or API requests.**

Postal creates a separate message per recipient (`OutgoingMessagePrototype#create_messages`), and the raw MIME is stored as two longblob rows per such message (`Database#insert_raw_message`), without deduplication. A message to 50 addresses is 50 `messages` rows, 50 queue rows and 100 longblob rows. It cannot be counted as a single unit of load.

Reports must explicitly distinguish `messages` (unique MIME) from `recipients` (addressees with their own delivery state).

## Preferred implementation

- Ansible roles + Jinja2 templates.
- Docker Engine and the Docker Compose plugin on the target servers, with package versions pinned.
- Ubuntu 24.04 LTS x86_64 as the base supported OS.
- **All images are pinned by digest** (`repo@sha256:…`), not by tag — see the "Images" section.
- The bench is a test setup, not production: simplicity of the code matters more than completeness. Idempotency is a wish (see "Idempotency").
- Containers must have configurable CPU/RAM limits.
- Postal is configured **only through environment variables**: Konfig loads `Environment` before YAML, so env always wins. Only `signing.key` remains in `/config`.

## Inventory groups

```yaml
postal_main_db:       # the main Postal MariaDB
postal_message_db:    # the message DB; the same host as main by default
postal_admin:         # exactly one node for initialize/seed/migrations
postal_web:           # one or more web/API instances
postal_smtp:          # one or more SMTP ingress instances
postal_workers:       # one or more worker nodes
postal_load_balancers:# an optional HAProxy — ONLY for the HTTP API, not for SMTP

test_dns:             # internal authoritative DNS for the test MX records
postfix_sinks:        # one or more receiving Postfix instances
load_generators:      # load generators
monitoring:           # metric collection and report building
```

A single host may be included in all groups at once. The number of servers in `postal_web`, `postal_smtp`, `postal_workers` and `postfix_sinks` must not be limited by the playbook.

Two example inventories:

- `inventories/single-host/hosts.yml` — all roles on a single server (debugging);
- `inventories/distributed/hosts.yml` — at least two servers: **A (SUT)** = MariaDB + Postal, **B (aux)** = DNS + Postfix sink + generator. Extended by adding lines.

For inter-server communication use the `service_ip` variable; if it is absent, `ansible_host`, then the private address from the facts. `service_ip` is mandatory in the inventory and is checked by preflight: the facts of other hosts are unavailable under `--limit` and in component plays.

## Port layout

**Postal SMTP ingress is always `2525`, the Postfix sink is always `25`.**

An MX record does not carry a port number, so the sink must listen on 25, whereas ingress can be moved (`SMTP_SERVER_PORT`) — the generator is ours. Thanks to this, the same topology works both on a single server and on several, and the `network_mode: host` from the upstream template is used as is. This is also what makes IP pools workable: the worker sees all the addresses of its host.

The rest: web `5000`, worker health `9200+i`, smtp health `9100`, MariaDB `3306`, DNS on `service_ip:53`. The health server bases are spread apart with room to spare: with two or more worker replicas, adjacent numbers would collide with the SMTP port, and the check for the second replica would poll a foreign process.

## Required roles

Determined by the implementer. At a minimum the following are expected: host preparation, Docker, network containment, DNS, MariaDB, Postal (config + startup + schema initialisation + seeding), the Postfix sink, the load generator, metric and report collection, reset.

## DNS is mandatory

Entries in `/etc/hosts` are **not enough, and this is not a matter of convenience**: `app/lib/dns_resolver.rb` goes through `Resolv::DNS` and never reads `/etc/hosts`; an MX record does not exist as a type in a hosts file. An unanswered MX query costs about 10 seconds and **raises an exception** (`raise_timeout_errors: true`), turning into a SoftFail.

Cloud DNS (Route53 and the like) is not suitable: `.test` is a reserved zone under RFC 6761 and cannot be delegated, while public resolution adds latency on the hot delivery path and exposes the bench topology.

An internal authoritative server (CoreDNS) is required for the `.test` zone, **without forwarders** — then external domains do not resolve at all rather than merely being blocked by the firewall.

The sender domain must be verified, otherwise any send fails with `530 From/Sender name is not valid`. The records (SPF, DKIM, verification TXT, return-path CNAME) are served from our own zone, and `POSTAL_USE_LOCAL_NS_FOR_DOMAIN_VERIFICATION=true` must be set — it defaults to `false`, in which case Postal first resolves the domain's NS and breaks on `.test`.

## Load distribution across sinks

The method is set by a variable, but the options are not equivalent:

- **Internal DNS (the default)** — several MX records of equal priority. `DNSResolver#mx` randomises records with the same priority, so the load spreads by itself.
- **`smtp_relays`** — acceptable only as a debugging workaround. It sets a single smart host and **disables MX resolution entirely**, so routing by recipient domain stops working. The relay host must be a resolvable FQDN: an IP literal in `smtp_relays` does not work in Postal v3.
- **HAProxy for SMTP is forbidden.** It terminates TCP, and the sink sees the balancer's address instead of the source IP that Postal bound to the socket. That destroys the only end-to-end proof that outbound IP binding and IP rotation work.

## Images

Pinning **only by digest**: `repo@sha256:<index digest>`. Verified against the registry — `latest` and `stable` are moving pointers with different digests, and floating tags `3` and `3.3` do not exist. The role must reject the tags `latest`, `stable`, `branch-*` and `ci-*`; the last of these are built with `--target ci` without asset precompilation, which makes web return 500 while the TCP health check stays green.

The digest of every image is recorded in the run report.

## Data seeding

Postal has no administrative API: `config/routes.rb` exposes only `/api/v1/send/*` and `/api/v1/messages/*`. `postal make-user` is interactive (HighLine). Raw SQL is dangerous: `Server` creates its own message DB in `after_create`, and `Domain` generates the DKIM key in `before_create`.

The only correct automatable path is `rails runner` with a script built on `find_or_create_by!` that prints the result as JSON (server_id, the message DB name, the DNS records, the credential keys) for subsequent use by the DNS role and the generator.

## Test safety

- Postfix runs only in a closed network and deletes messages via `discard` after a normal SMTP acceptance.
- Outbound TCP 25/465/587 is forbidden by nftables to everything except the bench sinks, with named counters.
- The internal DNS has no forwarders — external MX records physically do not resolve.
- The smoke test must confirm that a message travelled `load generator → Postal → Postfix → discard`, **and at the same time** that a message addressed to a real public domain reached nowhere, while the nftables counter on all hosts stayed at zero. Both checks are tied to a specific sent message: a grep over the log without a marker would pass on any bench that has ever delivered anything.

## Mandatory Postfix sink settings

The Postfix defaults would limit the bench before Postal does, and that would look like a measurement result for Postal:

- `in_flow_delay = 0` — the default of `1s` is documented as limiting reception to roughly 100 messages per second above the delivery rate.
- `smtpd_client_connection_count_limit = 0` — the default of 50 applies to what is effectively a single client IP (all the Postal workers).
- `default_process_limit = 400`.
- `maillog_file` to a file, bypassing journald. By default journald caps at about 333 lines per second per service, while a discard sink at 300 msg/s writes about 2100 — up to 85 % of the lines needed for reconciliation are lost silently, and that looks like lost messages.

## Postal settings that must not be left at their defaults

- `POSTAL_QUEUED_MESSAGE_LOCK_STALE_DAYS` — set explicitly. `TidyQueuedMessagesTask` **destroys** messages with a stale lock instead of reopening them. On top of that, `bin/postal` starts Ruby without `exec`, so PID 1 is bash, the signal handlers do not fire on `docker stop`, and locked rows are left behind after every restart.
- `HEALTH_SERVER_BIND_ADDRESS=0.0.0.0` and a port derived from the replica index. By default the health server listens on `127.0.0.1`, and when the port is taken it catches `EADDRINUSE` and merely writes to the log — only the first replica will have metrics.
- `POSTAL_USE_LOCAL_NS_FOR_DOMAIN_VERIFICATION=true` — see the DNS section.

## Metrics and the report

The only stated requirement is performance. The other counters are useful only for diagnosing different builds and are added as needed. At the first stage Prometheus and exporters are not deployed.

The minimum mandatory set:

| Metric | Source |
|---|---|
| accepted recipients/s, ingress latency p50/p95/p99 | the generator's CSV |
| delivered recipients/s | counting Postfix log lines by a unique discard token |
| queue depth and the age of the oldest message over time | an SQL sampler, one query every 5 s |
| CPU/RAM per container | `docker stats` into CSV every 5 s |
| drain time after the load stops | the same SQL sampler |
| reconciliation by buckets | 5 SQL COUNTs at the end of the run |

Postal's stock counters are not enough for this: version 3.x has exactly 11 Prometheus metrics, and among them there is neither queue depth nor delivered/failed/held; the web process does not serve `/metrics` at all; and the stock `script/queue_size.rb` contains an `AND`/`OR` precedence bug and counts locked rows.

**The run artifact is a single text file `reports/<run_id>.md`**, self-contained enough to publish: the run parameters (image digests, limits, the key Postal and MariaDB variables, the load profile, the host roles and their hardware, the phase durations), the calibration result, the results, the reconciliation table and a "what this run does not prove" section. The raw CSV files are placed alongside. The MariaDB data is deleted after the run — there is no requirement to keep it.

## Reconciliation

```
accepted = sent + hard_failed + held + queued + in_flight
```

The formulation of the first edition (`accepted = delivered_to_sink + failed + queued`) can never add up: it lacks the `Held` bucket (suppression list, send_limit, dev mode, suspended server) and lacks `in_flight` (rows with a non-empty `locked_at`). Besides, in Postal **`500–504` and `530–535` are classified as SoftFail rather than permanent** (`Net::SMTP::Response#exception_class`), so "failed" without qualification is ambiguous.

`delivered` is counted independently — from the sink logs — and compared with `sent` from the Postal DB. A discrepancy means either lost messages or lost log lines, and must be explained in the report.

Additionally: unique localparts per run and `TRUNCATE suppressions` in reset. Two HardFails per address within 24 hours move all subsequent messages to it into `Held`, and the recipient pool gets eaten up between runs.

## Load profile

The primary profile is pinned and does not change between builds: 1 recipient per message, MIME 100 KB, around 1000 destination domains with a skew, 100 % `250 OK`, tracking off, DKIM on, webhooks off, an empty starting queue.

Domain cardinality matters fundamentally: `batch_key = "outgoing-<domain>"` packs up to 100 messages into a batch, so sending to a single domain hands Postal a free ~100x win and makes the baseline dishonest.

The generator must work in an **open model** (a fixed sending schedule, with latency measured from the scheduled time). A closed generator stops applying load exactly when the SUT stalls, and systematically understates the latency tail — that is, it hides precisely what distinguishes builds.

## Idempotency

A wish, not an acceptance criterion. The configuration playbooks are worth making repeatable, but `reset.yml`, `calibrate.yml` and `benchmark.yml` are non-idempotent by design: the comparison protocol requires restoring an identical DB state before every run.

## Secrets

The lab passwords (MariaDB, the Postal admin, the credential keys) are stored in plain text in `group_vars` with a comment explaining why — this makes a run reproducible, and there is nothing to protect on an isolated `.test` bench. No vault file is used.

Exactly four things do not go into the repository: the client fork's deploy key, registry credentials, production DKIM keys and production dumps.

## Acceptance criteria

- Both sample inventories work without changing the roles and playbooks.
- Adding a worker, SMTP, web or Postfix server requires only a change to the inventory.
- A single physical server can perform all roles at once (debug mode; measurements taken on it are not presented as comparative).
- Replacing the Postal image deploys a different build without recreating MariaDB, the network and the host preparation.
- No test message can escape to the public internet — confirmed by the smoke test in both of its halves.
- The reconciliation adds up: the discrepancy against the identity is below 1 %.
- Calibration confirms that the generator-to-sink path has headroom relative to the target rate; otherwise the run does not start.
- The report contains absolute values and, when a baseline exists, the percentage change relative to it, together with the spread between repeats.
- The documentation contains commands for single-host, distributed, smoke, calibration, benchmark and reset.

## Deliverable

A git repository with the structure of an Ansible project, the roles, two inventories, configuration templates, a README and minimal CI (lint and syntax check).

This task covers the first two stages of the overall plan and prepares the third:

1. Setting up a test environment for comparing different builds.
2. Deploying the test environment.
3. Forking Postal and adding CI/CD-driven load tests.
4. Optimizing Postal and progressively replacing bottleneck components with custom implementations.
