# ClassCue admin dashboard

A small server (no extra packages, needs Node 22+) with a dashboard for you, and the API the desktop app and the website call.

## Run it

```bash
npm run admin:create -- you@example.com owner "Your Name"   # once: prints a password, shown only now
npm run admin                                               # http://localhost:4180
```

Data lives in `admin/data/` (`admin.db` and `signing-key.pem`). **Back up the whole folder.** If `signing-key.pem` is lost, every installed app would need a new public key. Never share it or commit it.

Forgot a password: `npm run admin:create -- you@example.com --reset`

## What the dashboard does

| Screen | Use |
|---|---|
| Overview | Revenue, customers, active/trial/expiring licences, trial-to-paid %, computers seen, new customers per day |
| Customers | Search, add, edit, notes; see a customer's licences and orders |
| Licences | Issue trial or paid keys, extend, cancel/reinstate, change computer limit, remove activated computers |
| Orders | Record payments (optionally issue the licence in the same step), mark refunds (optionally cancel the licence) |
| Releases | Publish versions with download link and minimum supported version; the app reads the newest |
| Support | Messages from the website contact form; add notes, close, reply by email |
| Audit log | Who did what and when (sign-ins, changes) |
| Team | Add people, change role, disable access, set a new password (owner only) |

Roles: **owner** everything; **admin** everything except the team; **support** read everything, answer messages, extend licences, reset computers.

## API for the app and website (public, no cookies)

| Call | Purpose |
|---|---|
| `POST /api/licence/activate` `{key, deviceId, deviceName, appVersion}` | First use on a computer. Counts towards the computer limit |
| `POST /api/licence/validate` `{key, deviceId}` | Re-check at start-up; never adds a computer |
| `POST /api/licence/deactivate` `{key, deviceId}` | Free a computer |
| `GET /api/releases/latest?channel=stable` | Newest release for update checks |
| `POST /api/contact` `{name, email, topic, message}` | Website contact form, saved under Support |
| `GET /api/public-key` | The key that verifies licence answers |

A successful licence answer is `{ ok, plan, kind, expiresAt, payload, signature }`. `payload` is a JSON string and `signature` is an Ed25519 signature (base64) of it. **The app must verify the signature with the public key built into the app**, and check that `payload.deviceId` is its own and `payload.expiresAt` has not passed. Without that check a user could fake the "OK" answer. Failures are `{ ok: false, code }` with a code such as `invalid_key`, `expired`, `revoked`, `device_limit`, `not_activated`.

## Security notes

- Passwords are hashed (scrypt). Sign-in locks for 15 minutes after 5 wrong attempts. Sessions last 12 hours, are stored hashed, and end when an account is disabled.
- Changes need the same-site header and a same-origin request, and the cookie is `HttpOnly; SameSite=Strict`.
- The dashboard shows all data as plain text, and sends a strict content-security policy.
- The public API is rate limited per address (licence calls 60 a minute, contact form 5 an hour).

## Before you put it on the internet

1. Run it behind HTTPS (a reverse proxy such as Caddy or nginx, or a host that provides it) and set `SECURE_COOKIES=1`. If the proxy forwards the visitor's address, also set `TRUST_PROXY=1` so rate limits see real addresses, and only then.
2. Keep the dashboard private if you can: restrict it by IP or VPN at the proxy. The public `/api/` paths are the only ones the world needs.
3. Add two-factor sign-in before you have staff beyond yourself (not built yet).
4. Back up `admin/data/` regularly.

Settings (environment variables): `PORT` (4180), `HOST` (127.0.0.1), `ADMIN_DATA_DIR`, `SECURE_COOKIES`, `TRUST_PROXY`.

## Not built yet

- Automatic orders from the payment provider (Paddle / Lemon Squeezy webhook). Today you record orders by hand. A webhook must verify the provider's signature before it creates anything.
- Emailing the licence key to the customer.
- A customer self-service page (see licences, remove a computer).
- The licence check inside the desktop app (the API is ready for it).
- Two-factor sign-in.
