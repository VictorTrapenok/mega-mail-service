# Testing our own build of Postal

This document covers our own Postal build: the source in
[vendor/postal/](../vendor/postal/), how it becomes a Docker image, and how a run proves
which build it actually measured.

## Where the source lives

`vendor/postal/` is our Postal source, committed to this repository. There is no submodule
and no separate remote: it is edited here, in the same working tree as the Ansible roles, and
it is built and tested from here.

The Postal version it implements is declared once, as `postal_version` in
[group_vars/all/20-images.yml](../group_vars/all/20-images.yml). It goes into the image as
the `VERSION` build argument and is printed in every report.

## Which image a run deploys

One variable decides, `postal_image_source`:

| Value | What is deployed | What it is for |
|---|---|---|
| `local` (default) | An image built here from `vendor/postal/` | Our build. The only path by which an added index or an edited worker reaches a run. |
| `upstream` | The reference `ghcr.io/postalserver/postal` image, resolved to a digest | Kept because the runs in [reports/reference/](../reports/reference/) were made on it, so a number is comparable with them only if it can be re-measured the same way. |

```bash
# our source, i.e. whatever is in the working tree right now
ansible-playbook -i inventories/distributed playbooks/benchmark.yml

# the reference image, to re-measure a published baseline
ansible-playbook -i inventories/distributed playbooks/benchmark.yml \
  -e postal_image_source=upstream -e postal_image_ref=3.3.7
```

## The edit-and-measure loop

```bash
$EDITOR vendor/postal/app/lib/worker/jobs/process_queued_messages_job.rb
ansible-playbook -i inventories/distributed playbooks/benchmark.yml
```

That is the whole loop. Every measurement playbook — `benchmark.yml`, `ingress.yml`,
`drain.yml` — imports [build.yml](../playbooks/build.yml) before resetting state, so a run
always tests the source currently in the working tree. The failure mode this exists to
prevent is editing the worker, running the benchmark and measuring the previous build; it
leaves no trace in the numbers.

Set `postal_build_before_run=false` to skip it, or run `playbooks/build.yml` on its own.

### Schema changes and indexes

`build.yml` runs `postal_schema` after deploying, and `postal initialize` is
`rake db:create postal:update`, which takes the `db:migrate` branch on an already
initialised installation. So a migration added to our source is applied before the run.

Adding an index to `queued_messages` therefore means a normal Rails migration under
`vendor/postal/db/migrate/`, plus the matching change to `db/schema.rb`. It does **not**
mean hand-written SQL against the running database: that would be invisible to
`schema_migrations`, would not survive a reset, and could not be attributed to a build.

Note the constraint from [postal-internals.md](postal-internals.md): message database
migrations are one-way — `Postal::MessageDB::Migration` defines only `up`. Going back to a
build with an older schema requires a state reset, not just redeploying the old image.

## How the build is identified

The image is tagged `postal-bench/postal:src-<first 12 hex>`, where the hash is **git's own
tree object id** for `vendor/postal`, computed through a throw-away index so it describes the
working tree rather than the last commit:

```bash
idx="$(mktemp)"; export GIT_INDEX_FILE="$idx"
git read-tree HEAD
git add -A -- vendor/postal
git write-tree --prefix=vendor/postal/
```

Touching a file does not change it; editing one does. The real index is untouched.

It got there the hard way, and the reason is worth keeping. The first version hashed a tar
archive of the tree with all the metadata zeroed, which looked deterministic and was not: the
same byte-identical tree hashed to `52733cbabb11` under GNU tar 1.34 and `722b34598b73` under
1.35, so a workstation and a CI runner disagreed about what the same source was called —
which is precisely the thing the hash exists to prevent. Before that it depended on the
checkout umask as well. A git tree id has one definition and every git computes it the same.

Two further properties fall out of using git rather than the filesystem:

- **It covers exactly what a checkout covers.** `git add` honours `.gitignore`, so a
  `vendor/bundle` left behind by somebody running `bundle install` in the source changes
  neither the hash nor the image.
- **The build context is exported from that same tree id** with `git archive`, so the bytes
  shipped to the host are the bytes the hash describes rather than a similar set of files.

The source therefore has to live inside a git working tree; a downloaded zip will not do, and
the roles fail with that message rather than silently hashing something else.

Two things follow. A hand-maintained tag lies as soon as somebody forgets to bump it, and
the entire point of this path is to run edited code — a content hash cannot forget. And
because the tag changes only when the source changes, asking for a build before every run
costs nothing when nothing was edited: the tag already exists and the build is skipped.

Use `-e postal_build_force=true` to rebuild anyway (needed after changing the base image or
clearing the layer cache, not to pick up source edits).

## How a run proves which build it measured

The tree id is baked into the image as the label `bench.source.tree`, and it is read back
in two places, both off the **running container** rather than off the image or the tag:

- `build.yml` ends with an assertion that the running worker carries the tree id of the
  current working tree, and fails the run if it does not.
- The report prints `Source tree (built)` and `Source tree (running)` side by side and
  adds a warning row if they disagree or if the label is absent.

A tag says what someone meant to deploy. A label on a running container says what ran. The
gap between the two is exactly a compose file that did not change, a container that was not
recreated, or a stale tag — all of which produce a run that looks completely normal.

## Running the test suite

```bash
ansible-playbook -i inventories/distributed playbooks/rspec.yml
ansible-playbook -i inventories/distributed playbooks/rspec.yml \
  -e postal_specs_args=spec/models/queued_message_spec.rb
```

The `postal_specs` role computes the source identity the same way the image build does and
exports the source from that same tree id, builds the `ci` target on the target host and runs
the suite against a throw-away MariaDB from Postal's own compose file, then tears it down.
Because the identity is computed identically, a suite result and a benchmark result name one
identical tree rather than two that were probably the same.

Where it runs is the `postal_specs` inventory group, and in the measurement inventory that is
the auxiliary machine, not the system under test — a two-core bundle install has no business
competing with a measurement, and on the SUT it would also be squeezed by the memory the
Postal stack already holds.

It deploys nothing, touches neither the Postal stack nor its database, and publishes nothing.

## CI: the test suite and the image for handover

[.github/workflows/postal-image.yml](../.github/workflows/postal-image.yml) runs on every
push, in three jobs:

1. **identity** — computes the source digest with the same tar recipe the Ansible role uses,
   and reads `postal_version` out of `group_vars/all/20-images.yml` so there is one source of
   truth for it. Both land in the run summary.
2. **test** — builds the `ci` target and runs `bundle exec rspec` against a throw-away
   MariaDB, using Postal's own [docker-compose.yml](../vendor/postal/docker-compose.yml).
   The same three steps `playbooks/rspec.yml` performs above; the difference is only where
   the Docker daemon lives.
3. **publish** — builds the `full` target and pushes to the GitHub Container Registry.
   Gated on **test**: an image nobody has run the suite against is not something to put in
   front of anyone.

Tags on `ghcr.io/victortrapenok/mega-mail-service/postal`:

| Tag | Means |
|---|---|
| `src-<12 hex>` | The code. Same source always, different source never. **This is the tag to hand over.** |
| `sha-<12 hex>` | The commit of this repository that produced it |
| `latest` | Default branch only |
| `v*` | Carried through from a git tag |

The image also carries `bench.source.tree` as a label, so `build.yml` and the run report
verify a pulled image exactly as they verify a locally built one.

### Handing the image over

```bash
docker pull ghcr.io/victortrapenok/mega-mail-service/postal:src-250f8d03cec2
docker inspect ghcr.io/victortrapenok/mega-mail-service/postal:src-250f8d03cec2 \
  | jq -r '.[0].Config.Labels["bench.source.tree"]'
```

The point of quoting the `src-` tag rather than `latest` is that it is the same string the
report prints as "Source tree". "This image is the build that produced that report" then
becomes something the receiver can check instead of something they have to take on trust.

Two things to do once, before the first handover:

- **The GHCR package is private by default.** Make it public, or grant read
  access, under the repository's *Packages* settings. Until then a `docker pull` from
  outside will fail with a 403 that reads like the image does not exist.
- **Nothing here signs the image.** If the handover needs provenance beyond a label,
  that is cosign or GitHub attestations, and neither is set up.

To point the bench at a published image instead of building locally, deploy it as an
reference-image path:

```bash
ansible-playbook -i inventories/distributed playbooks/benchmark.yml \
  -e postal_image_source=upstream \
  -e postal_image_repo=ghcr.io/victortrapenok/mega-mail-service/postal \
  -e postal_image_ref=src-250f8d03cec2
```

## What this does not do

- **It does not distribute the image.** Each Postal host builds it from the same archive.
  Both inventories currently place every Postal group on one machine, so this is moot; with
  Postal spread over several machines the builds could drift apart, because the base image
  `ruby:3.4.6-slim-bookworm` is a moving tag and the build is not bit-reproducible. A local
  registry is the fix, and it is in the [roadmap](../roadmap.md).
- **It does not pin the base image.** `postal_build_pull` is off by default so a series is
  not rebased mid-flight, but the first build on a fresh host takes whatever
  `ruby:3.4.6-slim-bookworm` points at that day.
- **It does not make the local build byte-identical to the reference image.** The
  `Gemfile.lock` is pinned, but the base layers may differ, so a `local` build and the
  reference image are not the same bytes even where the code is the same.
