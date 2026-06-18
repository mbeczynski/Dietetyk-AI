const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseHealthAutoExportDate, dateObjToLocalDateString } = require('../utils/dates');

// Webhook odbierający dane z apki "Health Auto Export" (iOS) - bridge między Apple Health
// a naszym backendem (HealthKit nie ma publicznego API w chmurze, więc potrzebny jest
// pośrednik działający na telefonie, patrz https://github.com/Lybron/health-auto-export).
//
// AUTORYZACJA: ten endpoint NIE używa sesji/ciasteczek (apka na telefonie wysyła żądanie
// w tle, bez przeglądarki) - identyfikujemy użytkownika przez jego unikalny `sync_token`
// (kolumna users.sync_token, już od dawna obecna w bazie, widoczna w Ustawieniach) wpisany
// wprost w URL webhooka. Dlatego ten router MUSI być zamontowany w server.js PRZED
// `app.use('/api', requireAuth)` - tak samo jak routes/healthcheck.js.
//
// REKONCYLIACJA Z OURA: Oura Ring też dostarcza steps/active_calories/total_calories
// (services/sync.js), ale z opóźnieniem (dane dobowe finalizują się zwykle następnego
// ranka - patrz wcześniejsza diagnoza przez scripts/check-oura-api.sh). Apple Health
// dostarcza te dane prawie od razu, ale traktujemy Oura jako źródło bardziej autorytatywne.
// Kolumna health_metrics.activity_source ('oura' | 'apple') pamięta, kto ostatnio
// zapisał dane aktywności dla danej daty:
//   - syncOura (services/sync.js) ZAWSZE nadpisuje i ustawia activity_source='oura',
//     gdy faktycznie ma dane aktywności dla tej daty.
//   - Ten webhook NIGDY nie nadpisuje wiersza, który już ma activity_source='oura'
//     (patrz warunek CASE w zapytaniu UPDATE poniżej) - więc gdy Oura "dojedzie"
//     z prawdziwymi danymi, Apple Health już nie nadpisze ich z powrotem.
//
// FORMAT PAYLOADU (Health Auto Export, "Automatyzacja typu REST API"):
//   { "data": { "metrics": [ { "name": "step_count", "units": "steps",
//       "data": [ { "date": "2026-06-18 14:00:00 +0200", "qty": 1234 }, ... ] }, ... ] } }
// Pole "name" to zawsze snake_case identyfikator metryki (np. "step_count",
// "active_energy", "basal_energy_burned", "apple_exercise_time") - NIE wyświetlana
// nazwa z UI apki (np. "Step Count"). Potwierdzone na podstawie przykładowych
// payloadów z dokumentacji/community (m.in. ladvien.com, irvinlim/apple-health-ingester).
//
// Obsługujemy tylko metryki potrzebne do bilansu kalorycznego (kroki, kalorie, minuty
// aktywności) - inne metryki w payloadzie (np. tętno, sen) są po prostu ignorowane,
// nie traktujemy ich jako błąd.

const KJ_TO_KCAL = 1 / 4.184;

// Health Auto Export może wysyłać energię w "kJ" albo "kcal" w zależności od ustawień
// regionalnych jednostek na telefonie użytkownika - zawsze konwertujemy do kcal.
function toKcal(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'kj' || u === 'kilojoule' || u === 'kilojoules') {
    return qty * KJ_TO_KCAL;
  }
  return qty;
}

// Mapowanie nazw metryk Health Auto Export -> nasze pola w health_metrics.
// `field` to nasz wewnętrzny bucket (patrz `byDate` poniżej), nie nazwa kolumny SQL 1:1 -
// total_calories_burned liczymy jako suma active_calories + basal_calories.
const METRIC_FIELD_MAP = {
  step_count: { field: 'steps', convert: (qty) => qty },
  active_energy: { field: 'active_calories', convert: toKcal },
  basal_energy_burned: { field: 'basal_calories', convert: toKcal },
  apple_exercise_time: { field: 'active_minutes', convert: (qty) => qty }
};

router.post('/api/integrations/apple-health/:syncToken', async (req, res) => {
  try {
    const { syncToken } = req.params;
    if (!syncToken || !syncToken.trim()) {
      return res.status(401).json({ error: 'Brak tokenu synchronizacji w adresie webhooka.' });
    }

    const user = await db.get(`SELECT id FROM users WHERE sync_token = ?`, [syncToken.trim()]);
    if (!user) {
      // Celowo ten sam, generyczny komunikat jak przy braku tokenu - nie chcemy ujawniać,
      // czy podany token kiedykolwiek istniał.
      return res.status(404).json({ error: 'Nieznany token synchronizacji.' });
    }

    // Automatyzacja z "Typ danych: Treningi" (Workouts) wysyła payload w INNYM formacie
    // niż automatyzacja ogólnych metryk zdrowia - dane są w polu data.workouts[], a nie
    // data.metrics[] (potwierdzone na podstawie ręcznego eksportu CSV "Workouts-*.csv":
    // kolumny Workout Type/Start/End/Aktywna Energia (kJ)/Energia Spoczynkowa (kJ)/...).
    // Nie znamy jeszcze dokładnych nazw pól w wersji JSON tego formatu, więc na razie
    // NIE wyciągamy z niego danych (żeby nie zapisać błędnych wartości) - tylko
    // potwierdzamy odebranie (status 200), żeby automatyzacja w apce nie raportowała
    // błędu, i logujemy przykładowy obiekt do dalszej analizy.
    const rawMetrics = req.body && req.body.data && req.body.data.metrics;
    const rawWorkouts = req.body && req.body.data && req.body.data.workouts;
    const metrics = Array.isArray(rawMetrics) ? rawMetrics : null;
    const workouts = Array.isArray(rawWorkouts) ? rawWorkouts : null;

    if (!metrics && !workouts) {
      return res.status(400).json({ error: 'Nieprawidłowy format danych - oczekiwano pola data.metrics[] lub data.workouts[].' });
    }

    if (workouts && workouts.length > 0) {
      console.log(`[APPLE HEALTH] Odebrano ${workouts.length} trening(ów) z automatyzacji "Treningi" (jeszcze nie przetwarzane). Przykładowy obiekt:`, JSON.stringify(workouts[0]).slice(0, 3000));
    }

    if (!metrics || metrics.length === 0) {
      return res.json({ status: 'ok', saved_dates: [], workouts_received: workouts ? workouts.length : 0 });
    }

    // Sumujemy wszystkie wpisy danej metryki przypadające na ten sam dzień kalendarzowy
    // (Health Auto Export może wysyłać dane w wielu mniejszych, np. godzinowych, paczkach
    // dla pojedynczej metryki - suma tych paczek daje prawidłową dobową wartość dla
    // kroków/kalorii/minut aktywności, bo to wartości kumulatywne, nie chwilowe).
    const byDate = {};
    let matchedEntries = 0;

    for (const metric of metrics) {
      const name = metric && typeof metric.name === 'string' ? metric.name.toLowerCase() : '';
      const handler = METRIC_FIELD_MAP[name];
      if (!handler || !Array.isArray(metric.data)) continue;

      for (const entry of metric.data) {
        const rawQty = entry && entry.qty;
        const qty = typeof rawQty === 'number' ? rawQty : parseFloat(rawQty);
        if (!Number.isFinite(qty)) continue;

        const parsedDate = parseHealthAutoExportDate(entry.date);
        if (!parsedDate) continue;

        const dateStr = dateObjToLocalDateString(parsedDate);
        if (!byDate[dateStr]) {
          byDate[dateStr] = { steps: null, active_calories: null, basal_calories: null, active_minutes: null };
        }
        const bucket = byDate[dateStr];
        const converted = handler.convert(qty, metric.units);
        bucket[handler.field] = (bucket[handler.field] || 0) + converted;
        matchedEntries++;
      }
    }

    const dates = Object.keys(byDate);
    if (dates.length === 0) {
      // Brak rozpoznanych przez nas metryk w payloadzie - nie jest to błąd (apka może
      // wysyłać też metryki, których nie obsługujemy, np. tętno czy sen).
      return res.json({ status: 'ok', saved_dates: [] });
    }

    const lastSyncTime = new Date().toISOString();
    const savedDates = [];

    for (const dateStr of dates) {
      const m = byDate[dateStr];
      const steps = m.steps !== null ? Math.round(m.steps) : null;
      const activeCalories = m.active_calories !== null ? Math.round(m.active_calories) : null;
      const totalCalories = (m.active_calories !== null && m.basal_calories !== null)
        ? Math.round(m.active_calories + m.basal_calories)
        : null;
      const activeMinutes = m.active_minutes !== null ? Math.round(m.active_minutes) : null;

      await db.run(`
        INSERT INTO health_metrics (user_id, date, steps, active_calories, total_calories_burned, active_minutes, activity_source, last_sync)
        VALUES (?, ?, ?, ?, ?, ?, 'apple', ?)
        ON CONFLICT(user_id, date) DO UPDATE SET
          steps = CASE WHEN activity_source IS NULL OR activity_source = 'apple' THEN COALESCE(excluded.steps, steps) ELSE steps END,
          active_calories = CASE WHEN activity_source IS NULL OR activity_source = 'apple' THEN COALESCE(excluded.active_calories, active_calories) ELSE active_calories END,
          total_calories_burned = CASE WHEN activity_source IS NULL OR activity_source = 'apple' THEN COALESCE(excluded.total_calories_burned, total_calories_burned) ELSE total_calories_burned END,
          active_minutes = CASE WHEN activity_source IS NULL OR activity_source = 'apple' THEN COALESCE(excluded.active_minutes, active_minutes) ELSE active_minutes END,
          activity_source = CASE WHEN activity_source IS NULL OR activity_source = 'apple' THEN 'apple' ELSE activity_source END,
          last_sync = CASE WHEN activity_source IS NULL OR activity_source = 'apple' THEN excluded.last_sync ELSE last_sync END
      `, [user.id, dateStr, steps, activeCalories, totalCalories, activeMinutes, lastSyncTime]);

      savedDates.push(dateStr);
    }

    console.log(`[APPLE HEALTH] Użytkownik ${user.id}: zapisano dane dla dat [${savedDates.join(', ')}] (${matchedEntries} wpisów źródłowych z payloadu).`);
    res.json({ status: 'ok', saved_dates: savedDates });
  } catch (err) {
    console.error('[APPLE HEALTH ERROR]', err.message);
    res.status(500).json({ error: 'Błąd przetwarzania danych Apple Health.' });
  }
});

module.exports = router;
