#!/bin/zsh
set -eu
saitu_root="${0:A:h}"
cd "$saitu_root"
exec "$saitu_root/saitu" start --open
