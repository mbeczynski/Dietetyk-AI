const crypto = require('crypto');
const db = require('../db');
const { PDF_REPORT_MAX_DAYS, PDF_REPORT_DEFAULT_DAYS } = require('./pdfReport');

// Udostępnianie raportu PDF linkiem (read-only, bez konta) - rozszerzenie eksportu PDF
// dla lekarza/dietetyka (services/pdfReport.js) o wariant "wyślij link" zamiast
// "pobierz i wyślij plik samodzielnie". Token w URL identyfikuje zarówno użytkownika,
// jak i konkretne udostępnienie - bez sesji/ciasteczka, bo odbiorca linku (lekarz/
// dietetyk) nie ma i nie powinien potrzebować konta w aplikacji.
//
// Wykorzystuje wyłącznie już istniejący mechanizm generowania PDF (buildHealthReportPdf) -
// żadnych nowych źródeł danych, żadnego kopiowania funkcji z konkurencji.

// Limity czasu ważności linku - krótkie domyślnie (link ma żyć tyle, co potrzeba na
// jedną wizytę/konsultację), ale z opcją dłuższego okresu, gdyby ktoś chciał wysłać
// link np. przed planowaną wizytą za kilka tygodni.
const VALIDITY_OPTIONS_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30
};
const DEFAULT_VALIDITY_KEY = '7d';

function resolveValidityHours(validityKey) {
  return VALIDITY_OPTIONS_HOURS[validityKey] || VALIDITY_OPTIONS_HOURS[DEFAULT_VALIDITY_KEY];
}

// Tworzy nowy link udostępniający raport PDF danego użytkownika. `days` to okres
// danych w samym raporcie (jak w buildHealthReportPdf) - niezależny od `validityKey`,
// czyli tego, jak długo sam LINK będzie działał.
async function createShareLink(userId, requestedDays, validityKey) {
  const days = Math.min(Math.max(parseInt(requestedDays, 10) || PDF_REPORT_DEFAULT_DAYS, 1), PDF_REPORT_MAX_DAYS);
  const validityHours = resolveValidityHours(validityKey);

  const token = 'share_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + validityHours * 60 * 60 * 1000).toISOString();

  await db.run(
    `INSERT INTO shared_reports (user_id, token, days, expires_at) VALUES (?, ?, ?, ?)`,
    [userId, token, days, expiresAt]
  );

  return { token, days, expiresAt };
}

// Lista udostępnień danego użytkownika (do wyświetlenia w Ustawieniach) - zarówno
// aktywne, jak i wygasłe/odwołane, żeby użytkownik widział historię, a nie tylko
// to, co aktualnie działa. Front decyduje, jak to pokazać (status liczony tu, żeby
// nie duplikować logiki "czy wygasł" w dwóch miejscach).
async function listSharesForUser(userId) {
  const rows = await db.all(
    `SELECT id, token, days, created_at, expires_at, revoked
     FROM shared_reports WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  const nowIso = new Date().toISOString();
  return rows.map((r) => ({
    id: r.id,
    days: r.days,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revoked: !!r.revoked,
    // Status do wyświetlenia - nie zwracamy samego tokenu ponownie (token jest
    // pokazywany użytkownikowi tylko raz, w momencie stworzenia linku - patrz
    // routes/account.js), żeby lista udostępnień nie była dodatkowym miejscem,
    // z którego można odzyskać działający link bez świadomości właściciela.
    status: r.revoked ? 'revoked' : (r.expires_at < nowIso ? 'expired' : 'active')
  }));
}

// Odwołanie linku - tylko właściciel (sprawdzane przez user_id w WHERE, nie tylko id)
// może odwołać swój link. Zwraca true, jeśli realnie coś zmieniono.
async function revokeShare(userId, shareId) {
  const result = await db.run(
    `UPDATE shared_reports SET revoked = 1 WHERE id = ? AND user_id = ?`,
    [shareId, userId]
  );
  return result.changes > 0;
}

// Weryfikacja tokenu z publicznego endpointu (routes/sharedReport.js) - zwraca dane
// potrzebne do wygenerowania PDF (userId, days) albo null, jeśli token nie istnieje,
// jest odwołany albo wygasł. Nie rozróżniamy tych trzech przypadków w odpowiedzi
// HTTP (patrz routes/sharedReport.js) - z punktu widzenia kogoś próbującego odgadnąć
// token, "nie znaleziono" i "wygasło" powinny wyglądać identycznie.
async function getActiveShareByToken(token) {
  const row = await db.get(
    `SELECT user_id, days, expires_at, revoked FROM shared_reports WHERE token = ?`,
    [token]
  );
  if (!row || row.revoked) return null;
  if (row.expires_at < new Date().toISOString()) return null;
  return { userId: row.user_id, days: row.days };
}

module.exports = {
  createShareLink,
  listSharesForUser,
  revokeShare,
  getActiveShareByToken,
  VALIDITY_OPTIONS_HOURS,
  DEFAULT_VALIDITY_KEY
};
