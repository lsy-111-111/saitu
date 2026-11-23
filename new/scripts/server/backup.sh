#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run backup as root.' >&2; exit 1; }
umask 077
task_backup_root=/var/backups/saitu
install -d -m 0700 "$task_backup_root"
exec 9>"$task_backup_root/.lock"
flock -n 9 || { echo 'A backup is already running.' >&2; exit 1; }
task_backup_id=$(date -u +%Y%m%dT%H%M%SZ)
task_staging=$(mktemp -d "$task_backup_root/.pending-${task_backup_id}-XXXXXX")
trap 'rm -rf "$task_staging"' EXIT
sudo -u postgres /usr/lib/postgresql/17/bin/pg_dump --format=custom --no-owner --no-acl saitu_production > "$task_staging/database.dump"
/usr/lib/postgresql/17/bin/pg_restore --list "$task_staging/database.dump" >/dev/null
tar -czf "$task_staging/configuration.tar.gz" -C / etc/saitu
cp /opt/resume-ai/current/release-source-manifest.json "$task_staging/release-source-manifest.json"
readlink -f /opt/resume-ai/current > "$task_staging/release.txt"
(cd "$task_staging" && sha256sum database.dump configuration.tar.gz release-source-manifest.json release.txt > SHA256SUMS && sha256sum --check --status SHA256SUMS)
chmod 0600 "$task_staging"/*
mv "$task_staging" "$task_backup_root/$task_backup_id"
trap - EXIT
find "$task_backup_root" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime +6 -exec rm -rf -- {} +
printf '%s\n' "Backup ready: $task_backup_root/$task_backup_id"
