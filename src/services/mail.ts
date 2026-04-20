import nodemailer from 'nodemailer';
import { config } from '../config';
import { logger } from '../logger';

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.password,
  },
});

/**
 * Sends a password-reset e-mail containing a deep-link the user can tap in
 * the Watchd iOS app (watchd://reset-password?token=…).
 */
export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
  // Universal Link — iOS intercepts this and opens the app directly when installed.
  // Falls back to the /reset-password HTML page when the app is absent.
  const deepLink = `${config.appUrl}/reset-password?token=${resetToken}`;

  const html = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#141414;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#141414;padding:40px 20px;">
    <tr><td align="center">
      <table width="500" cellpadding="0" cellspacing="0" style="background-color:#1e1e1e;border-radius:12px;padding:40px;">
        <tr><td align="center" style="padding-bottom:24px;">
          <h1 style="color:#E50914;font-size:28px;font-weight:bold;margin:0;">WATCHD</h1>
        </td></tr>
        <tr><td style="color:#ffffff;font-size:16px;line-height:24px;padding-bottom:24px;">
          <p style="margin:0 0 16px;">Hallo,</p>
          <p style="margin:0 0 16px;">du hast eine Passwort-Zurücksetzung für dein Watchd-Konto angefordert.</p>
          <p style="margin:0 0 16px;">Tippe auf den folgenden Button, um ein neues Passwort zu setzen. Der Link ist <strong>1 Stunde</strong> gültig.</p>
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px;">
          <a href="${deepLink}" style="display:inline-block;background-color:#E50914;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;">
            Passwort zurücksetzen
          </a>
        </td></tr>
        <tr><td style="color:#888888;font-size:13px;line-height:20px;">
          <p style="margin:0 0 8px;">Falls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail einfach.</p>
          <p style="margin:0;color:#555555;font-size:12px;">© ${new Date().getFullYear()} Watchd</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Watchd – Passwort zurücksetzen',
    '',
    'Du hast eine Passwort-Zurücksetzung angefordert.',
    'Tippe auf den Link, um ihn in der Watchd-App zu öffnen:',
    '',
    deepLink,
    '',
    'Der Link ist 1 Stunde gültig.',
    'Falls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.',
  ].join('\n');

  // In development without SMTP config, log instead of sending
  if (!config.smtp.host) {
    logger.info({ to, deepLink }, 'SMTP not configured – password reset link (dev only)');
    return;
  }

  try {
    await transporter.sendMail({
      from: config.smtp.from,
      to,
      subject: 'Watchd – Passwort zurücksetzen',
      text,
      html,
    });
    logger.info({ to }, 'Password reset email sent');
  } catch (err) {
    logger.error({ err, to }, 'Failed to send password reset email');
    throw err;
  }
}
