const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAdmin } = require('../middleware/auth');
const { sendMailgunEmail } = require('../services/mailgun');

// Klucze logowania Google - globalne dla całej aplikacji (w przeciwieństwie do Oura/Withings,
// logowanie Google dotyczy uwierzytelnienia do samej aplikacji, więc konfiguruje je raz admin).
const GOOGLE_CONFIG_KEYS = ['google_client_id', 'google_client_secret'];

router.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM app_config`);
    const config = {};
    rows.forEach(r => {
      if (r.key.startsWith('mailgun_') || r.key === 'app_url' || r.key === 'force_2fa' || GOOGLE_CONFIG_KEYS.includes(r.key)) {
        if ((r.key === 'mailgun_api_key' || r.key === 'google_client_secret') && r.value) {
          config[r.key] = '********';
        } else {
          config[r.key] = r.value;
        }
      }
    });
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania konfiguracji.' });
  }
});

router.post('/api/admin/config', requireAdmin, async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, val] of Object.entries(settings)) {
      if ((key === 'mailgun_api_key' || key === 'google_client_secret') && val === '********') {
        continue;
      }
      if (!key.startsWith('mailgun_') && key !== 'app_url' && key !== 'force_2fa' && !GOOGLE_CONFIG_KEYS.includes(key)) {
        continue;
      }
      await db.run(`
        INSERT INTO app_config (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, [key, String(val)]);
    }
    res.json({ success: true, message: 'Konfiguracja została zapisana pomyślnie!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu konfiguracji.' });
  }
});

// 6h. Zarządzanie użytkownikami (Admin)
router.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, username, email, role, status, totp_enabled, force_password_change, force_2fa 
      FROM users
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania listy użytkowników.' });
  }
});

router.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'Nie możesz usunąć własnego konta administratora.' });
  }

  try {
    await db.run(`DELETE FROM users WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Użytkownik został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania użytkownika.' });
  }
});

router.post('/api/admin/users/:id/reset-2fa', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, force_2fa = 0 WHERE id = ?`, [id]);
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    res.json({ success: true, message: 'Zabezpieczenie 2FA zostało zresetowane i cofnięto wymuszenie.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd resetowania 2FA.' });
  }
});

router.post('/api/admin/users/:id/force-2fa', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.run(`UPDATE users SET force_2fa = 1 WHERE id = ?`, [id]);
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    res.json({ success: true, message: 'Wymuszono 2FA dla użytkownika przy kolejnym logowaniu.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wymuszania 2FA.' });
  }
});

router.post('/api/admin/users/:id/force-password-change', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.run(`UPDATE users SET force_password_change = 1 WHERE id = ?`, [id]);
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    res.json({ success: true, message: 'Wymuszono zmianę hasła na użytkowniku.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wymuszania zmiany hasła.' });
  }
});

router.post('/api/admin/invite', requireAdmin, async (req, res) => {
  const { email, role, confirm_admin } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Adres e-mail jest wymagany.' });
  }

  // Wymuszenie wprost dodatkowego potwierdzenia (confirm_admin: true) przy roli admin -
  // zabezpieczenie przed przypadkowym utworzeniem konta z uprawnieniami administratora
  // przez błąd UI (np. domyślnie zaznaczony select) lub błędną integrację wysyłającą
  // żądanie automatycznie.
  if (role === 'admin' && confirm_admin !== true) {
    return res.status(400).json({ error: 'Tworzenie konta z rolą administratora wymaga potwierdzenia (confirm_admin: true).' });
  }

  const roleToUse = role === 'admin' ? 'admin' : 'user';

  try {
    const existing = await db.get(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) {
      return res.status(400).json({ error: 'Użytkownik o tym adresie e-mail już istnieje.' });
    }

    // invitation_token jest jedyną rzeczą stojącą między e-mailem zaproszenia
    // a utworzeniem konta (potencjalnie z rolą admin) - musi być nieprzewidywalny.
    const token = 'inv_' + crypto.randomBytes(24).toString('hex');
    const tempUsername = 'pending_' + crypto.randomBytes(6).toString('hex');
    const dummyPassword = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const syncToken = 'sync_' + crypto.randomBytes(24).toString('hex');

    await db.run(`
      INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, invitation_token)
      VALUES (?, ?, ?, 0, ?, ?, 'pending', ?)
    `, [tempUsername, dummyPassword, syncToken, email, roleToUse, token]);

    const origin = req.headers.referer || req.headers.origin || `http://${req.headers.host}`;
    const registrationLink = `${origin}/register?token=${token}`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.05);">
        <h2 style="color: #38bdf8; text-align: center;">Zaproszenie do Dietetyk AI</h2>
        <p>Witaj,</p>
        <p>Zostałeś zaproszony do utworzenia konta w aplikacji <strong>Dietetyk AI</strong>.</p>
        <p>Kliknij poniższy przycisk, aby dokończyć rejestrację, wybrać swoją nazwę użytkownika, hasło i skonfigurować weryfikację 2FA:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${registrationLink}" style="background-color: #38bdf8; color: #0f172a; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 1rem;">Dokończ Rejestrację</a>
        </div>
        <p style="font-size: 0.85rem; color: #64748b; text-align: center;">
          Jeśli przycisk nie działa, skopiuj i wklej ten odnośnik w przeglądarce:<br/>
          <a href="${registrationLink}" style="color: #38bdf8;">${registrationLink}</a>
        </p>
      </div>
    `;

    console.log(`[MAILGUN] Wysyłanie zaproszenia do ${email}...`);
    await sendMailgunEmail({
      to: email,
      subject: 'Dietetyk AI - Zaproszenie do rejestracji',
      html: emailHtml
    });

    res.json({ success: true, message: 'Zaproszenie zostało wysłane pomyślnie.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapraszania użytkownika: ' + err.message });
  }
});

module.exports = router;
