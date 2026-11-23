#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run restore verification as root.' >&2; exit 1; }
task_backup=${1:?Provide one backup directory}
[[ "$task_backup" =~ ^/var/backups/saitu/20[0-9]{6}T[0-9]{6}Z$ ]] || { echo 'Invalid backup directory.' >&2; exit 1; }
cd /opt/resume-ai/current
(cd "$task_backup" && sha256sum --check --status SHA256SUMS)
task_database="saitu_restore_test_$(date -u +%Y%m%d%H%M%S)_$$"
sudo -u postgres /usr/lib/postgresql/17/bin/createdb "$task_database"
trap 'sudo -u postgres /usr/lib/postgresql/17/bin/dropdb --if-exists "$task_database"' EXIT
sudo -u postgres /usr/lib/postgresql/17/bin/pg_restore --exit-on-error --no-owner --no-acl --dbname "$task_database" < "$task_backup/database.dump"
sudo -u postgres /usr/lib/postgresql/17/bin/psql -v ON_ERROR_STOP=1 --dbname "$task_database" -c "update saitu_discovery_runtime_grants set enabled=false; select count(*) as restored_migrations from saitu_local_migrations; select count(*) as restored_receipts from saitu_discovery_call_receipts;" >/dev/null
tar -xOzf "$task_backup/configuration.tar.gz" etc/saitu/saitu.env |
  /opt/saitu-tools/node/bin/node --input-type=module -e 'import {parseEnv} from "node:util";let input="";for await(const chunk of process.stdin) input+=chunk;const value=parseEnv(input).AI_CONVERSATION_SIGNING_SECRET;if(!value||value.length<32)throw new Error("BACKUP_SIGNING_SECRET_MISSING");process.stdout.write(JSON.stringify({signingSecret:value}));' |
  sudo -u postgres env "SAITU_MAINTENANCE_DATABASE_URL=postgresql:///$task_database?host=/var/run/postgresql" /opt/saitu-tools/node/bin/node /opt/resume-ai/current/scripts/server/verify-restored-data.mjs
printf '%s\n' 'Backup checksum and isolated database restore passed; restored authorization was disabled.'
