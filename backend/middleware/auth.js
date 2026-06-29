const db = require('../db');

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
    req.path === '/auth/withings/callback' ||
    req.path === '/auth/google-fit/callback' ||
    req.path === '/auth/google' ||
    req.path === '/auth/google/callback' ||
    // Trasy INICJUJĄCE połączenie z Oura/Withings/Google Fit oraz linkowanie konta
    // Google (frontend wywołuje je przez window.location.href, bo tylko nawigacja
    // najwyższego poziomu może przekierować przeglądarkę do ekranu zgody dostawcy
    // OAuth - fetch() z nagłówkiem Authorization nie da takiego przekierowania).
    // Token trafia więc do nich przez ?token= w query, NIE przez nagłówek Bearer.
    // Każda z tych 4 tras sama waliduje req.query.token względem tabeli sessions
    // (patrz routes/integrations.js i routes/auth.js) - nie korzystają z req.user,
    // więc wymaganie tu nagłówka Authorization tylko je blokowało (regresja
    // wprowadzona razem z usunięciem ogólnego fallbacku query.token powyżej).
    req.path === '/auth/oura' ||
    req.path === '/auth/withings' ||
    req.path === '/auth/google-fit' ||
    req.path === '/auth/google/link'
  ) {
    return next();
  }

  // Token akceptujemy WYŁĄCZNIE z nagłówka Authorization. Wcześniej istniał tu
  // fallback na req.query.token, ale token sesji w query stringu trafiał
  // niezaszyfrowany do logów morgan('dev') (logującego pełny URL żądania) oraz
  // do historii przeglądarki/nagłówka Referer. Front-end (App.jsx) i tak zawsze
  // wysyła token przez nagłówek Bearer - fallback był martwym kodem zwiększającym
  // powierzchnię ataku, nie realnie wykorzystywaną funkcją.
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    token = authHeader.replace('Bearer ', '');
  }

  if (!token) {
    return res.status(401).json({ error: 'Brak autoryzacji. Zaloguj się.' });
  }
  try {
    const session = await db.get(`
      SELECT s.*, u.username, u.totp_enabled, u.role, u.first_name, u.last_name
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

    // Przedłuż sesję o 7 dni tylko, jeśli do wygaśnięcia zostało mniej niż 6 dni
    // (zapobiega to ciągłym zapisom w SQLite przy każdym zapytaniu API, co mogło
    // powodować locki bazy SQLITE_BUSY przy równoległych żądaniach z dashboardu).
    const expiresAtMs = new Date(session.expires_at.replace(' ', 'T') + 'Z').getTime();
    const nowMs = Date.now();
    const remainingTimeMs = expiresAtMs - nowMs;
    const sixDaysInMs = 6 * 24 * 60 * 60 * 1000;

    if (remainingTimeMs < sixDaysInMs) {
      const nextWeek = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`, [nextWeek, token]);
    }

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
      // Imię/nazwisko (opcjonalne, ustawiane w Ustawieniach) - używane do
      // personalizacji zwrotów AI dietetyka ("Cześć Marcin" zamiast username).
      first_name: session.first_name,
      last_name: session.last_name
    };
    next();
  } catch (err) {
    console.error('Błąd w middleware requireAuth:', err);
    res.status(500).json({ error: 'Błąd autoryzacji serwera.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Brak uprawnień administratora.' });
}

module.exports = {
  requireAuth,
  requireAdmin
};
