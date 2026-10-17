#!/usr/bin/env bash
# Daily backup of the database and the signing key (run by cron, see deploy/setup.sh).
# Keeps the newest 14 backups in /opt/classcue/backups. Download them to your PC regularly:
# a backup on the same disk does not survive the loss of the server.
set -euo pipefail

DATA=/opt/classcue/data
DEST=/opt/classcue/backups
STAMP=$(date -u +%Y%m%d-%H%M)
WORK="$DEST/$STAMP"

mkdir -p "$WORK"
sqlite3 "$DATA/admin.db" ".backup '$WORK/admin.db'"      # a consistent copy, even while the server is running
cp "$DATA/signing-key.pem" "$WORK/"
# the secret that decrypts the AI keys stored in the database (admin dashboard, AI keys); without it they must be re-entered
[ -f "$DATA/api-keys.secret" ] && cp "$DATA/api-keys.secret" "$WORK/"
tar -czf "$DEST/classcue-$STAMP.tgz" -C "$DEST" "$STAMP"
rm -rf "$WORK"
chmod 600 "$DEST/classcue-$STAMP.tgz"
ls -1t "$DEST"/classcue-*.tgz | tail -n +15 | xargs -r rm --
echo "Backup written: $DEST/classcue-$STAMP.tgz"
