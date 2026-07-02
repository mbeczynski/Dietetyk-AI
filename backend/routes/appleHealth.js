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
// (services/sync.js). Wcześniej Oura była traktowana jako bardziej autorytatywne źródło,
// ale w praktyce dane Oura (i Withings) i tak synchronizują się do Apple Health na
// telefonie - więc Apple Health jest faktycznie najpełniejszym, najszybszym źródłem
// (Oura potrafi dawać dane z opóźnieniem - dobowe dane finalizują się zwykle następnego
// ranka, patrz wcześniejsza diagnoza przez scripts/check-oura-api.sh). Priorytet
// odwrócony: Apple Health jest teraz źródłem AUTORYTATYWNYM dla aktywności.
// Kolumna health_metrics.activity_source ('oura' | 'apple') pamięta, kto ostatnio
// zapisał dane aktywności dla danej daty:
//   - Ten webhook ZAWSZE nadpisuje dane aktywności i ustawia activity_source='apple'.
//   - syncOura (services/sync.js) NIE nadpisuje wiersza, który już ma
//     activity_source='apple' (patrz warunek CASE w tamtym zapytaniu UPDATE) - więc
//     gdy Apple Health już dostarczyło dane dla danej daty, Oura ich nie nadpisze.
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
// aktywności), temperaturę nadgarstka, dystans i wodę ("Dietary Water" - patrz
// METRIC_FIELD_MAP niżej) z data.metrics[] - inne metryki w tym payloadzie (np. sen) są
// po prostu ignorowane, nie traktujemy ich jako błąd. WYJĄTEK: tętno per trening z data.workouts[]
// (avgHeartRate/maxHeartRate/heartRateData) - patrz sekcja "STREFY KARDIO" niżej, JEST
// obsługiwane, o ile użytkownik włączył przełącznik "Include Workout Metrics" w
// automatyzacji Health Auto Export na telefonie (domyślnie wyłączony - bez niego
// payload treningu nie zawiera w ogóle pól tętna).

// Górne limity rozmiaru payloadu webhooka (Runda 12, audyt bezpieczeństwa) - patrz
// komentarz przy ich użyciu w handlerze POST niżej.
const MAX_METRIC_ENTRIES_PER_REQUEST = 20000;
const MAX_WORKOUTS_PER_REQUEST = 500;

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

// Health Auto Export może wysyłać temperaturę w stopniach F (jeśli telefon ma
// regionalne jednostki US) albo C - zawsze konwertujemy do °C.
function toCelsius(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'degf' || u === 'fahrenheit' || u === '°f' || u === 'f') {
    return (qty - 32) * (5 / 9);
  }
  return qty;
}

// Health Auto Export wysyła dystans w "km" albo "mi" w zależności od regionalnych
// jednostek na telefonie - zawsze konwertujemy do metrów (tak jak Oura/Google Fit).
function toMeters(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'mi' || u === 'mile' || u === 'miles') {
    return qty * 1609.344;
  }
  if (u === 'km' || u === 'kilometer' || u === 'kilometers' || u === 'kilometres') {
    return qty * 1000;
  }
  // 'm' / 'meter' / nieznane - zakładamy, że już jest w metrach.
  return qty;
}

// Health Auto Export wysyła wodę ("Dietary Water" - HKQuantityTypeIdentifier
// dietaryWater) w "mL", "L" albo "fl_oz_us"/"fl_oz_imp" w zależności od regionalnych
// jednostek na telefonie - zawsze konwertujemy do mililitrów (tak jak kolumna
// health_metrics.water_ml zasilana przez /api/water/add w routes/health.js).
function toMilliliters(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'l' || u === 'liter' || u === 'liters' || u === 'litre' || u === 'litres') {
    return qty * 1000;
  }
  if (u === 'fl_oz_us' || u === 'fl_oz' || u === 'floz' || u === 'fl oz' || u === 'oz' || u === 'fluid ounce' || u === 'fluid ounces') {
    return qty * 29.5735;
  }
  if (u === 'fl_oz_imp' || u === 'imperial fluid ounce' || u === 'imperial fluid ounces') {
    return qty * 28.4131;
  }
  if (u === 'cup' || u === 'cups') {
    return qty * 240;
  }
  // 'ml' / 'millilitre' / nieznane - zakładamy, że już jest w mililitrach.
  return qty;
}

// STREFY KARDIO (Karvonen) per trening - patrz migracja w db.js (apple_health_workouts.
// avg_heart_rate/max_heart_rate/zone1_minutes..zone5_minutes). Te same progi procentowe
// rezerwy tętna (50/60/70/80/90%), co statyczna tabela referencyjna "Strefy Tętna" na
// Dashboardzie (frontend/src/components/Dashboard.jsx) i ten sam wzór HRmax = 220 - wiek
// na bazie roku urodzenia (routes/dashboard.js) - żeby obie karty pokazywały zgodne ze
// sobą granice stref.
const KARVONEN_ZONE_UPPER_BOUNDS = [0.6, 0.7, 0.8, 0.9]; // <0.6 -> Z1, <0.7 -> Z2, <0.8 -> Z3, <0.9 -> Z4, >=0.9 -> Z5

function numOrNull(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Klasyfikuje pojedynczy odczyt tętna do strefy 1-5 (Karvonen). Zwraca null, gdy nie da
// się tego policzyć (brak HRmax - użytkownik nie podał roku urodzenia w profilu - albo
// rezerwa tętna wychodzi <= 0, np. błędnie wpisany rok urodzenia dający HRmax <= RHR).
function classifyKarvonenZone(hr, userMaxHr, rhr) {
  if (!Number.isFinite(hr) || userMaxHr == null) return null;
  const hrReserve = userMaxHr - rhr;
  if (hrReserve <= 0) return null;
  const pct = (hr - rhr) / hrReserve;
  for (let i = 0; i < KARVONEN_ZONE_UPPER_BOUNDS.length; i++) {
    if (pct < KARVONEN_ZONE_UPPER_BOUNDS[i]) return i + 1;
  }
  return 5;
}

// Wyciąga reprezentatywną wartość tętna z jednej próbki heartRateData - Health Auto
// Export używa RÓŻNYCH kształtów w zależności od wersji eksportu ("Workouts v1": pole
// `qty`; "Workouts v2": pola `Min`/`Avg`/`Max`) - bierzemy średnią, jeśli jest, inaczej
// pierwszą dostępną liczbę.
function extractSampleHr(entry) {
  if (!entry) return null;
  const candidates = [entry.Avg, entry.avg, entry.qty, entry.Max, entry.max, entry.Min, entry.min];
  for (const c of candidates) {
    const n = numOrNull(c);
    if (n != null) return n;
  }
  return null;
}

const MAX_SAMPLE_GAP_MINUTES = 5; // Health Auto Export zwykle próbkuje tętno podczas
// treningu ~co minutę - większy odstęp między kolejnymi próbkami (np. utracone próbki,
// duplikat znacznika czasu) ucinamy do tego limitu, żeby jedna "dziura" w danych nie
// zaliczyła kilkudziesięciu minut do przypadkowej strefy.
const DEFAULT_LAST_SAMPLE_MINUTES = 1; // czas przypisany ostatniej próbce w serii (nie
// ma kolejnej próbki, więc nie da się policzyć realnego odstępu).

// Liczy realny rozkład minut treningu w 5 strefach Karvonena na bazie szeregu próbek
// tętna z payloadu (workout.heartRateData). Gdy payload nie zawiera szeregu próbek, ale
// zawiera samo uśrednione tętno treningu (workout.avgHeartRate) i znamy czas trwania
// treningu, jako rozsądny fallback przypisujemy CAŁY czas trwania do jednej strefy
// odpowiadającej temu uśrednionemu tętru - to wciąż realne zmierzone tętno, tylko bez
// rozkładu w czasie, więc lepsze niż brak jakichkolwiek danych o strefach.
function computeWorkoutHrZones(workout, userMaxHr, rhr, durationMinutes) {
  const avgHrQty = numOrNull(workout.avgHeartRate && workout.avgHeartRate.qty)
    ?? numOrNull(workout.heartRate && workout.heartRate.avg && workout.heartRate.avg.qty);
  const maxHrQty = numOrNull(workout.maxHeartRate && workout.maxHeartRate.qty)
    ?? numOrNull(workout.heartRate && workout.heartRate.max && workout.heartRate.max.qty);

  if (userMaxHr == null) {
    // Bez roku urodzenia użytkownika nie da się policzyć stref Karvonena - zwracamy
    // przynajmniej surowe avg/max tętno (jeśli payload je zawiera), strefy zostają NULL.
    return { avgHr: avgHrQty, maxHr: maxHrQty, zones: [null, null, null, null, null] };
  }

  const rawSamples = Array.isArray(workout.heartRateData) ? workout.heartRateData : [];
  const samples = rawSamples
    .map((entry) => ({ date: parseHealthAutoExportDate(entry && entry.date), hr: extractSampleHr(entry) }))
    .filter((s) => s.date && s.hr != null)
    .sort((a, b) => a.date - b.date);

  const zones = [0, 0, 0, 0, 0];
  let hasZoneData = false;

  if (samples.length > 0) {
    for (let i = 0; i < samples.length; i++) {
      let dtMinutes = i < samples.length - 1
        ? (samples[i + 1].date - samples[i].date) / 60000
        : DEFAULT_LAST_SAMPLE_MINUTES;
      if (!Number.isFinite(dtMinutes) || dtMinutes <= 0) dtMinutes = DEFAULT_LAST_SAMPLE_MINUTES;
      dtMinutes = Math.min(dtMinutes, MAX_SAMPLE_GAP_MINUTES);

      const zone = classifyKarvonenZone(samples[i].hr, userMaxHr, rhr);
      if (zone) {
        zones[zone - 1] += dtMinutes;
        hasZoneData = true;
      }
    }
  } else if (avgHrQty != null && Number.isFinite(durationMinutes) && durationMinutes > 0) {
    const zone = classifyKarvonenZone(avgHrQty, userMaxHr, rhr);
    if (zone) {
      zones[zone - 1] = durationMinutes;
      hasZoneData = true;
    }
  }

  return {
    avgHr: avgHrQty,
    maxHr: maxHrQty,
    zones: hasZoneData ? zones.map((z) => Math.round(z * 10) / 10) : [null, null, null, null, null]
  };
}

// Mapowanie nazw metryk Health Auto Export -> nasze pola w health_metrics.
// `field` to nasz wewnętrzny bucket (patrz `byDate` poniżej), nie nazwa kolumny SQL 1:1 -
// total_calories_burned liczymy jako suma active_calories + basal_calories.
// `mode: 'last'` (w przeciwieństwie do domyślnego sumowania) - dla temperatury
// nadgarstka NIE sumujemy kolejnych wpisów z tego samego dnia (to jeden pomiar
// nocny, nie wartość kumulatywna jak kroki/kalorie) - bierzemy ostatnią wartość
// z paczki danych.
const METRIC_FIELD_MAP = {
  step_count: { field: 'steps', convert: (qty) => qty },
  active_energy: { field: 'active_calories', convert: toKcal },
  basal_energy_burned: { field: 'basal_calories', convert: toKcal },
  apple_exercise_time: { field: 'active_minutes', convert: (qty) => qty },
  // Wymaga włączenia metryki "Wrist Temperature" w automatyzacji Health Auto
  // Export na telefonie (domyślnie wyłączona) - dostępna tylko z Apple Watch
  // Series 8+/Ultra. Inna wartość niż Oura `temperature_deviation` (tam to
  // odchylenie od bazowej, tu wartość absolutna w °C).
  wrist_temperature: { field: 'wrist_temperature', convert: toCelsius, mode: 'last' },
  // Dystans (chód + bieg) - wcześniej w ogóle nieobsługiwany (payload przychodził,
  // jeśli użytkownik miał tę metrykę włączoną w automatyzacji, ale był po cichu
  // ignorowany, bo nie było dla niego wpisu w tej mapie). Sumujemy jak kroki/kalorie
  // (wartość kumulatywna w ciągu dnia, nie chwilowa).
  walking_running_distance: { field: 'distance_meters', convert: toMeters },
  // Woda ("Dietary Water") - źródło: "smart butelka" użytkownika, która loguje wypitą
  // wodę do Apple Health, skąd Health Auto Export eksportuje ją dalej do tego webhooka.
  // Wymaga włączenia metryki "Dietary Water" w automatyzacji Health Auto Export na
  // telefonie (domyślnie wyłączona, tak jak Wrist Temperature). UWAGA: nazwa pola JSON
  // "dietary_water" jest wyprowadzona z konwencji snake_case widocznej w pozostałych
  // metrykach tej mapy (np. step_count, active_energy, apple_exercise_time) i z nazwy
  // identyfikatora HealthKit (HKQuantityTypeIdentifier.dietaryWater) - nie udało się
  // znaleźć jej w dokumentacji Health Auto Export w formie 1:1 (wiki opisuje strukturę
  // ogólną, a nie pełną listę nazw pól). Jeśli po włączeniu synchronizacji w logach
  // serwera "Dietetyk" nie pojawią się wpisy dla wody, sprawdź w logu webhooka, jaka
  // nazwa faktycznie przychodzi w payloadzie, i popraw klucz w tej mapie.
  dietary_water: { field: 'water_ml', convert: toMilliliters }
};

router.post('/api/integrations/apple-health/:syncToken', async (req, res) => {
  try {
    const { syncToken } = req.params;
    if (!syncToken || !syncToken.trim()) {
      return res.status(401).json({ error: 'Brak tokenu synchronizacji w adresie webhooka.' });
    }

    const user = await db.get(`
      SELECT id, birth_year,
        (SELECT 1 FROM oauth_tokens WHERE user_id = users.id AND service = 'oura') AS has_oura
      FROM users WHERE sync_token = ?
    `, [syncToken.trim()]);
    if (!user) {
      // Celowo ten sam, generyczny komunikat jak przy braku tokenu - nie chcemy ujawniać,
      // czy podany token kiedykolwiek istniał.
      return res.status(404).json({ error: 'Nieznany token synchronizacji.' });
    }

    // HRmax (220 - wiek) na bazie roku urodzenia - ten sam wzór co w routes/dashboard.js,
    // potrzebny tutaj do policzenia stref Karvonena per trening (patrz computeWorkoutHrZones).
    const userMaxHr = user.birth_year ? (220 - (new Date().getFullYear() - user.birth_year)) : null;

    // RHR (tętno spoczynkowe) per dzień treningu - cache w ramach jednego żądania
    // webhooka, żeby nie odpytywać bazy wielokrotnie dla treningów z tego samego dnia.
    // Fallback: jeśli dany dzień nie ma jeszcze zapisanego RHR (np. Oura zsynchronizuje
    // się później), bierzemy najnowszy wcześniejszy znany RHR użytkownika; jeśli
    // zupełnie nieznany, używamy orientacyjnej wartości 60 bpm (przeciętne RHR dorosłej
    // osoby) - lepsze niż RHR=0, które fałszywie zawyżałoby rezerwę tętna.
    const DEFAULT_RHR_FALLBACK = 60;
    const rhrCache = new Map();
    async function getRestingHrForDate(dateStr) {
      if (rhrCache.has(dateStr)) return rhrCache.get(dateStr);
      let rhr = null;
      const exact = await db.get(
        'SELECT rhr FROM health_metrics WHERE user_id = ? AND date = ? AND rhr IS NOT NULL',
        [user.id, dateStr]
      );
      if (exact && exact.rhr != null) rhr = exact.rhr;
      if (rhr == null) {
        const prior = await db.get(
          'SELECT rhr FROM health_metrics WHERE user_id = ? AND date < ? AND rhr IS NOT NULL ORDER BY date DESC LIMIT 1',
          [user.id, dateStr]
        );
        if (prior && prior.rhr != null) rhr = prior.rhr;
      }
      if (rhr == null) rhr = DEFAULT_RHR_FALLBACK;
      rhrCache.set(dateStr, rhr);
      return rhr;
    }

    // Automatyzacja z "Typ danych: Treningi" (Workouts) wysyła payload w INNYM formacie
    // niż automatyzacja ogólnych metryk zdrowia - dane są w polu data.workouts[], a nie
    // data.metrics[] (potwierdzone na podstawie ręcznego eksportu CSV "Workouts-*.csv":
    // kolumny Workout Type/Start/End/Aktywna Energia (kJ)/Energia Spoczynkowa (kJ)/...).
    // Dokładny kształt obiektu treningu w JSON potwierdzony na podstawie logów produkcyjnych:
    //   { id, name, start: "2026-06-18 06:00:26 +0200", end: "...",
    //     duration: 4715.99 (SEKUNDY), activeEnergyBurned: { qty: 2299.5, units: "kJ" },
    //     intensity: {...}, temperature: {...}, humidity: {...}, metadata: {} }
    // Mapujemy: activeEnergyBurned -> active_calories (po konwersji do kcal), duration
    // (sekundy -> minuty) -> active_minutes, przypisane do dnia kalendarzowego pola `start`.
    // Trening NIE dostarcza basal_calories, więc total_calories_burned nie jest tu liczone
    // (dashboard.js i tak ma fallback bmr + active_calories, gdy total_calories_burned brak).
    //
    // BEZ RYZYKA PODWÓJNEGO LICZENIA: użytkownik potwierdził, że to JEDYNA skonfigurowana
    // automatyzacja Health Auto Export (brak równoległej automatyzacji "ogólne metryki",
    // która już wliczałaby kalorie treningowe do dobowego active_energy) - bezpiecznie
    // można więc zapisywać activeEnergyBurned z treningów jako active_calories.
    const rawMetrics = req.body && req.body.data && req.body.data.metrics;
    const rawWorkouts = req.body && req.body.data && req.body.data.workouts;
    const metrics = Array.isArray(rawMetrics) ? rawMetrics : null;
    const workouts = Array.isArray(rawWorkouts) ? rawWorkouts : null;

    if (!metrics && !workouts) {
      return res.status(400).json({ error: 'Nieprawidłowy format danych - oczekiwano pola data.metrics[] lub data.workouts[].' });
    }

    // Audyt bezpieczeństwa (Runda 12): ten webhook NIE ma autentykacji sesyjnej (tylko
    // sync_token w URL, patrz komentarz na początku pliku) i przed tą zmianą nie miał
    // ŻADNEGO górnego limitu liczby wpisów w payloadzie. Każdy trening robi sekwencyjne
    // zapytania do bazy (getRestingHrForDate + INSERT), a każdy wpis metryki jest
    // przetwarzany w pętli - spreparowany payload z tysiącami elementów mógłby zająć
    // serwer na długo (DoS). Realny payload z Health Auto Export (nawet przy zbiorczej
    // wysyłce wielu dni/automatyzacji naraz) nie powinien przekraczać tych wartości.
    const totalMetricEntries = metrics
      ? metrics.reduce((sum, m) => sum + (m && Array.isArray(m.data) ? m.data.length : 0), 0)
      : 0;
    if (totalMetricEntries > MAX_METRIC_ENTRIES_PER_REQUEST) {
      return res.status(400).json({ error: `Za dużo wpisów metryk w jednym żądaniu (limit: ${MAX_METRIC_ENTRIES_PER_REQUEST}).` });
    }
    if (workouts && workouts.length > MAX_WORKOUTS_PER_REQUEST) {
      return res.status(400).json({ error: `Za dużo treningów w jednym żądaniu (limit: ${MAX_WORKOUTS_PER_REQUEST}).` });
    }

    // Sumujemy wszystkie wpisy danej metryki/treningu przypadające na ten sam dzień
    // kalendarzowy (Health Auto Export może wysyłać dane w wielu mniejszych, np.
    // godzinowych, paczkach - suma tych paczek daje prawidłową dobową wartość dla
    // kroków/kalorii/minut aktywności, bo to wartości kumulatywne, nie chwilowe).
    const byDate = {};
    let matchedEntries = 0;

    if (metrics) {
      for (const metric of metrics) {
        const name = metric && typeof metric.name === 'string' ? metric.name.toLowerCase() : '';
        
        // Specjalny parser dla analizy snu (sleep_analysis), ponieważ jest to metryka kategorialna (przedziały czasowe)
        if (name === 'sleep_analysis') {
          if (!Array.isArray(metric.data)) continue;
          for (const entry of metric.data) {
            const startStr = entry.startDate || entry.start_date || entry.date;
            const endStr = entry.endDate || entry.end_date;
            if (!startStr || !endStr) continue;

            const start = new Date(startStr);
            const end = new Date(endStr);
            if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

            const durationHrs = (end - start) / (1000 * 60 * 60);
            if (durationHrs <= 0 || durationHrs > 24) continue; // sanity check

            // Tradycyjnie czas snu przypisuje się do dnia, w którym użytkownik się budzi (endDate)
            const dateStr = dateObjToLocalDateString(end);
            
            if (!byDate[dateStr]) {
              byDate[dateStr] = {
                steps: null, active_calories: null, basal_calories: null, active_minutes: null,
                wrist_temperature: null, distance_meters: null, water_ml: null,
                sleep_duration: null, sleep_deep: null, sleep_rem: null, sleep_score: null,
                in_bed_duration: 0
              };
            }
            
            const bucket = byDate[dateStr];
            if (bucket.sleep_duration === null) {
              bucket.sleep_duration = 0;
              bucket.sleep_deep = 0;
              bucket.sleep_rem = 0;
            }

            const val = typeof entry.value === 'string' ? entry.value.toLowerCase() : '';
            if (val.includes('deep')) {
              bucket.sleep_deep += durationHrs;
              bucket.sleep_duration += durationHrs;
            } else if (val.includes('rem')) {
              bucket.sleep_rem += durationHrs;
              bucket.sleep_duration += durationHrs;
            } else if (val.includes('core') || val.includes('asleep') || val.includes('light')) {
              bucket.sleep_duration += durationHrs;
            } else if (val.includes('in_bed') || val.includes('inbed')) {
              bucket.in_bed_duration += durationHrs;
            }
            matchedEntries++;
          }
          continue;
        }

        const handler = METRIC_FIELD_MAP[name];
        if (!handler || !Array.isArray(metric.data)) continue;

        for (const entry of metric.data) {
          const rawQty = entry && entry.qty;
          const qty = typeof rawQty === 'number' ? rawQty : parseFloat(rawQty);
          if (!Number.isFinite(qty)) continue;
          if (qty < 0 && handler.mode !== 'last') continue;

          const parsedDate = parseHealthAutoExportDate(entry.date);
          if (!parsedDate) continue;

          const dateStr = dateObjToLocalDateString(parsedDate);
          if (!byDate[dateStr]) {
            byDate[dateStr] = {
              steps: null, active_calories: null, basal_calories: null, active_minutes: null,
              wrist_temperature: null, distance_meters: null, water_ml: null,
              sleep_duration: null, sleep_deep: null, sleep_rem: null, sleep_score: null,
              in_bed_duration: 0
            };
          }
          const bucket = byDate[dateStr];
          const converted = handler.convert(qty, metric.units);
          if (name === 'dietary_water') {
            // Runda 3 (audyt): Idempotentność wody - zapisz próbkę unikalną po user_id i timestamp
            const timestamp = entry.date || parsedDate.toISOString();
            const res = await db.run(`
              INSERT OR IGNORE INTO apple_health_water_samples (user_id, timestamp, date, qty)
              VALUES (?, ?, ?, ?)
            `, [user.id, timestamp, dateStr, converted]);
            if (res.changes > 0) {
              bucket[handler.field] = (bucket[handler.field] || 0) + converted;
            }
          } else {
            bucket[handler.field] = handler.mode === 'last'
              ? converted
              : (bucket[handler.field] || 0) + converted;
          }
          matchedEntries++;
        }
      }
    }

    // Każdy trening zapisujemy NAJPIERW osobno (zidentyfikowany przez workout.id) do
    // tabeli apple_health_workouts - patrz komentarz przy tej tabeli w db.js po co
    // (uniknięcie podwójnego liczenia przy ponownym wysłaniu tego samego treningu, oraz
    // prawidłowe sumowanie wielu treningów danego dnia dostarczonych w różnych wywołaniach
    // webhooka). Dobową sumę do health_metrics liczymy NA KOŃCU jako SUM(...) z tej
    // tabeli dla wszystkich dni, których dotyczy ten payload - nie inkrementujemy jej
    // bezpośrednio z treści żądania.
    let matchedWorkouts = 0;
    const workoutAffectedDates = new Set();
    if (workouts) {
      for (const workout of workouts) {
        if (!workout || !workout.id) continue;

        const parsedDate = parseHealthAutoExportDate(workout.start);
        if (!parsedDate) continue;
        const dateStr = dateObjToLocalDateString(parsedDate);

        let activeCaloriesKcal = 0;
        const energy = workout.activeEnergyBurned;
        if (energy && typeof energy.qty === 'number') {
          activeCaloriesKcal = toKcal(energy.qty, energy.units);
        }

        let durationMinutes = 0;
        const durationSec = typeof workout.duration === 'number' ? workout.duration : parseFloat(workout.duration);
        if (Number.isFinite(durationSec)) {
          durationMinutes = durationSec / 60;
        }

        // `workout.name` to typ treningu z UI apki (np. "Running", "Functional
        // Strength Training") - patrz potwierdzony kształt obiektu treningu w
        // komentarzu nad tym handlerem. Zapisujemy go, żeby Dashboard mógł pokazać
        // sekcję "Ostatnia aktywność" z realną nazwą/ikoną, a nie pustą listą.
        const workoutType = typeof workout.name === 'string' && workout.name.trim()
          ? workout.name.trim()
          : null;

        // Strefy kardio (Karvonen) per trening - patrz computeWorkoutHrZones wyżej.
        // Wymaga RHR z dnia treningu (nie dnia "dziś") - trening może dotyczyć dowolnej
        // wcześniejszej daty z payloadu.
        const rhrForWorkoutDate = await getRestingHrForDate(dateStr);
        const hrZones = computeWorkoutHrZones(workout, userMaxHr, rhrForWorkoutDate, durationMinutes);

        await db.run(`
          INSERT INTO apple_health_workouts (
            user_id, workout_id, date, active_calories, duration_minutes, workout_type,
            avg_heart_rate, max_heart_rate, zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
          ON CONFLICT(user_id, workout_id) DO UPDATE SET
            date = excluded.date,
            active_calories = excluded.active_calories,
            duration_minutes = excluded.duration_minutes,
            workout_type = excluded.workout_type,
            avg_heart_rate = excluded.avg_heart_rate,
            max_heart_rate = excluded.max_heart_rate,
            zone1_minutes = excluded.zone1_minutes,
            zone2_minutes = excluded.zone2_minutes,
            zone3_minutes = excluded.zone3_minutes,
            zone4_minutes = excluded.zone4_minutes,
            zone5_minutes = excluded.zone5_minutes,
            updated_at = excluded.updated_at
        `, [
          user.id, String(workout.id), dateStr, activeCaloriesKcal, durationMinutes, workoutType,
          hrZones.avgHr, hrZones.maxHr, hrZones.zones[0], hrZones.zones[1], hrZones.zones[2], hrZones.zones[3], hrZones.zones[4]
        ]);

        workoutAffectedDates.add(dateStr);
        matchedWorkouts++;
      }

      for (const dateStr of workoutAffectedDates) {
        const sums = await db.get(
          `SELECT SUM(active_calories) AS total_calories, SUM(duration_minutes) AS total_minutes
           FROM apple_health_workouts WHERE user_id = ? AND date = ?`,
          [user.id, dateStr]
        );
        if (!byDate[dateStr]) {
          byDate[dateStr] = {
            steps: null, active_calories: null, basal_calories: null, active_minutes: null,
            wrist_temperature: null, distance_meters: null, water_ml: null,
            sleep_duration: null, sleep_deep: null, sleep_rem: null, sleep_score: null,
            in_bed_duration: 0
          };
        }
        byDate[dateStr].active_calories = sums && sums.total_calories !== null ? sums.total_calories : 0;
        byDate[dateStr].active_minutes = sums && sums.total_minutes !== null ? sums.total_minutes : 0;
      }
    }

    // Post-processing danych snu i obliczanie sleep_score na podstawie celu użytkownika
    const sleepGoalRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'target_sleep_duration'", [user.id]);
    const targetSleep = sleepGoalRow ? parseFloat(sleepGoalRow.value) : 7.2;

    for (const dateStr of Object.keys(byDate)) {
      const bucket = byDate[dateStr];
      if (bucket.sleep_duration !== null) {
        // Jeśli nie zarejestrowano faz snu, ale mamy czas w łóżku (np. stary zegarek/brak sleep stages)
        if (bucket.sleep_duration === 0 && bucket.in_bed_duration > 0) {
          bucket.sleep_duration = bucket.in_bed_duration;
        }
        
        // Zabezpieczenie sanity-check (maksymalnie 24h na dobę)
        if (bucket.sleep_duration > 24) bucket.sleep_duration = 24;
        if (bucket.sleep_deep > 24) bucket.sleep_deep = 24;
        if (bucket.sleep_rem > 24) bucket.sleep_rem = 24;
        
        // Obliczanie sleep_score (0-100) na podstawie celu snu
        bucket.sleep_score = Math.min(100, Math.round((bucket.sleep_duration / targetSleep) * 100));
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
      const wristTemperature = m.wrist_temperature !== null ? Math.round(m.wrist_temperature * 10) / 10 : null;
      const distanceMeters = m.distance_meters !== null ? Math.round(m.distance_meters) : null;
      
      const MAX_DAILY_WATER_ML = 10000;
      const waterMl = m.water_ml !== null ? Math.min(Math.round(m.water_ml), MAX_DAILY_WATER_ML) : null;

      const sleepDuration = m.sleep_duration !== null ? Math.round(m.sleep_duration * 10) / 10 : null;
      const sleepDeep = m.sleep_deep !== null ? Math.round(m.sleep_deep * 10) / 10 : null;
      const sleepRem = m.sleep_rem !== null ? Math.round(m.sleep_rem * 10) / 10 : null;
      const sleepScore = m.sleep_score !== null ? Math.round(m.sleep_score) : null;

      // Zabezpieczenie danych Oura Ring: jeśli użytkownik ma połączoną Ourę, dane o śnie z Apple Health
      // zapisujemy wyłącznie, jeśli w bazie nie ma jeszcze żadnych danych dla tej daty (COALESCE(sleep_duration, excluded.sleep_duration)).
      // W przeciwnym wypadku (użytkownik bez Oury, np. żona), Apple Health jest źródłem nadrzędnym (COALESCE(excluded.sleep_duration, sleep_duration)).
      const sleepDurationUpdate = user.has_oura === 1
        ? 'sleep_duration = COALESCE(sleep_duration, excluded.sleep_duration)'
        : 'sleep_duration = COALESCE(excluded.sleep_duration, sleep_duration)';
      const sleepDeepUpdate = user.has_oura === 1
        ? 'sleep_deep = COALESCE(sleep_deep, excluded.sleep_deep)'
        : 'sleep_deep = COALESCE(excluded.sleep_deep, sleep_deep)';
      const sleepRemUpdate = user.has_oura === 1
        ? 'sleep_rem = COALESCE(sleep_rem, excluded.sleep_rem)'
        : 'sleep_rem = COALESCE(excluded.sleep_rem, sleep_rem)';
      const sleepScoreUpdate = user.has_oura === 1
        ? 'sleep_score = COALESCE(sleep_score, excluded.sleep_score)'
        : 'sleep_score = COALESCE(excluded.sleep_score, sleep_score)';

      await db.run(`
        INSERT INTO health_metrics (
          user_id, date, steps, active_calories, total_calories_burned, active_minutes, wrist_temperature,
          distance_meters, water_ml, sleep_duration, sleep_deep, sleep_rem, sleep_score, activity_source, last_sync
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'apple', ?)
        ON CONFLICT(user_id, date) DO UPDATE SET
          steps = COALESCE(excluded.steps, steps),
          active_calories = COALESCE(excluded.active_calories, active_calories),
          total_calories_burned = COALESCE(excluded.total_calories_burned, total_calories_burned),
          active_minutes = COALESCE(excluded.active_minutes, active_minutes),
          wrist_temperature = COALESCE(excluded.wrist_temperature, wrist_temperature),
          distance_meters = COALESCE(excluded.distance_meters, distance_meters),
          water_ml = CASE WHEN excluded.water_ml IS NOT NULL THEN COALESCE(water_ml, 0) + excluded.water_ml ELSE water_ml END,
          ${sleepDurationUpdate},
          ${sleepDeepUpdate},
          ${sleepRemUpdate},
          ${sleepScoreUpdate},
          activity_source = 'apple',
          last_sync = excluded.last_sync
      `, [
        user.id, dateStr, steps, activeCalories, totalCalories, activeMinutes, wristTemperature,
        distanceMeters, waterMl, sleepDuration, sleepDeep, sleepRem, sleepScore, lastSyncTime
      ]);

      savedDates.push(dateStr);
    }

    console.log(`[APPLE HEALTH] Użytkownik ${user.id}: zapisano dane dla dat [${savedDates.join(', ')}] (${matchedEntries} wpisów metryk, ${matchedWorkouts} treningów z payloadu).`);
    res.json({ status: 'ok', saved_dates: savedDates, workouts_received: workouts ? workouts.length : 0 });
  } catch (err) {
    console.error('[APPLE HEALTH ERROR]', err.message);
    res.status(500).json({ error: 'Błąd przetwarzania danych Apple Health.' });
  }
});

module.exports = router;
