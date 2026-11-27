# Secret Macabi

A family gift-exchange site: organizers draw names and email each person their secret match, and everyone shares wish lists.

## Project structure

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css`, `config.js` | Admin site (GitHub Pages) |
| `wishlist.html` | Family wish lists, opened by a per-family link |
| `server.js` | Backend that builds and sends the emails (Render) |
| `apps-script/Code.gs` | Google Apps Script that sends mail from Gmail |
| `supabase/` | Database schema and numbered update files |
