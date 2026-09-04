#!/bin/sh
set -eu

# The queue lives on tmpfs, so its structure has to be rebuilt on every
# start: the volume is empty while Postfix expects a ready directory tree with permissions.
mkdir -p /var/log/postfix
postfix set-permissions >/dev/null 2>&1 || true
postfix check

# start-fg keeps the process in the foreground so that Docker sees it as PID 1
# and delivers stop signals correctly.
exec postfix start-fg
