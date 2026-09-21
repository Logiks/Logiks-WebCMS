const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const layout = (siteName, bodyHtml) =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f4f2;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c2b2f">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #dde3e1;border-radius:6px;padding:28px">
<div style="font-weight:600;font-size:18px;margin-bottom:16px">${esc(siteName)}</div>${bodyHtml}
</div></body></html>`;

const button = (href, label) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#2b59c3;color:#fff;text-decoration:none;padding:10px 18px;border-radius:5px;display:inline-block">${esc(label)}</a></p>`;

/**
 * Each template returns { subject, text, html }. Every interpolated value is escaped.
 * Add new templates here; callers use mailer.sendTemplate(to, name, data).
 */
export const templates = {
  'password-reset': ({ siteName, name, link, minutes }) => ({
    subject: `Reset your ${siteName} password`,
    text: `Hi ${name},\n\nSomeone asked to reset the password for your ${siteName} account. Open this link to choose a new one (it works once and expires in ${minutes} minutes):\n\n${link}\n\nIf this wasn't you, ignore this email. Your password stays the same.`,
    html: layout(
      siteName,
      `<p>Hi ${esc(name)},</p><p>Someone asked to reset the password for your account. The link below works once and expires in ${esc(minutes)} minutes.</p>${button(link, 'Choose a new password')}<p style="color:#5d7076;font-size:13px">If the button doesn't work, paste this address into your browser:<br>${esc(link)}</p><p style="color:#5d7076;font-size:13px">If this wasn't you, ignore this email. Your password stays the same.</p>`,
    ),
  }),

  'user-invite': ({ siteName, name, link, hours, invitedBy }) => ({
    subject: `You've been invited to ${siteName}`,
    text: `Hi ${name},\n\n${invitedBy ? `${invitedBy} invited` : 'You have been invited'} you to the ${siteName} admin. Open this link to choose your password (it works once and expires in ${hours} hours):\n\n${link}\n\nIf you weren't expecting this, ignore this email. No account access is possible until a password is chosen.`,
    html: layout(
      siteName,
      `<p>Hi ${esc(name)},</p><p>${invitedBy ? `${esc(invitedBy)} invited` : 'You have been invited'} you to the admin. The link below works once and expires in ${esc(hours)} hours.</p>${button(link, 'Choose your password')}<p style="color:#5d7076;font-size:13px">If the button doesn't work, paste this address into your browser:<br>${esc(link)}</p><p style="color:#5d7076;font-size:13px">If you weren't expecting this, ignore this email.</p>`,
    ),
  }),

  'password-changed': ({ siteName, name, when }) => ({
    subject: `Your ${siteName} password was changed`,
    text: `Hi ${name},\n\nThe password for your ${siteName} account was changed on ${when}. All your other sessions were signed out.\n\nIf this wasn't you, contact an administrator straight away.`,
    html: layout(
      siteName,
      `<p>Hi ${esc(name)},</p><p>The password for your account was changed on ${esc(when)}. All your other sessions were signed out.</p><p>If this wasn't you, contact an administrator straight away.</p>`,
    ),
  }),

  'contact-message': ({ siteName, name, email, message, page }) => ({
    subject: `New message on ${siteName}`,
    text: `${name} <${email}> wrote${page ? ` from ${page}` : ''}:\n\n${message}\n\nReply to this email to answer them.`,
    html: layout(
      siteName,
      `<p><strong>${esc(name)}</strong> (${esc(email)}) wrote${page ? ` from ${esc(page)}` : ''}:</p><blockquote style="margin:16px 0;padding-left:12px;border-left:3px solid #dde3e1;white-space:pre-wrap">${esc(message)}</blockquote><p style="color:#5d7076;font-size:13px">Reply to this email to answer them.</p>`,
    ),
  }),

  test: ({ siteName }) => ({
    subject: `Test email from ${siteName}`,
    text: `This is a test email from ${siteName}. Your email settings work.`,
    html: layout(siteName, `<p>This is a test email. Your email settings work.</p>`),
  }),
};

export function render(name, data) {
  const t = templates[name];
  if (!t) throw new Error(`Unknown email template "${name}"`);
  return t(data);
}
