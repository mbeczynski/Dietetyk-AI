const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');
const { sendMailgunEmail } = require('../services/mailgun');

router.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM app_config`);
    const config = {};
    rows.forEach(r => {
      if (r.key.startsWith('mailgun_') || r.key === 'app_url' || r.key === 'force_2fa') {
        if (r.key === 'mailgun_api_key' && r.value) {
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
      if (key === 'mailgun_api_key' && val === '********') {
        continue;
      }
      if (!key.startsWith('mailgun_') && key !== 'app_url' && key !== 'force_2fa') {
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
  const { email, role } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Adres e-mail jest wymagany.' });
  }

  const roleToUse = role === 'admin' ? 'admin' : 'user';

  try {
    const existing = await db.get(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) {
      return res.status(400).json({ error: 'Użytkownik o tym adresie e-mail już istnieje.' });
    }

    const token = 'inv_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const tempUsername = 'pending_' + Math.random().toString(36).substring(2, 8);
    const dummyPassword = await bcrypt.hash(Math.random().toString(36), 10);
    const syncToken = 'sync_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

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
