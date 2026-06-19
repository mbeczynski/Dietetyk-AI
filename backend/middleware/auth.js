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
    req.path === '/auth/google/callback'
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

    // Przedłuż sesję o 7 dni
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`, [nextWeek, token]);

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
