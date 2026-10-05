# Salone Register

Salone Register is a school enrollment and report-card app for Sierra Leone schools. It uses Node.js 24 and SQLite. Teachers can optionally save a guardian email address, prepare reports with entered subjects only, and share/download report-card PDFs. Report cards include typed teacher and head-teacher names.

School names search the shared school-logo directory. If a logo is not listed, an authenticated teacher can upload a PNG, JPEG, or WebP badge (up to 1 MB) or look up the school's website icon by domain. Website icons may not be official badges, so verify the result or upload the approved school logo. Saved logos are shared with signed-in teachers; this is a teacher-contributed directory, not an official national registry. **Share PDF** fetches the actual report file after teacher confirmation and opens the phone's native share sheet when the browser supports file sharing. WhatsApp, email, Bluetooth, AirDrop, and other destinations depend on the device, browser, installed apps, and network. If native file sharing is unavailable, the PDF downloads so it can be attached manually. Email/WhatsApp summary links send text only. Report PDF downloads require the teacher to own the student record or have it explicitly shared with them.

## Run locally

1. Run `npm start` from this folder.
2. Open `http://127.0.0.1:4173`.
3. On the server computer, create the first teacher account. The initial setup form is prefilled for Jonathan Decker (`jonathan.decker`); set a unique password of at least 12 characters. Setup is restricted to a loopback connection and is disabled after the first account is created.
4. Other teachers can create separate accounts from the sign-in screen. Their records are private to their account unless explicitly shared.

Passwords are stored as salted scrypt hashes. Sessions use HttpOnly, SameSite cookies and expire after 30 minutes without activity. Student records and report cards are stored in the server's `data/salone.sqlite` database. Each teacher can grant another teacher view-only or report-edit access to an individual student by entering the teacher's display name or username, then revoke it later. Usernames allow letters, numbers, dots, underscores, and hyphens, up to 32 characters. Avoid setting a password that is the same as an account or system password.

### Install on Linux

Download and extract `salone-register-linux.tar.gz`, open a terminal in the extracted folder, and run `./install-linux.sh`. This adds Salone Register to your user Applications menu. Installation requires Node.js 24+, npm, `curl`, `xdg-open`, and internet access to download the locked PDF dependency. The launcher binds to `127.0.0.1`; it does not expose the server to your network. Its database is stored at `~/.local/share/salone-register/salone.sqlite`, separately from the downloaded app files. To stop a launcher-started server, run `./launch-linux.sh --stop` from the extracted folder.

### Open from a phone on the same Wi-Fi

The normal `npm start` listens only on this computer. To temporarily allow devices on the same Wi-Fi, stop it with `Ctrl+C` and run `npm run start:lan`. On the server computer, find its private Wi-Fi IPv4 address (Linux: `hostname -I`). On the phone, open `http://<that-ip>:4173` in Safari (iPhone) or Chrome (Android). Both devices must be on the same trusted network, and the host firewall must allow port `4173` on the private network.

**LAN mode uses unencrypted HTTP. Use fictional data only in this mode.** Do not enter real student names, guardian contacts, or marks over LAN HTTP. For real records, deploy the HTTPS domain configuration below; then on iPhone use Safari's Share menu → Add to Home Screen, and on Android use Chrome's menu → Install app/Add to Home Screen. After signing in while online, the app caches the last saved register and report cards in that browser so they can be viewed offline. New registrations, edits, deletes, sharing, logo lookups, and PDF generation still require a connection to the server; reconnect before making changes.

## Hosting

The server binds to `127.0.0.1` by default. For school-network access, set `HOST=0.0.0.0` and restrict network access with a firewall. For public hosting, put the app behind HTTPS, set `NODE_ENV=production` and set `APP_ORIGIN` to the exact public origin (`https://sl-serleone.com`). Production must use HTTPS so session cookies are Secure. Back up and protect the SQLite database file; it contains student and guardian information.

### Deploy with Docker and automatic HTTPS

The included Docker Compose setup keeps the app port private and lets Caddy obtain and renew HTTPS certificates. You need a Linux host with Docker Compose, a public static IP address, and a domain you control.

1. Make sure you own or have permission to use `sl-serleone.com`, then point its DNS `A` record to the host's public IPv4 address. Add an `AAAA` record only if the host is reachable over IPv6.
2. Allow inbound TCP ports `80` and `443` (and UDP `443` for HTTP/3) through the host firewall and hosting provider.
3. Copy `.env.example` to `.env`. It is configured for `sl-serleone.com`; set `SETUP_TOKEN` to the output of `openssl rand -hex 32` and keep `.env` private.
4. Run `docker compose up -d --build` and wait for the domain to resolve and Caddy to issue its certificate.
5. Open `https://sl-serleone.com` and create the initial account for Jonathan Decker (`jonathan.decker`), entering the `SETUP_TOKEN` from `.env` and a unique password of at least 12 characters. The one-time key is compared on the server and is only accepted while the teacher table is empty.
6. Remove `SETUP_TOKEN` from `.env` and restart with `docker compose up -d`. The initial-setup route stays disabled after the first account is created.

Use `docker compose logs -f caddy app` to diagnose startup. The student database and Caddy certificates are held in named Docker volumes. Back up the `salone_data` volume regularly and restrict host access; it contains student and guardian information. Docker is not installed in the current development environment, so the Compose stack still needs validation on the host where it will run.

This prepares the app for your domain; it does not register a domain or provision a public host. Domain registration, DNS changes, hosting access, and any provider fees require your account and approval.

## Tests

Run `npm test` for authentication, session expiry, record isolation, explicit sharing, school-logo validation, and permission-checked report PDF generation.
