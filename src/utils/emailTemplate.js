'use strict';

/**
 * Cold outreach email template generator.
 * Pure function — no I/O, easy to test and swap.
 */

/** Escape user-provided values before embedding in HTML. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First name from a full name, fallback to "there". */
function firstNameOf(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first || 'there';
}

/**
 * Build a personalized cold email.
 * @param {object} contact { fullName, companyName, title, email }
 * @returns {{ subject: string, htmlContent: string }}
 */
function generateColdEmail(contact = {}) {
  const firstName = escapeHtml(firstNameOf(contact.fullName));
  const company = escapeHtml(contact.companyName || 'your team');
  const title = escapeHtml(contact.title || '');

  const subject = `Quick idea for ${contact.companyName || 'your team'}`;

  const roleLine = title
    ? `As ${title} at ${company}, you're likely focused on scaling what works.`
    : `I imagine the team at ${company} is focused on scaling what works.`;

  const htmlContent = `<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; font-size: 15px; color: #222; line-height: 1.5;">
    <p>Hi ${firstName},</p>
    <p>${roleLine}</p>
    <p>
      We help teams like ${company} automate their outbound pipeline end-to-end —
      from finding lookalike accounts to reaching the right decision makers with
      verified contact data.
    </p>
    <p>Open to a quick 15-minute chat next week?</p>
    <p>Best,<br/>The Outreach Team</p>
  </body>
</html>`;

  return { subject, htmlContent };
}

module.exports = { generateColdEmail, escapeHtml, firstNameOf };
