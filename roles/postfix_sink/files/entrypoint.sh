#!/bin/sh
set -eu

# Очередь лежит на tmpfs, поэтому её структуру нужно пересобирать при каждом
# старте: том пустой, а Postfix ожидает готовое дерево каталогов с правами.
mkdir -p /var/log/postfix
postfix set-permissions >/dev/null 2>&1 || true
postfix check

# start-fg держит процесс на переднем плане, чтобы Docker видел его как PID 1
# и корректно доставлял сигналы остановки.
exec postfix start-fg
