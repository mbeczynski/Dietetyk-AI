function getLocalDateString() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000; // offset w ms
  const localISOTime = (new Date(d.getTime() - tzOffset)).toISOString().slice(0, 10);
  return localISOTime;
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
