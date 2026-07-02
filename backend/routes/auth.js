const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const loginAttempts = require('../services/loginAttempts');
const logger = require('../services/logger');
const { getAppConfig, generateOAuthState, verifyOAuthState, getVerifiedSessionByToken } = require('../services/oauthHelpers');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

// Pomocnicza funkcja do tworzenia sesji (tymczasowej lub stałej) - wydzielona, bo ten
// sam wzorzec (wygeneruj token, policz expires_at, wstaw wiersz do sessions) był
// powtórzony osobno w kilkunastu miejscach w tym pliku (force_password_change,
// require_2fa, setup_2fa, logowanie bez 2FA, logowanie Google, weryfikacja 2FA,
// rejestracja...), z identyczną logiką poza długością ważności i flagą is_verified_2fa.
// `ttlDays` przyjmuje też wartości ułamkowe (np. tymczasowe sesje 5-minutowe, patrz
// TEMP_SESSION_TTL_DAYS poniżej) - liczone i tak w milisekundach.
// Prefiks tokenu ('temp_' dla krótkotrwałych sesji weryfikacyjnych, 'sess_' dla
// docelowych sesji zalogowania) zachowuje dokładnie te same wzorce tokenów, które
// rozpoznaje reszta kodu (np. getVerifiedSessionByToken, middleware/auth.js).
const TEMP_SESSION_TTL_DAYS = 5 / (24 * 60); // 5 minut wyrażone w dniach
const PERMANENT_SESSION_TTL_DAYS = 7;

const validatePassword = (password) => {
  if (!password || password.length < 8) {
    return 'Hasło musi mieć co najmniej 8 znaków.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Hasło musi zawierać co najmniej jedną literę i jedną cyfrę.';
  }
  return null;
};

async function createSession(userId, isVerified2fa, ttlDays = PERMANENT_SESSION_TTL_DAYS) {
  const tokenPrefix = ttlDays >= 1 ? 'sess_' : 'temp_';
  const token = tokenPrefix + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
    VALUES (?, ?, ?, ?)
  `, [token, userId, expiresAt, isVerified2fa ? 1 : 0]);
  return token;
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

    const clientFingerprint = crypto.createHash('sha256').update(req.ip + (req.headers['user-agent'] || '')).digest('hex');
    const state = generateOAuthState(0, `google_login:${clientFingerprint}`);

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
    const session = await getVerifiedSessionByToken(token);
    if (!session) {
      return res.status(401).send('Sesja wygasła lub wymaga weryfikacji 2FA.');
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
  const verified = verifyOAuthState(state);

  const clientFingerprint = crypto.createHash('sha256').update(req.ip + (req.headers['user-agent'] || '')).digest('hex');
  const isLoginFlow = verified && verified.userId === 0 && verified.service === `google_login:${clientFingerprint}`;
  const isLinkFlow = verified && verified.userId > 0 && verified.service === 'google_link';

  if (error) {
    console.error('[GOOGLE LOGIN CALLBACK ERROR]', error);
    return res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=auth_failed' : '/?google_error=auth_failed');
  }
  if (!code || !verified || (!isLoginFlow && !isLinkFlow)) {
    return res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=csrf_failed' : '/?google_error=csrf_failed');
  }

  try {
    const clientId = await getAppConfig('google_client_id');
    const clientSecret = await getAppConfig('google_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    const tokenRes = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
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

    const userInfoRes = await fetchWithTimeout('https://www.googleapis.com/oauth2/v3/userinfo', {
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
      const conflictingUser = await db.get(`SELECT id FROM users WHERE google_id = ? AND id != ?`, [profile.sub, verified.userId]);
      if (conflictingUser) {
        return res.redirect('/?tab=settings&google_link_error=already_linked');
      }
      await db.run(`UPDATE users SET google_id = ? WHERE id = ?`, [profile.sub, verified.userId]);
      return res.redirect('/?tab=settings&google_link=success');
    }

    // 1. Szukamy użytkownika już powiązanego z tym kontem Google
    let user = await db.get(`SELECT * FROM users WHERE google_id = ?`, [profile.sub]);

    if (!user && profile.email) {
      // 2. Jeśli nie znaleziono, ale e-mail się zgadza z istniejącym kontem (logowanie hasłem) -
      // NIE łączymy automatycznie ze względów bezpieczeństwa (zapobiega przejęciu konta przez rejestrację
      // z fałszywym adresem e-mail). Odsyłamy użytkownika do zalogowania się hasłem i połączenia w Ustawieniach.
      const existingByEmail = await db.get(`SELECT * FROM users WHERE email = ?`, [profile.email]);
      if (existingByEmail) {
        return res.redirect('/?google_error=email_exists');
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
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
      // Token w fragmencie URL (#), NIE w query stringu: fragment nigdy nie jest
      // wysyłany przez przeglądarkę do serwera przy kolejnym żądaniu (np. GET /),
      // więc żywy token sesji nie trafia do logów morgan('dev') (logującego pełny
      // URL żądania) ani do nagłówka Referer/historii przeglądarki.
      return res.redirect(`/#google_temp_token=${tempToken}`);
    }

    const permanentToken = await createSession(user.id, false);
    res.redirect(`/#google_token=${permanentToken}`);
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
    const user = await db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, username]);
    if (!user) {
      await loginAttempts.recordFailure(req.ip, username);
      logger.security(`Nieudana próba logowania na konto: ${username} (użytkownik nie istnieje)`, 'AUTH_LOGIN_FAILURE', { username }, req.ip);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      await loginAttempts.recordFailure(req.ip, username);
      logger.security(`Nieudana próba logowania na konto: ${username} (błędne hasło)`, 'AUTH_LOGIN_FAILURE', { username }, req.ip);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    await loginAttempts.recordSuccess(req.ip, username);

    // Sprawdź czy wymuszona jest zmiana hasła
    if (user.force_password_change === 1) {
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);

      return res.json({
        status: 'force_password_change',
        tempToken: tempToken
      });
    }

    if (user.totp_enabled === 1) {
      // Generowanie tymczasowego tokenu (ważnego 5 minut)
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);

      return res.json({
        status: 'require_2fa',
        tempToken: tempToken
      });
    } else {
      // B-W4: Wymuszenie 2FA działa dla WSZYSTKICH użytkowników — w tym admina (usunięto bypass)
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

          const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);

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
      const permanentToken = await createSession(user.id, false);

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
      logger.security(`Niepoprawny kod 2FA podczas konfiguracji (UID: ${session.user_id})`, 'AUTH_2FA_FAILURE', { userId: session.user_id }, req.ip);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, tempToken);

    // Aktywuj 2FA dla użytkownika
    await db.run(`UPDATE users SET totp_enabled = 1, force_2fa = 0 WHERE id = ?`, [session.user_id]);

    // Wygeneruj stały token sesji (ważny 7 dni), już zweryfikowany 2FA
    const permanentToken = await createSession(session.user_id, true);

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
      logger.security(`Niepoprawny kod 2FA podczas logowania (UID: ${session.user_id})`, 'AUTH_2FA_FAILURE', { userId: session.user_id }, req.ip);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, tempToken);

    // Wygeneruj stały token sesji (ważny 7 dni), już zweryfikowany 2FA
    const permanentToken = await createSession(session.user_id, true);

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
  const passError = validatePassword(newPassword);
  if (passError) {
    return res.status(400).json({ error: passError });
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
      // B-W5: Unieważnij stary tempToken i wygeneruj nowy po zmianie hasła
      await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);
      const newTempToken = await createSession(session.user_id, false, TEMP_SESSION_TTL_DAYS);
      res.json({
        status: 'require_2fa',
        tempToken: newTempToken
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

        // B-W5: Unieważnij stary tempToken i wygeneruj nowy przed setup_2fa
        await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);
        const newTempToken = await createSession(session.user_id, false, TEMP_SESSION_TTL_DAYS);
        res.json({
          status: 'setup_2fa',
          tempToken: newTempToken,
          qrCode: qrCodeDataUrl,
          secret: secret
        });
      } else {
        const permanentToken = await createSession(session.user_id, false);

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
  const passError = validatePassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

  // Endpointy rejestracji (w przeciwieństwie do /api/login, /api/login-2fa,
  // /api/verify-2fa-setup) nie miały DEDYKOWANEJ ochrony przed automatycznym
  // masowym tworzeniem kont z jednego IP - chronił je tylko ogólny apiRateLimiter
  // (120 żądań/min). Reużywamy mechanizm loginAttempts (per-IP, nie per-username,
  // bo przy rejestracji nazwa użytkownika jest inna przy każdej próbie) - każda
  // próba rejestracji (niezależnie od wyniku) liczy się do limitu, w przeciwieństwie
  // do logowania, gdzie tylko NIEUDANE próby się liczą.
  const registerLockedMs = await loginAttempts.isLocked(req.ip, 'register_endpoint');
  if (registerLockedMs > 0) {
    return res.status(429).json({ error: `Za dużo prób rejestracji z tego adresu IP. Spróbuj ponownie za ${Math.ceil(registerLockedMs / 60000)} min.` });
  }
  await loginAttempts.recordFailure(req.ip, 'register_endpoint');

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

    const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
    const isForce2faEnabled = force2faRow && force2faRow.value === '1';

    if (isForce2faEnabled) {
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
      const otpauth = authenticator.keyuri(username, 'Dietetyk AI', secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

      res.json({
        status: 'setup_2fa',
        tempToken: tempToken,
        qrCode: qrCodeDataUrl,
        secret: secret
      });
    } else {
      const permanentToken = await createSession(user.id, false);
      res.json({
        token: permanentToken
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rejestracji zaproszenia.' });
  }
});

// 6f-2. Publiczna rejestracja (bez tokenu zaproszenia)
router.post('/api/register-public', async (req, res) => {
  // Runda 17 (naprawa z audytu): ten endpoint wcześniej nie miał ŻADNEJ flagi
  // włącz/wyłącz i całkowicie omijał system zaproszeń admina (/api/admin/invite).
  // Domyślnie WYŁĄCZONY - flaga `allow_public_registration` w app_config (domyślny
  // wiersz '0' wstawiany w db.js, ta sama konwencja co `force_2fa`), zarządzana
  // przez admina w GET/POST /api/admin/config.
  const allowPublicRegRow = await db.get(`SELECT value FROM app_config WHERE key = 'allow_public_registration'`);
  const isPublicRegistrationEnabled = allowPublicRegRow && allowPublicRegRow.value === '1';
  if (!isPublicRegistrationEnabled) {
    return res.status(403).json({ error: 'Rejestracja publiczna jest wyłączona. Skontaktuj się z administratorem, aby otrzymać zaproszenie.' });
  }

  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }
  const passError = validatePassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

  // Patrz komentarz w /api/register-invitation - ten sam mechanizm anty-spam per-IP.
  const registerLockedMs = await loginAttempts.isLocked(req.ip, 'register_endpoint');
  if (registerLockedMs > 0) {
    return res.status(429).json({ error: `Za dużo prób rejestracji z tego adresu IP. Spróbuj ponownie za ${Math.ceil(registerLockedMs / 60000)} min.` });
  }
  await loginAttempts.recordFailure(req.ip, 'register_endpoint');

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

    const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
    const isForce2faEnabled = force2faRow && force2faRow.value === '1';

    if (isForce2faEnabled) {
      const tempToken = await createSession(result.id, false, TEMP_SESSION_TTL_DAYS);
      const otpauth = authenticator.keyuri(username, 'Dietetyk AI', secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

      res.json({
        status: 'setup_2fa',
        tempToken: tempToken,
        qrCode: qrCodeDataUrl,
        secret: secret
      });
    } else {
      const permanentToken = await createSession(result.id, false);
      res.json({
        token: permanentToken
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rejestracji.' });
  }
});

module.exports = router;
