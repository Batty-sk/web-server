# squircle-server

The Squircle Labs API. It handles everything on [squircle.london](https://squircle.london) that needs a server:

- **Accounts.** People sign up and sign in with Apple or Google. This will later cover Manuscript subscriptions and template uploads.
- **Admin.** A separate sign-in, by invitation only. It holds the Newsroom editor for now.
- **The Newsroom.** Stories live in the database. The website's Newsroom pages read them from a public JSON API.

The website stays static on GitHub Pages. The Newsroom pages, and the Newsroom tile on the home page,
fetch published stories from this server. `/account/` and `/admin/` call it with credentials. Every other
page works without it.

This server never writes to the website's repository. A story is live the moment it's published, and
nothing here holds a GitHub token.

```text
 squircle.london (GitHub Pages)                api.squircle.london (Render)        Turso
 ─────────────────────────────                  ──────────────────────────          ─────
 /newsroom/, home tile ── fetch, public ──────▶  /newsroom/*, /media/* ──────────▶  articles, media
 /account/  ── fetch, credentials ────────────▶  /auth/*, /me           ──────────▶  users, sessions
 /admin/    ── fetch, credentials ────────────▶  /admin/auth/*,         ──────────▶  admins, articles, media
                                                  /admin/newsroom/*
 other pages ── never call the API
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
| `/admin/newsroom/articles[/:id][/publish\|/unpublish\|/story]` | admin | Stories. `/story` is a draft in the same shape as the public one, for previews. |
| `POST /admin/newsroom/uploads`, `POST /admin/newsroom/render` | admin | Images and Markdown preview. |
| `GET /newsroom/stories[?limit=n]` | anyone | Published stories, newest first, as cards. |
| `GET /newsroom/stories/:slug` | anyone | One story with its body as HTML, plus three more to read. |
| `GET /newsroom/rss.xml` | anyone | The RSS feed. |
| `GET /media/:name` | anyone | Newsroom images. Names are content hashes, cached for a year. |
| `GET /health` | anyone | Render's health check. |

### Security

- **Sign-in:** OAuth 2.0 authorization code flow, run on the server. Google uses PKCE. Apple uses a signed client secret. Every ID token is verified against the provider's published keys, including issuer, audience and nonce. The `state` and nonce travel in a signed cookie that lasts ten minutes.
- **Separate sessions:** users and admins have separate sessions with separate cookies (`sl_session` on `/` for 30 days, renewed while used; `sl_admin` on `/admin` for 12 hours). The session table stores only a hash of each random token, so sessions can be revoked.
- **Cookies:** `HttpOnly`, `Secure`, `SameSite=Lax`. They work because `api.squircle.london` is on the same site as `squircle.london`. That's why the API must live on a subdomain: Safari blocks cookies from other domains.
- **Writes:** CORS allows only `SITE_URL` (plus `EXTRA_ORIGINS`). Every write must carry an allowed `Origin`.
- **Story HTML:** a story's body is Markdown. The server escapes it before formatting it, and allows only `http(s)` and `mailto` links, so the HTML the website inserts can't carry script.
- **Admin access:** only for emails on the team. `OWNER_EMAIL` is always an owner, so the team can't lock itself out. Add people with `npm run admin:add -- person@example.com editor`.
- **Linked accounts:** a new Apple or Google login joins an existing account only when the provider has verified the email.

## Local development

```bash
npm install
cp .env.example .env        # set OWNER_EMAIL; DEV_SIGN_IN=true is already on
npm run dev                 # http://localhost:4000

# In the website checkout (../manuscript):
python3 -m http.server 8080 # http://localhost:8080
```

When the site runs on localhost, it calls `http://localhost:4000` automatically. With `DEV_SIGN_IN=true`,
the sign-in pages show a **Developer sign-in** box that skips Apple and Google. It never exists in
production.

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

### 2. Sign in with Apple

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

### 3. Sign in with Google

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

### 4. Render (hosting)

1. Push this repository to GitHub, for example `Batty-sk/squircle-server`.
2. On Render: **New → Blueprint**, pick the repository. Render reads `render.yaml`.
3. Fill in the values marked `sync: false`: `OWNER_EMAIL`, the Turso, Google and Apple values. Render generates `SESSION_SECRET`.
4. **Settings → Custom Domains → Add** `api.squircle.london`. Render shows a CNAME target (`squircle-server.onrender.com`).
   Add that CNAME record at your DNS provider. Render then issues the HTTPS certificate.
5. Open `https://api.squircle.london/health`. It should say `{"ok":true}`.

**About the free plan:** the server sleeps after 15 minutes without requests and takes about a minute to
wake. The Account and Admin pages say "Waking up…" while that happens, and the Newsroom shows its
loading state. Other pages are unaffected. Render's Starter plan keeps the server awake, which matters
once the Newsroom has readers.

### 5. Check it

- `https://squircle.london/account/`: sign up with Apple, then sign out and in with Google using the same email. Both appear under **Signs in with**.
- `https://squircle.london/admin/`: sign in as `OWNER_EMAIL`, edit a story and press **Update**. Reload the story on the Newsroom: the change is already there.

## Scripts

| | |
| --- | --- |
| `npm run dev` | Local server, restarted on change |
| `npm run build` · `npm start` | Compile, then run (what Render does) |
| `npm run admin:add -- email [editor\|owner]` | Invite someone to Admin |
| `npm run newsroom:import -- source.db` | Copy stories and images into `DATABASE_URL` |
