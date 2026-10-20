# Publishing the ShortlistPrep server and website

Server (licence API + admin dashboard + SQLite) on a **Google Cloud e2-micro** (free tier), website on
**Cloudflare Pages** (free). Replace `yourdomain.com` everywhere with your real domain.

| Address | What | Where |
|---|---|---|
| `https://api.yourdomain.com` | Licence API for the app and the website (only `/api/...`) | Google Cloud VM |
| `https://admin.yourdomain.com` | Your admin dashboard | Google Cloud VM |
| `https://yourdomain.com` | Website | Cloudflare Pages |

## A. Google Cloud: create the free server (about 20 minutes)

1. Go to https://console.cloud.google.com, sign in, accept the terms, add a billing account (a card is required
   even for the free tier) and create a project, for example `classcue`.
2. **Budget alert first:** Billing → Budgets & alerts → Create budget → amount **$1** → email alerts at 50% and 100%.
3. Compute Engine → VM instances (enable the API if asked) → **Create instance**:
   - Name: `classcue-server`
   - Region: **us-central1 (Iowa)**, **us-east1** or **us-west1** (only these are in the free tier)
   - Machine type: **E2 → e2-micro**
   - Boot disk → Change: **Ubuntu 24.04 LTS (x86/64)**, disk type **Standard persistent disk** (not Balanced), size **30 GB**
   - Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**
   - Create
4. Give it a fixed address: VPC network → IP addresses → find the VM's external address → **Promote to static**.
   Note the address (for example `34.123.45.67`). Check Google's pricing page and your first bill for any
   IPv4 address charge.

## B. Domain: point the names at the server (5 minutes, then wait)

At your domain registrar's DNS settings add two **A records** pointing at the VM's static address:

| Type | Name | Value |
|---|---|---|
| A | `api` | `34.123.45.67` |
| A | `admin` | `34.123.45.67` |

Wait until they work (minutes to a few hours). Check from your PC: `nslookup api.yourdomain.com`.

## C. Install the server (about 15 minutes)

1. On your PC, in the project folder: `npm run server:package` → creates `dist\classcue-server.tgz`.
2. In Google Cloud, VM instances → **SSH** (opens a terminal in your browser). Use the **Upload file** button
   (top right) to upload:
   - `dist\classcue-server.tgz`
   - `admin\data\signing-key.pem` (**must** be this file: the app's built-in public key matches it)
3. In the SSH window:
   ```bash
   tar -xzf classcue-server.tgz
   sudo bash deploy/setup.sh api.yourdomain.com admin.yourdomain.com
   ```
   The script removes the uploaded `signing-key.pem` from the home folder after copying it.
4. Create your admin login (prints a password once; copy it):
   ```bash
   sudo -u classcue ADMIN_DATA_DIR=/opt/classcue/data node /opt/classcue/admin/create-admin.js you@example.com owner "Your Name"
   ```
5. Open `https://admin.yourdomain.com`, sign in, change the password (My account).
   Check `https://api.yourdomain.com/api/health` shows `{"ok":true}`.
6. Optional but recommended: allow only your own IP to open the dashboard — edit `/etc/caddy/Caddyfile`
   (uncomment the two `remote_ip` lines), then `sudo systemctl reload caddy`.

## D. Point the app at the live server and build the customer installer

1. Edit `src/licence/settings.js`:
   - `SERVER_URL` → `https://api.yourdomain.com`
   - `BUY_URL` → `https://yourdomain.com/pricing.html`
2. `npm run dist` → `dist\ShortlistPrep-Setup-1.0.0.exe`. Install it on your PC and start a trial or activate a key
   against the live server. It must appear in the live dashboard.
3. Host the installer **not** on the VM (247 MB downloads would use up the free 1 GB of traffic):
   - GitHub Releases (only if the repository is public), or
   - a public Cloudflare R2 bucket (free downloads).
4. In the live dashboard → Releases → add version 1.0.0 with that download link.

## E. Website on Cloudflare Pages (about 15 minutes)

1. https://dash.cloudflare.com → Workers & Pages → Create → Pages → **Connect to Git** → choose the repository.
2. Build settings: build command `node website/build.js`, build output directory `website/site`.
3. Deploy, then Custom domains → add `yourdomain.com` (and `www.yourdomain.com`).
4. The website carries the ShortlistPrep pages; the ShortlistPrep product pages, real prices and
   the download link must be added before launch.

## Everyday tasks (in the VM's SSH window)

| Task | Command |
|---|---|
| Server status | `sudo systemctl status classcue-admin` |
| Server log | `sudo journalctl -u classcue-admin -n 100` |
| Restart | `sudo systemctl restart classcue-admin` |
| Update the server code | upload a new `classcue-server.tgz`, then `tar -xzf classcue-server.tgz && sudo bash deploy/setup.sh api.yourdomain.com admin.yourdomain.com` (database and key are kept) |
| Backup now | `sudo -u classcue /opt/classcue/backup.sh` |
| Download a backup | `sudo cp /opt/classcue/backups/classcue-*.tgz ~ && sudo chown $USER ~/classcue-*.tgz`, then **Download file** (top right) |

Backups run every day at 02:30 UTC and the newest 14 are kept on the server. **Download one to your PC every week**;
a backup on the same disk is lost with the server.

## Keep safe
- `signing-key.pem` is the most important file: if it is lost, every installed app needs a rebuilt installer.
  Keep a copy offline (for example an encrypted USB stick), never in Git, email or chat.
- Never open port 4180 in the Google Cloud firewall; only Caddy (80/443) is public.
