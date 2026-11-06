# squircle-server

The Squircle Labs API. It handles everything on [squircle.london](https://squircle.london) that needs a server:

- **Accounts.** People sign up and sign in with Apple or Google. This will later cover Manuscript subscriptions and template uploads.
- **Manuscript subscriptions.** One product at one price: $9.99 per person per month, for everyone.
  Organisations buy more seats. Includes entitlements for the Mac app.
- **Admin.** A separate sign-in, by invitation only. It holds the Newsroom editor for now.
- **The Newsroom.** It renders static pages and publishes them to the website's repository.

The website stays fully static on GitHub Pages. Its public pages never call this server. Only
`/account/` and `/admin/` do, and only when someone opens them.

```text
 squircle.london (GitHub Pages)                api.squircle.london (Render)        Turso
 ─────────────────────────────                  ──────────────────────────          ─────
 public pages ── never call the API
 /account/  ── fetch, credentials ────────────▶  /auth/*, /me           ──────────▶  users, sessions
 /admin/    ── fetch, credentials ────────────▶  /admin/auth/*,         ──────────▶  admins, articles, media
                                                  /admin/newsroom/*
            ◀── GitHub Pages deploys ◀── one commit to main (newsroom/, assets/newsroom/, index.html)
```

**Stack:** Express 5 and TypeScript; [libSQL](https://github.com/tursodatabase/libsql-client-ts), which uses a local SQLite file in
development and Turso in production; [jose](https://github.com/panva/jose) to verify and sign tokens. Those are
all the runtime dependencies.

## API

| Route | Who | |
| --- | --- | --- |
| `GET /auth/{apple,google}` → `/auth/{provider}/callback` | anyone | Sign up or sign in. The same step for both. |
| `GET /auth/session`, `POST /auth/sign-out` | user | |
| `GET · PATCH · DELETE /me` | user | Your account: read, rename, delete. |
| `GET /admin/auth/{apple,google}` → `/admin/auth/{provider}/callback` | team | Admin sign-in. Refused unless the email is on the team. |
| `GET /admin/auth/session`, `POST /admin/auth/sign-out` | admin | |
| `/admin/newsroom/articles[/:id][/publish\|/unpublish\|/preview]` | admin | Stories. |
| `POST /admin/newsroom/uploads`, `POST /admin/newsroom/render` | admin | Images and Markdown preview. |
| `GET /media/:name` | anyone | Images for drafts, before they're published to the site. |
| `GET /billing/plan` | anyone | The one plan: price, currency, interval. |
| `POST /billing/checkout`, `POST /billing/portal` | user | Start a purchase on Stripe Checkout, or open the Stripe billing portal. |
| `POST /billing/webhook` | Stripe | Subscription changes. Signed and idempotent. |
| `GET · PATCH /me/subscription`, `POST /me/subscription/{seats,members,claim-seat,leave}`, `DELETE /me/subscription/members/:id` | user | Status, seats and the people holding them. |
| `POST /me/invitations/:id/{accept,decline}` | user | Seats offered to you by email. |
| `GET · DELETE /me/devices[/:id]` | user | The Macs signed in to your account. |
| `GET /app/authorize` → website `/account/authorize/` → `POST /app/authorize/approve` | app + user | Sign in to the Mac app (OAuth with PKCE). |
| `POST /app/token` | app | Exchange a code or refresh token for tokens. |
| `GET /app/entitlement`, `POST /app/sign-out` | app | May this person use Manuscript? Answered with a signed token. |
| `GET /app/jwks.json` | anyone | The public key for entitlement tokens. |
| `GET /health` | anyone | Render's health check. |

### Security

- **Sign-in:** OAuth 2.0 authorization code flow, run on the server. Google uses PKCE. Apple uses a signed client secret. Every ID token is verified against the provider's published keys, including issuer, audience and nonce. The `state` and nonce travel in a signed cookie that lasts ten minutes.
- **Separate sessions:** users and admins have separate sessions with separate cookies (`sl_session` on `/` for 30 days, renewed while used; `sl_admin` on `/admin` for 12 hours). The session table stores only a hash of each random token, so sessions can be revoked.
- **Cookies:** `HttpOnly`, `Secure`, `SameSite=Lax`. They work because `api.squircle.london` is on the same site as `squircle.london`. That's why the API must live on a subdomain: Safari blocks cookies from other domains.
- **Writes:** CORS allows only `SITE_URL` (plus `EXTRA_ORIGINS`). Every write must carry an allowed `Origin`.
- **Admin access:** only for emails on the team. `OWNER_EMAIL` is always an owner, so the team can't lock itself out. Add people with `npm run admin:add -- person@example.com editor`.
- **Linked accounts:** a new Apple or Google login joins an existing account only when the provider has verified the email.

## Manuscript subscriptions

### The model

- **One price.** $9.99 per seat per month (`PLAN` in `src/config.ts`; Stripe's price must match, and the
  server warns at startup if it doesn't). There are no student, education or business tiers.
- **Seats.** A subscription has N seats. The buyer takes the first one and gives the others away by
  email. Invited people accept on their Account page after signing in with that email. The buyer can
  release their own seat (for example, if they're buying for others) and take it back later.
- **Entitlement.** `entitlementFor(userId)` in `src/billing/subscriptions.ts` is the only place that
  decides access. Every surface (website, Mac app, a future iOS app) asks it.
  - `active` and `trialing` grant access.
  - `past_due` also grants access. This is a grace period while Stripe retries the card, as Apple does.
  - A subscription cancelled at the end of its period keeps access until the last day.
  - If seats are cut elsewhere, the people who accepted first keep access.
- **Channels.** Every subscription has a `channel`: `web` (billed by Squircle through Stripe) or
  `app_store` (billed by Apple; reserved for later). An App Store purchase will become a row in the
  same table, so the Account page and the app treat both the same way.
- **Accounts can't be deleted** while they're still paying for a subscription.

### Why Stripe, and not RevenueCat (yet)

The server owns the source of truth for who's entitled to what. Stripe handles only the money:

- **Hosted pages:** Checkout and the billing portal run on Stripe's pages, so card data never touches Squircle.
- **Payment methods:** Apple Pay, cards and local methods come through dynamic payment methods.
- **Built in:** invoices, retries and dunning.

Every provider call goes through the small `BillingProvider` interface in `src/billing/types.ts`.
Moving to RevenueCat later, or adding App Store Server Notifications, means adding a provider. Nothing
else changes.

### Setting up Stripe

Develop and test in a [Stripe sandbox](https://docs.stripe.com/sandboxes) rather than live mode. The
Stripe CLI can make one without an account: `npm i -g @stripe/cli && stripe sandbox create`.

1. **Product and price.** Create the product **Manuscript** with one recurring price: **$9.99 USD per month,
   per unit**. The price's ID is `STRIPE_PRICE_ID`. Seats are the quantity.
2. **Restricted API key** (Developers → API keys → Create restricted key) → `STRIPE_API_KEY`.
   Grant only these permissions:
   - Customers: **Write**
   - Checkout Sessions: **Write**
   - Customer portal: **Write**
   - Subscriptions: **Write**
   - Prices: **Read**
   - Charges: **Read**
3. **Webhook** (Developers → Webhooks → Add endpoint):
   - URL: `https://api.squircle.london/billing/webhook`
   - Events — exactly these, which `WEBHOOK_EVENTS` in `src/billing/stripe.ts` handles:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`
     - `invoice.paid`
     - `invoice.payment_failed`
     - `charge.refunded`
     - `charge.dispute.created`
     - `radar.early_fraud_warning.created`
   - Signing secret → `STRIPE_WEBHOOK_SECRET`.

   Locally:
   ```bash
   stripe listen --forward-to localhost:4000/billing/webhook \
     --events checkout.session.completed,checkout.session.async_payment_succeeded,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed,invoice.paid,invoice.payment_failed,charge.refunded,charge.dispute.created,radar.early_fraud_warning.created
   ```
4. **Customer portal** (Settings → Billing → Customer portal):
   - **Turn on:** payment method updates, invoice history, and cancellation at the end of the period.
   - **Turn off:** quantity changes. Seats are managed on the Account page, so people see who holds each one.
5. **Payment methods:** leave them on dynamic (the default). The code never sets `payment_method_types`.

Disputes, refunds and early fraud warnings are recorded in `billing_alerts`, tied to the person. The
server doesn't act on them automatically. Decide on a policy, for example cancelling on an early
fraud warning, before launch.

### Tax

Squircle Labs is a UK company selling a digital service worldwide. Tax depends on your registrations,
and Stripe will **not** collect anything until a registration is active.

1. In Stripe → Tax → Settings, set the head office address.
2. Add registrations for every place you're obliged to collect. For example:
   - **UK VAT**, once you're registered.
   - **EU VAT**, usually through the One Stop Shop for digital services to consumers. Choose the scheme with your tax advisor.
   - **US states**, as Stripe's threshold monitoring flags them.
3. Pick the Manuscript product's tax code from Stripe's [tax code list](https://docs.stripe.com/tax/tax-codes)
   together with your tax advisor. Don't guess one.
4. Only then set `STRIPE_AUTOMATIC_TAX=true`. Checkout then collects addresses and calculates VAT and sales tax.

### Family Sharing

Family Sharing is an Apple feature for App Store subscriptions. When Manuscript ships on the App Store,
a family member's shared purchase will arrive through App Store Server Notifications as an
`app_store` subscription and grant entitlement through the same `entitlementFor()`. Whether web
subscriptions get a family equivalent hasn't been decided, so nothing here implements one.

## The Mac app: signing in and checking entitlement

Manuscript downloaded from the website signs in with the same Squircle account. The server is an
OAuth 2.0 authorization server for native apps, using the authorization code flow with PKCE.

| | |
| --- | --- |
| Client ID | `manuscript-mac` |
| Redirect URI | `manuscript://auth/callback` (register the `manuscript` URL scheme in the app) |
| Authorize | `GET https://api.squircle.london/app/authorize` |
| Token | `POST https://api.squircle.london/app/token` |
| Entitlement | `GET https://api.squircle.london/app/entitlement` with `Authorization: Bearer …` |
| Public key | `GET https://api.squircle.london/app/jwks.json` |

**1. Sign in.** Make a random `code_verifier` (32 bytes, base64url) and its S256 `code_challenge`, then:

```swift
var url = URLComponents(string: "https://api.squircle.london/app/authorize")!
url.queryItems = [
  .init(name: "client_id", value: "manuscript-mac"),
  .init(name: "redirect_uri", value: "manuscript://auth/callback"),
  .init(name: "code_challenge", value: challenge),
  .init(name: "code_challenge_method", value: "S256"),
  .init(name: "state", value: state),
  .init(name: "device_name", value: Host.current().localizedName ?? "Mac"),
]
let session = ASWebAuthenticationSession(url: url.url!, callback: .customScheme("manuscript")) { callback, error in
  // callback: manuscript://auth/callback?code=…&state=…   (or ?error=access_denied)
}
session.prefersEphemeralWebBrowserSession = false   // reuse the person's website sign-in
session.start()
```

The person signs in on the website with Apple or Google if needed. They then see **Sign in to
Manuscript**, with the app, the Mac's name and their account, and choose Continue.

**2. Exchange the code** (valid once, for 2 minutes):

```http
POST /app/token
Content-Type: application/json

{ "grant_type": "authorization_code", "client_id": "manuscript-mac", "code": "…",
  "code_verifier": "…", "redirect_uri": "manuscript://auth/callback" }
```

→ `{ "access_token", "token_type": "Bearer", "expires_in": 900, "refresh_token" }`. Keep the refresh
token in the Keychain. Refresh with `{ "grant_type": "refresh_token", "client_id", "refresh_token" }`.
**Every refresh returns a new refresh token; store it and discard the old one.** Presenting an old one
signs that Mac out, as protection against stolen tokens.

**3. Check entitlement** on launch and about once a day (`refreshAfter`):

```http
GET /app/entitlement
Authorization: Bearer <access_token>
```

→ `{ entitlement, user, token, refreshAfter, manageUrl, subscribeUrl }`. `token` is an **ES256-signed
JWT** (`typ: entitlement+jwt`). Its claims are `sub`, `entitled`, `state` (`active` · `grace` ·
`ending`), `period_end`, `channel` and `role`. Its `aud` is `manuscript-mac` and its `iss` is
`https://api.squircle.london`.

Verify it with the public key from `/app/jwks.json`, and **ship that key inside the app** as well, so
the first launch works offline. Trust a verified token until its `exp`. That's at most 7 days, and
never past the last day of a cancelled subscription. That's the offline grace. When it lapses, ask the
server again. When `entitled` is false, show `subscribeUrl` in the browser.

**4. Sign out:** `POST /app/sign-out` with the bearer token. People can also sign a Mac out from
**Your Macs** on their Account page, which takes effect immediately.

`ENTITLEMENT_PRIVATE_KEY` signs these tokens. Generate it once:
`openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt`.
Keep it secret, and keep it stable: changing it invalidates every token in the field until each app
fetches a new one.

## Tests

```bash
npm test     # 41 tests on Node's built-in runner, against a throwaway database
```

They cover:
- **Purchase:** the full flow over HTTP, plus team seats and invitations.
- **Entitlement:** grace periods, cancellations, cut seats and out-of-order updates.
- **Stripe:** webhook signatures and every handled event, using a stand-in Stripe client.
- **Mac app:** sign-in with PKCE, single-use codes, refresh rotation and replay detection, and offline verification of the signed token.

## Local development

```bash
npm install
cp .env.example .env        # set OWNER_EMAIL; DEV_SIGN_IN=true is already on
npm run dev                 # http://localhost:4000

# In the website checkout (../manuscript):
python3 -m http.server 8080 # http://localhost:8080
```

With `BILLING_PROVIDER=dev` (the development default), **Subscribe** opens a developer checkout:
press Subscribe there and the subscription is real in your local database, but no money moves.
**Manage** opens a small developer portal that can cancel, resume, simulate a failed payment or end
the subscription.

When the site runs on localhost, it calls `http://localhost:4000` automatically. With `DEV_SIGN_IN=true`,
the sign-in pages show a **Developer sign-in** box that skips Apple and Google. It never exists in
production. In development, publishing writes into `SITE_DIR` (`../manuscript`) instead of committing to GitHub.

Google sign-in also works on localhost if you add the localhost redirect URIs (below). Apple doesn't allow
localhost, so test it on the deployed server.

## Production setup

Do these once, in order. Afterwards, each deploy is just a `git push`.

### 1. Turso (database)

```bash
brew install tursodatabase/tap/turso
turso auth signup                          # or: turso auth login
turso db create squircle                   # choose the location closest to London
turso db show squircle --url               # → DATABASE_URL (libsql://…)
turso db tokens create squircle            # → DATABASE_AUTH_TOKEN
```

Copy the existing Newsroom stories and images into it from your development database:

```bash
DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npm run newsroom:import -- data/dev.db
```

### 2. GitHub token (publishing)

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.

- **Repository access:** Only select repositories → `Batty-sk/manuscript`
- **Permissions:** Repository → **Contents: Read and write**. Nothing else.
- **Expiration:** a year. Note the date; publishing stops when the token expires.

This is `GITHUB_TOKEN`.

### 3. Sign in with Apple

You need the paid Apple Developer Program membership. Everything is at
[developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles**.

1. **Team ID.** Shown at the top right of the page, and under Membership details. It's 10 characters, for example `A1B2C3D4E5`. → `APPLE_TEAM_ID`
2. **App ID** (Sign in with Apple hangs off one):
   Identifiers → **+** → **App IDs** → Continue → **App** → Continue.
   - Description: `Squircle Labs`
   - Bundle ID: **Explicit**, `london.squircle.web`
   - Capabilities: tick **Sign In with Apple**
   - Continue → Register.
3. **Services ID** (this is the web sign-in's client ID):
   Identifiers → **+** → **Services IDs** → Continue.
   - Description: `Squircle Labs` (people see this on Apple's sign-in sheet)
   - Identifier: `london.squircle.signin` → `APPLE_SERVICES_ID`
   - Continue → Register. Then open it, tick **Sign In with Apple**, and click **Configure**:
     - Primary App ID: `Squircle Labs (london.squircle.web)`
     - Domains and Subdomains: `api.squircle.london`
     - Return URLs, both of them:
       - `https://api.squircle.london/auth/apple/callback`
       - `https://api.squircle.london/admin/auth/apple/callback`
   - Next → Done → Continue → **Save**.
4. **Key** (signs the client secret):
   Keys → **+** → name it `Squircle Sign in with Apple`, tick **Sign In with Apple** → **Configure** → Primary App ID
   `london.squircle.web` → Save → Continue → **Register**.
   - **Download** the `.p8` file. Apple lets you download it **once only**. Keep it somewhere safe, outside any repository.
   - The **Key ID** is shown on the same page → `APPLE_KEY_ID`
   - The file's whole contents, including the `BEGIN`/`END` lines → `APPLE_PRIVATE_KEY`. Render accepts multi-line values. If a tool needs one line, replace the newlines with `\n`.

Things to know about Sign in with Apple:

- Apple sends the person's **name only on their first sign-in**. The server saves it then, and they can change it on the Account page.
- People can choose **Hide My Email**. They're then known by an `…@privaterelay.appleid.com` address. To email them later, register your sending domain under Services → **Sign in with Apple for Email Communication**.
- For **Admin**, the Apple ID's email must match the invited email. Admins should choose **Share My Email**, or use Google.

### 4. Sign in with Google

At [console.cloud.google.com](https://console.cloud.google.com):

1. Create a project named `Squircle Labs`.
2. **Google Auth Platform → Branding**:
   - App name `Squircle Labs`, your support email, the logo.
   - Home page `https://squircle.london`, privacy policy `https://squircle.london/privacy.html`, terms `https://squircle.london/terms.html`.
   - Authorised domain `squircle.london`.
3. **Audience:** External. Then **Publish app**. The `openid email profile` scopes need no Google review.
4. **Clients → Create client → Web application**, named `squircle-server`. Authorised redirect URIs:
   - `https://api.squircle.london/auth/google/callback`
   - `https://api.squircle.london/admin/auth/google/callback`
   - `http://localhost:4000/auth/google/callback` (development)
   - `http://localhost:4000/admin/auth/google/callback` (development)
5. Copy the **Client ID** → `GOOGLE_CLIENT_ID` and the **Client secret** → `GOOGLE_CLIENT_SECRET`.

### 5. Render (hosting)

1. Push this repository to GitHub, for example `Batty-sk/squircle-server`.
2. On Render: **New → Blueprint**, pick the repository. Render reads `render.yaml`.
3. Fill in the values marked `sync: false`:
   - `OWNER_EMAIL`
   - the Turso, Google, Apple and GitHub values
   - the Stripe values (`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`)
   - `ENTITLEMENT_PRIVATE_KEY`

   Render generates `SESSION_SECRET`.
4. **Settings → Custom Domains → Add** `api.squircle.london`. Render shows a CNAME target (`squircle-server.onrender.com`).
   Add that CNAME record at your DNS provider. Render then issues the HTTPS certificate.
5. Open `https://api.squircle.london/health`. It should say `{"ok":true}`.

**About the free plan:** the server sleeps after 15 minutes without requests and takes about a minute to
wake. The Account and Admin pages say "Waking up…" while that happens. Public pages are unaffected
because they never call the server. Render's Starter plan keeps the server awake.

### 6. Check it

- `https://squircle.london/account/`: sign up with Apple, then sign out and in with Google using the same email. Both appear under **Signs in with**.
- `https://squircle.london/admin/`: sign in as `OWNER_EMAIL`, edit a story and press **Update**. A commit `newsroom: update “…”` appears on `main`, and the page updates about a minute later.

## Scripts

| | |
| --- | --- |
| `npm run dev` | Local server, restarted on change |
| `npm run build` · `npm start` | Compile, then run (what Render does) |
| `npm run admin:add -- email [editor\|owner]` | Invite someone to Admin |
| `npm run newsroom:rebuild` | Republish every Newsroom page (after a template change) |
| `npm run newsroom:import -- source.db` | Copy stories and images into `DATABASE_URL` |
| `npm test` | Run the test suite |
