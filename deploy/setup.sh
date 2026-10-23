#!/usr/bin/env bash
# One-time (and re-runnable) server setup on Ubuntu 24.04, e.g. a Google Cloud e2-micro.
#
#   sudo bash deploy/setup.sh api.yourdomain.com admin.yourdomain.com [yourdomain.com]
#
# Expects, in the same folder as deploy/: the admin/ folder, the site/ folder (the built website, if a third name
# is given) and (first time) signing-key.pem from your PC.
# Installs Node 24, Caddy (HTTPS) and sqlite3; runs the admin server as a service; daily backups at 02:30 UTC.
# Running it again updates the server code and keeps the database and signing key.
set -euo pipefail

API_HOST="${1:-}"
ADMIN_HOST="${2:-}"
SITE_HOST="${3:-}"   # optional: the website (home page)
if [ -z "$API_HOST" ] || [ -z "$ADMIN_HOST" ]; then
  echo "Usage: sudo bash deploy/setup.sh api.yourdomain.com admin.yourdomain.com [yourdomain.com]"; exit 1
fi
[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo."; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/admin/server.js" ] || { echo "admin/server.js not found next to deploy/. Unpack shortlistprep-server.tgz first."; exit 1; }
if [ -n "$SITE_HOST" ] && [ ! -f "$HERE/site/index.html" ]; then echo "site/index.html not found next to deploy/. Make the package with npm run server:package."; exit 1; fi

echo "== 1/7 Swap file (the e2-micro has only 1 GB of memory)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 2/7 System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 unattended-upgrades

echo "== 3/7 Node.js 24"
if ! node -v 2>/dev/null | grep -qE '^v(2[4-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 4/7 Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "== 5/7 Server files in /opt/shortlistprep"
id shortlistprep >/dev/null 2>&1 || useradd --system --home /opt/shortlistprep --shell /usr/sbin/nologin shortlistprep
mkdir -p /opt/shortlistprep/data /opt/shortlistprep/backups
rm -rf /opt/shortlistprep/admin
cp -r "$HERE/admin" /opt/shortlistprep/admin
rm -rf /opt/shortlistprep/admin/data                      # the live data lives in /opt/shortlistprep/data, never in the code folder
if [ -f "$HERE/signing-key.pem" ]; then
  if [ -f /opt/shortlistprep/data/signing-key.pem ] && ! cmp -s "$HERE/signing-key.pem" /opt/shortlistprep/data/signing-key.pem; then
    echo "!! A different signing key is already on the server. Keeping the server's key; remove $HERE/signing-key.pem."
  else
    install -m 600 "$HERE/signing-key.pem" /opt/shortlistprep/data/signing-key.pem
  fi
  shred -u "$HERE/signing-key.pem" 2>/dev/null || rm -f "$HERE/signing-key.pem"   # do not leave a copy in the home folder
fi
if [ ! -f /opt/shortlistprep/data/signing-key.pem ]; then
  echo "!! No signing key uploaded. The server will create a NEW one, and the app must then be rebuilt with its public key."
fi
if [ -n "$SITE_HOST" ]; then
  rm -rf /opt/shortlistprep/website
  cp -r "$HERE/site" /opt/shortlistprep/website
fi
install -m 750 "$HERE/deploy/backup.sh" /opt/shortlistprep/backup.sh
chown -R shortlistprep:shortlistprep /opt/shortlistprep
chmod 755 /opt/shortlistprep
chmod 700 /opt/shortlistprep/data /opt/shortlistprep/backups
[ -d /opt/shortlistprep/website ] && chmod -R a+rX /opt/shortlistprep/website   # Caddy (another user) reads the website

echo "== 6/7 Service, HTTPS and daily backup"
install -m 644 "$HERE/deploy/shortlistprep-admin.service" /etc/systemd/system/shortlistprep-admin.service
sed -e "s/__API_HOST__/$API_HOST/" -e "s/__ADMIN_HOST__/$ADMIN_HOST/" "$HERE/deploy/Caddyfile" > /etc/caddy/Caddyfile
# (not when Caddyfile.local below already has a block for that address: Caddy refuses a site defined twice)
if [ -n "$SITE_HOST" ] && ! { [ -f /etc/caddy/Caddyfile.local ] && grep -qE "(^|[[:space:],])$SITE_HOST([[:space:],{]|$)" /etc/caddy/Caddyfile.local; }; then
  sed -e "s/__SITE_HOST__/$SITE_HOST/" "$HERE/deploy/Caddyfile.site" >> /etc/caddy/Caddyfile
fi
# extra sites you added by hand (for example your own domain) live in /etc/caddy/Caddyfile.local and survive updates
[ -f /etc/caddy/Caddyfile.local ] && { echo; cat /etc/caddy/Caddyfile.local; } >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
echo "30 2 * * * shortlistprep /opt/shortlistprep/backup.sh >> /opt/shortlistprep/backups/backup.log 2>&1" > /etc/cron.d/shortlistprep-backup
systemctl daemon-reload
systemctl enable --now shortlistprep-admin
systemctl restart shortlistprep-admin
systemctl enable --now caddy
systemctl reload caddy

echo "== 7/7 Check (the server needs a few seconds to start on a small VM)"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4180/api/health 2>/dev/null; then ok=1; echo "  <- admin server is answering"; break; fi
  sleep 1
done
[ -n "$ok" ] || echo "!! The admin server did not answer within 30 seconds. See: sudo journalctl -u shortlistprep-admin -n 30 --no-pager"
echo
echo "Done. Next:"
echo "  1. Create your admin login (once):"
echo "     sudo -u shortlistprep ADMIN_DATA_DIR=/opt/shortlistprep/data node /opt/shortlistprep/admin/create-admin.js you@example.com owner \"Your Name\""
echo "  2. Open https://$ADMIN_HOST  (the certificate is issued on the first visit; DNS must already point here)"
echo "  3. Test the API: https://$API_HOST/api/health"
if [ -n "$SITE_HOST" ]; then echo "  4. Website: https://$SITE_HOST"; fi
