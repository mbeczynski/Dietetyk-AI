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

// Formatowanie daty YYYY-MM-DD.
// UWAGA: poprzednio liczone przez dateObj.getFullYear()/getMonth()/getDate() - strefa
// czasowa PROCESU NODE, nie Europe/Warsaw. services/sync.js używa tej funkcji do budowania
// kluczy dat (metricsByDate) dla danych z Oura, której pole `day` jest podawane w lokalnej
// dacie użytkownika/urządzenia. Na serwerze działającym w UTC, w oknie nocnym czasu polskiego,
// klucz wyliczony tu nie zgadzał się z kluczem z Oury i dane danego dnia gubiły się po cichu
// (metricsByDate[dateStr] było undefined). Delegujemy do dateObjToLocalDateString, która
// poprawnie wymusza Europe/Warsaw - tak jak resztę funkcji w tym pliku.
function formatDateString(dateObj) {
  return dateObjToLocalDateString(dateObj);
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

// Zwraca "zegarowe" wartości dnia tygodnia/godziny/minuty w strefie Europe/Warsaw,
// niezależnie od strefy czasowej procesu Node. Potrzebne wszędzie, gdzie harmonogram
// (scheduler.js) porównuje aktualny czas z czasem ustawionym przez użytkownika
// (np. "wyślij podsumowanie w poniedziałek 18:00") - te ustawienia są w czasie polskim,
// a goła `new Date().getHours()/getDay()` zwraca czas strefy serwera (na hostingu
// typowo UTC), co przy serwerze w UTC przesuwało harmonogram o 1-2h względem
// intencji użytkownika. Trik: sformatuj datę w Europe/Warsaw, a potem zbuduj z tych
// składowych nowy Date metodą Date.UTC - dzięki temu gołe gettery getUTCDay()/
// getUTCHours()/getUTCMinutes() na zwróconym obiekcie dają wartości zegara warszawskiego,
// bez względu na to w jakiej strefie działa proces Node.
function getWarsawWallClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });

  return new Date(Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  ));
}

module.exports = {
  getLocalDateString,
  formatDateString,
  timestampToDateString,
  parseHealthAutoExportDate,
  dateObjToLocalDateString,
  getWarsawWallClock
};
