require('dotenv').config();
require('dotenv').config({ path: 'local.env' });

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// Trim stray spaces/newlines/quotes that often sneak in when pasting into a dashboard.
const env = (key, fallback = '') => String(process.env[key] ?? fallback).trim().replace(/^["']|["']$/g, '').trim();
const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');
const APPS_SCRIPT_URL = env('APPS_SCRIPT_URL');
const APPS_SCRIPT_SECRET = env('APPS_SCRIPT_SECRET');
const SITE_URL = env('SITE_URL');
const ALLOWED_ORIGINS = env('ALLOWED_ORIGINS') || (SITE_URL ? new URL(SITE_URL).origin : '');
const PORT = env('PORT', '10000');
// Only these logged-in accounts may send email (from the site owner's Gmail).
// Empty = nobody can send, so a missing setting fails safe.
const APPROVED_SENDERS = new Set(env('APPROVED_SENDERS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const APPS_SCRIPT_URL_OK = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(APPS_SCRIPT_URL);
// Safe-to-show fingerprint of the URL (not secret) so setup problems can be spotted from /api/health.
const appsScriptHint = APPS_SCRIPT_URL ? APPS_SCRIPT_URL.slice(0, 40) + '…' + APPS_SCRIPT_URL.slice(-12) : '(missing)';

const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APPS_SCRIPT_URL', 'APPS_SCRIPT_SECRET', 'SITE_URL']
  .filter((key) => !env(key));
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

const NOT_APPROVED = 'Sending email isn\'t turned on for your account. Ask the site owner to approve your email address.';
const isApprovedSender = (user) => !!user?.email && APPROVED_SENDERS.has(user.email.toLowerCase());

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
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || text.slice(0, 80);
    console.error('Apps Script non-JSON reply', response.status, response.url, title);
    throw new Error(`Mail service returned an unexpected response (HTTP ${response.status}: "${title.trim()}"). ` +
      (APPS_SCRIPT_URL_OK ? 'Check the Apps Script deployment: Execute as "Me", access "Anyone".'
                          : 'APPS_SCRIPT_URL on Render doesn\'t look like https://script.google.com/macros/s/…/exec'));
  }
}

// ---------- email design (shared by every email) ----------
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

// The white card with "Secret Macabi" header and a quiet footer.
// `preview` is the hidden inbox-preview line; padding stops Gmail pulling body text into it.
function emailShell({ preview, inner, signoff, footer = "Remember, it's a secret 🤫" }) {
  const previewPad = '&#8204;&nbsp;'.repeat(120);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f4f1">
  <div style="display:none;font-size:1px;color:#f4f4f1;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(preview)}${previewPad}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f1">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
        <tr><td align="center" style="padding:0 0 20px;font:20px/1 ${SERIF};color:#2446c7">Secret Macabi</td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e4e4e0;border-radius:14px;padding:32px 32px 28px">
${inner}
        </td></tr>
        <tr><td align="center" style="padding:20px 8px 0;font:13px/1.6 ${FONT};color:#8a8e96">
          ${escapeHtml(footer)}${signoff ? `<br>${escapeHtml(signoff)}` : ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const emailText = (text, color = '#17191e', margin = '0 0 6px') =>
  `<p style="margin:${margin};font:15px/1.5 ${FONT};color:${color}">${text}</p>`;

function highlightBox(label, value) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1fc;border-radius:10px">
            <tr><td align="center" style="padding:22px 16px">
              <div style="font:600 12px/1 ${FONT};letter-spacing:1.5px;text-transform:uppercase;color:#2446c7">${escapeHtml(label)}</div>
              <div style="padding-top:10px;font:28px/1.2 ${SERIF};color:#17191e">${escapeHtml(value)}</div>
            </td></tr>
          </table>`;
}

function detailRows(family) {
  const row = (label, value) => value ? `
      <tr>
        <td style="padding:10px 0;border-top:1px solid #ececea;font:14px/1.4 ${FONT};color:#6b6f78">${label}</td>
        <td align="right" style="padding:10px 0;border-top:1px solid #ececea;font:600 14px/1.4 ${FONT};color:#17191e">${escapeHtml(value)}</td>
      </tr>` : '';
  const rows = row('Occasion', family.occasion) + row('Budget', family.budget);
  return rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">${rows}
      <tr><td colspan="2" style="border-top:1px solid #ececea;font-size:0;line-height:0">&nbsp;</td></tr>
    </table>` : '';
}

const giftLink = (url, label) =>
  `<p style="margin:24px 0 0;font:15px/1.5 ${FONT}">🎁&nbsp; <a href="${escapeHtml(url)}" style="color:#2446c7;font-weight:600;text-decoration:underline">${escapeHtml(label)}</a></p>`;

// Plain-text version for mail apps that don't show HTML; collapses repeated blank lines.
const plainText = (lines) => lines.filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n').trim();

// ---------- the assignment email ----------
function buildEmail(family, giver, receiver, wishlistUrl) {
  const subject = (family.email_subject || 'Your Secret Macabi match is here!').split('{name}').join(giver.name);
  const body = plainText([
    'Your Secret Macabi match is inside 🤫', '', '', '',
    `Hi ${giver.name},`, '',
    `You're giving a gift to: ${receiver.name}`,
    family.occasion ? `Occasion: ${family.occasion}` : '',
    family.budget ? `Budget: ${family.budget}` : '', '',
    `🎁 ${receiver.name}'s wishlist: ${wishlistUrl}`, '',
    "Remember, it's a secret!", family.signoff || ''
  ]);
  const html = emailShell({
    preview: 'Your Secret Macabi match is inside 🤫 Open to find out!',
    signoff: family.signoff,
    inner: emailText(`Hi ${escapeHtml(giver.name)},`) +
      emailText("The names have been drawn. Here's who you're shopping for.", '#6b6f78', '0 0 24px') +
      highlightBox('Your match', receiver.name) +
      detailRows(family) +
      giftLink(wishlistUrl, `See ${receiver.name}'s wishlist`)
  });
  return { subject, body, html };
}

// ---------- the heads-up email (sent before the draw) ----------
const WHEN_OPTIONS = { tomorrow: 'Tomorrow', '2days': 'In 2 days', '3days': 'In 3 days', nextweek: 'Next week' };

function buildHeadsUpEmail(family, person, whenKey, wishlistUrl) {
  const when = WHEN_OPTIONS[whenKey];
  const whenLower = when.toLowerCase();
  const subject = `The Secret Macabi drawing is ${whenLower}!`;
  const body = plainText([
    `Hi ${person.name},`, '',
    `Get ready! The Secret Macabi drawing is ${whenLower}.`,
    'Add a few gift ideas to your wishlist so your Secret Macabi knows what you love.', '',
    family.occasion ? `Occasion: ${family.occasion}` : '',
    family.budget ? `Budget: ${family.budget}` : '', '',
    `🎁 Your wishlist: ${wishlistUrl}`, '',
    family.signoff || ''
  ]);
  const html = emailShell({
    preview: `The drawing is ${whenLower}. Add to your wishlist before names are drawn 🎁`,
    signoff: family.signoff,
    footer: 'See you soon!',
    inner: emailText(`Hi ${escapeHtml(person.name)},`) +
      emailText('Get ready! Add a few gift ideas to your wishlist so your Secret Macabi knows what you love.', '#6b6f78', '0 0 24px') +
      highlightBox('The drawing is', when) +
      detailRows(family) +
      giftLink(wishlistUrl, 'Add to your wishlist')
  });
  return { subject, body, html };
}

// ---------- routes ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'secret-macabi-email',
    configured: missing.length === 0,
    missing,
    appsScriptUrl: appsScriptHint,
    appsScriptUrlLooksValid: APPS_SCRIPT_URL_OK,
    secretLength: APPS_SCRIPT_SECRET.length,
    approvedSenders: APPROVED_SENDERS.size
  });
});

// Send a test email to the logged-in admin themself.
app.post('/api/test-email', async (req, res) => {
  try {
    const auth = await userClient(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    if (!isApprovedSender(auth.user)) return res.status(403).json({ ok: false, error: NOT_APPROVED });
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
    if (!isApprovedSender(auth.user)) return res.status(403).json({ ok: false, error: NOT_APPROVED });
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

// Heads-up email to everyone taking part, sent before the draw.
// Body: { familyId: uuid, when: 'tomorrow' | '2days' | '3days' | 'nextweek' }
app.post('/api/send-heads-up', async (req, res) => {
  try {
    const auth = await userClient(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    if (!isApprovedSender(auth.user)) return res.status(403).json({ ok: false, error: NOT_APPROVED });
    const { sb, user } = auth;
    const { familyId, when } = req.body || {};
    if (!familyId || !WHEN_OPTIONS[when]) return res.status(400).json({ ok: false, error: 'Pick when the drawing is.' });

    // RLS: these only return rows if this user is an admin of the family.
    const { data: family, error: famError } = await sb.from('families')
      .select('id, name, budget, occasion, signoff, share_token').eq('id', familyId).maybeSingle();
    if (famError) throw famError;
    if (!family) return res.status(403).json({ ok: false, error: 'Family not found, or you are not an admin of it.' });

    const { data: people, error: peopleError } = await sb.from('members')
      .select('id, name, email').eq('family_id', familyId).eq('active', true);
    if (peopleError) throw peopleError;

    const results = [];
    const outgoing = [];
    for (const person of people) {
      if (!person.email) { results.push({ id: person.id, ok: false, error: `${person.name} has no email address.` }); continue; }
      const url = new URL('wishlist.html', SITE_URL);
      url.searchParams.set('f', family.share_token);
      url.searchParams.set('me', person.id);
      url.searchParams.set('open', person.id);
      outgoing.push({ id: person.id, to: person.email, ...buildHeadsUpEmail(family, person, when, url.toString()) });
    }
    if (!outgoing.length) return res.json({ ok: false, results, error: 'Nobody taking part has an email address.' });
    if (!withinRateLimit(user.id, outgoing.length)) {
      return res.status(429).json({ ok: false, error: 'Too many emails this hour. Try again later.' });
    }

    for (let i = 0; i < outgoing.length; i += 50) {
      const batch = outgoing.slice(i, i + 50);
      const result = await callMailer({ senderName: family.signoff || 'Secret Macabi', messages: batch });
      if (!result.ok) { batch.forEach((m) => results.push({ id: m.id, ok: false, error: result.error })); continue; }
      result.results.forEach((r) => results.push({ id: r.id, ok: r.ok, error: r.error }));
    }
    res.json({ ok: results.every((r) => r.ok), results });
  } catch (error) {
    console.error('send-heads-up failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'Email failed to send.' });
  }
});

// Start the server when run directly; allow tests/previews to import the email builders.
if (require.main === module) {
  app.listen(Number(PORT), () => {
    console.log(`Secret Macabi API listening on http://localhost:${PORT}`);
  });
}

module.exports = { buildEmail, buildHeadsUpEmail };

