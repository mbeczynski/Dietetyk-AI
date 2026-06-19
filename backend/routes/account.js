const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { sendWeeklySummaryForUser, sendDailySummaryForUser, sendMonthlySummaryForUser } = require('../services/summaries');

router.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const user = await db.get(`SELECT sync_token FROM users WHERE id = ?`, [req.user.id]);
    const settings = {
      sync_token: user ? user.sync_token : ''
    };
    rows.forEach(r => {
      if ((r.key === 'gemini_api_key' || r.key === 'oura_client_secret' || r.key === 'withings_client_secret') && r.value) {
        settings[r.key] = '********';
      } else if (r.value === '') {
        // UWAGA: Number('') === 0, a isNaN('') === false - więc bez tego wyjątku
        // pusty string byłby tu zamieniany na liczbę 0. To był realny błąd:
        // withings_client_id/oura_client_id zapisane jako '' (np. przez
        // niezamierzony pusty zapis całego formularza ustawień) wracały z tego
        // endpointu jako 0, a 0 w JS to liczba, więc kod budujący URL OAuth
        // (sprawdzający tylko `if (!clientId)`) je odrzucał - ale string "0"
        // (po zapisaniu z powrotem przez POST) już nie jest falsy i przechodził
        // dalej, dając w efekcie client_id=0 w adresie autoryzacji Withings/Oura.
        settings[r.key] = '';
      } else {
        settings[r.key] = isNaN(r.value) ? r.value : Number(r.value);
      }
    });
    // Uwaga: BRAK fallbacku do globalnych zmiennych środowiskowych (OURA_CLIENT_ID/SECRET,
    // WITHINGS_CLIENT_ID/SECRET) - każdy użytkownik, włącznie z adminem, musi skonfigurować
    // własne dane aplikacji Oura/Withings. Dzięki temu nowy użytkownik nigdy nie łączy się
    // poprzez aplikację OAuth innego użytkownika.
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania ustawień.' });
  }
});

// 6. Zapisanie ustawień i celów dobowych
// Pola poświadczeń integracji - nigdy nie wolno ich nadpisać puste/zerowe,
// bo psuje to OAuth (patrz komentarz przy GET /api/settings powyżej). Każdy
// zapis ustawień z frontendu wysyła CAŁY obiekt stanu formularza (nie tylko
// zmienione pole), więc np. zapisanie samych celów kalorycznych mogłoby
// przypadkowo "wyczyścić" Client ID/Secret, jeśli w danym momencie stan
// formularza miał je puste/nieustawione.
const CREDENTIAL_KEYS = ['oura_client_id', 'oura_client_secret', 'withings_client_id', 'withings_client_secret'];

router.post('/api/settings', async (req, res) => {
  const settings = req.body; // Klucze i wartości
  try {
    for (const [key, val] of Object.entries(settings)) {
      if (key === 'sync_token') continue; // Pole tylko do odczytu
      if ((key === 'gemini_api_key' || key === 'oura_client_secret' || key === 'withings_client_secret') && val === '********') {
        continue; // Pomijamy aktualizację sekretów, jeśli przesłano maskę
      }
      if (CREDENTIAL_KEYS.includes(key) && (val === '' || val === null || val === undefined || val === 0)) {
        continue; // Nie zapisuj puste/zerowej wartości poświadczeń - patrz komentarz wyżej
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, key, String(val)]);
    }
    res.json({ success: true, message: 'Ustawienia zostały zaktualizowane.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu ustawień.' });
  }
});

// 6a. Pobranie profilu użytkownika (nazwa, email, avatar, rola i status 2FA)
router.get('/api/user/profile', async (req, res) => {
  try {
    const user = await db.get(`SELECT username, email, avatar_base64, role, totp_enabled, first_name, last_name, google_id FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const summaryEnabledRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_enabled'`, [req.user.id]);
    const summaryDayRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_day'`, [req.user.id]);
    const summaryTimeRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_time'`, [req.user.id]);

    const monthlyEnabledRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'monthly_summary_enabled'`, [req.user.id]);
    const monthlyDayRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'monthly_summary_day'`, [req.user.id]);
    const monthlyTimeRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'monthly_summary_time'`, [req.user.id]);

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);
    const hasGoogleFitRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'google_fit'`, [req.user.id]);

    res.json({
      username: user.username,
      email: user.email || '',
      avatar_base64: user.avatar_base64,
      role: user.role,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      totp_enabled: user.totp_enabled === 1,
      weekly_summary_enabled: summaryEnabledRow ? summaryEnabledRow.value === '1' : false,
      weekly_summary_day: summaryDayRow ? Number(summaryDayRow.value) : 1,
      weekly_summary_time: summaryTimeRow ? summaryTimeRow.value : '18:00',
      monthly_summary_enabled: monthlyEnabledRow ? monthlyEnabledRow.value === '1' : false,
      monthly_summary_day: monthlyDayRow ? Number(monthlyDayRow.value) : 1,
      monthly_summary_time: monthlyTimeRow ? monthlyTimeRow.value : '09:00',
      has_oura: !!hasOuraRow,
      has_withings: !!hasWithingsRow,
      has_google: !!user.google_id,
      has_google_fit: !!hasGoogleFitRow
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania profilu.' });
  }
});

// 6b. Aktualizacja profilu użytkownika (avatar, email, syncToken)
router.post('/api/user/profile', async (req, res) => {
  const { avatar, email, syncToken, first_name, last_name, weekly_summary_enabled, weekly_summary_day, weekly_summary_time, monthly_summary_enabled, monthly_summary_day, monthly_summary_time } = req.body;
  try {
    if (syncToken !== undefined) {
      const trimmedToken = syncToken.trim();
      if (!trimmedToken) {
        return res.status(400).json({ error: 'Token synchronizacji nie może być pusty.' });
      }
      const existing = await db.get(`SELECT id FROM users WHERE sync_token = ? AND id != ?`, [trimmedToken, req.user.id]);
      if (existing) {
        return res.status(400).json({ error: 'Ten token synchronizacji jest już przypisany do innego użytkownika.' });
      }
      await db.run(`UPDATE users SET sync_token = ? WHERE id = ?`, [trimmedToken, req.user.id]);
    }

    if (avatar !== undefined && email !== undefined) {
      await db.run(`UPDATE users SET avatar_base64 = ?, email = ? WHERE id = ?`, [avatar, email, req.user.id]);
    } else if (avatar !== undefined) {
      await db.run(`UPDATE users SET avatar_base64 = ? WHERE id = ?`, [avatar, req.user.id]);
    } else if (email !== undefined) {
      await db.run(`UPDATE users SET email = ? WHERE id = ?`, [email, req.user.id]);
    }

    // Imię/nazwisko - używane przez AI dietetyka do personalizacji zwrotów
    // (np. "Cześć Marcin"). Trim + zamiana pustego stringa na NULL, żeby AI nie
    // dostawało literalnie pustego ciągu jako "imienia" użytkownika.
    if (first_name !== undefined) {
      const trimmedFirstName = String(first_name).trim();
      await db.run(`UPDATE users SET first_name = ? WHERE id = ?`, [trimmedFirstName || null, req.user.id]);
    }
    if (last_name !== undefined) {
      const trimmedLastName = String(last_name).trim();
      await db.run(`UPDATE users SET last_name = ? WHERE id = ?`, [trimmedLastName || null, req.user.id]);
    }

    if (weekly_summary_enabled !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'weekly_summary_enabled', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, weekly_summary_enabled]);
    }
    if (weekly_summary_day !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'weekly_summary_day', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, weekly_summary_day]);
    }
    if (weekly_summary_time !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'weekly_summary_time', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, weekly_summary_time]);
    }

    if (monthly_summary_enabled !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'monthly_summary_enabled', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, monthly_summary_enabled]);
    }
    if (monthly_summary_day !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'monthly_summary_day', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, monthly_summary_day]);
    }
    if (monthly_summary_time !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'monthly_summary_time', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, monthly_summary_time]);
    }

    res.json({ success: true, message: 'Profil został zaktualizowany.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd aktualizacji profilu.' });
  }
});

router.post('/api/user/setup-2fa', async (req, res) => {
  try {
    const user = await db.get(`SELECT username, totp_secret FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const secret = authenticator.generateSecret();
    await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, req.user.id]);

    const tempToken = 'temp_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
      VALUES (?, ?, ?, 0)
    `, [tempToken, req.user.id, expiresAt]);

    const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    res.json({
      secret,
      qrCode: qrCodeDataUrl,
      tempToken
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd generowania konfiguracji 2FA.' });
  }
});

// 6b-2. Włączenie 2FA po zweryfikowaniu kodu przez zalogowanego użytkownika
router.post('/api/user/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Token i kod są wymagane.' });
  }

  try {
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.user_id = ? AND datetime(s.expires_at) > datetime('now')
    `, [tempToken, req.user.id]);

    if (!session) {
      return res.status(400).json({ error: 'Tymczasowa sesja wygasła lub jest niepoprawna. Spróbuj ponownie.' });
    }

    const isValid = authenticator.verify({
      token: code,
      secret: session.totp_secret
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Niepoprawny kod 2FA.' });
    }

    // Aktywuj 2FA dla użytkownika
    await db.run(`UPDATE users SET totp_enabled = 1 WHERE id = ?`, [req.user.id]);
    // Usuń tymczasową sesję
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

    res.json({ success: true, message: 'Dwuetapowa weryfikacja (2FA) została włączona.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd aktywacji 2FA.' });
  }
});

// 6b-3. Wyłączenie 2FA przez zalogowanego użytkownika
router.post('/api/user/disable-2fa', async (req, res) => {
  try {
    await db.run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`, [req.user.id]);
    res.json({ success: true, message: 'Dwuetapowa weryfikacja (2FA) została wyłączona.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd dezaktywacji 2FA.' });
  }
});

// Odłączenie konta Google - logowanie hasłem (lub Google Fit, jeśli był połączony
// wyłącznie przy okazji logowania Google) pozostaje dostępne, bo konto zawsze ma
// password_hash (losowy, jeśli konto powstało przez Google - można go zresetować).
router.post('/api/user/unlink-google', async (req, res) => {
  try {
    await db.run(`UPDATE users SET google_id = NULL WHERE id = ?`, [req.user.id]);
    res.json({ success: true, message: 'Odłączono konto Google.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd odłączania konta Google.' });
  }
});

// 6c. Zmiana hasła użytkownika
router.post('/api/user/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Obecne i nowe hasło są wymagane.' });
  }

  try {
    const user = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Obecne hasło jest niepoprawne.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id]);
    res.json({ success: true, message: 'Hasło zostało pomyślnie zmienione.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zmiany hasła serwera.' });
  }
});

router.post('/api/user/send-weekly-summary', async (req, res) => {
  try {
    const customEmail = req.body.email;
    await sendWeeklySummaryForUser(req.user.id, customEmail);
    res.json({
      success: true,
      message: 'Tygodniowe podsumowanie zostało pomyślnie wysłane.'
    });
  } catch (err) {
    console.error('[API ERROR] Błąd wysyłania podsumowania tygodniowego:', err);
    res.status(500).json({ error: 'Błąd serwera podczas wysyłania e-maila: ' + err.message });
  }
});

// 6ii. Wysyłanie podsumowania codziennego na e-mail (Mailgun)
router.post('/api/user/send-daily-summary', async (req, res) => {
  try {
    const customEmail = req.body.email;
    await sendDailySummaryForUser(req.user.id, customEmail);
    res.json({
      success: true,
      message: 'Codzienne podsumowanie zostało pomyślnie wysłane.'
    });
  } catch (err) {
    console.error('[API ERROR] Błąd wysyłania podsumowania codziennego:', err);
    res.status(500).json({ error: 'Błąd serwera podczas wysyłania e-maila: ' + err.message });
  }
});

// 6iii. Wysyłanie podsumowania miesięcznego na e-mail (Mailgun)
router.post('/api/user/send-monthly-summary', async (req, res) => {
  try {
    const customEmail = req.body.email;
    await sendMonthlySummaryForUser(req.user.id, customEmail);
    res.json({
      success: true,
      message: 'Miesięczne podsumowanie zostało pomyślnie wysłane.'
    });
  } catch (err) {
    console.error('[API ERROR] Błąd wysyłania podsumowania miesięcznego:', err);
    res.status(500).json({ error: 'Błąd serwera podczas wysyłania e-maila: ' + err.message });
  }
});

// Eksport danych użytkownika (RODO/GDPR, art. 20 - prawo do przenoszenia danych).
// Aplikacja przetwarza dane zdrowotne (waga, skład ciała, aktywność, sen) z Oura/
// Withings/Apple Health/Google Fit - to dane szczególnej kategorii (art. 9 RODO),
// więc użytkownik musi mieć możliwość samodzielnego pobrania własnych danych bez
// proszenia administratora. Hasła/sekrety (password_hash, totp_secret, tokeny OAuth)
// są świadomie WYŁĄCZONE z eksportu - to nie są "dane osobowe do przenoszenia" tylko
// poświadczenia bezpieczeństwa konta.
router.get('/api/user/export', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await db.get(`
      SELECT username, email, first_name, last_name, role, created_at
      FROM users WHERE id = ?
    `, [userId]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const [settings, meals, healthMetrics, bodyMeasurements, workouts] = await Promise.all([
      db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [userId]),
      db.all(`SELECT * FROM meals WHERE user_id = ? ORDER BY timestamp`, [userId]),
      db.all(`SELECT * FROM health_metrics WHERE user_id = ? ORDER BY date`, [userId]),
      db.all(`SELECT * FROM body_measurements WHERE user_id = ? ORDER BY date`, [userId]),
      db.all(`SELECT * FROM apple_health_workouts WHERE user_id = ? ORDER BY date`, [userId])
    ]);

    // Sekrety/poświadczenia OAuth (oura_client_secret, withings_client_secret,
    // gemini_api_key) maskowane tak samo jak w GET /api/settings - eksport profilu
    // nie powinien ujawniać sekretów integracji w pliku, który użytkownik może
    // gdzieś zapisać/wysłać dalej.
    const maskedSettings = {};
    settings.forEach(r => {
      if (['gemini_api_key', 'oura_client_secret', 'withings_client_secret'].includes(r.key) && r.value) {
        maskedSettings[r.key] = '********';
      } else {
        maskedSettings[r.key] = r.value;
      }
    });

    res.setHeader('Content-Disposition', 'attachment; filename="dietetyk-ai-eksport-danych.json"');
    res.json({
      exported_at: new Date().toISOString(),
      profile: {
        username: user.username,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        created_at: user.created_at
      },
      settings: maskedSettings,
      meals,
      health_metrics: healthMetrics,
      body_measurements: bodyMeasurements,
      apple_health_workouts: workouts
    });
  } catch (err) {
    console.error('[EXPORT ERROR]', err);
    res.status(500).json({ error: 'Błąd eksportu danych.' });
  }
});

// Usunięcie własnego konta (RODO/GDPR, art. 17 - prawo do bycia zapomnianym).
// Wymaga podania aktualnego hasła, żeby ktoś, kto przejął WYŁĄCZNIE token sesji
// (np. zostawiony otwarty w przeglądarce), nie mógł trwale usunąć konta bez
// znajomości hasła. Konta zalogowane przez Google bez ustawionego hasła
// (teoretyczny przypadek - rejestracja przez Google ustawia losowy hash) są
// obsłużone tym samym sprawdzeniem bcrypt.
router.delete('/api/user/account', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Potwierdzenie hasłem jest wymagane do usunięcia konta.' });
  }

  try {
    const user = await db.get(`SELECT password_hash, role FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Niepoprawne hasło.' });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        error: 'Konto administratora nie może zostać usunięte samodzielnie z tego miejsca. Skontaktuj się z drugim administratorem lub usuń konto bezpośrednio w bazie danych.'
      });
    }

    // PRAGMA foreign_keys=ON (patrz db.js) zapewnia kaskadowe usunięcie wierszy
    // powiązanych z tym user_id (sessions, oauth_tokens, meals, settings,
    // health_metrics, body_measurements, apple_health_workouts).
    await db.run(`DELETE FROM users WHERE id = ?`, [req.user.id]);

    res.json({ success: true, message: 'Konto i wszystkie powiązane dane zostały usunięte.' });
  } catch (err) {
    console.error('[ACCOUNT DELETE ERROR]', err);
    res.status(500).json({ error: 'Błąd usuwania konta.' });
  }
});

module.exports = router;
