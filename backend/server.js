const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const db = require('./db');
const { PORT } = require('./config');
const { requireAuth } = require('./middleware/auth');
const { runHourlySyncIfDue } = require('./scheduler');

const app = express();

// Ufaj nagłówkowi X-Forwarded-For z nginx (reverse proxy przed backendem w docker-compose),
// żeby req.ip pokazywał prawdziwy adres klienta, a nie adres kontenera nginx.
// Wymagane do poprawnego działania blokady brute-force per adres IP.
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Serwowanie plików statycznych frontendu w trybie produkcyjnym
app.use(express.static(path.join(__dirname, 'public')));

// Publiczny health-check (BEZ autoryzacji) - musi być zamontowany PRZED
// `app.use('/api', requireAuth)` poniżej, inaczej Docker/CI dostałby 401
// zamiast realnego statusu aplikacji.
app.use(require('./routes/healthcheck'));

// Zabezpieczenie wszystkich tras /api/ za pomocą middleware
app.use('/api', requireAuth);

// --- TRASY API (zamontowane jako routery, każdy definiuje pełne ścieżki /api/...) ---
app.use(require('./routes/auth'));
app.use(require('./routes/meals'));
app.use(require('./routes/account'));
app.use(require('./routes/integrations'));
app.use(require('./routes/health'));
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
  console.error('[ERROR] Nieobsłużony błąd żądania:', err.message);
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ error: 'Nieprawidłowe żądanie.' });
});

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
