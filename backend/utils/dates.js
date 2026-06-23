function getLocalDateString() {
  // UWAGA: poprzednio liczone przez d.getTimezoneOffset() - czyli strefę czasową
  // PROCESU NODE, nie aplikacji. Każda inna funkcja w tym pliku (timestampToDateString,
  // dateObjToLocalDateString) świadomie wymusza Europe/Warsaw przez Intl.DateTimeFormat,
  // bo aplikacja jest polska. Jeśli serwer/kontener działa w UTC (typowe dla hostingu),
  // ta funkcja - używana jako "dzisiejsza data" w dashboardzie, czacie, harmonogramie
  // podsumowań i synchronizacji - zwracała datę przesuniętą o godzinę różnicy strefowej
  // w oknie ok. 22:00-23:59 czasu Europe/Warsaw (gdy w UTC to już następny dzień) lub
  // 00:00-01:59 (gdy w UTC to jeszcze poprzedni dzień), rozjeżdżając się z resztą logiki dat.
  return dateObjToLocalDateString(new Date());
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

// Parsowanie daty z webhooka Apple Health (apka Health Auto Export). Format wysyłany
// przez apkę to "yyyy-MM-dd HH:mm:ss Z", np. "2024-01-01 12:00:00 +0100" - `new Date()`
// w Node nie parsuje tego niezawodnie (spacja zamiast 'T', offset bez dwukropka), więc
// normalizujemy string do poprawnego ISO 8601 przed parsowaniem.
function parseHealthAutoExportDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  let normalized = dateStr.trim();
  normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, '$1T$2');
  normalized = normalized.replace(/\s+([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Jak timestampToDateString, ale przyjmuje obiekt Date (a nie sekundy Unix) - używane
// przy grupowaniu wpisów z webhooka Apple Health na dni kalendarzowe w strefie Europe/Warsaw.
function dateObjToLocalDateString(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

module.exports = {
  getLocalDateString,
  formatDateString,
  timestampToDateString,
  parseHealthAutoExportDate,
  dateObjToLocalDateString
};
