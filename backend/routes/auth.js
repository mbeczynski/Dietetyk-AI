const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const loginAttempts = require('../services/loginAttempts');
const { getAppConfig, generateOAuthState, verifyOAuthState } = require('../services/oauthHelpers');

// Pomocnicza funkcja do tworzenia stałego tokenu sesji (7 dni) - używana też przez logowanie Google
async function createPermanentSession(userId) {
  const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
    VALUES (?, ?, ?, 0)
  `, [permanentToken, userId, expiresAt]);
  return permanentToken;
}

// ===== Logowanie przez Google =====
// Krok 1: przekierowanie do ekranu zgody Google. Client ID/Secret konfigurowane
// globalnie przez admina (Panel Admina), bo logowanie dotyczy całej aplikacji,
// a nie integracji per-użytkownik (jak Oura/Withings).
router.get('/api/auth/google', async (req, res) => {
  try {
    const clientId = await getAppConfig('google_client_id');
    if (!clientId) {
      return res.status(400).send('Logowanie przez Google nie jest skonfigurowane. Administrator musi wpisać Client ID/Secret w Panelu Admina.');
    }

    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid email profile')}&state=${state}&prompt=select_account`;
    res.redirect(authUrl);
  } catch (err) {
    console.error('[GOOGLE LOGIN ERROR]', err);
    res.status(500).send('Błąd serwera.');
  }
});

// Krok 1b: jak wyżej, ale dla użytkownika JUŻ ZALOGOWANEGO, który chce explicite
// powiązać swoje istniejące konto z Google (Ustawienia -> "Połącz z Google"),
// a nie logować się nim od nowa. Logowanie Google (powyżej) i tak łączy konta po
// e-mailu jako efekt domyślny, ale tylko gdy e-mail się zgadza - ten przepływ
// działa niezależnie od adresu e-mail, bo użytkownik jest już zweryfikowany sesją.
// `state` jest tu podpisany HMAC-em (generateOAuthState), w przeciwieństwie do
// zwykłego logowania Google, gdzie state to tylko losowy ciąg bez weryfikacji -
// to po tym callback rozróżnia oba przepływy.
router.get('/api/auth/google/link', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await db.get(`SELECT user_id, expires_at FROM sessions WHERE token = ?`, [token]);
    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(401).send('Sesja wygasła.');
    }

    const clientId = await getAppConfig('google_client_id');
    if (!clientId) {
      return res.status(400).send('Logowanie przez Google nie jest skonfigurowane. Administrator musi wpisać Client ID/Secret w Panelu Admina.');
    }

    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    const state = generateOAuthState(session.user_id, 'google_link');
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid email profile')}&state=${state}&prompt=select_account`;
    res.redirect(authUrl);
  } catch (err) {
    console.error('[GOOGLE LINK ERROR]', err);
    res.status(500).send('Błąd serwera.');
  }
});

// Krok 2: callback - wymiana kodu na token, pobranie profilu, znalezienie/utworzenie konta
// (lub, jeśli `state` wskazuje na przepływ łączenia konta - patrz wyżej, po prostu
// przypisanie google_id do już zalogowanego użytkownika).
router.get('/api/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const linkVerified = verifyOAuthState(state);
  const isLinkFlow = linkVerified && linkVerified.service === 'google_link';
  if (error) {
    console.error('[GOOGLE LOGIN CALLBACK ERROR]', error);
    return res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=auth_failed' : '/?google_error=auth_failed');
  }
  if (!code) {
    return res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=auth_failed' : '/?google_error=auth_failed');
  }

  try {
    const clientId = await getAppConfig('google_client_id');
    const clientSecret = await getAppConfig('google_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Wymiana kodu Google nieudana: ${errText}`);
    }
    const tokenData = await tokenRes.json();

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    if (!userInfoRes.ok) {
      throw new Error('Nie udało się pobrać profilu użytkownika Google.');
    }
    const profile = await userInfoRes.json(); // { sub, email, name, picture, email_verified, ... }

    if (!profile.sub) {
      throw new Error('Odpowiedź Google nie zawiera identyfikatora użytkownika (sub).');
    }

    // Przepływ łączenia konta (Ustawienia -> "Połącz z Google"): użytkownik jest już
    // zalogowany (zweryfikowany przez podpisany `state`), więc tylko przypisujemy
    // google_id do JEGO konta - nie logujemy, nie tworzymy nowego konta, nie wydajemy
    // nowej sesji. Blokujemy "podebranie" konta, jeśli ten sam google_id jest już
    // przypisany do innego użytkownika.
    if (isLinkFlow) {
      const conflictingUser = await db.get(`SELECT id FROM users WHERE google_id = ? AND id != ?`, [profile.sub, linkVerified.userId]);
      if (conflictingUser) {
        return res.redirect('/?tab=settings&google_link_error=already_linked');
      }
      await db.run(`UPDATE users SET google_id = ? WHERE id = ?`, [profile.sub, linkVerified.userId]);
      return res.redirect('/?tab=settings&google_link=success');
    }

    // 1. Szukamy użytkownika już powiązanego z tym kontem Google
    let user = await db.get(`SELECT * FROM users WHERE google_id = ?`, [profile.sub]);

    if (!user && profile.email) {
      // 2. Jeśli nie znaleziono, ale e-mail się zgadza z istniejącym kontem (logowanie hasłem) - łączymy konta
      const existingByEmail = await db.get(`SELECT * FROM users WHERE email = ?`, [profile.email]);
      if (existingByEmail) {
        await db.run(`UPDATE users SET google_id = ? WHERE id = ?`, [profile.sub, existingByEmail.id]);
        user = existingByEmail;
      }
    }

    if (!user) {
      // 3. Brak konta - tworzymy nowe. Konto Google nie ma znanego hasła, więc
      // generujemy losowy, niewykorzystywany hash (NOT NULL w schemacie), żeby
      // logowanie hasłem dla tego konta było faktycznie niemożliwe, dopóki
      // użytkownik sam nie ustawi hasła w Ustawieniach.
      const randomPassword = crypto.randomBytes(24).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);
      const syncToken = 'sync_' + crypto.randomBytes(24).toString('hex');

      let baseUsername = (profile.email ? profile.email.split('@')[0] : profile.name || 'user').replace(/[^a-zA-Z0-9_.-]/g, '') || 'user';
      let username = baseUsername;
      let suffix = 0;
      while (await db.get(`SELECT id FROM users WHERE username = ?`, [username])) {
        suffix += 1;
        username = `${baseUsername}${suffix}`;
      }

      const result = await db.run(`
        INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, google_id)
        VALUES (?, ?, ?, 0, ?, 'user', 'active', ?)
      `, [username, passwordHash, syncToken, profile.email || null, profile.sub]);

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

      user = await db.get(`SELECT * FROM users WHERE id = ?`, [result.id]);
    }

    if (user.status !== 'active') {
      return res.redirect('/?google_error=account_inactive');
    }

    // Respektujemy 2FA, jeśli użytkownik je wcześniej włączył (logowanie Google nie omija 2FA)
    if (user.totp_enabled === 1) {
      const tempToken = 'temp_' + crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      await db.run(`
        INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
        VALUES (?, ?, ?, 0)
      `, [tempToken, user.id, expiresAt]);
      return res.redirect(`/?google_temp_token=${tempToken}`);
    }

    const permanentToken = await createPermanentSession(user.id);
    res.redirect(`/?google_token=${permanentToken}`);
  } catch (err) {
    console.error('[GOOGLE LOGIN CALLBACK ERROR]', err.message);
    res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=exchange_failed' : '/?google_error=exchange_failed');
  }
});

router.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }

  const lockedMs = await loginAttempts.isLocked(req.ip, username);
  if (lockedMs > 0) {
    return res.status(429).json({
      error: `Za dużo nieudanych prób logowania. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
    });
  }

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!user) {
      await loginAttempts.recordFailure(req.ip, username);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      await loginAttempts.recordFailure(req.ip, username);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    await loginAttempts.recordSuccess(req.ip, username);

    // Sprawdź czy wymuszona jest zmiana hasła
    if (user.force_password_change === 1) {
      const tempToken = 'temp_' + crypto.randomBytes(24).toString('hex');
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
      const tempToken = 'temp_' + crypto.randomBytes(24).toString('hex');
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

          const tempToken = 'temp_' + crypto.randomBytes(24).toString('hex');
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
      const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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
      const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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

  const lockedMs = await loginAttempts.isLocked(req.ip, tempToken);
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
      await loginAttempts.recordFailure(req.ip, tempToken);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, tempToken);

    // Aktywuj 2FA dla użytkownika
    await db.run(`UPDATE users SET totp_enabled = 1, force_2fa = 0 WHERE id = ?`, [session.user_id]);

    // Wygeneruj stały token sesji (ważny 7 dni)
    const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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

  const lockedMs = await loginAttempts.isLocked(req.ip, tempToken);
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
      await loginAttempts.recordFailure(req.ip, tempToken);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, tempToken);

    // Wygeneruj stały token sesji (ważny 7 dni)
    const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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
        const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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

    const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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
    const syncToken = 'sync_' + crypto.randomBytes(24).toString('hex');

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

    const permanentToken = 'sess_' + crypto.randomBytes(24).toString('hex');
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
