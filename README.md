# XD-MARKET

A Sierra Leone-focused multi-vendor marketplace with a responsive storefront, buyer checkout, seller registration and approval, product photo listings, vendor order and payout dashboards, and an administrator console. Node.js 24 uses the built-in SQLite backend for local development and PostgreSQL for persistent deployments. The original marketplace mark is in `logo.svg`.

## Run locally

Run from this directory for local development (SQLite is created at `data/salonemarket.sqlite`):

```sh
npm start
```

Open `http://127.0.0.2:4175`. The multipage storefront includes `index.html`, `fashion.html`, `electronics.html`, `beauty.html`, `signup.html`, `cart.html`, `checkout.html`, `vendor.html`, `about.html`, and `contact.html`. Shared marketplace UI lives in `css/styles.css` and `js/main.js`. The admin dashboard remains in `index.html`. Browsing, seller registration, product listings, the cart, and cash-on-delivery checkout work locally. The database is created at `data/salonemarket.sqlite` to preserve existing marketplace data.

To create the first administrator, provide an email and a unique password with at least 12 characters on the first run. The admin account is stored in the selected database and is not recreated on later starts.

```sh
export ADMIN_EMAIL=admin@example.com
read -rsp 'Admin password: ' ADMIN_PASSWORD; export ADMIN_PASSWORD; printf '\n'
npm start
```

The server binds to `127.0.0.2:4175` by default. Set `HOST` and `PORT` to override. Local development and tests use SQLite unless `DATABASE_URL` is set. `MARKET_DB_PATH` can override the local SQLite file.

For a persistent PostgreSQL deployment such as Supabase, set `DATABASE_URL` to the database's PostgreSQL connection URI in the hosting provider's secret environment configuration. Apply migrations with `npm run migrate`; startup also applies any pending migrations before accepting requests. PostgreSQL connections use a bounded pool (10 connections by default, configurable with `PG_POOL_MAX`) and TLS certificate verification. `PGSSLMODE=disable` is available only for explicitly configured non-production local PostgreSQL; do not use it in production. No database credentials belong in source control.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 12 characters) on the first run to create the first administrator; these values are not stored in project files. Set `NODE_ENV=production`, `APP_ORIGIN` to the exact public API origin, and `FRONTEND_ORIGIN` only when the frontend is hosted on another origin. Set `HOST` and `PORT` as needed. Configure `FLW_SECRET_KEY` and `FLW_WEBHOOK_SECRET` for online payment. Keep all secrets in your hosting provider's secret manager.

The PostgreSQL migrations create the schema but do not copy existing local SQLite records. Existing SQLite data remains available locally; migrate/import any records that must be retained before switching production traffic.

## Promotions

The first five unique buyers can claim free delivery on one order each. Online-payment claims are held for 30 minutes while checkout is pending; a provider setup failure or expired payment releases the slot. Cash-on-delivery claims are recorded with the order. The first ten vendors that an admin approves receive a persistent 5% commission rate; subsequent vendors use the active admin-configured rate. Admin and vendor pages display the assigned rate.

## GitHub Pages frontend

The Node server must remain online as the API; GitHub Pages only serves the static pages and cannot run `server.mjs` or access its database. Deploy the site files at the Pages site root (or use a custom domain), host the API behind HTTPS with PostgreSQL configured as above, and set `FRONTEND_ORIGIN` to the exact Pages origin, such as `https://yourname.github.io`. Set `APP_ORIGIN` to the exact public API origin. In each HTML file that loads the app, set `<meta name="xd-api-base" content="https://api.example.com">` to the API URL (no trailing slash). The CORS handler permits only that configured frontend origin and uses credentialed requests.

Authentication uses salted scrypt password hashes and a short-lived, `HttpOnly`, `SameSite=None; Secure` cookie when frontend and API origins differ. It deliberately does not return a JWT for storage in `localStorage`; browser scripts cannot read the session token. Use HTTPS for both frontend and API. Some browsers block cross-site cookies; production deployments should use a custom frontend/API domain arrangement that is same-site where possible.

Registration requires a valid email, international phone number, and a password of at least 12 characters. Public registration can create buyer or pending vendor accounts only. Admin approval controls vendor permissions; admin privileges are only granted through the server's first-admin environment bootstrap.

Contact form submissions are stored in the configured database and appear in the administrator dashboard's Contact inbox. Administrators can mark messages read and reply using the sender's email address; messages are not automatically forwarded by email.

## Payments

Online payment checkout uses Flutterwave-hosted checkout. Set `FLW_SECRET_KEY` and `FLW_WEBHOOK_SECRET` in the server environment, and configure the provider webhook URL as `https://your-domain.example/api/flutterwave/webhook`. The webhook secret must match the provider dashboard. Set `APP_ORIGIN` to your public HTTPS URL so the payment return URL is correct.

Orange Money and Afrimoney selections route to Flutterwave's Sierra Leone mobile-money checkout; customers complete the carrier flow on the provider page. Visa/Mastercard and bank transfer use the corresponding hosted checkout options. Confirm Sierra Leone merchant activation, available payment rails, and supported SLE/USD settlement currencies in your Flutterwave account before accepting live transactions. No credentials are included in this project.

The application records the platform commission and vendor earnings after a payment is verified server-to-server. A browser redirect alone never marks a payment as paid. Vendor payout requests are queued for administrator review; an administrator records completion after manually sending the funds to the requested wallet or bank account. This is not an automatic split-settlement or payout integration. Cash on delivery is disabled when `NODE_ENV=production`.

## Tests

```sh
npm test
```

The integration tests cover commission rounding, seller approval, multi-vendor orders, currency separation, payout balance reservation, failed-payment stock restoration, webhook signature enforcement, and static-file access restrictions.
