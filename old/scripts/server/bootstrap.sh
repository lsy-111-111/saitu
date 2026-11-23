#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run bootstrap as root.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg xz-utils git rsync nginx certbot python3-certbot-nginx postgresql-common ufw
install -d -m 0755 /usr/share/postgresql-common/pgdg
curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
gpg --show-keys --with-colons /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc | awk -F: '$1 == "fpr" {print $10}' | grep -qx B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main' > /etc/apt/sources.list.d/saitu-pgdg.list
apt-get update
apt-get install -y postgresql-17 postgresql-client-17
if ! /opt/saitu-tools/node/bin/node --version 2>/dev/null | grep -qx v24.22.1; then
  install -d -m 0755 /opt/saitu-tools
  task_tmp=$(mktemp -d)
  trap 'rm -rf "$task_tmp"' EXIT
  curl --fail --silent --show-error https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o "$task_tmp/node.tar.xz"
  curl --fail --silent --show-error https://nodejs.org/dist/v24.22.1/SHASUMS256.txt -o "$task_tmp/SHASUMS256.txt"
  node_sha=$(awk '$2 == "node-v24.22.1-linux-x64.tar.xz" {print $1}' "$task_tmp/SHASUMS256.txt")
  [[ "$node_sha" =~ ^[a-f0-9]{64}$ ]]
  printf '%s  %s\n' "$node_sha" "$task_tmp/node.tar.xz" | sha256sum --check --status
  tar -xJf "$task_tmp/node.tar.xz" -C /opt/saitu-tools
  ln -sfn node-v24.22.1-linux-x64 /opt/saitu-tools/node
fi
export PATH=/opt/saitu-tools/node/bin:$PATH
if ! /opt/saitu-tools/node/bin/pnpm --version 2>/dev/null | grep -qx 11.19.0; then
  npm install --global pnpm@11.19.0
fi
id saitu >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/saitu --shell /usr/sbin/nologin saitu
install -d -o root -g root -m 0755 /opt/resume-ai /opt/resume-ai/releases /var/cache/resume-ai /var/lib/saitu /var/lib/saitu/incoming
install -d -o root -g saitu -m 0750 /etc/saitu /etc/saitu/releases
install -d -o root -g root -m 0700 /var/backups/saitu /var/lib/saitu/acceptance
install -d -o saitu -g saitu -m 0750 /var/lib/saitu/build-home
install -d -o root -g root -m 0755 /var/www/saitu-acme/.well-known/acme-challenge
python3 - <<'PY'
from pathlib import Path
import re
config = Path('/etc/postgresql/17/main/postgresql.conf')
contents, count = re.subn(r"(?m)^#?listen_addresses\s*=.*$", "listen_addresses = '127.0.0.1'", config.read_text())
if count != 1:
    raise SystemExit('Unexpected PostgreSQL listen_addresses configuration')
config.write_text(contents)
PY
pg_conftool 17 main set port 5432
systemctl enable --now postgresql nginx
systemctl restart postgresql@17-main
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
printf '%s\n' 'Server tools and directories are ready. No API calls were made.'
