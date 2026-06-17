// Prosta, bezzależnościowa blokada brute-force (w pamięci procesu).
// Śledzi nieudane próby logowania / weryfikacji 2FA po kluczu (IP + login lub IP + tempToken)
// i blokuje dalsze próby na pewien czas po przekroczeniu limitu.
// Nie wymaga żadnej dodatkowej biblioteki npm.

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;   // okno czasowe, w którym liczymy nieudane próby
const LOCKOUT_MS = 15 * 60 * 1000;  // czas blokady po przekroczeniu limitu

const attempts = new Map(); // key -> { count, firstAt, lockedUntil }

function buildKey(ip, identifier) {
  return `${ip || 'unknown'}::${(identifier || '').toString().toLowerCase()}`;
}

// Zwraca liczbę ms blokady pozostałych (0 jeśli nie zablokowano)
function isLocked(ip, identifier) {
  const key = buildKey(ip, identifier);
  const rec = attempts.get(key);
  if (!rec) return 0;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return rec.lockedUntil - Date.now();
  }
  return 0;
}

function recordFailure(ip, identifier) {
  const key = buildKey(ip, identifier);
  const now = Date.now();
  let rec = attempts.get(key);

  if (!rec || (now - rec.firstAt) > WINDOW_MS) {
    rec = { count: 0, firstAt: now, lockedUntil: 0 };
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }

  attempts.set(key, rec);
}

function recordSuccess(ip, identifier) {
  attempts.delete(buildKey(ip, identifier));
}

// Okresowe czyszczenie wygasłych wpisów, aby mapa nie rosła w nieskończoność
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts.entries()) {
    const stillLocked = rec.lockedUntil && rec.lockedUntil > now;
    const withinWindow = (now - rec.firstAt) <= WINDOW_MS;
    if (!stillLocked && !withinWindow) {
      attempts.delete(key);
    }
  }
}, 10 * 60 * 1000);

module.exports = {
  isLocked,
  recordFailure,
  recordSuccess,
  MAX_ATTEMPTS,
  LOCKOUT_MS
};
