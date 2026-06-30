const db = require('../db');

// Etykiety typów zdarzeń dnia (Tag dnia) - muszą być zgodne z VALID_TYPES w
// routes/dayEvents.js. Trzymane tu osobno, bo ten plik jest importowany przez
// prompty AI (dashboard.js, chat.js), a routes/dayEvents.js przez CRUD endpointy -
// rozdzielenie unika cyklicznego importu routera tam, gdzie potrzebny jest tylko odczyt.
const DAY_EVENT_TYPE_LABELS = {
  illness: 'Choroba',
  vacation: 'Wakacje/urlop',
  late_sleep: 'Późne zaśnięcie'
};

// Zdarzenia dnia użytkownika nakładające się na podany zakres dat (włącznie) -
// używane do (a) wykluczania tagowanych dni z baseline w insightach (patrz
// getExcludedDates w dashboard.js) i (b) wzbogacenia kontekstu promptów AI
// poniżej, żeby AI nie traktowało nietypowych dni jako normalnego wzorca.
async function getDayEventsInRange(userId, startDate, endDate) {
  return db.all(
    `SELECT type, start_date, end_date, note FROM day_events
     WHERE user_id = ? AND end_date >= ? AND start_date <= ?
     ORDER BY start_date ASC`,
    [userId, startDate, endDate]
  );
}

// Formatuje zdarzenia dnia do zwartego opisu po polsku do wstrzyknięcia w prompt AI.
// Zwraca pusty string, gdy nie ma żadnych zdarzeń w zakresie - żeby nie dodawać
// pustej/zbędnej sekcji do promptu na większości dni (gdzie użytkownik nic nie oznaczył).
function formatDayEventsForPrompt(events) {
  if (!events || events.length === 0) return '';
  const lines = events.map(ev => {
    const label = DAY_EVENT_TYPE_LABELS[ev.type] || ev.type;
    const range = ev.start_date === ev.end_date ? ev.start_date : `${ev.start_date} – ${ev.end_date}`;
    return `- ${label}: ${range}${ev.note ? ` (notatka użytkownika: ${ev.note})` : ''}`;
  });
  return `\nDni oznaczone przez użytkownika jako "Tag dnia" (specjalny kontekst) w analizowanym okresie:\n${lines.join('\n')}\nWAŻNE: jeśli dane z powyższych dni odbiegają od normy, weź pod uwagę ten kontekst - NIE traktuj ich jako typowy wzorzec użytkownika i nie buduj na ich podstawie rekomendacji korygujących dietę/trening/sen (np. wyższe kalorie czy gorszy sen w trakcie wakacji, podniesione tętno/gorsze parametry przy chorobie, gorszy sen po nocy z bardzo późnym zaśnięciem - to oczekiwane, już wyjaśnione wyjątki, nie sygnał do zmiany planu).\n`;
}

module.exports = { getDayEventsInRange, formatDayEventsForPrompt, DAY_EVENT_TYPE_LABELS };
