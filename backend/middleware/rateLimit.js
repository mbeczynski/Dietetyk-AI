// Prosty, bezzależnościowy globalny limiter zapytań API (w pamięci procesu),
// w tym samym stylu co backend/services/loginAttempts.js. Chroni przede
// wszystkim trasy korzystające z Gemini AI (analiza posiłków/zdjęć, czat
// dietetyka) oraz resztę /api przed nadużyciem (np. zalewem zapytań z jednego
// adresu IP, ręcznym lub zautomatyzowanym), zanim koszty/limity API zostaną
// wykorzystane lub baza danych zostanie przeciążona.
// Nie wymaga żadnej dodatkowej biblioteki npm (np. express-rate-limit).

const WINDOW_MS = 60 * 1000;   // okno czasowe liczenia zapytań
const MAX_REQUESTS = 120;      // maks. liczba zapytań /api na adres IP w oknie

const logger = require('../services/logger');

const hits = new Map(); // ip -> { count, windowStart }

function apiRateLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = hits.get(ip);

  if (!rec || (now - rec.windowStart) > WINDOW_MS) {
    rec = { count: 0, windowStart: now };
  }

  rec.count += 1;
  hits.set(ip, rec);

  if (rec.count > MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((rec.windowStart + WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSec, 1)));
    
    logger.security(
      `Przekroczono limit żądań API (${rec.count}/${MAX_REQUESTS})`,
      'RATE_LIMIT',
      { path: req.originalUrl, method: req.method },
      ip
    );

    return res.status(429).json({ error: 'Zbyt wiele żądań. Spróbuj ponownie za chwilę.' });
  }

  next();
}

// Okresowe czyszczenie wygasłych wpisów, aby mapa nie rosła w nieskończoność
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits.entries()) {
    if ((now - rec.windowStart) > WINDOW_MS) {
      hits.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// Dedykowany, ostrzejszy limiter per-użytkownik dla endpointów wysyłki e-maili
// testowych podsumowań (send-weekly/daily/monthly-summary). Te endpointy
// przyjmują dowolny `email` w body (zamierzona funkcja "wyślij testowy e-mail
// na wskazany adres") - bez tego limitu zalogowany użytkownik mógłby w kółko
// wysyłać e-maile na dowolny adres zewnętrzny, wykorzystując reputację/limit
// konta Mailgun do spamu. Limit jest per-user_id (nie per-IP jak globalny
// apiRateLimiter powyżej), bo to ten sam użytkownik wielokrotnie wywołujący
// endpoint stanowi tu ryzyko, niezależnie od adresu IP.
const SUMMARY_EMAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minut
const SUMMARY_EMAIL_MAX = 5;                    // maks. 5 wysyłek testowych / 10 min / użytkownik

const summaryEmailHits = new Map(); // userId -> { count, windowStart }

function summaryEmailLimiter(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) return next(); // requireAuth powinien to wyłapać wcześniej; tu tylko defensywnie

  const now = Date.now();
  let rec = summaryEmailHits.get(userId);

  if (!rec || (now - rec.windowStart) > SUMMARY_EMAIL_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
  }

  rec.count += 1;
  summaryEmailHits.set(userId, rec);

  if (rec.count > SUMMARY_EMAIL_MAX) {
    const retryAfterSec = Math.ceil((rec.windowStart + SUMMARY_EMAIL_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSec, 1)));

    logger.security(
      `Przekroczono limit wysyłki e-maili testowych (${rec.count}/${SUMMARY_EMAIL_MAX})`,
      'RATE_LIMIT_EMAIL',
      { email: req.body.email },
      req.ip || 'unknown',
      userId
    );

    return res.status(429).json({ error: 'Zbyt wiele wysłanych e-maili testowych. Spróbuj ponownie później.' });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, rec] of summaryEmailHits.entries()) {
    if ((now - rec.windowStart) > SUMMARY_EMAIL_WINDOW_MS) {
      summaryEmailHits.delete(userId);
    }
  }
}, 10 * 60 * 1000);

module.exports = { apiRateLimiter, WINDOW_MS, MAX_REQUESTS, summaryEmailLimiter };
