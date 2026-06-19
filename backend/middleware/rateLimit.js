// Prosty, bezzależnościowy globalny limiter zapytań API (w pamięci procesu),
// w tym samym stylu co backend/services/loginAttempts.js. Chroni przede
// wszystkim trasy korzystające z Gemini AI (analiza posiłków/zdjęć, czat
// dietetyka) oraz resztę /api przed nadużyciem (np. zalewem zapytań z jednego
// adresu IP, ręcznym lub zautomatyzowanym), zanim koszty/limity API zostaną
// wykorzystane lub baza danych zostanie przeciążona.
// Nie wymaga żadnej dodatkowej biblioteki npm (np. express-rate-limit).

const WINDOW_MS = 60 * 1000;   // okno czasowe liczenia zapytań
const MAX_REQUESTS = 120;      // maks. liczba zapytań /api na adres IP w oknie

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

module.exports = { apiRateLimiter, WINDOW_MS, MAX_REQUESTS };
