const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');

// Wczytaj zmienne środowiskowe
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_TOKEN = process.env.SYNC_TOKEN || 'secure-diet-token-123';

// Inicjalizacja Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY;
let genAI = null;
let model = null;

if (geminiApiKey) {
  try {
    genAI = new GoogleGenerativeAI(geminiApiKey);
    // Używamy modelu gemini-1.5-flash jako standardu i stabilnej wersji
    model = genAI.getGenerativeModel({ 
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash" 
    });
    console.log(`Zainicjalizowano Gemini API z modelem: ${process.env.GEMINI_MODEL || "gemini-1.5-flash"}`);
  } catch (err) {
    console.error('Błąd inicjalizacji Gemini API:', err.message);
  }
} else {
  console.warn('Ostrzeżenie: Brak GEMINI_API_KEY w pliku .env. Analiza AI nie będzie działać!');
}

// Pomocnicza funkcja do generowania treści z obsługą modeli zapasowych (fallback) i logowaniem
async function generateContentWithFallback(promptText, isJson = false, imagePart = null, customApiKey = null, forceCustomKeyOnly = false) {
  const apiKeyToUse = customApiKey || (forceCustomKeyOnly ? null : process.env.GEMINI_API_KEY);
  if (!apiKeyToUse) {
    throw new Error('Usługa AI jest obecnie niedostępna (brak klucza API). Upewnij się, że klucz jest wprowadzony w zakładce Ustawienia.');
  }

  const localGenAI = new GoogleGenerativeAI(apiKeyToUse);

  const modelsToTry = [
    process.env.GEMINI_MODEL,
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-3.5-flash'
  ].filter(Boolean);

  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  console.log(`[AI LOG] Rozpoczęcie generowania z promptem o długości ${promptText.length} znaków.`);

  for (const modelName of uniqueModels) {
    try {
      console.log(`[AI LOG] Próba wysłania zapytania (JSON=${isJson}, Obraz=${!!imagePart}) do modelu: ${modelName}`);
      const tempModel = localGenAI.getGenerativeModel({ model: modelName });
      
      const config = {
        temperature: 0.2,
      };
      if (isJson) {
        config.responseMimeType = "application/json";
      }

      const parts = [{ text: promptText }];
      if (imagePart) {
        parts.push(imagePart);
      }

      const response = await tempModel.generateContent({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: config
      });

      const text = response.response.text();
      console.log(`[AI LOG] Sukces! Użyto modelu: ${modelName}. Długość odpowiedzi: ${text.length} znaków.`);
      return text;
    } catch (err) {
      console.warn(`[AI WARNING] Model ${modelName} zgłosił błąd: ${err.message}`);
      lastError = err;
    }
  }

  console.error(`[AI ERROR] Wszystkie dostępne modele (${uniqueModels.join(', ')}) zawiodły.`);
  throw lastError || new Error("Wszystkie skonfigurowane modele Gemini zwróciły błąd.");
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Serwowanie plików statycznych frontendu w trybie produkcyjnym
app.use(express.static(path.join(__dirname, 'public')));

// Pomocnicza funkcja pobierająca dzisiejszą datę w formacie lokalnym YYYY-MM-DD
function getLocalDateString() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000; // offset w ms
  const localISOTime = (new Date(d.getTime() - tzOffset)).toISOString().slice(0, 10);
  return localISOTime;
}

// --- ZABEZPIECZENIA I SESJA ---

// Middleware sprawdzające autoryzację dla tras /api/* (z wyjątkiem logowania i webhooka)
async function requireAuth(req, res, next) {
  // Wyjątek dla publicznych tras logowania/zaproszeń/rejestracji/callbacków
  if (
    req.path === '/login' || 
    req.path === '/verify-2fa-setup' || 
    req.path === '/login-2fa' ||
    req.path === '/invitation-status' ||
    req.path === '/register-invitation' ||
    req.path === '/change-password-forced' ||
    req.path === '/register-public' ||
    req.path === '/auth/oura/callback' ||
    req.path === '/auth/withings/callback'
  ) {
    return next();
  }

  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    token = authHeader.replace('Bearer ', '');
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Brak autoryzacji. Zaloguj się.' });
  }
  try {
    const session = await db.get(`
      SELECT s.*, u.username, u.totp_enabled, u.role
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
    `, [token]);

    if (!session) {
      return res.status(401).json({ error: 'Sesja wygasła lub jest niepoprawna. Zaloguj się ponownie.' });
    }

    // Zablokuj dostęp, jeśli użytkownik ma włączone 2FA, ale sesja nie jest zweryfikowana
    if (session.totp_enabled === 1 && session.is_verified_2fa === 0) {
      return res.status(401).json({ error: 'Wymagana weryfikacja 2FA. Uzupełnij kod.' });
    }

    // Przedłuż sesję o 7 dni
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`, [nextWeek, token]);

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role
    };
    next();
  } catch (err) {
    console.error('Błąd w middleware requireAuth:', err);
    res.status(500).json({ error: 'Błąd autoryzacji serwera.' });
  }
}

// Zabezpieczenie wszystkich tras /api/ za pomocą middleware
app.use('/api', requireAuth);

// 0. Endpoint logowania - Krok 1 (hasło)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!user) {
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

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
app.post('/api/verify-2fa-setup', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Tymczasowy token i kod są wymagane.' });
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
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

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
app.post('/api/login-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Tymczasowy token i kod są wymagane.' });
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
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

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
app.post('/api/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace('Bearer ', '');
    await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
  }
  res.json({ success: true });
});

// --- TRASY API ---

// 1. Dodawanie nowego posiłku (analiza przez Gemini AI)
app.post('/api/meals', async (req, res) => {
  const { rawText, date, image } = req.body;
  const targetDate = date || getLocalDateString();

  if ((!rawText || rawText.trim() === '') && !image) {
    return res.status(400).json({ error: 'Opis posiłku lub zdjęcie nie może być puste.' });
  }

  try {
    console.log(`[API LOG] POST /api/meals - Rozpoczęto analizę dla użytkownika ${req.user.username} (${targetDate})`);

    let imagePart = null;
    if (image) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];
        imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        };
        console.log(`[API LOG] Pomyślnie przetworzono zdjęcie. Typ: ${mimeType}, Rozmiar Base64: ${base64Data.length} znaków.`);
      } else {
        console.warn(`[API WARNING] Nieprawidłowy format pliku obrazu.`);
      }
    }

    let prompt = '';
    if (imagePart) {
      prompt = `
Przeanalizuj dołączone zdjęcie posiłku pod kątem wartości odżywczych. 
${rawText ? `Użytkownik opisał ten posiłek następująco: "${rawText}"` : 'Użytkownik nie podał opisu tekstowego, zidentyfikuj dania na zdjęciu samodzielnie.'}

Zwróć odpowiedź w formacie JSON zawierającym szacunkowe wartości odżywcze posiłku. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "calories": (liczba całkowita - kcal dla całego posiłku),
  "protein": (liczba - gramy białka),
  "carbs": (liczba - gramy węglowodanów),
  "fat": (liczba - gramy tłuszczu),
  "food_items": [
    {
      "name": "nazwa zidentyfikowanego składnika (np. jajko sadzone, ziemniaki gotowane, pierś z kurczaka)",
      "portion": "wielkość porcji oszacowana na podstawie zdjęcia (np. 2 sztuki, 150g, 1 szklanka)",
      "calories": (liczba - kcal),
      "protein": (liczba - g),
      "carbs": (liczba - g),
      "fat": (liczba - g)
    }
  ],
  "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania). Oceń zbilansowanie posiłku na zdjęciu, zalety, wady i ewentualne sugestie ulepszenia.",
  "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe, a 10 to super zdrowe i zbilansowane)
}
`;
    } else {
      prompt = `
Analizujesz posiłek użytkownika pod kątem wartości odżywczych. 
Użytkownik napisał: "${rawText}"

Zwróć odpowiedź w formacie JSON zawierającym szacunkowe wartości odżywcze posiłku. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "calories": (liczba całkowita - kcal dla całego posiłku),
  "protein": (liczba - gramy białka),
  "carbs": (liczba - gramy węglowodanów),
  "fat": (liczba - gramy tłuszczu),
  "food_items": [
    {
      "name": "nazwa składnika (np. jajko, chleb pszenny)",
      "portion": "wielkość porcji podana przez użytkownika lub domyślna szacowana (np. 2 sztuki, 100g)",
      "calories": (liczba - kcal),
      "protein": (liczba - g),
      "carbs": (liczba - g),
      "fat": (liczba - g)
    }
  ],
  "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania). Ocen zbilansowanie posiłku, zalety, wady i ewentualne sugestie ulepszenia.",
  "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe np. fast food, a 10 to super zdrowe i zbilansowane)
}
`;
    }

    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? apiKeyRow.value : null;
    const forceCustomKeyOnly = req.user.role !== 'admin';
    const responseText = await generateContentWithFallback(prompt, true, imagePart, userApiKey, forceCustomKeyOnly);
    let analysis;
    try {
      analysis = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[API ERROR] Błąd parsowania odpowiedzi AI:', responseText);
      throw new Error('AI nie zwróciło poprawnego formatu JSON.');
    }

    const mealDescription = rawText || "Posiłek ze zdjęcia";

    // Zapisz posiłek w bazie
    const result = await db.run(`
      INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, analysis_json, image_base64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      targetDate,
      mealDescription,
      analysis.calories || 0,
      analysis.protein || 0,
      analysis.carbs || 0,
      analysis.fat || 0,
      JSON.stringify(analysis),
      image || null
    ]);

    console.log(`[API LOG] Dodano posiłek o ID: ${result.id} dla ${req.user.username}. Kalorie: ${analysis.calories} kcal`);

    res.status(201).json({
      id: result.id,
      date: targetDate,
      raw_text: mealDescription,
      image_base64: image || null,
      ...analysis
    });

  } catch (err) {
    console.error('[API ERROR] Błąd analizy posiłku przez AI:', err);
    res.status(500).json({ error: 'Wystąpił błąd podczas analizowania posiłku przez AI: ' + err.message });
  }
});

// 2. Pobieranie listy posiłków z danego dnia
app.get('/api/meals', async (req, res) => {
  const date = req.query.date || getLocalDateString();
  try {
    const rows = await db.all(`
      SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY timestamp DESC
    `, [req.user.id, date]);

    const meals = rows.map(r => {
      let analysis = {};
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      return {
        id: r.id,
        date: r.date,
        timestamp: r.timestamp,
        raw_text: r.raw_text,
        image_base64: r.image_base64,
        ...analysis
      };
    });

    res.json(meals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania posiłków.' });
  }
});

// 3. Usuwanie posiłku
app.delete('/api/meals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM meals WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Nie znaleziono posiłku.' });
    }
    res.json({ success: true, message: 'Posiłek został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania posiłku.' });
  }
});


// 5. Pobranie stanu ustawień i celów dobowych
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const user = await db.get(`SELECT sync_token FROM users WHERE id = ?`, [req.user.id]);
    const settings = {
      sync_token: user ? user.sync_token : ''
    };
    rows.forEach(r => {
      if ((r.key === 'gemini_api_key' || r.key === 'oura_client_secret' || r.key === 'withings_client_secret') && r.value) {
        settings[r.key] = '********';
      } else {
        settings[r.key] = isNaN(r.value) ? r.value : Number(r.value);
      }
    });
    // Fallback do zmiennych środowiskowych dla Oura
    if (process.env.OURA_CLIENT_ID && !settings.oura_client_id) {
      settings.oura_client_id = process.env.OURA_CLIENT_ID;
    }
    if (process.env.OURA_CLIENT_SECRET && !settings.oura_client_secret) {
      settings.oura_client_secret = '********';
    }
    // Fallback do zmiennych środowiskowych dla Withings
    if (process.env.WITHINGS_CLIENT_ID && !settings.withings_client_id) {
      settings.withings_client_id = process.env.WITHINGS_CLIENT_ID;
    }
    if (process.env.WITHINGS_CLIENT_SECRET && !settings.withings_client_secret) {
      settings.withings_client_secret = '********';
    }
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania ustawień.' });
  }
});

// 6. Zapisanie ustawień i celów dobowych
app.post('/api/settings', async (req, res) => {
  const settings = req.body; // Klucze i wartości
  try {
    for (const [key, val] of Object.entries(settings)) {
      if (key === 'sync_token') continue; // Pole tylko do odczytu
      if ((key === 'gemini_api_key' || key === 'oura_client_secret' || key === 'withings_client_secret') && val === '********') {
        continue; // Pomijamy aktualizację sekretów, jeśli przesłano maskę
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
app.get('/api/user/profile', async (req, res) => {
  try {
    const user = await db.get(`SELECT username, email, avatar_base64, role, totp_enabled FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const summaryEnabledRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_enabled'`, [req.user.id]);
    const summaryDayRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_day'`, [req.user.id]);
    const summaryTimeRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_time'`, [req.user.id]);

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);

    res.json({
      username: user.username,
      email: user.email || '',
      avatar_base64: user.avatar_base64,
      role: user.role,
      totp_enabled: user.totp_enabled === 1,
      weekly_summary_enabled: summaryEnabledRow ? summaryEnabledRow.value === '1' : false,
      weekly_summary_day: summaryDayRow ? Number(summaryDayRow.value) : 1,
      weekly_summary_time: summaryTimeRow ? summaryTimeRow.value : '18:00',
      has_oura: !!hasOuraRow,
      has_withings: !!hasWithingsRow
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania profilu.' });
  }
});

// 6b. Aktualizacja profilu użytkownika (avatar, email, syncToken)
app.post('/api/user/profile', async (req, res) => {
  const { avatar, email, syncToken, weekly_summary_enabled, weekly_summary_day, weekly_summary_time } = req.body;
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

    res.json({ success: true, message: 'Profil został zaktualizowany.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd aktualizacji profilu.' });
  }
});

// ==================== OURA & WITHINGS INTEGRATION ENGINE ====================

// Helper do pobierania konfiguracji z bazy app_config
async function getAppConfig(key) {
  if (key === 'app_url' && process.env.APP_URL) {
    return process.env.APP_URL;
  }
  const row = await db.get(`SELECT value FROM app_config WHERE key = ?`, [key]);
  return row ? row.value : null;
}


// Helper do pobierania ustawień konkretnego użytkownika
async function getUserSetting(userId, key) {
  const row = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = ?`, [userId, key]);
  return row ? row.value : null;
}

// Bezpieczne generowanie i weryfikacja stanu OAuth (stateless)
function generateOAuthState(userId, service = 'oura') {
  const salt = Math.random().toString(36).substring(2);
  const data = `${userId}:${service}:${salt}`;
  const hmac = crypto.createHmac('sha256', process.env.APP_PASSWORD || 'default_secret').update(data).digest('hex');
  return `${userId}:${service}:${salt}:${hmac}`;
}

function verifyOAuthState(state) {
  if (!state) return null;
  const parts = state.split(':');
  if (parts.length === 3) {
    const [userId, salt, hmac] = parts;
    const expectedHmac = crypto.createHmac('sha256', process.env.APP_PASSWORD || 'default_secret').update(`${userId}:${salt}`).digest('hex');
    if (hmac === expectedHmac) {
      return { userId: parseInt(userId, 10), service: 'oura' };
    }
  } else if (parts.length === 4) {
    const [userId, service, salt, hmac] = parts;
    const expectedHmac = crypto.createHmac('sha256', process.env.APP_PASSWORD || 'default_secret').update(`${userId}:${service}:${salt}`).digest('hex');
    if (hmac === expectedHmac) {
      return { userId: parseInt(userId, 10), service };
    }
  }
  return null;
}

// Formatowanie daty YYYY-MM-DD
function formatDateString(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Konwersja timestamp Unix do daty YYYY-MM-DD w strefie Europe/Warsaw
function timestampToDateString(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

// Pobieranie / Odświeżanie tokenu OAuth
async function getOrRefreshToken(userId, service) {
  const token = await db.get(`SELECT * FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
  if (!token) return null;

  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  
  // Jeśli token jest ważny dłużej niż 5 minut, zwracamy go
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  console.log(`[OAUTH] Odświeżanie tokenu dla użytkownika ${userId}, serwis: ${service}...`);
  try {
    if (service === 'oura') {
      const clientId = process.env.OURA_CLIENT_ID || await getUserSetting(userId, 'oura_client_id');
      const clientSecret = process.env.OURA_CLIENT_SECRET || await getUserSetting(userId, 'oura_client_secret');
      if (!clientId || !clientSecret) throw new Error('Brak Client ID lub Secret dla Oura.');

      const response = await fetch('https://api.ouraring.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Błąd odświeżania Oura: ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'oura'
      `, [data.access_token, data.refresh_token || token.refresh_token, newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'withings') {
      const clientId = process.env.WITHINGS_CLIENT_ID || await getUserSetting(userId, 'withings_client_id');
      const clientSecret = process.env.WITHINGS_CLIENT_SECRET || await getUserSetting(userId, 'withings_client_secret');
      if (!clientId || !clientSecret) throw new Error('Brak Client ID lub Secret dla Withings.');

      const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token.refresh_token
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Błąd odświeżania Withings: ${errorText}`);
      }

      const resJson = await response.json();
      if (resJson.status !== 0) {
        throw new Error(`Błąd Withings API: ${resJson.error || 'Status ' + resJson.status}`);
      }

      const data = resJson.body;
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'withings'
      `, [data.access_token, data.refresh_token || token.refresh_token, newExpiresAt, userId]);

      return data.access_token;
    }
  } catch (err) {
    console.error(`[OAUTH ERROR] Błąd odświeżania tokenu dla ${service} (użytkownik ${userId}):`, err.message);
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
    return null;
  }
  return null;
}

// Synchronizacja danych Oura
async function syncOura(userId) {
  const accessToken = await getOrRefreshToken(userId, 'oura');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Oura. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 7);

  const startDate = formatDateString(past);
  const endDate = formatDateString(now);

  console.log(`[SYNC OURA] Pobieranie danych gotowości/snu/aktywności dla użytkownika ${userId} od ${startDate} do ${endDate}...`);

  try {
    const sleepRes = await fetch(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!sleepRes.ok) {
      const errText = await sleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania snu Oura (Status ${sleepRes.status}): ${detail}`);
    }
    const sleepData = await sleepRes.json();

    const dailySleepRes = await fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!dailySleepRes.ok) {
      const errText = await dailySleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania dziennego podsumowania snu Oura (Status ${dailySleepRes.status}): ${detail}`);
    }
    const dailySleepData = await dailySleepRes.json();

    const actRes = await fetch(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!actRes.ok) {
      const errText = await actRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania aktywności Oura (Status ${actRes.status}): ${detail}`);
    }
    const actData = await actRes.json();

    const readRes = await fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!readRes.ok) {
      const errText = await readRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania gotowości Oura (Status ${readRes.status}): ${detail}`);
    }
    const readData = await readRes.json();

    const metricsByDate = {};
    for (let i = 0; i <= 7; i++) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      const dateStr = formatDateString(d);
      metricsByDate[dateStr] = {
        steps: null,
        active_calories: null,
        total_calories: null,
        sleep_score: null,
        sleep_duration: null,
        sleep_deep: null,
        sleep_rem: null,
        readiness_score: null,
        hrv: null,
        rhr: null,
        temperature_deviation: null
      };
    }

    if (sleepData && sleepData.data) {
      sleepData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].sleep_duration = item.total_sleep_duration ? Math.round((item.total_sleep_duration / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_deep = item.deep_sleep_duration ? Math.round((item.deep_sleep_duration / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_rem = item.rem_sleep_duration ? Math.round((item.rem_sleep_duration / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].rhr = item.lowest_heart_rate || null;
          metricsByDate[dateStr].hrv = item.average_hrv || null;
        }
      });
    }

    if (dailySleepData && dailySleepData.data) {
      dailySleepData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].sleep_score = item.score || null;
        }
      });
    }

    if (actData && actData.data) {
      actData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].steps = item.steps || 0;
          metricsByDate[dateStr].active_calories = item.active_calories || 0;
          metricsByDate[dateStr].total_calories = item.total_calories || 0;
          metricsByDate[dateStr].active_minutes = Math.round(((item.medium_activity_time || 0) + (item.high_activity_time || 0)) / 60) || 0;
        }
      });
    }

    if (readData && readData.data) {
      readData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].readiness_score = item.score || null;
          metricsByDate[dateStr].temperature_deviation = item.temperature?.deviation || null;
        }
      });
    }

    const lastSyncTime = new Date().toISOString();
    for (const [dateStr, metrics] of Object.entries(metricsByDate)) {
      if (metrics.steps !== null || metrics.sleep_score !== null || metrics.readiness_score !== null) {
        await db.run(`
          INSERT INTO health_metrics (
            user_id, date, steps, active_calories, total_calories_burned, 
            sleep_score, sleep_duration, sleep_deep, sleep_rem, 
            readiness_score, hrv, rhr, temperature_deviation, active_minutes, last_sync
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            steps = COALESCE(excluded.steps, steps),
            active_calories = COALESCE(excluded.active_calories, active_calories),
            total_calories_burned = COALESCE(excluded.total_calories_burned, total_calories_burned),
            sleep_score = COALESCE(excluded.sleep_score, sleep_score),
            sleep_duration = COALESCE(excluded.sleep_duration, sleep_duration),
            sleep_deep = COALESCE(excluded.sleep_deep, sleep_deep),
            sleep_rem = COALESCE(excluded.sleep_rem, sleep_rem),
            readiness_score = COALESCE(excluded.readiness_score, readiness_score),
            hrv = COALESCE(excluded.hrv, hrv),
            rhr = COALESCE(excluded.rhr, rhr),
            temperature_deviation = COALESCE(excluded.temperature_deviation, temperature_deviation),
            active_minutes = COALESCE(excluded.active_minutes, active_minutes),
            last_sync = excluded.last_sync
        `, [
          userId, dateStr, 
          metrics.steps, metrics.active_calories, metrics.total_calories,
          metrics.sleep_score, metrics.sleep_duration, metrics.sleep_deep, metrics.sleep_rem,
          metrics.readiness_score, metrics.hrv, metrics.rhr, metrics.temperature_deviation,
          metrics.active_minutes || 0,
          lastSyncTime
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC OURA ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja danych Withings
async function syncWithings(userId) {
  const accessToken = await getOrRefreshToken(userId, 'withings');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Withings. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 30);
  const startTimestamp = Math.floor(past.getTime() / 1000);

  console.log(`[SYNC WITHINGS] Pobieranie pomiarów wagi dla użytkownika ${userId}...`);

  try {
    const response = await fetch('https://wbsapi.withings.net/v2/measure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`
      },
      body: new URLSearchParams({
        action: 'getmeas',
        meastypes: '1,6,76', // 1: waga (kg), 6: % tłuszczu, 76: mięśnie (kg)
        category: '1',
        lastupdate: String(startTimestamp)
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Withings: ${errText}`);
    }

    const resJson = await response.json();
    if (resJson.status !== 0) {
      throw new Error(`Withings API status: ${resJson.status}`);
    }

    const measureGrps = resJson.body?.measuregrps || [];
    const lastSyncTime = new Date().toISOString();

    for (const grp of measureGrps) {
      const dateStr = timestampToDateString(grp.date);
      let weight = null;
      let fatRatio = null;
      let muscleMass = null;

      grp.measures.forEach(m => {
        const val = m.value * Math.pow(10, m.unit);
        if (m.type === 1) weight = Math.round(val * 100) / 100;
        if (m.type === 6) fatRatio = Math.round(val * 100) / 100;
        if (m.type === 76) muscleMass = Math.round(val * 100) / 100;
      });

      if (weight !== null || fatRatio !== null || muscleMass !== null) {
        await db.run(`
          INSERT INTO health_metrics (user_id, date, weight, fat_ratio, muscle_mass, last_sync)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            weight = COALESCE(excluded.weight, weight),
            fat_ratio = COALESCE(excluded.fat_ratio, fat_ratio),
            muscle_mass = COALESCE(excluded.muscle_mass, muscle_mass),
            last_sync = excluded.last_sync
        `, [userId, dateStr, weight, fatRatio, muscleMass, lastSyncTime]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC WITHINGS ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja Oura dla wszystkich użytkowników (co 15 minut)
async function syncAllOura() {
  console.log('[CRON OURA] Synchronizacja danych Oura Ring...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'oura'`);
    for (const t of tokens) {
      await syncOura(t.user_id);
    }
    console.log(`[CRON OURA] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Oura:', err);
  }
}

// Synchronizacja Withings dla wszystkich użytkowników (co 60 minut)
async function syncAllWithings() {
  console.log('[CRON WITHINGS] Synchronizacja danych Withings...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'withings'`);
    for (const t of tokens) {
      await syncWithings(t.user_id);
    }
    console.log(`[CRON WITHINGS] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Withings:', err);
  }
}

// Trasy OAuth: Inicjalizacja Oura
app.get('/api/auth/oura', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await db.get(`SELECT user_id, expires_at FROM sessions WHERE token = ?`, [token]);
    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(401).send('Sesja wygasła.');
    }

    const clientId = process.env.OURA_CLIENT_ID || await getUserSetting(session.user_id, 'oura_client_id');
    if (!clientId) {
      return res.status(400).send('Integracja z Oura nie jest skonfigurowana. Wpisz Client ID w Ustawieniach.');
    }

    const state = generateOAuthState(session.user_id);
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/oura/callback`;

    const authUrl = `https://cloud.ouraring.com/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=daily%20heartrate%20personal`;
    res.redirect(authUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

// Trasa OAuth: Callback Oura
app.get('/api/auth/oura/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (!code && !state) {
    return res.status(200).send('Callback URL verification OK');
  }
  if (error) {
    console.error('[OAUTH CALLBACK ERROR]', error);
    return res.redirect('/?tab=setup&error=auth_failed');
  }

  const verified = verifyOAuthState(state);
  if (!verified) {
    return res.status(400).send('Nieprawidłowy parametr state (zabezpieczenie CSRF).');
  }

  const { userId, service } = verified;

  if (service === 'withings') {
    try {
      const clientId = process.env.WITHINGS_CLIENT_ID || await getUserSetting(userId, 'withings_client_id');
      const clientSecret = process.env.WITHINGS_CLIENT_SECRET || await getUserSetting(userId, 'withings_client_secret');
      const appUrl = await getAppConfig('app_url');
      const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
      const redirectUri = `${base}${req.path}`; // dynamiczny matching: /api/auth/oura/callback

      const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          redirect_uri: redirectUri
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Wymiana kodu Withings nieudana: ${errText}`);
      }

      const resJson = await response.json();
      if (resJson.status !== 0) {
        throw new Error(`Withings API błąd: ${resJson.error || resJson.status}`);
      }

      const data = resJson.body;
      const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

      await db.run(`
        INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
        VALUES (?, 'withings', ?, ?, ?)
        ON CONFLICT(user_id, service) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at
      `, [userId, data.access_token, data.refresh_token, expiresAt]);

      await syncWithings(userId);
      return res.redirect('/?tab=setup&success=withings');
    } catch (err) {
      console.error('[OAUTH WITHINGS CALLBACK VIA OURA ERROR]', err.message);
      return res.redirect('/?tab=setup&error=withings_exchange_failed');
    }
  }

  try {
    const clientId = process.env.OURA_CLIENT_ID || await getUserSetting(userId, 'oura_client_id');
    const clientSecret = process.env.OURA_CLIENT_SECRET || await getUserSetting(userId, 'oura_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/oura/callback`;

    const response = await fetch('https://api.ouraring.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Wymiana kodu Oura nieudana: ${errText}`);
    }

    const data = await response.json();
    console.log('[OAUTH OURA CALLBACK SUCCESS] Zwrócone dane tokenu:', {
      access_token_masked: data.access_token ? data.access_token.substring(0, 10) + '...' : null,
      refresh_token_masked: data.refresh_token ? data.refresh_token.substring(0, 10) + '...' : null,
      scopes: data.scope || data.scopes || 'brak pola scope w response'
    });
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await db.run(`
      INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
      VALUES (?, 'oura', ?, ?, ?)
      ON CONFLICT(user_id, service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at
    `, [userId, data.access_token, data.refresh_token, expiresAt]);

    await syncOura(userId);
    res.redirect('/?tab=setup&success=oura');
  } catch (err) {
    console.error('[OAUTH OURA CALLBACK ERROR]', err.message);
    res.redirect('/?tab=setup&error=oura_exchange_failed');
  }
});

// Trasa OAuth: Odłączenie Oura
app.post('/api/auth/oura/disconnect', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    res.json({ success: true, message: 'Rozłączono z Oura Ring.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rozłączania Oura.' });
  }
});

// Trasy OAuth: Inicjalizacja Withings
app.get('/api/auth/withings', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await db.get(`SELECT user_id, expires_at FROM sessions WHERE token = ?`, [token]);
    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(401).send('Sesja wygasła.');
    }

    const clientId = process.env.WITHINGS_CLIENT_ID || await getUserSetting(session.user_id, 'withings_client_id');
    if (!clientId) {
      return res.status(400).send('Integracja z Withings nie jest skonfigurowana. Wpisz Client ID w Ustawieniach.');
    }

    const state = generateOAuthState(session.user_id, 'withings');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const dbRedirectUri = await getUserSetting(session.user_id, 'withings_redirect_uri');
    const redirectUri = dbRedirectUri || process.env.WITHINGS_REDIRECT_URI || `${base}/api/auth/withings/callback`;

    const authUrl = `https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=user.metrics,user.activity`;
    res.redirect(authUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

// Trasa OAuth: Callback Withings
app.get('/api/auth/withings/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (!code && !state) {
    return res.status(200).send('Callback URL verification OK');
  }
  if (error) {
    console.error('[OAUTH WITHINGS CALLBACK ERROR]', error);
    return res.redirect('/?tab=setup&error=withings_auth_failed');
  }

  const verified = verifyOAuthState(state);
  if (!verified) {
    return res.status(400).send('Nieprawidłowy parametr state (zabezpieczenie CSRF).');
  }
  const { userId } = verified;

  try {
    const clientId = process.env.WITHINGS_CLIENT_ID || await getUserSetting(userId, 'withings_client_id');
    const clientSecret = process.env.WITHINGS_CLIENT_SECRET || await getUserSetting(userId, 'withings_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}${req.path}`;

    const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'requesttoken',
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Wymiana kodu Withings nieudana: ${errText}`);
    }

    const resJson = await response.json();
    if (resJson.status !== 0) {
      throw new Error(`Withings API błąd: ${resJson.error || resJson.status}`);
    }

    const data = resJson.body;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await db.run(`
      INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
      VALUES (?, 'withings', ?, ?, ?)
      ON CONFLICT(user_id, service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at
    `, [userId, data.access_token, data.refresh_token, expiresAt]);

    await syncWithings(userId);
    res.redirect('/?tab=setup&success=withings');
  } catch (err) {
    console.error('[OAUTH WITHINGS CALLBACK ERROR]', err.message);
    res.redirect('/?tab=setup&error=withings_exchange_failed');
  }
});

// Trasa OAuth: Odłączenie Withings
app.post('/api/auth/withings/disconnect', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);
    res.json({ success: true, message: 'Rozłączono z Withings.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rozłączania Withings.' });
  }
});

// Ręczna synchronizacja danych Oura i Withings dla zalogowanego użytkownika
app.post('/api/sync/manual', requireAuth, async (req, res) => {
  const userId = req.user.id;
  let ouraSuccess = false;
  let withingsSuccess = false;
  let ouraError = null;
  let withingsError = null;

  // Sprawdzamy czy ma tokeny Oura
  const hasOura = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [userId]);
  if (hasOura) {
    try {
      const result = await syncOura(userId);
      ouraSuccess = result.success;
      ouraError = result.success ? null : result.error;
    } catch (err) {
      ouraError = err.message;
    }
  }

  // Sprawdzamy czy ma tokeny Withings
  const hasWithings = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [userId]);
  if (hasWithings) {
    try {
      const result = await syncWithings(userId);
      withingsSuccess = result.success;
      withingsError = result.success ? null : result.error;
    } catch (err) {
      withingsError = err.message;
    }
  }

  res.json({
    success: true,
    oura: hasOura ? { success: ouraSuccess, error: ouraError } : null,
    withings: hasWithings ? { success: withingsSuccess, error: withingsError } : null,
    message: 'Zakończono proces manualnej synchronizacji.'
  });
});

// Historia danych zdrowotnych z ostatnich 30 dni (pod wykresy)
app.get('/api/health/history', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT date, weight, fat_ratio, muscle_mass, sleep_score, sleep_duration, readiness_score, steps, active_calories, total_calories_burned, rhr, hrv, active_minutes
      FROM health_metrics 
      WHERE user_id = ? AND date >= date('now', '-90 days')
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania historii pomiarów zdrowotnych.' });
  }
});

// Historia obwodów ciała
app.get('/api/body-measurements', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, date, chest, waist, hips, biceps, thigh 
      FROM body_measurements 
      WHERE user_id = ? 
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania obwodów ciała.' });
  }
});

// Zapisz/aktualizuj obwody ciała
app.post('/api/body-measurements', requireAuth, async (req, res) => {
  const { date, chest, waist, hips, biceps, thigh } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  try {
    await db.run(`
      INSERT INTO body_measurements (user_id, date, chest, waist, hips, biceps, thigh)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        chest = COALESCE(excluded.chest, chest),
        waist = COALESCE(excluded.waist, waist),
        hips = COALESCE(excluded.hips, hips),
        biceps = COALESCE(excluded.biceps, biceps),
        thigh = COALESCE(excluded.thigh, thigh)
    `, [
      req.user.id,
      date,
      chest ? Number(chest) : null,
      waist ? Number(waist) : null,
      hips ? Number(hips) : null,
      biceps ? Number(biceps) : null,
      thigh ? Number(thigh) : null
    ]);
    res.json({ success: true, message: 'Pomiary obwodów ciała zostały zapisane.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu obwodów ciała.' });
  }
});

// Usuń pomiar obwodu ciała
app.delete('/api/body-measurements/:id', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM body_measurements WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Pomiar obwodu ciała został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania pomiaru obwodu ciała.' });
  }
});


// 6b-1. Rozpoczęcie konfiguracji 2FA przez zalogowanego użytkownika
app.post('/api/user/setup-2fa', async (req, res) => {
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
app.post('/api/user/verify-2fa', async (req, res) => {
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
app.post('/api/user/disable-2fa', async (req, res) => {
  try {
    await db.run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`, [req.user.id]);
    res.json({ success: true, message: 'Dwuetapowa weryfikacja (2FA) została wyłączona.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd dezaktywacji 2FA.' });
  }
});

// 6c. Zmiana hasła użytkownika
app.post('/api/user/change-password', async (req, res) => {
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

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Brak uprawnień administratora.' });
}

// Pomocnicza funkcja do wysyłania e-maila przez Mailgun (zapisane w bazie danych app_config)
async function sendMailgunEmail({ to, subject, html }) {
  const configRows = await db.all(`SELECT * FROM app_config`);
  const config = {};
  configRows.forEach(r => {
    config[r.key] = r.value;
  });

  const apiKey = config.mailgun_api_key;
  const domain = config.mailgun_domain;
  const region = config.mailgun_region || 'us';
  const from = config.mailgun_from || `"Dietetyk AI" <noreply@${domain || 'dietetyk.ai'}>`;

  if (!apiKey || !domain) {
    throw new Error('Silnik e-mail (Mailgun) nie został jeszcze skonfigurowany przez administratora.');
  }

  const apiBase = region.toLowerCase() === 'eu'
    ? 'https://api.eu.mailgun.net/v3'
    : 'https://api.mailgun.net/v3';

  const url = `${apiBase}/${domain}/messages`;
  
  const formData = new URLSearchParams();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);

  const authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;

  console.log(`[MAILGUN] Wysyłanie e-maila do ${to} za pomocą domeny ${domain}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Błąd Mailgun API: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`[MAILGUN] Wysłano pomyślnie. ID: ${result.id}`);
  return result;
}

// 6d. Zmiana hasła po wymuszeniu (wersja bez autoryzacji sesji stałej)
app.post('/api/change-password-forced', async (req, res) => {
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
app.get('/api/invitation-status', async (req, res) => {
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
app.post('/api/register-invitation', async (req, res) => {
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
app.post('/api/register-public', async (req, res) => {
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

// 6g. Konfiguracja Mailgun (Admin)
app.get('/api/admin/config', requireAdmin, async (req, res) => {
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

app.post('/api/admin/config', requireAdmin, async (req, res) => {
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
app.get('/api/admin/users', requireAdmin, async (req, res) => {
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

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
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

app.post('/api/admin/users/:id/reset-2fa', requireAdmin, async (req, res) => {
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

app.post('/api/admin/users/:id/force-2fa', requireAdmin, async (req, res) => {
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

app.post('/api/admin/users/:id/force-password-change', requireAdmin, async (req, res) => {
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

app.post('/api/admin/invite', requireAdmin, async (req, res) => {
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

// Pomocnicza funkcja generująca i wysyłająca tygodniowy raport
async function sendWeeklySummaryForUser(userId, customEmail = null) {
  const user = await db.get(`SELECT username, email, role FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }

  // Pobranie danych z ostatnich 7 dni
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  const meals = await db.all(`
    SELECT * FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });

  const targetCalories = settings.target_calories || 2500;
  const targetProtein = settings.target_protein || 150;
  const targetCarbs = settings.target_carbs || 250;
  const targetFat = settings.target_fat || 80;
  const bmr = settings.bmr || 1800;

  // Obliczenie średnich żywieniowych
  let totalEatenCal = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
  meals.forEach(m => {
    totalEatenCal += m.calories;
    totalProtein += m.protein;
    totalCarbs += m.carbs;
    totalFat += m.fat;
  });

  // Obliczenie średnich zdrowotnych
  let totalSteps = 0, totalActiveCal = 0;
  let sleepScoreSum = 0, sleepScoreCount = 0;
  let readinessScoreSum = 0, readinessScoreCount = 0;
  let weightSum = 0, weightCount = 0;
  let fatRatioSum = 0, fatRatioCount = 0;
  let muscleMassSum = 0, muscleMassCount = 0;

  healthMetrics.forEach(h => {
    totalSteps += h.steps || 0;
    totalActiveCal += h.active_calories || 0;
    if (h.sleep_score !== null) {
      sleepScoreSum += h.sleep_score;
      sleepScoreCount++;
    }
    if (h.readiness_score !== null) {
      readinessScoreSum += h.readiness_score;
      readinessScoreCount++;
    }
    if (h.weight !== null) {
      weightSum += h.weight;
      weightCount++;
    }
    if (h.fat_ratio !== null) {
      fatRatioSum += h.fat_ratio;
      fatRatioCount++;
    }
    if (h.muscle_mass !== null) {
      muscleMassSum += h.muscle_mass;
      muscleMassCount++;
    }
  });

  const workoutsCount = healthMetrics.filter(h => (h.active_calories || 0) > 0).length;
  const numDays = 7;
  const avgEatenCalories = Math.round(totalEatenCal / numDays);
  const avgProtein = Math.round((totalProtein / numDays) * 10) / 10;
  const avgCarbs = Math.round((totalCarbs / numDays) * 10) / 10;
  const avgFat = Math.round((totalFat / numDays) * 10) / 10;

  const avgSteps = Math.round(totalSteps / numDays);
  const avgActiveCalories = Math.round(totalActiveCal / numDays);
  const avgTotalBurned = bmr + avgActiveCalories;
  const avgNetCalories = avgEatenCalories - avgTotalBurned;

  const avgSleepScore = sleepScoreCount > 0 ? Math.round(sleepScoreSum / sleepScoreCount) : null;
  const avgReadinessScore = readinessScoreCount > 0 ? Math.round(readinessScoreSum / readinessScoreCount) : null;
  const avgWeight = weightCount > 0 ? Math.round((weightSum / weightCount) * 10) / 10 : null;
  const avgFatRatio = fatRatioCount > 0 ? Math.round((fatRatioSum / fatRatioCount) * 10) / 10 : null;
  const avgMuscleMass = muscleMassCount > 0 ? Math.round((muscleMassSum / muscleMassCount) * 10) / 10 : null;

  // Generowanie porady AI
  let aiSummary = "Tygodniowy raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!";
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? apiKeyRow.value : null;
  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && (meals.length > 0 || totalActiveCal > 0 || sleepScoreCount > 0)) {
    try {
      const advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj tygodniowy raport żywieniowo-treningowy użytkownika ${user.username}:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Tygodniowe statystyki (średnie dzienne):
- Średnie dzienne spożycie energii: ${avgEatenCalories} kcal (Białko: ${avgProtein}g, Węglowodany: ${avgCarbs}g, Tłuszcz: ${avgFat}g)
- Średnia aktywność fizyczna (aktywne kalorie): ${avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${avgSteps}

Dane z Oura & Withings (średnie tygodniowe):
- Średni wynik snu (Sleep Score): ${avgSleepScore !== null ? avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${avgReadinessScore !== null ? avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${avgWeight !== null ? avgWeight + ' kg' : 'brak'}
- Średni procent tłuszczu: ${avgFatRatio !== null ? avgFatRatio + '%' : 'brak'}
- Średnia masa mięśniowa: ${avgMuscleMass !== null ? avgMuscleMass + ' kg' : 'brak'}

Napisz profesjonalny, zwięzły i motywujący tygodniowy raport w języku polskim. Skup się na:
1. Bilansie energetycznym (trzymanie celów).
2. Pokryciu makroskładników (ze szczególnym naciskiem na modyfikacje i sugestie dietetyczne, np. kiedy i jak dorzucić więcej białka w celu odbudowy mięśni lub jak zbilansować pozostałe makro).
3. Podsumowaniu aktywności treningowej, w tym szacunkowych strefach kardio po treningu (strefa spalania tłuszczu vs. wysoka intensywność tlenowa/beztlenowa) oszacowanych na podstawie spalonych aktywnych kalorii oraz wskaźników tętna spoczynkowego (RHR) i HRV z Oura.
4. Regeneracji i zmianach w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej).
5. Zakończ trzema konkretnymi rekomendacjami żywieniowo-treningowymi w punktach na nadchodzący tydzień.

Formatuj odpowiedź używając czytelnych akapitów, punktów i nagłówków. Pisz bezpośrednio do użytkownika.
`;
      const forceCustomKeyOnly = user.role !== 'admin';
      aiSummary = await generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly);
    } catch (err) {
      console.error('[API ERROR] Błąd generowania raportu tygodniowego AI:', err);
      aiSummary = 'Błąd podczas generowania podsumowania tygodniowego przez AI: ' + err.message;
    }
  }

  // Konwersja markdown z Gemini na HTML
  const formattedAiSummary = aiSummary
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\* ([^*]+)/g, '<li>$1</li>');

  // Budowanie maila HTML
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Tygodniowe Podsumowanie Dietetyk AI</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background-color: #0f172a;
          color: #f8fafc;
          margin: 0;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: #1e293b;
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 16px;
          padding: 30px;
        }
        h2 {
          color: #a78bfa;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .logo {
          font-size: 2.5rem;
          margin-bottom: 10px;
        }
        .title {
          font-size: 1.5rem;
          font-weight: 700;
          color: #38bdf8;
          margin: 0;
        }
        .section-title {
          font-size: 1.1rem;
          color: #c084fc;
          border-bottom: 1px solid rgba(192, 132, 252, 0.2);
          padding-bottom: 6px;
          margin-top: 24px;
          margin-bottom: 16px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
        }
        th, td {
          padding: 10px;
          text-align: left;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          color: #f8fafc;
        }
        th {
          color: #94a3b8;
          font-weight: 600;
          font-size: 0.85rem;
          text-transform: uppercase;
        }
        td {
          font-size: 0.95rem;
        }
        .ai-box {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          padding: 20px;
          line-height: 1.6;
          font-size: 0.95rem;
          color: #e2e8f0;
        }
        .footer {
          text-align: center;
          margin-top: 30px;
          padding-top: 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          font-size: 0.8rem;
          color: #64748b;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">Dietetyk AI: Podsumowanie Tygodniowe</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">Raport dla użytkownika <strong>${user.username}</strong></p>
        </div>

        <div class="section-title">📊 Twoje Statystyki (Średnia Dobowa)</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>Średnia</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Kalorie Spożyte</td>
              <td><strong>${avgEatenCalories} kcal</strong></td>
              <td>${targetCalories} kcal</td>
            </tr>
            <tr>
              <td>Białko</td>
              <td><strong>${avgProtein}g</strong></td>
              <td>${targetProtein}g</td>
            </tr>
            <tr>
              <td>Węglowodany</td>
              <td><strong>${avgCarbs}g</strong></td>
              <td>${targetCarbs}g</td>
            </tr>
            <tr>
              <td>Tłuszcz</td>
              <td><strong>${avgFat}g</strong></td>
              <td>${targetFat}g</td>
            </tr>
            <tr>
              <td>Kroki</td>
              <td><strong>${avgSteps}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Kalorie Spalone (Aktywne)</td>
              <td><strong>${avgActiveCalories} kcal</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Treningi w tygodniu</td>
              <td><strong>${workoutsCount}</strong></td>
              <td>-</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${formattedAiSummary}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;

  console.log(`[MAILGUN] Rozpoczęcie wysyłania tygodniowego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Tygodniowe Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// Pomocnicza funkcja generująca i wysyłająca codzienne podsumowanie
async function sendDailySummaryForUser(userId, customEmail = null) {
  const user = await db.get(`SELECT username, email, role FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }

  const date = getLocalDateString();

  // Pobranie celów
  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });

  const targetCalories = settings.target_calories || 2500;
  const targetProtein = settings.target_protein || 150;
  const targetCarbs = settings.target_carbs || 250;
  const targetFat = settings.target_fat || 80;
  const bmr = settings.bmr || 1800;

  // Posiłki z dzisiaj
  const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [userId, date]);
  let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const meals = mealRows.map(r => {
    let analysis = {};
    try {
      analysis = JSON.parse(r.analysis_json);
    } catch (e) {
      analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat };
    }
    totalEaten.calories += r.calories;
    totalEaten.protein += r.protein;
    totalEaten.carbs += r.carbs;
    totalEaten.fat += r.fat;
    return { id: r.id, raw_text: r.raw_text, ...analysis };
  });

  totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
  totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
  totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;

  // Dane zdrowotne z dzisiaj
  const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [userId, date]) || {
    steps: 0,
    active_calories: 0,
    total_calories_burned: 0,
    sleep_score: null,
    sleep_duration: null,
    sleep_deep: null,
    sleep_rem: null,
    readiness_score: null,
    hrv: null,
    rhr: null,
    temperature_deviation: null,
    weight: null,
    fat_ratio: null,
    muscle_mass: null
  };

  const activeCalories = health.active_calories || 0;
  const totalBurned = health.total_calories_burned || (bmr + activeCalories);
  const netCalories = totalEaten.calories - totalBurned;

  // Generowanie porady od Dietetyka AI na bazie dzisiejszych danych
  let aiAdvice = "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.";
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? apiKeyRow.value : null;
  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
    try {
      const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${user.username} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${targetCalories} kcal
- Cel Białka: ${targetProtein}g, Węglowodanów: ${targetCarbs}g, Tłuszczu: ${targetFat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${health.steps || 0}

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score + '/100' : 'Brak danych'} (Czas trwania: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms, Odchylenie temperatury ciała: ${health.temperature_deviation !== null ? health.temperature_deviation + ' °C' : 'brak'}
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${health.weight !== null ? health.weight + ' kg' : 'brak danych'}, Procent tłuszczu: ${health.fat_ratio !== null ? health.fat_ratio + '%' : 'brak danych'}, Masa mięśniowa: ${health.muscle_mass !== null ? health.muscle_mass + ' kg' : 'brak danych'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Napisz krótką, spersonalizowaną poradę dietetyczno-treningową (maksymalnie 4-5 zdań). Skup się na:
1. Analizie intensywności wysiłku i stref kardio po treningu na bazie aktywnych kalorii oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Sugerowaniu precyzyjnych zmian w diecie na bazie dzisiejszych posiłków i treningu (np. zalecenie dorzucenia większej ilości białka w celu wsparcia regeneracji włókien mięśniowych po ciężkim wysiłku beztlenowym lub redukcji węglowodanów w dni o niskim wysiłku aerobowym).
3. Uwzględnieniu gotowości Oura i trendów wagi/mięśni/tłuszczu z Withings.
Pisz bezpośrednio do użytkownika w języku polskim. Bądź konkretny, motywujący i merytoryczny.
`;

      const forceCustomKeyOnly = user.role !== 'admin';
      aiAdvice = await generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly);
      aiAdvice = aiAdvice.trim();
    } catch (aiErr) {
      console.error('[API ERROR] Błąd generowania porady AI do maila:', aiErr);
      aiAdvice = 'Błąd generowania analizy AI.';
    }
  }

  // Konwersja markdown z Gemini na HTML
  const formattedAiAdvice = aiAdvice
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\* ([^*]+)/g, '<li>$1</li>');

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Codzienne Podsumowanie Dietetyk AI</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background-color: #0f172a;
          color: #f8fafc;
          margin: 0;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: #1e293b;
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 16px;
          padding: 30px;
        }
        h2 {
          color: #a78bfa;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .logo {
          font-size: 2.5rem;
          margin-bottom: 10px;
        }
        .title {
          font-size: 1.5rem;
          font-weight: 700;
          color: #38bdf8;
          margin: 0;
        }
        .section-title {
          font-size: 1.1rem;
          color: #c084fc;
          border-bottom: 1px solid rgba(192, 132, 252, 0.2);
          padding-bottom: 6px;
          margin-top: 24px;
          margin-bottom: 16px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
        }
        th, td {
          padding: 10px;
          text-align: left;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          color: #f8fafc;
        }
        th {
          color: #94a3b8;
          font-weight: 600;
          font-size: 0.85rem;
          text-transform: uppercase;
        }
        td {
          font-size: 0.95rem;
        }
        .ai-box {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          padding: 20px;
          line-height: 1.6;
          font-size: 0.95rem;
          color: #e2e8f0;
        }
        .footer {
          text-align: center;
          margin-top: 30px;
          padding-top: 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          font-size: 0.8rem;
          color: #64748b;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">Dietetyk AI: Podsumowanie Codzienne</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">Raport z dnia <strong>${date}</strong> dla <strong>${user.username}</strong></p>
        </div>

        <div class="section-title">📊 Twoje Statystyki Dzisiejsze</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>Dzisiaj</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Kalorie Spożyte</td>
              <td><strong>${totalEaten.calories} kcal</strong></td>
              <td>${targetCalories} kcal</td>
            </tr>
            <tr>
              <td>Białko</td>
              <td><strong>${totalEaten.protein}g</strong></td>
              <td>${targetProtein}g</td>
            </tr>
            <tr>
              <td>Węglowodany</td>
              <td><strong>${totalEaten.carbs}g</strong></td>
              <td>${targetCarbs}g</td>
            </tr>
            <tr>
              <td>Tłuszcz</td>
              <td><strong>${totalEaten.fat}g</strong></td>
              <td>${targetFat}g</td>
            </tr>
            <tr>
              <td>Kroki</td>
              <td><strong>${health.steps || 0}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Kalorie Spalone (Aktywne)</td>
              <td><strong>${activeCalories} kcal</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Waga ciała</td>
              <td><strong>${health.weight !== null ? health.weight + ' kg' : 'brak'}</strong></td>
              <td>-</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${formattedAiAdvice}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;

  console.log(`[MAILGUN] Rozpoczęcie wysyłania codziennego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Codzienne Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// 6i. Wysyłanie podsumowania tygodniowego na e-mail (Mailgun)
app.post('/api/user/send-weekly-summary', async (req, res) => {
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
app.post('/api/user/send-daily-summary', async (req, res) => {
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

// 7. Pobranie kompletnego podsumowania (Dashboard)
app.get('/api/dashboard', async (req, res) => {
  const date = req.query.date || getLocalDateString();
  try {
    // Ustawienia celów
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    // Posiłki z dzisiaj
    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    const meals = mealRows.map(r => {
      let analysis = {};
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
      return { id: r.id, raw_text: r.raw_text, timestamp: r.timestamp, image_base64: r.image_base64, ...analysis };
    });

    // Zaokrąglenie makr zjedzonych
    totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
    totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
    totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;

    // Dane zdrowotne z Oura & Withings z wybranego dnia
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]) || {
      steps: 0,
      active_calories: 0,
      total_calories_burned: 0,
      sleep_score: null,
      sleep_duration: null,
      sleep_deep: null,
      sleep_rem: null,
      readiness_score: null,
      hrv: null,
      rhr: null,
      temperature_deviation: null,
      weight: null,
      fat_ratio: null,
      muscle_mass: null,
      active_minutes: 0,
      last_sync: null,
      ai_advice: null,
      ai_advice_generated_at: null
    };

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);

    // Pobierz najświeższe nie-null/nie-zero wartości dla wszystkich wskaźników zdrowotnych (jeśli wybrane są puste)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;
    let displaySteps = health.steps;
    let displayActiveCalories = health.active_calories;
    let displayTotalCaloriesBurned = health.total_calories_burned;
    let displaySleepScore = health.sleep_score;
    let displaySleepDuration = health.sleep_duration;
    let displaySleepDeep = health.sleep_deep;
    let displaySleepRem = health.sleep_rem;
    let displayReadinessScore = health.readiness_score;
    let displayHrv = health.hrv;
    let displayRhr = health.rhr;
    let displayTempDev = health.temperature_deviation;
    let displayActiveMinutes = health.active_minutes;

    if (displayWeight === null) {
      const row = await db.get(`SELECT weight FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWeight = row.weight;
    }
    if (displayFatRatio === null) {
      const row = await db.get(`SELECT fat_ratio FROM health_metrics WHERE user_id = ? AND fat_ratio IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayFatRatio = row.fat_ratio;
    }
    if (displayMuscleMass === null) {
      const row = await db.get(`SELECT muscle_mass FROM health_metrics WHERE user_id = ? AND muscle_mass IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayMuscleMass = row.muscle_mass;
    }
    if (!displaySteps || displaySteps === 0) {
      const row = await db.get(`SELECT steps FROM health_metrics WHERE user_id = ? AND steps IS NOT NULL AND steps > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySteps = row.steps;
    }
    if (!displayActiveCalories || displayActiveCalories === 0) {
      const row = await db.get(`SELECT active_calories FROM health_metrics WHERE user_id = ? AND active_calories IS NOT NULL AND active_calories > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayActiveCalories = row.active_calories;
    }
    if (!displayTotalCaloriesBurned || displayTotalCaloriesBurned === 0) {
      const row = await db.get(`SELECT total_calories_burned FROM health_metrics WHERE user_id = ? AND total_calories_burned IS NOT NULL AND total_calories_burned > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayTotalCaloriesBurned = row.total_calories_burned;
    }
    if (displaySleepScore === null || displaySleepScore === 0) {
      const row = await db.get(`SELECT sleep_score FROM health_metrics WHERE user_id = ? AND sleep_score IS NOT NULL AND sleep_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepScore = row.sleep_score;
    }
    if (displaySleepDuration === null || displaySleepDuration === 0) {
      const row = await db.get(`SELECT sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL AND sleep_duration > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDuration = row.sleep_duration;
    }
    if (displaySleepDeep === null || displaySleepDeep === 0) {
      const row = await db.get(`SELECT sleep_deep FROM health_metrics WHERE user_id = ? AND sleep_deep IS NOT NULL AND sleep_deep > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDeep = row.sleep_deep;
    }
    if (displaySleepRem === null || displaySleepRem === 0) {
      const row = await db.get(`SELECT sleep_rem FROM health_metrics WHERE user_id = ? AND sleep_rem IS NOT NULL AND sleep_rem > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepRem = row.sleep_rem;
    }
    if (displayReadinessScore === null || displayReadinessScore === 0) {
      const row = await db.get(`SELECT readiness_score FROM health_metrics WHERE user_id = ? AND readiness_score IS NOT NULL AND readiness_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayReadinessScore = row.readiness_score;
    }
    if (displayHrv === null || displayHrv === 0) {
      const row = await db.get(`SELECT hrv FROM health_metrics WHERE user_id = ? AND hrv IS NOT NULL AND hrv > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayHrv = row.hrv;
    }
    if (displayRhr === null || displayRhr === 0) {
      const row = await db.get(`SELECT rhr FROM health_metrics WHERE user_id = ? AND rhr IS NOT NULL AND rhr > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRhr = row.rhr;
    }
    if (displayTempDev === null) {
      const row = await db.get(`SELECT temperature_deviation FROM health_metrics WHERE user_id = ? AND temperature_deviation IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayTempDev = row.temperature_deviation;
    }
    if (!displayActiveMinutes || displayActiveMinutes === 0) {
      const row = await db.get(`SELECT active_minutes FROM health_metrics WHERE user_id = ? AND active_minutes IS NOT NULL AND active_minutes > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayActiveMinutes = row.active_minutes;
    }

    const activeCalories = displayActiveCalories || 0;
    const bmr = settings.bmr || 1800;
    const totalBurned = displayTotalCaloriesBurned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Generowanie porady od Dietetyka AI na bazie dzisiejszych danych (opcjonalne/throttled co 30 min)
    let aiAdvice = "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.";
    let hasValidCache = false;

    if (health && health.ai_advice) {
      aiAdvice = health.ai_advice;
      if (health.ai_advice_generated_at) {
        const lastGenerated = new Date(health.ai_advice_generated_at).getTime();
        if (Date.now() - lastGenerated < 30 * 60 * 1000) {
          hasValidCache = true;
        }
      }
    }

    if (!hasValidCache) {
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
      const userApiKey = apiKeyRow ? apiKeyRow.value : null;
      const forceCustomKeyOnly = req.user.role !== 'admin';
      const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));

      if (canUseAI && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
        try {
          const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${req.user.username} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${settings.target_calories} kcal
- Cel Białka: ${settings.target_protein}g, Węglowodanów: ${settings.target_carbs}g, Tłuszczu: ${settings.target_fat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${displaySteps || 0}

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'Brak danych'} (Czas trwania: ${displaySleepDuration || 0}h, Głęboki: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Odchylenie temperatury ciała: ${displayTempDev !== null ? displayTempDev + ' °C' : 'brak'}
- Wynik Gotowości (Readiness): ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${displayWeight !== null ? displayWeight + ' kg' : 'brak danych'}, Procent tłuszczu: ${displayFatRatio !== null ? displayFatRatio + '%' : 'brak danych'}, Masa mięśniowa: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'brak danych'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Napisz krótką, spersonalizowaną poradę dietetyczno-treningową (maksymalnie 4-5 zdań). Skup się na:
1. Analizie intensywności wysiłku i stref kardio po treningu na bazie aktywnych kalorii oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Sugerowaniu precyzyjnych zmian w diecie na bazie dzisiejszych posiłków i treningu (np. zalecenie dorzucenia większej ilości białka w celu wsparcia regeneracji włókien mięśniowych po ciężkim wysiłku beztlenowym lub redukcji węglowodanów w dni o niskim wysiłku aerobowym).
3. Uwzględnieniu gotowości Oura i trendów wagi/mięśni/tłuszczu z Withings.
Pisz bezpośrednio do użytkownika w języku polskim. Bądź konkretny, motywujący i merytoryczny.
`;

          aiAdvice = await generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly);
          aiAdvice = aiAdvice.trim();

          const nowStr = new Date().toISOString();
          await db.run(`
            INSERT INTO health_metrics (user_id, date, ai_advice, ai_advice_generated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, date) DO UPDATE SET
              ai_advice = excluded.ai_advice,
              ai_advice_generated_at = excluded.ai_advice_generated_at
          `, [req.user.id, date, aiAdvice, nowStr]);
        } catch (aiErr) {
          console.error('[API ERROR] Błąd generowania porady AI:', aiErr);
          if (!health || !health.ai_advice) {
            aiAdvice = 'Błąd generowania analizy AI. Spróbuj odświeżyć stronę za chwilę.';
          }
        }
      }
    }

    res.json({
      date,
      summary: {
        target_calories: settings.target_calories,
        target_protein: settings.target_protein,
        target_carbs: settings.target_carbs,
        target_fat: settings.target_fat,
        target_steps: isNaN(settings.target_steps) || !settings.target_steps ? 10000 : settings.target_steps,
        target_active_calories: isNaN(settings.target_active_calories) || !settings.target_active_calories ? 500 : settings.target_active_calories,
        target_sleep_duration: isNaN(settings.target_sleep_duration) || !settings.target_sleep_duration ? 7.2 : settings.target_sleep_duration,
        target_active_minutes: isNaN(settings.target_active_minutes) || !settings.target_active_minutes ? 30 : settings.target_active_minutes,
        bmr,
        calories_eaten: totalEaten.calories,
        calories_burned_active: activeCalories,
        calories_burned_total: totalBurned,
        net_calories: netCalories,
        eaten_protein: totalEaten.protein,
        eaten_carbs: totalEaten.carbs,
        eaten_fat: totalEaten.fat,
        steps: displaySteps || 0,
        workouts: [],
        last_sync: health.last_sync,
        sleep_score: displaySleepScore,
        sleep_duration: displaySleepDuration,
        sleep_deep: displaySleepDeep,
        sleep_rem: displaySleepRem,
        readiness_score: displayReadinessScore,
        hrv: displayHrv,
        rhr: displayRhr,
        temperature_deviation: displayTempDev,
        weight: displayWeight,
        fat_ratio: displayFatRatio,
        muscle_mass: displayMuscleMass,
        active_minutes: displayActiveMinutes || 0,
        has_oura: !!hasOuraRow,
        has_withings: !!hasWithingsRow
      },
      meals,
      aiAdvice
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania danych dashboardu.' });
  }
});

// Endpoint czatu z Dietetykiem AI
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, date, history } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Treść wiadomości jest wymagana.' });
  }

  const queryDate = date || getLocalDateString();

  try {
    // Pobierz cele użytkownika
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    const bmr = settings.bmr || 1800;

    // Pobierz dzisiejsze dane zdrowotne
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]) || {
      steps: 0,
      active_calories: 0,
      total_calories_burned: 0,
      sleep_score: null,
      sleep_duration: null,
      sleep_deep: null,
      sleep_rem: null,
      readiness_score: null,
      hrv: null,
      rhr: null,
      temperature_deviation: null,
      weight: null,
      fat_ratio: null,
      muscle_mass: null
    };

    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    mealRows.forEach(r => {
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
    });

    const activeCalories = health.active_calories || 0;
    const totalBurned = health.total_calories_burned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Pobierz najświeższe dane dla wagi, tłuszczu i mięśni (jeśli dzisiejsze są null)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;

    if (displayWeight === null) {
      const row = await db.get(`SELECT weight FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWeight = row.weight;
    }
    if (displayFatRatio === null) {
      const row = await db.get(`SELECT fat_ratio FROM health_metrics WHERE user_id = ? AND fat_ratio IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayFatRatio = row.fat_ratio;
    }
    if (displayMuscleMass === null) {
      const row = await db.get(`SELECT muscle_mass FROM health_metrics WHERE user_id = ? AND muscle_mass IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayMuscleMass = row.muscle_mass;
    }

    // Pobranie trendów z ostatnich 7 dni przed wybraną datą
    const pastDateLimit = new Date(new Date(queryDate).getTime() - 7 * 24 * 60 * 60 * 1000);
    const pastDateStr = pastDateLimit.toISOString().slice(0, 10);

    const historyMetrics = await db.all(`
      SELECT date, steps, active_calories, weight, sleep_score, sleep_duration, readiness_score
      FROM health_metrics
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    const historyMeals = await db.all(`
      SELECT date, raw_text, calories, protein, carbs, fat
      FROM meals
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    let weeklyTrendSummary = '';
    if (historyMetrics.length > 0 || historyMeals.length > 0) {
      weeklyTrendSummary = '\nHistoria i trendy użytkownika z ostatnich 7 dni (przed wybraną datą):\n';
      
      const mealsByDate = {};
      historyMeals.forEach(m => {
        if (!mealsByDate[m.date]) mealsByDate[m.date] = [];
        mealsByDate[m.date].push(m);
      });

      const allPastDates = new Set([...historyMetrics.map(hm => hm.date), ...Object.keys(mealsByDate)]);
      const sortedPastDates = Array.from(allPastDates).sort();

      sortedPastDates.forEach(dStr => {
        const hm = historyMetrics.find(h => h.date === dStr);
        const dayMeals = mealsByDate[dStr] || [];
        
        let dayLog = `- Data ${dStr}: `;
        if (hm) {
          const parts = [];
          if (hm.steps) parts.push(`Kroki: ${hm.steps}`);
          if (hm.active_calories) parts.push(`Kalorie aktywne: ${hm.active_calories} kcal`);
          if (hm.weight) parts.push(`Waga: ${hm.weight} kg`);
          if (hm.sleep_score) parts.push(`Sen: ${hm.sleep_score}/100`);
          if (hm.readiness_score) parts.push(`Gotowość: ${hm.readiness_score}/100`);
          dayLog += parts.join(', ');
        }
        if (dayMeals.length > 0) {
          const totalCal = dayMeals.reduce((sum, m) => sum + m.calories, 0);
          const totalP = dayMeals.reduce((sum, m) => sum + m.protein, 0);
          const totalC = dayMeals.reduce((sum, m) => sum + m.carbs, 0);
          const totalF = dayMeals.reduce((sum, m) => sum + m.fat, 0);
          dayLog += ` | Posiłki (${dayMeals.length}): łącznie zjedzone ${totalCal} kcal (B: ${totalP}g, W: ${totalC}g, T: ${totalF}g)`;
        }
        weeklyTrendSummary += dayLog + '\n';
      });
    }

    // Formatowanie historii czatu z tej sesji
    let historyContext = '';
    if (Array.isArray(history) && history.length > 0) {
      // Filtrowanie pustych wpisów
      const filteredHistory = history.filter(h => h.text && h.text.trim().length > 0);
      historyContext = '\nHistoria rozmowy w tej sesji (od najstarszej):\n' + filteredHistory.map(h => {
        const roleName = h.sender === 'user' ? 'Użytkownik' : 'Dietetyk AI';
        return `${roleName}: ${h.text}`;
      }).join('\n') + '\n';
    }

    // Pobierz klucz API użytkownika (jeśli posiada)
    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? apiKeyRow.value : null;

    const chatPrompt = `
Jesteś profesjonalnym, empatycznym i zorientowanym na cele dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Pomagasz użytkownikowi ${req.user.username} w optymalizacji jego diety, regeneracji, snu i treningów.

Informacje o profilu i celach użytkownika:
- Cel kaloryczny spożycia: ${settings.target_calories || 2000} kcal
- Cel makroskładników: Białko: ${settings.target_protein || 150}g, Węglowodany: ${settings.target_carbs || 250}g, Tłuszcz: ${settings.target_fat || 80}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualne statystyki użytkownika na dzień ${queryDate}:
- Spożycie: ${totalEaten.calories} kcal (B: ${totalEaten.protein}g, W: ${totalEaten.carbs}g, T: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Sumaryczny wydatek energetyczny: ${totalBurned} kcal (BMR + Aktywne)
- Bilans netto: ${netCalories} kcal
- Kroki: ${health.steps || 0}
- Waga: ${displayWeight || 'brak danych'} kg, % Tłuszczu: ${displayFatRatio || 'brak danych'}%, Masa mięśniowa: ${displayMuscleMass || 'brak danych'} kg
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score : 'brak danych'} (Czas: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score : 'brak danych'}
- Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms
${weeklyTrendSummary}
${historyContext}
Pytanie użytkownika: "${message}"

Odpowiedz zwięźle, merytorycznie i praktycznie w języku polskim (maksymalnie 3-4 krótkie akapity). Skup się na bezpośrednich zaleceniach odnoszących się do powyższych danych zdrowotnych użytkownika. Nawiąż do historii rozmowy lub trendów z ubiegłego tygodnia, jeśli to istotne i odpowiada na pytanie. Możesz używać formatowania markdown (listy wypunktowane, pogrubienia). Odpowiedź powinna być profesjonalna, życzliwa i motywująca.
`;

    const forceCustomKeyOnly = req.user.role !== 'admin';
    const aiResponse = await generateContentWithFallback(chatPrompt, false, null, userApiKey, forceCustomKeyOnly);
    res.json({ response: aiResponse.trim() });
  } catch (err) {
    console.error('[CHAT ERROR]', err);
    res.status(500).json({ error: 'Nie udało się uzyskać odpowiedzi od Dietetyka AI.' });
  }
});

// Serwowanie index.html dla wszystkich pozostałych tras (obsługa SPA w React)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Scheduler sprawdzający i wysyłający automatyczne podsumowania codzienne i tygodniowe
async function checkAndSendAutomatedSummaries() {
  try {
    const users = await db.all(`SELECT id, username, email FROM users WHERE status = 'active'`);
    const todayStr = getLocalDateString();
    
    const now = new Date();
    // getDay(): 0 (niedziela) do 6 (sobota). Mapujemy 0 na 7, pozostałe bez zmian.
    const currentDay = now.getDay() === 0 ? 7 : now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    console.log(`[SCHEDULER] Sprawdzanie harmonogramów podsumowań. Dzień tygodnia: ${currentDay}, Czas: ${currentTimeStr}, Data: ${todayStr}`);

    for (const user of users) {
      const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [user.id]);
      const settings = {};
      settingsRows.forEach(r => {
        settings[r.key] = r.value;
      });

      const enabled = settings.weekly_summary_enabled === '1'; // ogólna flaga włączenia podsumowań
      const scheduledDay = Number(settings.weekly_summary_day || 1); // domyślnie poniedziałek (1)
      const scheduledTime = settings.weekly_summary_time || '18:00';
      
      const lastWeeklySent = settings.last_weekly_summary_sent || '';
      const lastDailySent = settings.last_daily_summary_sent || '';

      if (enabled) {
        // --- 1. Podsumowanie Codzienne ---
        if (currentTimeStr >= scheduledTime) {
          if (lastDailySent !== todayStr) {
            console.log(`[SCHEDULER] Uruchamianie wysyłki codziennej dla ${user.username} (${user.email || 'brak e-maila'})`);
            if (user.email) {
              try {
                await sendDailySummaryForUser(user.id);
                // Zapisz informacje o wysłaniu w settings
                await db.run(`
                  INSERT INTO settings (user_id, key, value)
                  VALUES (?, 'last_daily_summary_sent', ?)
                  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                `, [user.id, todayStr]);
                console.log(`[SCHEDULER] Z powodzeniem wysłano codzienne podsumowanie dla ${user.username} i ustawiono last_daily_summary_sent na ${todayStr}`);
              } catch (sendErr) {
                console.error(`[SCHEDULER ERROR] Błąd podczas wysyłania codziennego dla ${user.username}:`, sendErr.message);
              }
            } else {
              console.warn(`[SCHEDULER WARNING] Nie można wysłać codziennego podsumowania dla ${user.username} - brak zdefiniowanego e-maila.`);
            }
          }
        }

        // --- 2. Podsumowanie Tygodniowe ---
        if (currentDay === scheduledDay) {
          if (currentTimeStr >= scheduledTime) {
            if (lastWeeklySent !== todayStr) {
              console.log(`[SCHEDULER] Uruchamianie wysyłki tygodniowej dla ${user.username} (${user.email || 'brak e-maila'})`);
              if (user.email) {
                try {
                  await sendWeeklySummaryForUser(user.id);
                  // Zapisz informacje o wysłaniu w settings
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_weekly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, todayStr]);
                  console.log(`[SCHEDULER] Z powodzeniem wysłano tygodniowe podsumowanie dla ${user.username} i ustawiono last_weekly_summary_sent na ${todayStr}`);
                } catch (sendErr) {
                  console.error(`[SCHEDULER ERROR] Błąd podczas wysyłania tygodniowego dla ${user.username}:`, sendErr.message);
                }
              } else {
                console.warn(`[SCHEDULER WARNING] Nie można wysłać tygodniowego podsumowania dla ${user.username} - brak zdefiniowanego e-maila.`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Błąd w checkAndSendAutomatedSummaries:', err);
  }
}

// Uruchomienie serwera
async function start() {
  await db.initDb();

  // Uruchomienie czyszczenia starych zdjęć przy starcie
  await db.cleanupOldImages();

  // Uruchomienie czyszczenia co 24 godziny
  setInterval(async () => {
    console.log('[CRON] Uruchomienie okresowego czyszczenia starych zdjęć...');
    await db.cleanupOldImages();
  }, 24 * 60 * 60 * 1000);

  // Uruchomienie synchronizacji i schedulera przy starcie
  try {
    await syncAllOura();
    await syncAllWithings();
    await checkAndSendAutomatedSummaries();
  } catch (err) {
    console.error('[SCHEDULER ERROR] Błąd uruchomienia przy starcie:', err);
  }

  // Oura: synchronizacja co 15 minut
  setInterval(async () => {
    await syncAllOura();
  }, 15 * 60 * 1000);

  // Withings: synchronizacja co 60 minut
  setInterval(async () => {
    await syncAllWithings();
  }, 60 * 60 * 1000);

  // Podsumowania email: sprawdzanie co 15 minut
  setInterval(async () => {
    await checkAndSendAutomatedSummaries();
  }, 15 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Serwer Dietetyk AI działa na porcie ${PORT}`);
  });
}

start();
