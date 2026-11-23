#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run Nginx configuration as root.' >&2; exit 1; }
task_mode=${1:-http}
[[ "$task_mode" == http || "$task_mode" == https ]] || { echo 'Use http or https.' >&2; exit 1; }
task_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ "$task_mode" == https ]]; then
  test -s /etc/letsencrypt/live/gzhanchuang.com/fullchain.pem
  test -s /etc/letsencrypt/live/gzhanchuang.com/privkey.pem
fi
task_previous=$(mktemp)
trap 'rm -f "$task_previous"' EXIT
task_had_previous=false
if [[ -f /etc/nginx/sites-available/saitu ]]; then
  cp /etc/nginx/sites-available/saitu "$task_previous"
  task_had_previous=true
fi
install -o root -g root -m 0644 "$task_source/ops/server/nginx-${task_mode}.conf" /etc/nginx/sites-available/saitu
ln -sfn /etc/nginx/sites-available/saitu /etc/nginx/sites-enabled/saitu
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  readlink /etc/nginx/sites-enabled/default > /etc/saitu/nginx-original-default-link
  rm /etc/nginx/sites-enabled/default
fi
if ! nginx -t; then
  if [[ "$task_had_previous" == true ]]; then cp "$task_previous" /etc/nginx/sites-available/saitu; else rm /etc/nginx/sites-enabled/saitu; fi
  exit 1
fi
systemctl reload nginx
if [[ "$task_mode" == https ]]; then
  install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  printf '%s\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/saitu-nginx.sh
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/saitu-nginx.sh
  systemctl enable --now certbot.timer
fi
printf '%s\n' "Nginx ${task_mode} configuration is active."
