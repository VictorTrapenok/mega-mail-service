# Confirmed Postal internals

Everything below was verified by reading the source in [vendor/postal/](../vendor/postal/),
not the documentation. Each item explains a specific decision in the bench roles — remove the
item and it becomes unclear why the role is built the way it is.

It describes the actual behaviour of the code, not anybody's intentions, so it has to be
re-checked whenever that code changes.

## Composition

Three long-lived processes from a single image, differing by the command argument:
`postal web-server`, `postal smtp-server`, `postal worker`. Plus `runner` for
one-off operations. RabbitMQ and the `cron` and `requeuer` processes were removed in 3.0.0;
Redis was never used. The queue lives in MariaDB — that is the only
external storage.

The image is built on `ruby:3.4.6-slim-bookworm`, Rails 7.1.6, Puma. Only
`linux/amd64`. The user inside is UID 999.

## What to read when debugging

The paths below are relative to the Postal source, which is now in this repository:
[vendor/postal/](../vendor/postal/). So they are also the files to edit — anything changed
there is in the next run's image (see [custom-builds.md](custom-builds.md)).

| Question | File |
|---|---|
| How the worker selects messages | `app/lib/worker/jobs/process_queued_messages_job.rb` |
| Batching by domain | `app/models/queued_message.rb` |
| Outbound IP binding | `config/initializers/smtp_extensions.rb`, `app/lib/smtp_client/endpoint.rb` |
| Classification of SMTP responses | `app/senders/smtp_sender.rb` |
| Writing the message and statistics | `lib/postal/message_db/message.rb` |
| The resolver | `app/lib/dns_resolver.rb` |
| The main DB schema | `db/schema.rb` |
| Environment variable names | `doc/config/environment-variables.md` |

## The unit of load is a recipient

`OutgoingMessagePrototype#create_messages` creates a separate message for
each addressee. `Database#insert_raw_message` stores the MIME as **two**
longblob rows in the per-day table `raw-YYYY-MM-DD`; there is no deduplication.

A message to 50 addresses is 50 `messages` rows, 50 queue rows and 100
longblob rows. At an average MIME of 100 KB, five million recipients mean
about 500 GB of raw data per day before indexes.

## The outbound IP is bound to the worker host

`ProcessQueuedMessagesJob#find_ip_addresses` enumerates the addresses of its own
network namespace via `Socket.ip_address_list`, excluding only
`127.*`, `fe80:` and `::`, and matches them against rows of the `ip_addresses` table.
The claim query takes only rows whose `ip_address_id` falls into that
set **or is NULL**.

Three consequences follow, each of which is already built into the roles:

- On a bridge network the worker sees only `172.x`, matches no row
  and, with pools enabled, processes **nothing**. Silently: no exception,
  no metric, no log line. That is why the bench uses `network_mode: host`.
- The orphaned rows are not picked up by the cleanup task either: `TidyQueuedMessagesTask`
  reacts only to a stale lock, while such rows have `locked_at IS NULL`.
- The address must be physically present on the worker host. The role assigns
  addresses to the interface and creates the corresponding DB rows from a single
  source — the inventory.

The binding itself is performed at the socket level: Postal patches `Net::SMTP#tcp_socket`
to `TCPSocket.open(address, port, source_address)`. The HELO name is taken from
`ip_addresses.hostname`.

## The queue and its indexes

The claim query:

```sql
UPDATE queued_messages
   SET locked_by = ?, locked_at = ?
 WHERE (ip_address_id IN (…) OR ip_address_id IS NULL)
   AND locked_by IS NULL AND locked_at IS NULL
   AND (retry_after IS NULL OR retry_after < ?)
 LIMIT 1
```

In `db/schema.rb` the table has exactly three indexes: `domain` (an 8-character prefix),
`message_id`, `server_id`. **Not a single predicate of the query is covered.**

But this query on its own does not give linear cost, and it is important not to get this wrong.
It has no `ORDER BY` but does have `LIMIT 1`, so the scan by primary key
stops at the first suitable row. When the whole queue is ready to send,
the very first row already qualifies, and the cost does not depend on the queue length at all.
The claim only becomes expensive once **unsuitable** rows have accumulated at the head of the
table by `id`: locked ones, ones deferred until `retry_after`, or ones belonging
to a foreign `ip_address_id`. That is exactly how a queue degenerates in production — a message
received a temporary rejection and stayed with its former, small `id`, while fresh messages get
larger `id`s. Hence the queue length must be set together with its composition:
a "one million ready rows" profile will show that no index is needed.

The readiness threshold is not "now" but `retry_after < 30.seconds.ago`
(`scope :ready_with_delayed_retry`). The queue depth sampler must reproduce
exactly this condition, otherwise it shows the worker a backlog of work it does not have.

Genuinely linear growth comes from the **second** query. Having claimed one row, the worker
calls `batchable_messages(100)` (`app/lib/message_dequeuer/initial_processor.rb`),
which collects up to 100 rows with the same `batch_key = "outgoing-<recipient domain>"`.
There is no index on `batch_key` either, and `LIMIT 100` stops the scan either once a
hundred are collected or **at the end of the table**. A hundred is only collected if a single
domain accounts for at least a hundred queue rows; with a thousand domains that requires a
queue of hundreds of thousands of rows. Until there is one, the query runs to the end of the
table, and this happens for **every** claimed message.

We have since narrowed this query without touching the schema — see
[optimisations.md](optimisations.md). What is described here is the behaviour before that
change, which is what the reference runs measured.

The consequence this suggests: the cost of processing a message should grow together
with the queue length divided by the density of its `batch_key`.

**This has NOT been confirmed by measurement on the bench.** Two points in a `drain.yml` series
at 1000 domains gave exactly the same drain rate — 20.8 recipients/s
both at a queue of 4851 rows and at 9938; the drain time grew strictly twofold.
The explanation most likely lies in scale: ten thousand rows fit entirely
into the buffer pool, and a full scan of such a table costs a few milliseconds
against the roughly 96 ms spent on a message. Over this range the scan
simply gets lost in the noise.

So the hypothesis is neither refuted nor proven: the threshold beyond which the scan
starts to dominate lies above the range available to the bench. The fill proceeds
the normal way at the ingress rate, and ten thousand messages take about
eleven minutes — a million would take some eighteen hours. Checking it requires
a bulk path through SQL; it is noted in the [roadmap](../roadmap.md).

The practical sizing conclusion is the opposite of what was expected and therefore valuable: as
long as draining keeps up with ingress and the queue stays short, its length does not affect
the rate, and there is no need to budget headroom "for queue degradation". The risk arises
only if draining stops keeping up and the queue grows to hundreds of thousands of rows —
behaviour there is unknown.

## IP pools defeat batching

`batchable_messages` filters on `ip_address_id` in addition to `batch_key`, so a batch may
only contain messages that share both the recipient domain and the outbound address. With
pools enabled every message is assigned an address at creation time by
`allocate_ip_address`, and the assignment is a uniform random pick —
`select_by_priority` is `ORDER BY RAND() * priority`. A pool of N addresses therefore divides
the batch candidates by roughly N.

Counting this correctly needs care. Postfix writes a `client=` line per **message**, not per
connection, so counting those says nothing about session reuse — the count simply equals the
number of messages in every configuration. Connections are `disconnect from` lines, and
`grep -c 'connect from'` matches `disconnect from` as well, doubling the figure.

Measured properly, without a pool: **896 connections for 3000 messages**, i.e. about 3.35
messages per SMTP session at 1000 destination domains. Batching does work.

With a six-address pool, same profile: **2114 connections for 3000 messages**, i.e. 1.42
messages per session. The pool did not destroy batching outright, but it made sessions 2.4
times more numerous, and throughput fell from 50.0 to 34.1 recipients/s — about a third.
Fragmentation is milder than the sixfold the address count suggests, because batching was
already far from its ceiling of 100: at 1000 domains a batch held 3.35 messages to begin with.

This is the pool's real trade-off, and it is the opposite of what one expects: a pool does not
raise throughput, it lowers it, because every extra session pays again for the TCP handshake,
EHLO and the MAIL/RCPT/DATA round trips. Its purpose is external — recipient providers cap
concurrent sessions per source address, and a pool is what makes a high aggregate concurrency
permissible at all. Budget it as a deliverability requirement with a throughput cost, not as a
scaling mechanism.

Domain cardinality, meanwhile, remains significant regardless of queue length:
sending to a single domain gives an almost hundredfold win on batching, and the
`wide_domains` profile exists precisely to remove that win.

## Serialisation points

They do not depend on the number of nodes, because they live in the installation's shared DB:

- `Statistic.global.increment!` is called **twice per message**,
  and there is a single row in the `statistics` table for the whole installation.
- `UPDATE servers SET send_limit_* …` on every delivery — one row per server.
- `UPDATE raw_message_sizes SET size = size + N` on every accepted message —
  one row per per-day table.

This is the main counterargument to the "slow Ruby" hypothesis: adding workers
and nodes does not relieve these three points.

## Classification of SMTP responses

`smtp_sender.rb` converts only `Net::SMTPFatalError` into `HardFail`.
Everything else — `SMTPServerBusy`, `SMTPAuthenticationError`, `SMTPSyntaxError`,
`SMTPUnknownError`, `ReadTimeout` and a bare `StandardError` — becomes
`SoftFail` with a retry.

Taking `Net::SMTP::Response#exception_class` into account (`/\A4/` → ServerBusy,
`/\A50/` → SyntaxError, `/\A53/` → AuthenticationError, `/\A5/` → FatalError),
this means: **`500–504` and `530–535` are SoftFail in Postal, not a final rejection**,
while `550–554` are `HardFail` as expected.
The fault injection matrix must proceed from this rather than from RFC 5321 semantics,
otherwise the reconciliation will carry an unexplained constant bias.

## The retry ladder

Every temporary failure goes through `HasLocking#retry_later`
(`app/models/concerns/has_locking.rb`):

```ruby
def retry_later(time = nil)
  retry_time = time || calculate_retry_time(attempts, 5.minutes)
  update_columns(locked_by: nil, locked_at: nil,
                 retry_after: Time.now + retry_time, attempts: attempts + 1)
end

def calculate_retry_time(attempts, initial_period)
  (1.3**attempts) * initial_period
end
```

**The first retry is five minutes out**, and each subsequent one is 30 % further. The base
period is hardcoded — there is no environment variable for it. With
`POSTAL_DEFAULT_MAXIMUM_DELIVERY_ATTEMPTS` at its default of 18, the ladder spans about
31 hours in total.

This decides how a throttled run must be shaped. A deferred recipient cannot come back inside
a 900-second window, so an arm that measures a throttled sink on an EMPTY queue measures the
retry ladder rather than the receiver's limit. It has to be measured on a prefilled queue,
where the worker always has ready rows and the cap binds continuously.

At the attempt ceiling `SingleMessageProcessor#check_delivery_attempts` writes `HardFail`,
removes the queue row **and adds the recipient to the suppression list** with the reason
"too many soft fails" — so sustained throttling eventually eats the recipient pool, and
`Held` above zero stops being a sign of a broken bench.

Two consequences for the reconciliation. A deferred message keeps its queue row *and* carries
a status on its `messages` row, so `SoftFail` must not be counted as terminal or every
deferred recipient is counted twice. The same is true of `Error`: `MessageDequeuer::Base#handle_exception`
calls `retry_later` on exactly the same path. Only `Pending`, `SoftFail` and `Error` keep
their queue row; a message never ends its life in `SoftFail`.

### The receiver can shorten the ladder

`SMTPSender` parses the remote reply text before falling back to the ladder:

```ruby
if e.message =~ /(\d+) seconds/
  r.retry = ::Regexp.last_match(1).to_i + 10
elsif e.message =~ /(\d+) minutes/
  r.retry = (::Regexp.last_match(1).to_i * 60) + 10
```

So a rejection saying "try again in 30 seconds" produces a 40-second retry instead of five
minutes. Postfix's own anvil rejections carry no such hint and cannot be reworded, but this is
the lever any future policy-service sink would use to make throttled runs measurable in a
short window.

## Webhooks are blocked to private addresses

`Postal::HTTP::AddressGuard` refuses any outbound webhook or HTTP-endpoint request whose
destination resolves into a private, loopback, link-local, multicast or otherwise reserved
range, as SSRF protection. `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `127.0.0.0/8`
are all on that list.

The failure is quiet in the way that matters: the `webhook_requests` row is still created,
still retried and still recorded, and the only sign is `error` reading
`Couldn't send to URL. Code received was -4`. Webhooks look enabled and deliver nothing.

The escape hatch is `postal.allowed_request_destinations` — hostnames or IP/CIDR ranges,
`POSTAL_ALLOWED_REQUEST_DESTINATIONS` as a comma-separated environment variable. Any
installation whose webhook endpoint is internal needs it. The bench allows the private ranges
wholesale because everything in it is on RFC1918; a real installation should list only its own
endpoint, since a wider allowlist reopens the hole the guard exists to close.

## The resolver

`DNSResolver.local` parses `dns.resolv_conf_path` for `nameserver`
lines and performs queries through `Resolv::DNS`. `/etc/hosts` is never read,
under any configuration.

`SMTPSender#resolve_mx_records_for_domain` calls `.mx(...)`,
`SMTPClient::Server#endpoints` calls `.aaaa()` first and then `.a()`, i.e.
at least three queries per session, with no cache and a new socket for each.

The MX query runs with `raise_timeout_errors: true`: an unanswered query
costs about 10 seconds and **raises an exception**, turning into a SoftFail.
The absence of a fast authoritative answer looks like a slow Postal.

`mx` shuffles MX records of equal priority, so the internal DNS is a working
mechanism for spreading load across sinks rather than a compromise.

`POSTAL_SMTP_RELAYS` disables MX resolution entirely: `SMTPSender#start`
takes `@servers || smtp_relays || resolve_mx_records_for_domain`. The relay host
is still resolved, though, and an IP literal does not work.

## Domain verification

The only gate on sending is the `verified_at` column
(`scope :verified, -> { where.not(verified_at: nil) }`). The DNS status
columns are informational.

`POSTAL_USE_LOCAL_NS_FOR_DOMAIN_VERIFICATION` defaults to **false**, in which case
Postal first resolves the domain's NS, which does not work for the `.test` zone. Without this
variable, verification breaks silently and any send fails with
`530 From/Sender name is not valid`.

Useful model methods: `dkim_record`, `dkim_record_name`, `spf_record`,
`dns_verification_string`, `verify_with_dns`, `mark_as_verified`.

## Seeding

There is no administrative API: `config/routes.rb` exposes only `/api/v1/send/*`
and `/api/v1/messages/*`, everything else is HTML controllers behind a session.
`postal make-user` is interactive (HighLine).

Raw SQL is dangerous: `Server` creates its own message database in `after_create`
(`message_db.provisioner.provision`), and `Domain` generates the DKIM key in `before_create`.
Hence the only correct path is `rails runner` through the models.

`Credential#generate_key` unconditionally sets the key of a new record, and
`validate_key_cannot_be_changed` forbids changing it through the model. The value is
pinned via `update_column`, otherwise re-seeding silently rotates the
keys and the generator starts getting `535` — i.e. a working build looks like
a regression.

SMTP authentication checks the password only
(`Credential.where(type: 'SMTP', key: password)`); the username is ignored.

## Schema lifecycle

`postal initialize` is `rake db:create postal:update`. The `postal:update` task
branches: if `schema_migrations` exists and is not empty, `db:migrate` runs,
otherwise `db:schema:load`. Hence re-running it on an
initialised installation is safe — unlike version 2, where
`initialize` was an unconditional `db:schema:load`.

The dangerous edge: if `schema_migrations` is empty but data exists, the
`db:schema:load` branch will recreate the tables (`schema.rb` uses `force: :cascade`).

Message database migrations are **one-way**: `Postal::MessageDB::Migration`
defines only `up`. Rolling the image back to a previous version on top of a
migrated DB will not raise an error — it will simply run old code against a new
schema. Hence changing the build requires a state reset, not just swapping the image.

## Observability

There are exactly eleven Prometheus metrics in version 3.x, and among them there is neither
queue depth nor counters for delivered, failed and held. The web process
does not serve `/metrics` at all.

The health server listens on `127.0.0.1` by default, and when the port is taken it
catches `EADDRINUSE` and merely writes to the log. With several replicas
on one host, only the first one ends up with metrics — "the service started"
and "the service is observable" are different facts here.

The `postal_message_queue_latency` histogram is registered without explicit
`buckets:`, so it inherits the client library defaults with the highest
finite bucket at 10 seconds. Under load all observations land in `+Inf`,
and both compared builds will show the same p99. The bench does not use it.

The stock `script/queue_size.rb` contains an `AND`/`OR` precedence bug
and counts locked rows as ready.

## What it deletes on its own

`TidyQueuedMessagesTask` **destroys** messages whose lock is older than
`POSTAL_QUEUED_MESSAGE_LOCK_STALE_DAYS` (1 by default) instead of reopening
them. There is no "unlock and retry" path.

This is made worse by `bin/postal` starting Ruby without `exec`: PID 1 is bash,
the signal handlers do not fire on `docker stop`, and locked rows are left behind
after every restart.

`ProcessMessageRetentionScheduledTask` applies `servers.raw_message_retention_size`
daily at 03:00 (2048 MB by default) and issues
`DROP TABLE` on the per-day raw tables. These are server columns, not environment
variables.

The suppression list is extended after **two** HardFails per address within a day,
and all subsequent messages to it become `Held`. It carries over between runs of a series
unless it is cleared.
