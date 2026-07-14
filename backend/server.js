// Touch to trigger CI rebuild
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const db = require('./db');
const { PORT } = require('./config');
const logger = require('./services/logger');
const { requireAuth } = require('./middleware/auth');
const { apiRateLimiter } = require('./middleware/rateLimit');
const { runHourlySyncIfDue } = require('./scheduler');

const app = express();

// Ufaj nagłówkowi X-Forwarded-For z nginx (reverse proxy przed backendem w docker-compose),
// żeby req.ip pokazywał prawdziwy adres klienta, a nie adres kontenera nginx.
// Wymagane do poprawnego działania blokady brute-force per adres IP.
app.set('trust proxy', true);

// Middleware
// CORS ograniczony do skonfigurowanego adresu aplikacji (APP_URL) - wcześniej
// cors() bez opcji odpowiadał Access-Control-Allow-Origin dla KAŻDEJ domeny,
// co przy uwierzytelnianiu tokenem Bearer nie jest krytyczne (token nie jest
// ciastkiem wysyłanym automatycznie), ale niepotrzebnie ułatwiało zapytania
// z dowolnej, nieznanej strony. W lokalnym dev (brak APP_URL) zostaje otwarte,
// żeby nie blokować pracy na różnych portach/localhost.
const allowedOrigin = process.env.APP_URL;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));
// Limit zwiększony z domyślnych 100kb - webhook Apple Health (Health Auto Export,
// patrz routes/appleHealth.js) przy eksporcie Treningów z włączonymi "Danymi Trasy"
// (GPS) za dłuższy okres wysyła duże payloady JSON, które przekraczały domyślny
// limit i kończyły się błędem 413 "Nieprawidłowe żądanie" (patrz centralny handler
// błędów poniżej).
app.use(express.json({ limit: '20mb' }));

// Domyślny format 'dev' morgana loguje pełny URL żądania WŁĄCZNIE z query stringiem.
// To problem, bo część endpointów (np. /api/invitation-status?token=...) przyjmuje
// wrażliwe wartości właśnie w query stringu - taki token trafiałby w czystym tekście
// do logów kontenera. Tokeny sesji (Google OAuth) już nie podróżują w query stringu
// (patrz routes/auth.js - przekazywane we fragmencie URL #, którego serwer nigdy nie
// widzi), ale to dodatkowa warstwa obrony "w głąb" (defense in depth) na wypadek
// innych/przyszłych parametrów tego typu w query stringu.
morgan.token('safe-url', (req) => {
  const url = req.originalUrl || req.url || '';
  return url
    .replace(/([?&])(token|code|state|access_token|refresh_token|client_secret|secret|key)=[^&]+/gi, '$1$2=%5Bredacted%5D')
    // Webhook Apple Health (routes/appleHealth.js) przyjmuje sync_token jako SEGMENT
    // ŚCIEŻKI (/api/integrations/apple-health/:syncToken), nie jako parametr query -
    // powyższy replace na query stringu go nie obejmuje, więc token lądował w logach
    // w czystym tekście. Redagujemy go tu osobno, niezależnie od długości/formatu tokenu.
    .replace(/(\/api\/integrations\/apple-health\/)[^/?]+/i, '$1%5Bredacted%5D');
});
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));

// Serwowanie plików statycznych frontendu w trybie produkcyjnym
app.use(express.static(path.join(__dirname, 'public')));

// Globalny limiter zapytań (chroni m.in. trasy korzystające z Gemini AI i resztę /api
// przed nadużyciem) - zamontowany PRZED requireAuth, żeby limitować również próby
// logowania, nie tylko zapytania zalogowanych.
// UWAGA: musi być zamontowany PRZED publicznym health-checkiem i webhookiem Apple Health
// poniżej, NIE po nich - obie te trasy też zaczynają się od /api/, a middleware Express
// wykonuje się w kolejności rejestracji. Webhook Apple Health w szczególności jest
// autoryzowany tylko tokenem w adresie URL (sync_token) - bez limitera zamontowanego
// PRZED nim, ten endpoint był całkowicie pozbawiony ochrony przed zalewem zapytań/
// próbami odgadnięcia poprawnego tokenu, mimo że kod i komentarz niżej zawsze zakładały,
// że limiter obejmuje "resztę /api", w tym tę trasę.
app.use('/api', apiRateLimiter);

// Publiczny health-check (BEZ autoryzacji sesyjnej) - musi być zamontowany PRZED
// `app.use('/api', requireAuth)` poniżej, inaczej Docker/CI dostałby 401
// zamiast realnego statusu aplikacji. Limit 120 zapytań/min/IP z limitera powyżej
// jest na tyle wysoki, że nie zakłóca typowych, częstych odpytań healthchecku.
app.use(require('./routes/healthcheck'));

// Webhook Apple Health (apka Health Auto Export) - również musi być zamontowany PRZED
// requireAuth, ponieważ ma własną autoryzację per-żądanie (sync_token w adresie URL,
// patrz routes/appleHealth.js), a nie sesję/ciasteczko jak resztę /api/.
app.use(require('./routes/appleHealth'));

// Publiczny, nieuwierzytelniony odbiór udostępnionego raportu PDF (Produkt:
// udostępnianie raportu linkiem) - z tych samych powodów musi być zamontowany PRZED
// requireAuth: token w adresie URL (patrz routes/sharedReport.js i
// services/sharedReports.js) jest jedyną autoryzacją tego endpointu, bo odbiorca
// linku (lekarz/dietetyk) nie ma konta w aplikacji.
app.use(require('./routes/sharedReport'));

// Zabezpieczenie wszystkich tras /api/ za pomocą middleware
app.use('/api', requireAuth);

// --- TRASY API (zamontowane jako routery, każdy definiuje pełne ścieżki /api/...) ---
app.use(require('./routes/auth'));
app.use(require('./routes/meals'));
app.use(require('./routes/account'));
app.use(require('./routes/integrations'));
app.use(require('./routes/health'));
app.use(require('./routes/dayEvents'));
app.use(require('./routes/admin'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/chat'));

// Serwowanie index.html dla wszystkich pozostałych tras (obsługa SPA w React)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralny handler błędów - musi być zarejestrowany jako ostatni middleware.
// Zapewnia, że błędy nieobsłużone w trasach (np. niepoprawny JSON w żądaniu,
// rzucony przez express.json()) zwracają czysty JSON zamiast domyślnej strony
// błędu Express ze stack trace'em i ścieżkami plików serwera.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  
  const status = err.status || err.statusCode || 500;
  const level = status >= 500 ? 'ERROR' : 'WARN';
  
  logger[level.toLowerCase()](
    `Błąd HTTP ${status}: ${err.message}`,
    'HTTP_SERVER',
    err,
    req.ip,
    req.user ? req.user.id : null
  );

  res.status(status).json({ error: 'Nieprawidłowe żądanie.' });
});

// Uruchomienie serwera
async function start() {
  await db.initDb();

  // Uruchomienie czyszczenia starych zdjęć, logów i wygasłych sesji przy starcie
  await db.cleanupExpiredSessions();
  await db.cleanupOldImages();
  await db.cleanupOldLogs();

  // Pierwsza kopia zapasowa bazy danych przy starcie (patrz db.js, backupDatabase) -
  // dzięki temu kopia istnieje od razu, a nie tylko po 24h działania kontenera.
  await db.backupDatabase();

  // Uruchomienie czyszczenia i kopii zapasowej co 24 godziny
  setInterval(async () => {
    console.log('[CRON] Uruchomienie okresowego czyszczenia starych zdjęć, logów i wygasłych sesji...');
    await db.cleanupExpiredSessions();
    await db.cleanupOldImages();
    await db.cleanupOldLogs();
  }, 24 * 60 * 60 * 1000);

  setInterval(async () => {
    console.log('[CRON] Uruchomienie okresowej kopii zapasowej bazy danych...');
    await db.backupDatabase();
  }, 24 * 60 * 60 * 1000);

  // Synchronizacja danych (Oura, Withings) oraz sprawdzanie podsumowań: co godzinę,
  // tylko w oknie 5:00-22:00. Sprawdzamy co 5 minut, czy minęła pełna godzina
  // zegarowa i czy jesteśmy w oknie aktywności - dzięki temu działa też odpornie
  // na restart serwera w trakcie dnia (zsynchronizuje się od razu po starcie).
  await runHourlySyncIfDue();
  setInterval(runHourlySyncIfDue, 5 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Serwer Dietetyk AI działa na porcie ${PORT}`);
  });
}

start();

// Globalne przechwytywanie błędów procesu
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception (nieobsłużony wyjątek): ${err.message}`, 'SYSTEM', err);
  // Dajemy logom czas na zapisanie się przed wyjściem z procesu
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    `Unhandled Rejection (nieobsłużona obietnica): ${reason}`,
    'SYSTEM',
    reason instanceof Error ? reason : new Error(String(reason))
  );
});
