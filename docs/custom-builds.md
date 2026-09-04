# Testing our own build of Postal

The bench measures two things that are easy to confuse: the official Postal image, and the
build we are trying to make faster. This document covers the second one — the fork in
[vendor/postal/](../vendor/postal/), how it becomes a Docker image, and how a run proves
which of the two it actually measured.

## Where the fork lives

`vendor/postal/` is a plain copy of the upstream source at a known tag, committed to this
repository. There is no submodule and no separate remote: the source is edited here, in the
same working tree as the Ansible roles, and `git diff` over that directory is the whole
patch set against upstream.

Provenance is declared in [group_vars/all/20-images.yml](../group_vars/all/20-images.yml):

| Variable | Meaning |
|---|---|
| `postal_build_upstream_repo` | Where the source came from |
| `postal_build_upstream_ref` | The tag it was taken at |
| `postal_build_upstream_commit` | The exact commit of that tag |

Those three values are printed in every report. Without them "which build produced this
number" has no answer that can be checked six months later.

## Which image a run deploys

One variable decides, `postal_image_source`:

| Value | What is deployed | What it is for |
|---|---|---|
| `local` (default) | An image built here from `vendor/postal/` | The candidate. The only path by which an added index or an edited worker reaches a run. |
| `upstream` | The official `ghcr.io/postalserver/postal` image, resolved to a digest | The baseline. Numbers on it are comparable with [reports/reference/](../reports/reference/). |

```bash
# the fork, i.e. whatever is in the working tree right now
ansible-playbook -i inventories/distributed playbooks/benchmark.yml

# the official image, for a baseline in the same series
ansible-playbook -i inventories/distributed playbooks/benchmark.yml \
  -e postal_image_source=upstream -e postal_image_ref=3.3.7
```

The fork is vendored at the pristine upstream tag, so with no edits a `local` build is the
same code as the baseline. That is deliberate: the first thing worth measuring is that the
two agree, because a difference between them is a property of the build environment and
would otherwise be silently attributed to the first optimisation attempted.

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
initialised installation. So a migration added to the fork is applied before the run.

Adding an index to `queued_messages` therefore means a normal Rails migration under
`vendor/postal/db/migrate/`, plus the matching change to `db/schema.rb`. It does **not**
mean hand-written SQL against the running database: that would be invisible to
`schema_migrations`, would not survive a reset, and could not be attributed to a build.

Note the constraint from [postal-internals.md](postal-internals.md): message database
migrations are one-way — `Postal::MessageDB::Migration` defines only `up`. Going back to a
build with an older schema requires a state reset, not just redeploying the old image.

## How the build is identified

The image is tagged `postal-bench/postal:src-<first 12 hex of the source digest>`, where the
digest is a SHA-256 over a deterministic archive of `vendor/postal/` — names sorted,
mtime, owner and pax time headers zeroed. Touching a file does not change it; editing one
does.

This buys two things. A hand-maintained tag lies as soon as somebody forgets to bump it,
and the entire point of this path is to run edited code — a content digest cannot forget.
And because the tag changes only when the source changes, asking for a build before every
run costs nothing when nothing was edited: the tag already exists and the build is skipped.

Use `-e postal_build_force=true` to rebuild anyway (needed after changing the base image or
clearing the layer cache, not to pick up source edits).

## How a run proves which build it measured

The digest is baked into the image as the label `bench.source.sha256`, and it is read back
in two places, both off the **running container** rather than off the image or the tag:

- `build.yml` ends with an assertion that the running worker carries the digest of the
  current working tree, and fails the run if it does not.
- The report prints `Source digest (built)` and `Source digest (running)` side by side and
  adds a warning row if they disagree or if the label is absent.

A tag says what someone meant to deploy. A label on a running container says what ran. The
gap between the two is exactly a compose file that did not change, a container that was not
recreated, or a stale tag — all of which produce a run that looks completely normal.

## Updating the fork from upstream

```bash
git clone --depth 1 --branch <new-tag> https://github.com/postalserver/postal.git /tmp/postal
rm -rf /tmp/postal/.git
# merge by hand, or diff against the current vendor/postal to see what upstream changed
```

Then update `postal_build_upstream_ref` and `postal_build_upstream_commit`, and re-read
[postal-internals.md](postal-internals.md): it describes the actual behaviour of a specific
version, not the project's intentions, and every item in it has to be re-checked when the
version moves.

## What this does not do

- **It does not distribute the image.** Each Postal host builds it from the same archive.
  Both inventories currently place every Postal group on one machine, so this is moot; with
  Postal spread over several machines the builds could drift apart, because the base image
  `ruby:3.4.6-slim-bookworm` is a moving tag and the build is not bit-reproducible. A local
  registry is the fix, and it is in the [roadmap](../roadmap.md).
- **It does not pin the base image.** `postal_build_pull` is off by default so a series is
  not rebased mid-flight, but the first build on a fresh host takes whatever
  `ruby:3.4.6-slim-bookworm` points at that day.
- **It does not make the local build byte-identical to the official one.** They are built
  from the same source and the same pinned `Gemfile.lock`, on possibly different base
  layers. Comparing `local` with no edits against `upstream` is the measurement that says
  how much that matters, and it has not been run yet.
