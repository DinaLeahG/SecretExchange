require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json({ limit: '1mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowed = !origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin);

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

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user,
      pass
    }
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'secret-macabi-email' });
});

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body, name, wishlistUrl } = req.body || {};

    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: 'Missing to, subject, or body.' });
    }

    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: [
        body,
        '',
        wishlistUrl ? `Wishlist: ${wishlistUrl}` : '',
        name ? `Sent for: ${name}` : ''
      ].filter(Boolean).join('\n')
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error('Email send failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Email failed to send.' });
  }
});

app.listen(port, () => {
  console.log(`Secret Macabi email API listening on http://localhost:${port}`);
});
