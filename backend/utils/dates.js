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

module.exports = {
  getLocalDateString,
  formatDateString,
  timestampToDateString
};
