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
Update `config.js` with your Formspree endpoint if you want the app to send emails through a real backend.

```js
window.SECRET_MACABI_CONFIG = {
  siteUrl: "https://your-github-username.github.io/secret-macabi-draw/",
  emailEndpoint: "https://formspree.io/f/your-form-id",
  wishlistPage: "wishlist.html"
};
```

If `emailEndpoint` is blank, the app falls back to a mailto link so the user can send the email from their own mail app.

## Wish list
Users can open the wish list page from the nav or through the draw app. The page supports adding items locally in the browser and has an optional event name in the query string.

Example:
`https://your-site.github.io/secret-macabi-draw/wishlist.html?event=Chanukah%20Party`
