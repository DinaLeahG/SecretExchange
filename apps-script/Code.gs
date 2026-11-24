/**
 * Secret Macabi — Gmail sender (Google Apps Script)
 *
 * What it does: receives a list of emails from YOUR Render backend and sends
 * them from your Gmail with MailApp. MailApp can only SEND mail; it cannot
 * read, search, or delete anything in your inbox.
 *
 * Who can use it: only callers that know SHARED_SECRET, which is stored in
 * Project Settings → Script Properties (never in this code).
 */

var MAX_MESSAGES_PER_CALL = 60;
var EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function doPost(e) {
  try {
    var request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');

    if (!secret || secret.length < 32 || request.secret !== secret) {
      return reply({ ok: false, error: 'unauthorized' });
    }

    if (request.action === 'quota') {
      return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
    }

    var messages = request.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES_PER_CALL) {
      return reply({ ok: false, error: 'Send between 1 and ' + MAX_MESSAGES_PER_CALL + ' messages per call.' });
    }

    var remaining = MailApp.getRemainingDailyQuota();
    if (remaining < messages.length) {
      return reply({ ok: false, error: 'Gmail daily limit reached (' + remaining + ' left today). Try again tomorrow.', remaining: remaining });
    }

    var senderName = String(request.senderName || 'Secret Macabi').slice(0, 60);
    var results = messages.map(function (m) {
      var to = String(m.to || '').trim();
      try {
        if (!EMAIL_PATTERN.test(to)) throw new Error('Invalid email address');
        MailApp.sendEmail({
          to: to,
          subject: String(m.subject || '').slice(0, 250),
          body: String(m.body || '').slice(0, 20000),
          htmlBody: m.html ? String(m.html).slice(0, 50000) : undefined,
          name: senderName
        });
        return { id: m.id, ok: true };
      } catch (err) {
        return { id: m.id, ok: false, error: String(err && err.message || err) };
      }
    });

    return reply({ ok: true, results: results, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: 'Bad request: ' + String(err && err.message || err) });
  }
}

// Visiting the web app URL in a browser just shows that it's alive. It sends nothing.
function doGet() {
  return reply({ ok: true, service: 'secret-macabi-mailer' });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor (▶ Run) to grant the "send email as you" permission. */
function authorize() {
  Logger.log('Emails you can still send today: ' + MailApp.getRemainingDailyQuota());
}
