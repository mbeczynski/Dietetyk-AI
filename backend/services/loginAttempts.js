// Prosta, bezzależnościowa blokada brute-force logowania / weryfikacji 2FA.
// Śledzi nieudane próby po kluczu (IP + login lub IP + tempToken) i blokuje
// dalsze próby na pewien czas po przekroczeniu limitu.
// Nie wymaga żadnej dodatkowej biblioteki npm.
//
// Stan trzymany jest w tabeli `login_attempts` w bazie SQLite (nie w pamięci
// procesu), żeby blokady przetrwały restart/redeploy kontenera backendu -
// inaczej atakujący mógłby ominąć blokadę, wywołując restart (np. crashując
// proces) albo czekając na rutynowy redeploy.

const db = require('../db');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;   // okno czasowe, w którym liczymy nieudane próby
const LOCKOUT_MS = 15 * 60 * 1000;  // czas blokady po przekroczeniu limitu

function buildKey(ip, identifier) {
  return `${ip || 'unknown'}::${(identifier || '').toString().toLowerCase()}`;
}

// Zwraca liczbę ms blokady pozostałych (0 jeśli nie zablokowano)
async function isLocked(ip, identifier) {
  const key = buildKey(ip, identifier);
  const rec = await db.get(`SELECT * FROM login_attempts WHERE key = ?`, [key]);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.locked_until && rec.locked_until > now) {
    return rec.locked_until - now;
  }
  return 0;
}

async function recordFailure(ip, identifier) {
  const key = buildKey(ip, identifier);
  const now = Date.now();
  const existing = await db.get(`SELECT * FROM login_attempts WHERE key = ?`, [key]);

  let count = 1;
  let firstAt = now;
  if (existing && (now - existing.first_at) <= WINDOW_MS) {
    count = existing.count + 1;
    firstAt = existing.first_at;
  }

  const lockedUntil = count >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0;

  if (count >= MAX_ATTEMPTS) {
    const logger = require('./logger');
    logger.security(`Blokada brute-force (lockout) dla: ${identifier}`, 'AUTH_LOCKOUT', { key, count }, ip);
  }

  await db.run(`
    INSERT INTO login_attempts (key, count, first_at, locked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET count = ?, first_at = ?, locked_until = ?
  `, [key, count, firstAt, lockedUntil, count, firstAt, lockedUntil]);
}

async function recordSuccess(ip, identifier) {
  await db.run(`DELETE FROM login_attempts WHERE key = ?`, [buildKey(ip, identifier)]);
}

// Okresowe czyszczenie wygasłych wpisów, aby tabela nie rosła w nieskończoność
setInterval(async () => {
  try {
    const now = Date.now();
    await db.run(`DELETE FROM login_attempts WHERE locked_until < ? AND first_at < ?`, [now, now - WINDOW_MS]);
  } catch (err) {
    console.error('[LOGIN ATTEMPTS] Błąd czyszczenia wygasłych wpisów:', err.message);
  }
}, 10 * 60 * 1000);

module.exports = {
  isLocked,
  recordFailure,
  recordSuccess,
  MAX_ATTEMPTS,
  LOCKOUT_MS
};
