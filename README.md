# Secret Macabi

A family gift-exchange site: organizers draw names and email each person their secret match, and everyone shares wish lists.

```
GitHub Pages (index.html, wishlist.html)
   │  login + data ─────────────▶ Supabase (Postgres + Auth, Row Level Security)
   │  "send emails" ─▶ Render (server.js) ─ checks you're an admin ─▶ Google Apps Script ─▶ your Gmail
```

| Piece | What it holds | Secrets |
|---|---|---|
| `index.html` + `app.js` | Admin app: families, people, draw, send, admins | none (anon key is public by design) |
| `wishlist.html` | Family wish lists, opened by a private per-family link | none |
| `supabase/schema.sql` | Tables, security rules, functions | — |
| `server.js` (Render) | Builds emails from the database and sends them | Apps Script URL + secret |
| `apps-script/Code.gs` | Sends mail from your Gmail (send-only permission) | secret in Script Properties |

---

## One-time setup

### 1. Supabase (database + logins)
1. Supabase dashboard → **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
   It creates: `families`, `family_admins`, `members`, `draws`, `assignments`, `wishlist_items`.
   ⚠️ Only run `schema.sql` on a brand-new database: it deletes and recreates the tables.
   For an existing database, run the numbered update files (e.g. `supabase/002_blank_defaults.sql`) instead.
   (Any tables you made earlier with other names are untouched. Delete them in Table Editor if unused.)
2. **Authentication → Sign In / Providers → Email**: keep Email enabled.
   Free Supabase can only send confirmation emails to your own team, so either:
   - turn **Confirm email** OFF (simplest), or
   - keep it on and set **Authentication → Emails → SMTP Settings** to Gmail:
     host `smtp.gmail.com`, port `465`, user = your Gmail, password = your Gmail App Password.
     (This also makes "Forgot password" work.)
3. **Authentication → URL Configuration**: Site URL = `https://dinaleahg.github.io/SecretExchange/`.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key (or the newer **publishable** key `sb_publishable_…`; either works).
   Never copy the `service_role` key anywhere; this project doesn't need it.

### 2. Google Apps Script (email)
1. Go to <https://script.google.com> → **New project** → name it "Secret Macabi Mailer".
2. Replace everything in `Code.gs` with `apps-script/Code.gs` from this repo. Save.
3. ⚙️ **Project Settings → Script Properties → Add**: name `SHARED_SECRET`, value = the
   `APPS_SCRIPT_SECRET` line from your local `local.env` file.
4. In the editor choose the `authorize` function → **▶ Run** → approve.
   Google will say "Google hasn't verified this app" because it's your own private script:
   **Advanced → Go to Secret Macabi Mailer**. The only permission is "Send email as you".
5. **Deploy → New deployment** → type **Web app** → Execute as **Me** → Who has access **Anyone** → Deploy.
   Copy the **Web app URL** (ends in `/exec`). "Anyone" just means it can be reached; without the secret it refuses.

If you edit the script later: **Deploy → Manage deployments → ✏️ → Version: New version**, or changes won't go live.

### 3. Render (backend)
Service → **Environment** → set:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1.4 |
| `SUPABASE_ANON_KEY` | anon public key from step 1.4 |
| `APPS_SCRIPT_URL` | Web app URL from step 2.5 |
| `APPS_SCRIPT_SECRET` | same secret as step 2.3 |
| `SITE_URL` | `https://dinaleahg.github.io/SecretExchange/` |
| `ALLOWED_ORIGINS` | `https://dinaleahg.github.io` |

Delete the old `RESEND_API_KEY`, `FROM_EMAIL`, `GMAIL_*` variables. Build command `npm install`, start command `npm start`.
Check `https://secretexchange.onrender.com/api/health` shows `"configured": true`.

### 4. The site
Edit `config.js` with the Project URL and anon key, commit, and push. GitHub Pages redeploys.

### 5. Try it
1. Open the site → **Create account** → sign in → create your family.
2. Step 4 → **Send me a test email**.
3. Add people (or import `people.txt` in Step 2) → Draw → Save → Send.

---

## How security works
- **Admins** sign in with Supabase Auth. Database Row Level Security means an admin only ever sees families they're listed on in `family_admins`. Owners add other admins by email (the person signs up first).
- **Wish lists** are reached through a secret per-family link (`wishlist.html?f=…`). The link only allows viewing and adding wish-list items: no emails, no draw results. "Make a new link" in Step 4 revokes the old one. People can delete only the items they added from that browser.
- **Email**: the browser never sends email text. It asks Render to "send draw X". Render checks the login with Supabase and builds the emails from the database. Then it calls Apps Script with the shared secret. It's limited to 150 emails/hour per admin, and Gmail allows about 100 recipients per day.
- Keep `local.env`, `people.txt`, `admin.key`, and `admin.jwt` out of git (they're in `.gitignore`).

## Local development
```bash
npm install
cp .env.example local.env   # fill in values
npm start                   # API on http://localhost:10000
python3 -m http.server 8000 # site on http://localhost:8000
```
For local testing, set `apiBase` in `config.js` to `http://localhost:10000`.
