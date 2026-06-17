const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const loginAttempts = require('../services/loginAttempts');

router.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }

  const lockedMs = loginAttempts.isLocked(req.ip, username);
  if (lockedMs > 0) {
    return res.status(429).json({
      error: `Za dużo nieudanych prób logowania. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
    });
  }

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!user) {
      loginAttempts.recordFailure(req.ip, username);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      loginAttempts.recordFailure(req.ip, username);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    loginAttempts.recordSuccess(req.ip, username);

    // Sprawdź czy wymuszona jest zmiana hasła
    if (user.force_password_change === 1) {
      const tempToken = 'temp_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

      await db.run(`
        INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
        VALUES (?, ?, ?, 0)
      `, [tempToken, user.id, expiresAt]);

      return res.json({
        status: 'force_password_change',
        tempToken: tempToken
      });
    }

    if (user.totp_enabled === 1) {
      // Generowanie tymczasowego tokenu (ważnego 5 minut)
      const tempToken = 'temp_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

      await db.run(`
        INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
        VALUES (?, ?, ?, 0)
      `, [tempToken, user.id, expiresAt]);

      return res.json({
        status: 'require_2fa',
        tempToken: tempToken
      });
    } else if (user.username !== 'admin') {
      const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
      const isForce2faEnabled = force2faRow && force2faRow.value === '1';
      const isUserForce2fa = user.force_2fa === 1;

      if (isForce2faEnabled || isUserForce2fa) {
        // Sprawdź wiek konta w UTC (tylko dla globalnego wymuszenia, dla indywidualnego wymuszamy natychmiast!)
        const userCreated = user.created_at ? new Date(user.created_at + 'Z') : new Date();
        const hoursSinceCreation = (Date.now() - userCreated.getTime()) / (1000 * 60 * 60);

        if (isUserForce2fa || hoursSinceCreation > 24) {
          // Wymuszamy setup 2FA przy logowaniu
          const secret = user.totp_secret || authenticator.generateSecret();
          if (!user.totp_secret) {
            await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, user.id]);
          }

          const tempToken = 'temp_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

          await db.run(`
            INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
            VALUES (?, ?, ?, 0)
          `, [tempToken, user.id, expiresAt]);

          const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
          const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

          return res.json({
            status: 'setup_2fa',
            tempToken: tempToken,
            qrCode: qrCodeDataUrl,
            secret: secret
          });
        }
      }

      // Logowanie bezpośrednie bez 2FA (wymuszenie wyłączone lub konto młodsze niż 24h)
      const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

      await db.run(`
        INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
        VALUES (?, ?, ?, 0)
      `, [permanentToken, user.id, expiresAt]);

      return res.json({
        token: permanentToken
      });
    } else {
      // Bezpośrednie generowanie stałego tokenu sesji dla testowego konta admina (MFA wyłączone)
      const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

      await db.run(`
        INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
        VALUES (?, ?, ?, 0)
      `, [permanentToken, user.id, expiresAt]);

      return res.json({
        token: permanentToken
      });
    }
  } catch (err) {
    console.error('Błąd logowania:', err);
    res.status(500).json({ error: 'Błąd logowania serwera.' });
  }
});

// Endpoint weryfikacji konfiguracji 2FA - Krok 2a
router.post('/api/verify-2fa-setup', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Tymczasowy token i kod są wymagane.' });
  }

  const lockedMs = loginAttempts.isLocked(req.ip, tempToken);
  if (lockedMs > 0) {
    return res.status(429).json({
      error: `Za dużo nieudanych prób. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
    });
  }

  try {
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_verified_2fa = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const isValid = authenticator.verify({
      token: code,
      secret: session.totp_secret
    });

    if (!isValid) {
      loginAttempts.recordFailure(req.ip, tempToken);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    loginAttempts.recordSuccess(req.ip, tempToken);

    // Aktywuj 2FA dla użytkownika
    await db.run(`UPDATE users SET totp_enabled = 1, force_2fa = 0 WHERE id = ?`, [session.user_id]);

    // Wygeneruj stały token sesji (ważny 7 dni)
    const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
      VALUES (?, ?, ?, 1)
    `, [permanentToken, session.user_id, expiresAt]);

    // Usuń tymczasową sesję
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

    res.json({ token: permanentToken });
  } catch (err) {
    console.error('Błąd weryfikacji 2FA setup:', err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

// Endpoint logowania 2FA - Krok 2b
router.post('/api/login-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Tymczasowy token i kod są wymagane.' });
  }

  const lockedMs = loginAttempts.isLocked(req.ip, tempToken);
  if (lockedMs > 0) {
    return res.status(429).json({
      error: `Za dużo nieudanych prób. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
    });
  }

  try {
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_verified_2fa = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const isValid = authenticator.verify({
      token: code,
      secret: session.totp_secret
    });

    if (!isValid) {
      loginAttempts.recordFailure(req.ip, tempToken);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    loginAttempts.recordSuccess(req.ip, tempToken);

    // Wygeneruj stały token sesji (ważny 7 dni)
    const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
      VALUES (?, ?, ?, 1)
    `, [permanentToken, session.user_id, expiresAt]);

    // Usuń tymczasową sesję
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

    res.json({ token: permanentToken });
  } catch (err) {
    console.error('Błąd logowania 2FA:', err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

// Endpoint wylogowania
router.post('/api/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace('Bearer ', '');
    await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
  }
  res.json({ success: true });
});

router.post('/api/change-password-forced', async (req, res) => {
  const { tempToken, newPassword } = req.body;
  if (!tempToken || !newPassword) {
    return res.status(400).json({ error: 'Token i nowe hasło są wymagane.' });
  }

  try {
    const session = await db.get(`
      SELECT s.*, u.username
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_verified_2fa = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.run(`
      UPDATE users 
      SET password_hash = ?, force_password_change = 0 
      WHERE id = ?
    `, [newHash, session.user_id]);

    const user = await db.get(`SELECT totp_enabled, username, totp_secret, force_2fa FROM users WHERE id = ?`, [session.user_id]);
    
    if (user.totp_enabled === 1) {
      res.json({
        status: 'require_2fa',
        tempToken: tempToken
      });
    } else {
      const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
      const isForce2faEnabled = force2faRow && force2faRow.value === '1';
      const isUserForce2fa = user.force_2fa === 1;

      if (isForce2faEnabled || isUserForce2fa) {
        const secret = authenticator.generateSecret();
        await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, session.user_id]);

        const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
        const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

        res.json({
          status: 'setup_2fa',
          tempToken: tempToken,
          qrCode: qrCodeDataUrl,
          secret: secret
        });
      } else {
        const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

        await db.run(`
          INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
          VALUES (?, ?, ?, 0)
        `, [permanentToken, session.user_id, expiresAt]);

        // Usuń tymczasową sesję
        await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

        res.json({
          token: permanentToken
        });
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zmiany wymuszonego hasła.' });
  }
});

// 6e. Sprawdzenie statusu zaproszenia (dla rejestracji)
router.get('/api/invitation-status', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Token jest wymagany.' });
  }

  try {
    const user = await db.get(`SELECT email FROM users WHERE invitation_token = ? AND status = 'pending'`, [token]);
    if (!user) {
      return res.status(404).json({ error: 'Nieprawidłowy lub wygasły token zaproszenia.' });
    }
    res.json({ email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd sprawdzania statusu zaproszenia.' });
  }
});

// 6f. Rejestracja z zaproszenia
router.post('/api/register-invitation', async (req, res) => {
  const { token, username, password } = req.body;
  if (!token || !username || !password) {
    return res.status(400).json({ error: 'Wszystkie pola są wymagane.' });
  }

  try {
    const user = await db.get(`SELECT id FROM users WHERE invitation_token = ? AND status = 'pending'`, [token]);
    if (!user) {
      return res.status(404).json({ error: 'Nieprawidłowy lub wygasły token zaproszenia.' });
    }

    const existingUsername = await db.get(`SELECT id FROM users WHERE username = ? AND id != ?`, [username, user.id]);
    if (existingUsername) {
      return res.status(400).json({ error: 'Ta nazwa użytkownika jest już zajęta.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = authenticator.generateSecret();
    
    await db.run(`
      UPDATE users 
      SET username = ?, password_hash = ?, totp_secret = ?, totp_enabled = 0, status = 'active', invitation_token = NULL
      WHERE id = ?
    `, [username, passwordHash, secret, user.id]);

    const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
      VALUES (?, ?, ?, 0)
    `, [permanentToken, user.id, expiresAt]);

    res.json({
      token: permanentToken
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rejestracji zaproszenia.' });
  }
});

// 6f-2. Publiczna rejestracja (bez tokenu zaproszenia)
router.post('/api/register-public', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }

  try {
    const existingUsername = await db.get(`SELECT id FROM users WHERE username = ?`, [username]);
    if (existingUsername) {
      return res.status(400).json({ error: 'Ta nazwa użytkownika jest już zajęta.' });
    }

    if (email) {
      const existingEmail = await db.get(`SELECT id FROM users WHERE email = ?`, [email]);
      if (existingEmail) {
        return res.status(400).json({ error: 'Ten adres e-mail jest już zajęty.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = authenticator.generateSecret();
    const syncToken = 'sync_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

    const result = await db.run(`
      INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, totp_secret)
      VALUES (?, ?, ?, 0, ?, 'user', 'active', ?)
    `, [username, passwordHash, syncToken, email || null, secret]);

    // Wstawienie domyślnych celów dla nowego użytkownika
    const defaultSettings = [
      { key: 'target_calories', value: '2500' },
      { key: 'target_protein', value: '150' },
      { key: 'target_carbs', value: '250' },
      { key: 'target_fat', value: '80' },
      { key: 'bmr', value: '1800' }
    ];
    for (const s of defaultSettings) {
      await db.run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)`, [result.id, s.key, s.value]);
    }

    const permanentToken = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
      VALUES (?, ?, ?, 0)
    `, [permanentToken, result.id, expiresAt]);

    res.json({
      token: permanentToken
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rejestracji.' });
  }
});

module.exports = router;
