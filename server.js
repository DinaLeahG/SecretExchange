require('dotenv').config();
require('dotenv').config({ path: 'local.env' });

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  APPS_SCRIPT_URL,
  APPS_SCRIPT_SECRET,
  SITE_URL = 'https://dinaleahg.github.io/SecretExchange/',
  ALLOWED_ORIGINS = 'https://dinaleahg.github.io',
  PORT = 10000
} = process.env;

const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APPS_SCRIPT_URL', 'APPS_SCRIPT_SECRET']
  .filter((key) => !process.env[key]);
if (missing.length) console.warn('⚠️  Missing environment variables:', missing.join(', '));

const app = express();
app.use(express.json({ limit: '100kb' }));

// ---------- CORS: only our own site may call this API from a browser ----------
const allowedOrigins = new Set(ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- helpers ----------
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Simple per-user limit so a stolen login can't be used to blast email.
const sendLog = new Map();
function withinRateLimit(userId, count, maxPerHour = 150) {
  const hourAgo = Date.now() - 3600_000;
  const recent = (sendLog.get(userId) || []).filter((t) => t > hourAgo);
  if (recent.length + count > maxPerHour) return false;
  sendLog.set(userId, recent.concat(Array(count).fill(Date.now())));
  return true;
}

// A Supabase client that acts AS the logged-in user, so database security rules apply.
async function userClient(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return { sb, user: data.user };
}

async function callMailer(payload) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, ...payload }),
    redirect: 'follow'
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Mail service returned an unexpected response. Check the Apps Script deployment (access must be "Anyone").');
  }
}

function buildEmail(family, giver, receiver, wishlistUrl) {
  const subject = (family.email_subject || 'Your Secret Macabi assignment').split('{name}').join(giver.name);
  const body = [
    `Hi ${giver.name},`,
    '',
    `You have been assigned ${receiver.name} for the ${family.occasion || 'party'}. ` +
      `Please remember the gift budget is ${family.budget || '$10'}.`,
    '',
    `See ${receiver.name}'s wish list and add your own: ${wishlistUrl}`,
    '',
    'Enjoy!',
    '',
    family.signoff || 'The Party Team'
  ].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2439">
      <p>Hi ${escapeHtml(giver.name)},</p>
      <p>You have been assigned <strong style="font-size:18px">${escapeHtml(receiver.name)}</strong>
         for the ${escapeHtml(family.occasion || 'party')}.<br>
         Please remember the gift budget is <strong>${escapeHtml(family.budget || '$10')}</strong>.</p>
      <p><a href="${escapeHtml(wishlistUrl)}" style="display:inline-block;background:#214ec2;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">
         See ${escapeHtml(receiver.name)}'s wish list</a></p>
      <p>Enjoy!<br>${escapeHtml(family.signoff || 'The Party Team')}</p>
    </div>`;
  return { subject, body, html };
}

// ---------- routes ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'secret-macabi-email', configured: missing.length === 0 });
});

// Send a test email to the logged-in admin themself.
app.post('/api/test-email', async (req, res) => {
  try {
    const auth = await userClient(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    if (!withinRateLimit(auth.user.id, 1)) return res.status(429).json({ ok: false, error: 'Too many emails this hour.' });

    const result = await callMailer({
      senderName: 'Secret Macabi',
      messages: [{
        id: 'test',
        to: auth.user.email,
        subject: 'Secret Macabi test email ✅',
        body: 'If you can read this, email sending is working.'
      }]
    });
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
    const first = result.results?.[0];
    if (!first?.ok) return res.status(502).json({ ok: false, error: first?.error || 'Send failed' });
    res.json({ ok: true, to: auth.user.email, remainingToday: result.remaining });
  } catch (error) {
    console.error('test-email failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Send assignment emails for a saved draw.
// Body: { drawId: uuid, assignmentIds?: uuid[], resend?: boolean }
app.post('/api/send-assignments', async (req, res) => {
  try {
    const auth = await userClient(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    const { sb, user } = auth;
    const { drawId, assignmentIds, resend } = req.body || {};
    if (!drawId) return res.status(400).json({ ok: false, error: 'drawId is required.' });

    // RLS guarantees these queries only return rows for families this user administers.
    const { data: draw, error: drawError } = await sb
      .from('draws')
      .select('id, family_id, families(name, budget, occasion, signoff, email_subject, share_token)')
      .eq('id', drawId)
      .maybeSingle();
    if (drawError) throw drawError;
    if (!draw) return res.status(403).json({ ok: false, error: 'Draw not found, or you are not an admin of this family.' });

    let query = sb
      .from('assignments')
      .select('id, sent_at, giver_id, receiver_id, giver:members!assignments_giver_fkey(name, email), receiver:members!assignments_receiver_fkey(name)')
      .eq('draw_id', drawId);
    if (Array.isArray(assignmentIds) && assignmentIds.length) query = query.in('id', assignmentIds);
    const { data: rows, error: rowsError } = await query;
    if (rowsError) throw rowsError;

    const family = draw.families;
    const results = [];
    const outgoing = [];

    for (const row of rows) {
      if (row.sent_at && !resend) {
        results.push({ id: row.id, ok: true, skipped: 'already sent' });
      } else if (!row.giver?.email) {
        results.push({ id: row.id, ok: false, error: `${row.giver?.name || 'This person'} has no email address.` });
      } else {
        const url = new URL('wishlist.html', SITE_URL);
        url.searchParams.set('f', family.share_token);
        url.searchParams.set('me', row.giver_id);
        url.searchParams.set('open', row.receiver_id);
        outgoing.push({ id: row.id, to: row.giver.email, ...buildEmail(family, row.giver, row.receiver, url.toString()) });
      }
    }

    if (outgoing.length) {
      if (!withinRateLimit(user.id, outgoing.length)) {
        return res.status(429).json({ ok: false, error: 'Too many emails this hour. Try again later.' });
      }
      for (let i = 0; i < outgoing.length; i += 50) {
        const batch = outgoing.slice(i, i + 50);
        const result = await callMailer({ senderName: family.signoff || 'Secret Macabi', messages: batch });
        if (!result.ok) {
          batch.forEach((m) => results.push({ id: m.id, ok: false, error: result.error }));
          continue;
        }
        const sentIds = result.results.filter((r) => r.ok).map((r) => r.id);
        if (sentIds.length) {
          const { error: markError } = await sb.from('assignments').update({ sent_at: new Date().toISOString() }).in('id', sentIds);
          if (markError) console.error('Could not mark sent:', markError);
        }
        result.results.forEach((r) => results.push({ id: r.id, ok: r.ok, error: r.error }));
      }
    }

    res.json({ ok: results.every((r) => r.ok), results });
  } catch (error) {
    console.error('send-assignments failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'Email failed to send.' });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Secret Macabi API listening on http://localhost:${PORT}`);
});
