require('dotenv').config();
require('dotenv').config({ path: 'local.env' });

const express = require('express');
const { Resend } = require('resend');

const app = express();
const port = Number(process.env.PORT || 10000);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json({ limit: '1mb' }));

const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isGitHubPagesOrigin = (origin) => /^https?:\/\/([a-zA-Z0-9-]+\.)?github\.io(?::\d+)?$/.test(origin || '');
const allowedOrigins = new Set(configuredOrigins);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowed = !origin || allowedOrigins.has(origin) || isGitHubPagesOrigin(origin);

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'secret-macabi-email' });
});

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body, name, wishlistUrl } = req.body || {};

    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: 'Missing to, subject, or body.' });
    }

    if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
      return res.status(500).json({ ok: false, error: 'Missing RESEND_API_KEY or FROM_EMAIL.' });
    }

    const safeBody = String(body || '').replace(/\r\n/g, '\n');
    const html = `
      <p>Hi ${name || 'there'},</p>
      <p>${safeBody.replace(/\n/g, '<br>')}</p>
      ${wishlistUrl ? `<p>Wishlist: <a href="${wishlistUrl}">${wishlistUrl}</a></p>` : ''}
    `;

    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      text: safeBody,
      html
    });

    return res.json({ ok: true, id: result?.data?.id || null });
  } catch (error) {
    console.error('Email send failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Email failed to send.' });
  }
});

app.listen(port, () => {
  console.log(`Secret Macabi email API listening on http://localhost:${port}`);
});
