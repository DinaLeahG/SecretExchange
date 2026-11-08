# Secret Macabi Draw

A static GitHub Pages site for running a Secret Macabi exchange.

## Included
- Draw names while preventing self-pairs and last-year matches
- Separate adult/kid pools
- Save data in the browser using localStorage
- Public wish list page
- Email flow via Formspree or mailto fallback

## Deploy to GitHub Pages
1. Push the contents of this folder to a GitHub repository.
2. Open GitHub repo settings.
3. Go to Pages.
4. Set the source to the default branch (or the folder you prefer).
5. Save and wait for the deployment to finish.

Your site will be available at:
`https://<your-github-username>.github.io/<repo-name>/`

## Configure email sending
The GitHub Pages site cannot send email by itself. The app needs a small backend endpoint to send via Gmail SMTP.

1. Copy `.env.example` to `.env`
2. Fill in your Gmail address and a Gmail App Password
3. Start the backend locally:

```bash
npm install
cp .env.example .env
npm start
```

4. Update `config.js` to point at your backend URL:

```js
window.SECRET_MACABI_CONFIG = {
  siteUrl: "https://your-github-username.github.io/secret-macabi-draw/",
  emailEndpoint: "http://localhost:3001/api/send-email",
  wishlistPage: "wishlist.html"
};
```

For production, deploy the backend to Render, Railway, Fly.io, or another Node host and use that URL instead.

If `emailEndpoint` is blank, the app falls back to a mailto link so the user can send the email from their own mail app.

## Gmail setup
- Turn on 2-Step Verification on the Gmail account
- Generate an App Password
- Use that app password in `GMAIL_APP_PASSWORD`, not your normal Gmail password

## Hooking it up to the frontend
The draw app already calls the configured endpoint in `site.js`:

```js
fetch(config.emailEndpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});
```

Your production backend URL should replace the placeholder in `config.js`.

## Wish list
Users can open the wish list page from the nav or through the draw app. Each wish list is stored by person name, and each person can have multiple items on their list.

Example:
`https://your-site.github.io/secret-macabi-draw/wishlist.html?event=Chanukah%20Party&person=Dina`
