const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
const { getCalorieBaseline, detectMealAnomalies } = require('../utils/mealAnomaly');
const { DEFAULT_TARGET_WATER_ML, getTargetCalories, getBmr, getTargetWaterMl } = require('../utils/defaultSettings');
const { genAI, generateContentWithFallback } = require('../config');

// Blokada równoległego generowania porady AI dla tej samej (user, data) - bez tego
// kilka odświeżeń dashboardu w krótkim czasie (np. otwarcie kilku zakładek albo
// szybkie odświeżanie po nieudanym ładowaniu) odpalałoby N równoległych zapytań
// do Gemini dla identycznego promptu, mnożąc niepotrzebnie koszt/limity API.
const pendingAdviceGeneration = new Set();

// Przesunięcie daty (string YYYY-MM-DD) o N dni - czysta arytmetyka kalendarzowa
// przez Date.UTC (jak w istniejącym subtractDay), żeby uniknąć błędów strefy
// czasowej. deltaDays może być ujemne (w tył) lub dodatnie (w przód).
const shiftDate = (dateStr, deltaDays) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
};

// Agregacja odżywiania (kalorie/makro) dla zakresu dat - używana do porównań
// tydzień/miesiąc (punkt 10 z analizy dashboardu). Średnie liczone WYŁĄCZNIE
// po dniach, w których faktycznie zapisano posiłki (days_logged) - dzielenie
// przez całą długość okresu zaniżałoby średnią przy nieregularnym logowaniu.
async function aggregateNutrition(userId, startDate, endDate) {
  const rows = await db.all(
    `SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat, SUM(fiber) AS fiber, SUM(sugar) AS sugar, SUM(sodium) AS sodium
     FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const daysLogged = rows.length;
  const totals = rows.reduce((acc, r) => {
    acc.calories += r.calories || 0;
    acc.protein += r.protein || 0;
    acc.carbs += r.carbs || 0;
    acc.fat += r.fat || 0;
    acc.fiber += r.fiber || 0;
    acc.sugar += r.sugar || 0;
    acc.sodium += r.sodium || 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  const avg = daysLogged > 0 ? {
    calories: Math.round(totals.calories / daysLogged),
    protein: Math.round((totals.protein / daysLogged) * 10) / 10,
    carbs: Math.round((totals.carbs / daysLogged) * 10) / 10,
    fat: Math.round((totals.fat / daysLogged) * 10) / 10,
    fiber: Math.round((totals.fiber / daysLogged) * 10) / 10,
    sugar: Math.round((totals.sugar / daysLogged) * 10) / 10,
    sodium: Math.round(totals.sodium / daysLogged)
  } : null;
  return { start: startDate, end: endDate, days_logged: daysLogged, totals, avg };
}

// Bilans kaloryczny narastająco dla zakresu dat (punkt 11 z analizy dashboardu).
// Liczony tylko po dniach z zapisanymi posiłkami - dni bez logów nie psują
// bilansu zerami.
async function aggregateCalorieBalance(userId, startDate, endDate, targetCalories, bmr) {
  const mealRows = await db.all(
    `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const healthRows = await db.all(
    `SELECT date, active_calories FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ?`,
    [userId, startDate, endDate]
  );
  const activeByDate = new Map(healthRows.map(r => [r.date, r.active_calories || 0]));

  const daysWithData = mealRows.length;
  let totalEaten = 0;
  let totalBurned = 0;
  mealRows.forEach(r => {
    totalEaten += r.calories || 0;
    totalBurned += bmr + (activeByDate.get(r.date) || 0);
  });

  return {
    start: startDate,
    end: endDate,
    days_with_data: daysWithData,
    target_calories: targetCalories,
    total_eaten: totalEaten,
    total_burned: daysWithData > 0 ? totalBurned : 0,
    balance_vs_burned: daysWithData > 0 ? totalEaten - totalBurned : null,
    balance_vs_target: daysWithData > 0 ? totalEaten - (targetCalories * daysWithData) : null
  };
}

router.get('/api/dashboard', async (req, res) => {
  const date = req.query.date || getLocalDateString();
  try {
    // Ustawienia celów
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    // Realny HRmax na bazie roku urodzenia użytkownika (wzór 220 - wiek) - wcześniej
    // strefy tętna (Karvonen) liczone na froncie zawsze zakładały HRmax=190 (czyli
    // wiek ~30 lat) niezależnie od realnego wieku użytkownika. Pole opcjonalne -
    // jeśli użytkownik nie podał roku urodzenia w profilu, zwracamy null, a front
    // sam wraca do fallbacku 190.
    const userRow = await db.get('SELECT birth_year FROM users WHERE id = ?', [req.user.id]);
    const currentYear = new Date().getFullYear();
    const userMaxHr = userRow && userRow.birth_year ? (220 - (currentYear - userRow.birth_year)) : null;

    // Posiłki z dzisiaj
    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    // Detektor anomalii (patrz utils/mealAnomaly.js) - bazowy rozkład kalorii liczony
    // RAZ dla całego dnia, z historii PRZED `date`, a nie per posiłek.
    const calorieBaseline = await getCalorieBaseline(req.user.id, date);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
    const meals = mealRows.map(r => {
      let analysis = {};
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
      totalEaten.fiber += r.fiber || 0;
      totalEaten.sugar += r.sugar || 0;
      totalEaten.sodium += r.sodium || 0;
      // Kolumny bazy (po sanityzacji przy zapisie) muszą nadpisać spread z `analysis`
      // (niesanityzowany JSON z AI) - inaczej karta posiłku pokaże inne wartości niż
      // te użyte tuż wyżej do totalEaten.
      return {
        id: r.id, raw_text: r.raw_text, timestamp: r.timestamp, image_base64: r.image_base64, ...analysis,
        calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
        anomalies: detectMealAnomalies({ calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat }, calorieBaseline)
      };
    });

    // Zaokrąglenie makr zjedzonych
    totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
    totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
    totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;
    totalEaten.fiber = Math.round(totalEaten.fiber * 10) / 10;
    totalEaten.sugar = Math.round(totalEaten.sugar * 10) / 10;
    totalEaten.sodium = Math.round(totalEaten.sodium);

    // Dane zdrowotne z Oura & Withings z wybranego dnia
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]) || getDefaultHealthMetrics();

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);

    // Pobierz najświeższe nie-null/nie-zero wartości dla wszystkich wskaźników zdrowotnych (jeśli wybrane są puste)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;
    let displayBpSystolic = health.blood_pressure_systolic;
    let displayBpDiastolic = health.blood_pressure_diastolic;
    let displaySteps = health.steps;
    let displayActiveCalories = health.active_calories;
    let displayTotalCaloriesBurned = health.total_calories_burned;
    let displaySleepScore = health.sleep_score;
    let displaySleepDuration = health.sleep_duration;
    let displaySleepDeep = health.sleep_deep;
    let displaySleepRem = health.sleep_rem;
    let displayReadinessScore = health.readiness_score;
    let displayHrv = health.hrv;
    let displayRhr = health.rhr;
    let displayTempDev = health.temperature_deviation;
    let displayRespiratoryRate = health.respiratory_rate;
    let displaySpo2 = health.spo2_percentage;
    let displayWristTemperature = health.wrist_temperature;
    let displayActiveMinutes = health.active_minutes;
    // Dystans i rozbicie aktywności (sedentary/low) to liczniki dzienne jak kroki -
    // celowo NIE są dociągane z poprzednich dni (patrz komentarz powyżej).
    let displayDistanceMeters = health.distance_meters;
    let displaySedentaryMinutes = health.sedentary_minutes;
    let displayLowActivityMinutes = health.low_activity_minutes;
    // Stres (Oura daily_stress) to wynik liczony raz dziennie, tak jak gotowość/sen -
    // dociągamy ostatnią dostępną wartość, jeśli dzisiejsza synchronizacja jeszcze nie
    // nadeszła (patrz analogiczna logika dla displayReadinessScore poniżej).
    let displayStressHighMinutes = health.stress_high_minutes;
    let displayStressRecoveryMinutes = health.stress_recovery_minutes;
    let displayStressSummary = health.stress_summary;

    if (displayWeight === null) {
      const row = await db.get(`SELECT weight FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWeight = row.weight;
    }
    if (displayFatRatio === null) {
      const row = await db.get(`SELECT fat_ratio FROM health_metrics WHERE user_id = ? AND fat_ratio IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayFatRatio = row.fat_ratio;
    }
    if (displayMuscleMass === null) {
      const row = await db.get(`SELECT muscle_mass FROM health_metrics WHERE user_id = ? AND muscle_mass IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayMuscleMass = row.muscle_mass;
    }
    // Ciśnienie tętnicze (Withings BPM) - dociągane analogicznie do wagi/składu ciała,
    // bo pomiar nie jest robiony codziennie.
    if (displayBpSystolic === null) {
      const row = await db.get(`SELECT blood_pressure_systolic FROM health_metrics WHERE user_id = ? AND blood_pressure_systolic IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayBpSystolic = row.blood_pressure_systolic;
    }
    if (displayBpDiastolic === null) {
      const row = await db.get(`SELECT blood_pressure_diastolic FROM health_metrics WHERE user_id = ? AND blood_pressure_diastolic IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayBpDiastolic = row.blood_pressure_diastolic;
    }
    // Uwaga: liczniki dzienne (kroki, kalorie aktywne, kalorie spalone, minuty aktywności)
    // celowo NIE są dociągane z poprzednich dni - mają zerować się każdego dnia, dopóki
    // pierwsza synchronizacja danego dnia nie zapisze nowych wartości w health_metrics.
    // (W przeciwnym razie dashboard otwarty rano przed pierwszą synchronizacją pokazywałby
    // wczorajsze kroki/kalorie, co jest błędne.)
    if (displaySleepScore === null || displaySleepScore === 0) {
      const row = await db.get(`SELECT sleep_score FROM health_metrics WHERE user_id = ? AND sleep_score IS NOT NULL AND sleep_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepScore = row.sleep_score;
    }
    if (displaySleepDuration === null || displaySleepDuration === 0) {
      const row = await db.get(`SELECT sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL AND sleep_duration > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDuration = row.sleep_duration;
    }
    if (displaySleepDeep === null || displaySleepDeep === 0) {
      const row = await db.get(`SELECT sleep_deep FROM health_metrics WHERE user_id = ? AND sleep_deep IS NOT NULL AND sleep_deep > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDeep = row.sleep_deep;
    }
    if (displaySleepRem === null || displaySleepRem === 0) {
      const row = await db.get(`SELECT sleep_rem FROM health_metrics WHERE user_id = ? AND sleep_rem IS NOT NULL AND sleep_rem > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepRem = row.sleep_rem;
    }
    if (displayReadinessScore === null || displayReadinessScore === 0) {
      const row = await db.get(`SELECT readiness_score FROM health_metrics WHERE user_id = ? AND readiness_score IS NOT NULL AND readiness_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayReadinessScore = row.readiness_score;
    }
    if (displayHrv === null || displayHrv === 0) {
      const row = await db.get(`SELECT hrv FROM health_metrics WHERE user_id = ? AND hrv IS NOT NULL AND hrv > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayHrv = row.hrv;
    }
    if (displayRhr === null || displayRhr === 0) {
      const row = await db.get(`SELECT rhr FROM health_metrics WHERE user_id = ? AND rhr IS NOT NULL AND rhr > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRhr = row.rhr;
    }
    if (displayTempDev === null) {
      const row = await db.get(`SELECT temperature_deviation FROM health_metrics WHERE user_id = ? AND temperature_deviation IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayTempDev = row.temperature_deviation;
    }
    if (displayRespiratoryRate === null) {
      const row = await db.get(`SELECT respiratory_rate FROM health_metrics WHERE user_id = ? AND respiratory_rate IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRespiratoryRate = row.respiratory_rate;
    }
    if (displaySpo2 === null) {
      const row = await db.get(`SELECT spo2_percentage FROM health_metrics WHERE user_id = ? AND spo2_percentage IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySpo2 = row.spo2_percentage;
    }
    if (displayWristTemperature === null) {
      const row = await db.get(`SELECT wrist_temperature FROM health_metrics WHERE user_id = ? AND wrist_temperature IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWristTemperature = row.wrist_temperature;
    }
    // displayActiveMinutes / displayDistanceMeters / displaySedentaryMinutes /
    // displayLowActivityMinutes: brak dociągania z poprzednich dni - patrz komentarz powyżej.
    if (displayStressHighMinutes === null) {
      const row = await db.get(`SELECT stress_high_minutes FROM health_metrics WHERE user_id = ? AND stress_high_minutes IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressHighMinutes = row.stress_high_minutes;
    }
    if (displayStressRecoveryMinutes === null) {
      const row = await db.get(`SELECT stress_recovery_minutes FROM health_metrics WHERE user_id = ? AND stress_recovery_minutes IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressRecoveryMinutes = row.stress_recovery_minutes;
    }
    if (displayStressSummary === null) {
      const row = await db.get(`SELECT stress_summary FROM health_metrics WHERE user_id = ? AND stress_summary IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressSummary = row.stress_summary;
    }

    // Ostatni zapisany pomiar obwodów ciała (niezależnie od wybranego dnia dashboardu) -
    // główny Dashboard wcześniej nie pokazywał nawet ostatniej wartości, mimo że pełny
    // CRUD + wykres trendu już istnieje w ActivityTracker.jsx.
    const latestBodyMeasurement = await db.get(
      `SELECT date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below FROM body_measurements WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
      [req.user.id]
    );

    // Realne treningi z danego dnia (zsynchronizowane przez webhook Apple Health,
    // patrz routes/appleHealth.js). Liczone tutaj (przed promptem AI), żeby dało się
    // przekazać dzisiejsze treningi do advicePrompt, nie tylko do odpowiedzi JSON.
    const workoutRows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories,
              avg_heart_rate, max_heart_rate, zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes
       FROM apple_health_workouts WHERE user_id = ? AND date = ? ORDER BY updated_at DESC`,
      [req.user.id, date]
    );
    const workouts = workoutRows.map(w => ({
      type: w.workout_type || 'Trening',
      duration_mins: Math.round(w.duration_minutes || 0),
      calories: Math.round(w.active_calories || 0),
      // Realne strefy kardio (Karvonen) zmierzone na zegarku w trakcie TEGO treningu -
      // patrz routes/appleHealth.js (computeWorkoutHrZones). null, gdy payload Health Auto
      // Export nie zawierał tętna (przełącznik "Include Workout Metrics" wyłączony) albo
      // użytkownik nie podał roku urodzenia (HRmax nieznany).
      avg_hr: w.avg_heart_rate != null ? Math.round(w.avg_heart_rate) : null,
      max_hr: w.max_heart_rate != null ? Math.round(w.max_heart_rate) : null,
      zone_minutes: [w.zone1_minutes, w.zone2_minutes, w.zone3_minutes, w.zone4_minutes, w.zone5_minutes]
    }));

    const activeCalories = displayActiveCalories || 0;
    const bmr = getBmr(settings);
    const totalBurned = displayTotalCaloriesBurned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Streaki celów (kalorie, sen) - liczone wyłącznie na bazie historii już zapisanej
    // w bazie (meals + health_metrics), zero nowych integracji (punkt 9 z analizy
    // dashboardu). Liczymy od WCZORAJ w dół względem przeglądanej daty (dzisiejszy/
    // przeglądany dzień może być jeszcze niedokończony - nie wszystkie posiłki czy sen
    // muszą być już zarejestrowane), przerywając na pierwszym dniu, który nie trafia
    // w cel, albo na pierwszej "dziurze" w danych (brak wpisu = przerwana passa).
    const subtractDay = (dateStr) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - 1);
      return dt.toISOString().split('T')[0];
    };
    const computeStreak = (valuesByDate, referenceDateStr, meetsGoal, maxDays = 90) => {
      let streak = 0;
      let cursor = subtractDay(referenceDateStr);
      for (let i = 0; i < maxDays; i++) {
        if (!valuesByDate.has(cursor) || !meetsGoal(valuesByDate.get(cursor))) break;
        streak++;
        cursor = subtractDay(cursor);
      }
      return streak;
    };

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals WHERE user_id = ? GROUP BY date ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const calorieMap = new Map(calorieRows.map(r => [r.date, r.total_calories]));
    // "Trafienie" w cel kaloryczny = bilans w rozsądnym paśmie wokół celu (+/-15%), nie
    // dokładnie do kalorii - inaczej streak byłby praktycznie niemożliwy do utrzymania.
    const targetCaloriesForStreak = getTargetCalories(settings);
    const calorieStreakDays = computeStreak(calorieMap, date, (total) =>
      total >= targetCaloriesForStreak * 0.85 && total <= targetCaloriesForStreak * 1.15
    );

    const sleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const sleepMap = new Map(sleepRows.map(r => [r.date, r.sleep_duration]));
    // POPRAWKA (runda 4 audytu): !settings.target_sleep_duration traktował realne,
    // zapisane przez użytkownika 0 (cel snu wyłączony) tak samo jak "nie ustawiono celu"
    // (settings.target_sleep_duration === undefined, gdy nie ma wiersza w tabeli settings).
    // Teraz fallback 7.2h włącza się tylko, gdy wartości faktycznie nie ma / jest NaN.
    const targetSleepForStreak = (settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)) ? 7.2 : settings.target_sleep_duration;
    const sleepStreakDays = computeStreak(sleepMap, date, (duration) => duration >= targetSleepForStreak);

    // Generowanie porady od Dietetyka AI na bazie dzisiejszych danych (opcjonalne/throttled co 30 min)
    let aiAdvice = "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.";
    let hasValidCache = false;

    if (health && health.ai_advice) {
      aiAdvice = health.ai_advice;
      if (health.ai_advice_generated_at) {
        const lastGenerated = new Date(health.ai_advice_generated_at).getTime();
        if (Date.now() - lastGenerated < 30 * 60 * 1000) {
          hasValidCache = true;
        }
      }
    }

    if (!hasValidCache) {
      // WAŻNE: dashboard ma być generowany WYŁĄCZNIE na podstawie danych już
      // zapisanych w bazie - to samo zgłoszenie, które kazało nam usunąć dane
      // demo z frontendu, dotyczy też tego miejsca. Wcześniej ten blok robił
      // "await generateContentWithFallback(...)" w trakcie obsługi żądania
      // GET /api/dashboard, czyli CAŁA odpowiedź (w tym kroki, kalorie, sen -
      // dane, które już były gotowe w bazie) czekała na żywe zapytanie sieciowe
      // do Gemini. Stąd wrażenie "dashboard się dociąga" przy otwarciu strony.
      // Teraz: jeśli cache porady wygasł, zwracamy to, co już mamy w bazie
      // (starą poradę lub domyślny placeholder) natychmiast, a nową poradę
      // generujemy w tle (fire-and-forget) - trafi do bazy i pojawi się przy
      // kolejnym odświeżeniu/synchronizacji, bez blokowania tej odpowiedzi.
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
      const userApiKey = apiKeyRow ? apiKeyRow.value : null;
      const forceCustomKeyOnly = req.user.role !== 'admin';
      const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));

      // Klucz (user, data) do blokady równoległego generowania (patrz definicja
      // pendingAdviceGeneration na górze pliku) - jeśli generowanie dla tej (user, data)
      // już trwa (np. inna karta przeglądarki odświeżyła dashboard chwilę wcześniej),
      // NIE odpalamy kolejnego zapytania do Gemini, tylko zostawiamy stary cache/placeholder.
      const adviceLockKey = `${req.user.id}:${date}`;

      if (canUseAI && !pendingAdviceGeneration.has(adviceLockKey) && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
        // Imię (jeśli ustawione w Ustawieniach) ma priorytet nad loginem technicznym -
        // o to prosił użytkownik: AI ma się zwracać po imieniu, nie po nazwie konta.
        const displayName = req.user.first_name || req.user.username;

        // Pomiary i posiłki z wczoraj do kontekstu porównawczego dla AI
        const yesterdayDate = shiftDate(date, -1);
        const yesterdayMealRows = await db.all(
          `SELECT calories, protein, carbs, fat, raw_text FROM meals WHERE user_id = ? AND date = ?`,
          [req.user.id, yesterdayDate]
        );
        let yesterdayTotalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        yesterdayMealRows.forEach(r => {
          yesterdayTotalEaten.calories += r.calories || 0;
          yesterdayTotalEaten.protein += r.protein || 0;
          yesterdayTotalEaten.carbs += r.carbs || 0;
          yesterdayTotalEaten.fat += r.fat || 0;
        });
        yesterdayTotalEaten.protein = Math.round(yesterdayTotalEaten.protein * 10) / 10;
        yesterdayTotalEaten.carbs = Math.round(yesterdayTotalEaten.carbs * 10) / 10;
        yesterdayTotalEaten.fat = Math.round(yesterdayTotalEaten.fat * 10) / 10;

        const yesterdayHealth = await db.get(
          `SELECT active_calories, steps, supplements FROM health_metrics WHERE user_id = ? AND date = ?`,
          [req.user.id, yesterdayDate]
        ) || { active_calories: 0, steps: 0, supplements: null };

        // Pobranie trendów historycznych z bazy danych dla AI
        const last7DaysNutrition = await aggregateNutrition(req.user.id, shiftDate(date, -7), shiftDate(date, -1));
        const last30DaysNutrition = await aggregateNutrition(req.user.id, shiftDate(date, -30), shiftDate(date, -1));
        
        const weightHistory = await db.all(
          `SELECT date, weight, fat_ratio, muscle_mass FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        const sleepHistory = await db.all(
          `SELECT date, sleep_score, readiness_score FROM health_metrics WHERE user_id = ? AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL) ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        const bpHistory = await db.all(
          `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics WHERE user_id = ? AND blood_pressure_systolic IS NOT NULL ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        // Pełna historia suplementów (ostatnie 7 dni z wpisem, nie tylko dziś/wczoraj) -
        // użytkownik wprost zażądał, żeby podsumowanie AI brało WSZYSTKO, co jest
        // wpisywane w aplikacji, łącznie z suplementami, a nie tylko dwa ostatnie dni.
        const supplementsHistory = await db.all(
          `SELECT date, supplements FROM health_metrics WHERE user_id = ? AND supplements IS NOT NULL AND supplements != '' ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );

        // Cel sylwetki (opis tekstowy + opcjonalne zdjęcie referencyjne, ustawiane
        // w Ustawieniach - patrz routes/account.js i migracja w db.js). Nie trzymamy
        // tego w req.user (middleware/auth.js), bo zdjęcie base64 mogłoby być duże
        // i niepotrzebnie obciążałoby KAŻDE uwierzytelnione żądanie - pobieramy je
        // tylko tutaj, raz na faktyczne generowanie porady AI.
        const bodyGoalRow = await db.get(`SELECT body_goal_text, body_goal_photo_base64 FROM users WHERE id = ?`, [req.user.id]);
        const bodyGoalText = bodyGoalRow && bodyGoalRow.body_goal_text ? bodyGoalRow.body_goal_text : null;
        let bodyGoalImagePart = null;
        if (bodyGoalRow && bodyGoalRow.body_goal_photo_base64) {
          const goalPhotoMatch = bodyGoalRow.body_goal_photo_base64.match(/^data:([^;]+);base64,(.+)$/);
          if (goalPhotoMatch) {
            bodyGoalImagePart = {
              inlineData: {
                data: goalPhotoMatch[2],
                mimeType: goalPhotoMatch[1]
              }
            };
          }
        }

        const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${displayName} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${getTargetCalories(settings)} kcal
- Cel Białka: ${settings.target_protein}g, Węglowodanów: ${settings.target_carbs}g, Tłuszczu: ${settings.target_fat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal
- Cel sylwetki opisany przez użytkownika: ${bodyGoalText || 'użytkownik nie opisał celu sylwetki w Ustawieniach'}${bodyGoalImagePart ? '\n- Użytkownik dołączył też zdjęcie referencyjne celu sylwetki (patrz załączony obraz) - przeanalizuj je wizualnie i odnieś rekomendacje do tego, jak wygląda sylwetka na zdjęciu (np. poziom umięśnienia, tkanki tłuszczowej, proporcje), w kontekście pozostałych danych.' : ''}

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g, Błonnik: ${totalEaten.fiber}g, Cukry: ${totalEaten.sugar}g, Sód: ${totalEaten.sodium}mg)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${displaySteps || 0}
- Aktywność dzisiaj: ${displayActiveMinutes || 0} min aktywności, Dystans: ${displayDistanceMeters ? (Math.round(displayDistanceMeters / 100) / 10) + ' km' : '0 km'}, Czas siedzący: ${displaySedentaryMinutes || 0} min, Niska intensywność: ${displayLowActivityMinutes || 0} min
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${getTargetWaterMl(settings)}ml)
- Przyjęte suplementy dzisiaj: ${health.supplements || 'brak (użytkownik nie zapisał dzisiaj żadnych suplementów)'}
- Treningi zarejestrowane dzisiaj (Apple Health): ${workouts.length > 0 ? workouts.map(w => {
    const base = `${w.type} (${w.duration_mins} min, ${w.calories} kcal)`;
    // Realne strefy kardio (Karvonen) zmierzone tętnem w trakcie treningu, gdy Health Auto
    // Export wysłał heartRateData (przełącznik "Include Workout Metrics" włączony) - patrz
    // routes/appleHealth.js. Jeśli niedostępne, AI ocenia intensywność tylko na bazie
    // kalorii/RHR/HRV (patrz instrukcja niżej).
    if (w.avg_hr != null && w.zone_minutes.some(z => z != null)) {
      const zonesStr = w.zone_minutes.map((z, i) => `Z${i + 1}: ${Math.round(z || 0)}min`).join(', ');
      return `${base}, śr. tętno ${w.avg_hr} bpm (max ${w.max_hr} bpm) - realny rozkład stref kardio: ${zonesStr}`;
    }
    return base;
  }).join(', ') : 'brak zarejestrowanych treningów'}
- Passa (streak) trafiania w cel kaloryczny: ${calorieStreakDays} dni, Passa snu wg celu: ${sleepStreakDays} dni

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'Brak danych'} (Czas trwania: ${displaySleepDuration || 0}h, Głęboki: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Odchylenie temperatury ciała: ${displayTempDev !== null ? displayTempDev + ' °C' : 'brak'}
- Oddech i utlenowanie krwi: Częstość oddechów: ${displayRespiratoryRate !== null ? displayRespiratoryRate + '/min' : 'brak'}, SpO2: ${displaySpo2 !== null ? displaySpo2 + '%' : 'brak'}, Temperatura nadgarstka: ${displayWristTemperature !== null ? displayWristTemperature + ' °C' : 'brak'}
- Stres (Oura): Wysoki stres: ${displayStressHighMinutes !== null ? displayStressHighMinutes + ' min' : 'brak danych'}, Regeneracja: ${displayStressRecoveryMinutes !== null ? displayStressRecoveryMinutes + ' min' : 'brak danych'}, Podsumowanie: ${displayStressSummary || 'brak'}
- Wynik Gotowości (Readiness): ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${displayWeight !== null ? displayWeight + ' kg' : 'brak danych'}, Procent tłuszczu: ${displayFatRatio !== null ? displayFatRatio + '%' : 'brak danych'}, Masa mięśniowa: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'brak danych'}
- Ciśnienie tętnicze (Withings): ${displayBpSystolic !== null && displayBpDiastolic !== null ? `${displayBpSystolic}/${displayBpDiastolic} mmHg` : 'brak danych'}
- Obwody ciała (ostatni zapisany pomiar${latestBodyMeasurement ? ', ' + latestBodyMeasurement.date : ''}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Pas +2cm: ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Pas -2cm: ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Barki: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps lewy: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps prawy: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'brak wypełnionych pól' : 'brak danych w bazie'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Dla kontekstu historycznego, oto dane z wczoraj (${yesterdayDate}):
- Łącznie zjedzone wczoraj: ${yesterdayTotalEaten.calories} kcal (Białko: ${yesterdayTotalEaten.protein}g, Węgle: ${yesterdayTotalEaten.carbs}g, Tłuszcz: ${yesterdayTotalEaten.fat}g)
- Aktywne kalorie spalone wczoraj: ${yesterdayHealth.active_calories || 0} kcal
- Wykonane kroki wczoraj: ${yesterdayHealth.steps || 0}
- Przyjęte suplementy wczoraj: ${yesterdayHealth.supplements || 'brak'}
- Lista wczorajszych posiłków:
${yesterdayMealRows.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak posiłków wczoraj'}

Trendy i historia z bazy danych użytkownika:
- Średnie odżywianie z ostatnich 7 dni: ${last7DaysNutrition.avg ? `${last7DaysNutrition.avg.calories} kcal (B: ${last7DaysNutrition.avg.protein}g, W: ${last7DaysNutrition.avg.carbs}g, T: ${last7DaysNutrition.avg.fat}g, Błonnik: ${last7DaysNutrition.avg.fiber}g, Cukry: ${last7DaysNutrition.avg.sugar}g, Sód: ${last7DaysNutrition.avg.sodium}mg) na ${last7DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Średnie odżywianie z ostatnich 30 dni: ${last30DaysNutrition.avg ? `${last30DaysNutrition.avg.calories} kcal (B: ${last30DaysNutrition.avg.protein}g, W: ${last30DaysNutrition.avg.carbs}g, T: ${last30DaysNutrition.avg.fat}g, Błonnik: ${last30DaysNutrition.avg.fiber}g, Cukry: ${last30DaysNutrition.avg.sugar}g, Sód: ${last30DaysNutrition.avg.sodium}mg) na ${last30DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Historia pomiarów wagi i składu ciała (ostatnie wpisy):
${weightHistory.map(w => `- ${w.date}: ${w.weight} kg (tłuszcz: ${w.fat_ratio || '-'}%, mięśnie: ${w.muscle_mass || '-'} kg)`).join('\n') || 'brak danych w bazie'}
- Historia suplementów (ostatnie wpisy, nie tylko dziś/wczoraj):
${supplementsHistory.map(s => `- ${s.date}: ${s.supplements}`).join('\n') || 'brak zapisanych suplementów w bazie'}
- Ostatnia jakość snu i gotowości Oura:
${sleepHistory.map(s => `- ${s.date}: Sen ${s.sleep_score || '-'}, Gotowość ${s.readiness_score || '-'}`).join('\n') || 'brak danych w bazie'}
- Historia ciśnienia tętniczego (Withings, ostatnie pomiary):
${bpHistory.map(b => `- ${b.date}: ${b.blood_pressure_systolic}/${b.blood_pressure_diastolic} mmHg`).join('\n') || 'brak danych w bazie'}

Twoja analiza MUSI uwzględniać WSZYSTKIE dane podane powyżej (dzisiejsze posiłki i mikroelementy, aktywność, treningi, suplementy, porównanie z wczoraj, trendy 7/30-dniowe, historię wagi/składu ciała/obwodów, ciśnienia tętniczego, snu, gotowości, stresu i parametrów oddechowych) - to jest kluczowa funkcja tej aplikacji, użytkownik oczekuje analizy na bazie CAŁEJ historii i wszystkich dostępnych metryk, nie tylko jednego dnia czy wybranych wskaźników. Weź pod uwagę przy analizie i rekomendacjach:
1. Intensywność wysiłku i strefy kardio: jeśli przy treningu podano "realny rozkład stref kardio" (zmierzony tętnem podczas treningu, strefy Z1-Z5 metodą Karvonena: Z1 regeneracja, Z2 spalanie tłuszczu/baza tlenowa, Z3 tempo, Z4-Z5 wysoka intensywność beztlenowa), PRIORYTETOWO oprzyj ocenę na tych realnych minutach w strefach, nie na szacowaniu - i odnieś ten rozkład wprost do celu sylwetki użytkownika (np. przy celu redukcji/spalania tłuszczu doceń czas w Z2, przy celu budowy wydolności/masy zwróć uwagę na czas w Z3-Z4, a nadmiar minut w Z1 przy intensywnym typie treningu skomentuj jako niewykorzystany potencjał). Jeśli realnych stref nie podano (brak danych z zegarka), oceń intensywność orientacyjnie na bazie aktywnych kalorii, typu/czasu trwania treningu oraz RHR/HRV, zaznaczając że to oszacowanie.
2. Precyzyjne zmiany w diecie na bazie dzisiejszych posiłków i treningu, w tym jakość diety pod kątem błonnika, cukrów prostych i sodu (np. zbyt mało błonnika w stosunku do kalorii, zbyt dużo cukrów prostych lub sodu w ostatnich dniach) - nie tylko makra, ale pełny obraz odżywiania.
3. Porównanie dzisiejszego odżywiania i aktywności z wczorajszymi oraz z trendem 7/30-dniowym - jeśli dieta z ostatnich dni nie była optymalna (np. za mało białka w stosunku do celu, zbyt mało kcal po dużym treningu lub nadmiar kalorii przy braku ruchu), wskaż to konstruktywnie i doradź konkretną korektę.
4. Wnioski z trendu wagi, składu ciała i obwodów ciała z ostatnich pomiarów Withings oraz jakości snu, regeneracji i poziomu stresu z Oura (zwróć uwagę, czy obecny trend przybliża użytkownika do celu w dłuższej perspektywie 7/30 dni).
5. Przyjęte suplementy: przeanalizuj CAŁĄ historię suplementów (nie tylko dziś/wczoraj, ale wszystkie dostępne wpisy z ostatnich dni) i skomentuj krótko ich przydatność, regularność przyjmowania i czas przyjmowania w odniesieniu do treningu i samopoczucia użytkownika.
6. Ciśnienie tętnicze: jeśli dostępne są pomiary ciśnienia, oceń czy wartości są w normie (orientacyjnie <120/80 mmHg optymalnie, 120-129/<80 podwyższone prawidłowe, ≥130/80 nadciśnienie) i czy trend z ostatnich pomiarów jest stabilny, rosnący czy spadkowy - jeśli widzisz niepokojący trend lub wartości podwyższone, zalecaj konsultację lekarską (nie diagnozuj).
7. Regeneracja i stres: jeśli dostępne są dane o stresie (Oura), SpO2, częstości oddechów czy temperaturze nadgarstka, skomentuj ogólny stan regeneracji organizmu i zasugeruj, czy potrzebny jest dzień odpoczynku.
8. Konsekwencja (streaki): jeśli użytkownik ma passę trafiania w cel kaloryczny lub cel snu, doceń to krótko - jeśli passa jest przerwana lub bliska zera, zachęcająco zasugeruj, jak wrócić na właściwe tory.
9. Cel sylwetki: jeśli użytkownik opisał swój cel sylwetki (i/lub dołączył zdjęcie referencyjne), odnieś dzisiejsze i historyczne dane DO TEGO CELU - oceń, czy obecne tempo, dieta i trening realnie do niego prowadzą, i jeśli nie, zaproponuj konkretną korektę. Jeśli cel nie został opisany, pomiń ten punkt bez komentowania jego braku.

Sformatuj odpowiedź WYŁĄCZNIE w tej strukturze Markdown (frontend renderuje nagłówki, pogrubienia i listy punktowane):
1. Jedno krótkie, spersonalizowane zdanie wstępu, zwracające się do użytkownika po imieniu (${displayName}).
2. Nagłówek "## Analiza" a pod nim 2-3 zwięzłe zdania syntetyzujące dzisiejsze dane NA TLE trendu historycznego (wczoraj + 7/30 dni) - to ma być realna analiza porównawcza, nie powtórzenie samych liczb.
3. Nagłówek "## Rekomendacje" a pod nim lista punktowana (3-5 punktów, każdy zaczynający się od "- ") z konkretnymi, wykonalnymi działaniami wynikającymi z analizy (dieta i mikroelementy, trening, regeneracja i stres, suplementy, ciśnienie - tylko te obszary, które mają pokrycie w danych).
Używaj **pogrubienia** dla kluczowych liczb i fraz w Analizie i Rekomendacjach. Pisz w języku polskim, bezpośrednio do użytkownika, konkretnie i merytorycznie, bez lania wody.
`;

        // Oznaczamy (user, data) jako "generowanie w toku" PRZED startem zapytania do
        // Gemini, żeby kolejne, prawie równoczesne żądanie GET /api/dashboard (patrz
        // warunek pendingAdviceGeneration.has(...) powyżej) nie odpaliło duplikatu.
        pendingAdviceGeneration.add(adviceLockKey);

        // Fire-and-forget: NIE czekamy na wynik w tym żądaniu (patrz komentarz wyżej).
        generateContentWithFallback(advicePrompt, false, bodyGoalImagePart, userApiKey, forceCustomKeyOnly)
          .then(async (text) => {
            const trimmed = text.trim();
            const nowStr = new Date().toISOString();
            await db.run(`
              INSERT INTO health_metrics (user_id, date, ai_advice, ai_advice_generated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, date) DO UPDATE SET
                ai_advice = excluded.ai_advice,
                ai_advice_generated_at = excluded.ai_advice_generated_at
            `, [req.user.id, date, trimmed, nowStr]);
          })
          .catch((aiErr) => {
            console.error('[API ERROR] Błąd generowania porady AI (w tle):', aiErr);
          })
          .finally(() => {
            // Usuwamy blokadę zarówno po sukcesie, jak i po błędzie - inaczej błąd
            // (np. tymczasowa awaria Gemini) zablokowałby generowanie porady dla tej
            // (user, data) na zawsze, do restartu serwera.
            pendingAdviceGeneration.delete(adviceLockKey);
          });
      }
    }

    res.json({
      date,
      summary: {
        target_calories: settings.target_calories,
        target_protein: settings.target_protein,
        target_carbs: settings.target_carbs,
        target_fat: settings.target_fat,
        // POPRAWKA (runda 4 audytu): te pola to cele aktywności edytowalne w
        // ActivityTracker/Ustawieniach z atrybutem min="0" - użytkownik może świadomie
        // zapisać 0 (np. wyłączyć śledzenie celu kroków). Poprzedni warunek `!wartość`
        // traktował to zapisane 0 identycznie jak "brak wiersza w settings" (undefined)
        // i bezpowrotnie nadpisywał je domyślną wartością przy każdym odświeżeniu
        // dashboardu - 0 nigdy nie wracało do frontu. Teraz fallback działa tylko
        // faktycznie brakującej (undefined) lub niepoprawnej (NaN) wartości.
        target_steps: (settings.target_steps === undefined || isNaN(settings.target_steps)) ? 10000 : settings.target_steps,
        target_active_calories: (settings.target_active_calories === undefined || isNaN(settings.target_active_calories)) ? 500 : settings.target_active_calories,
        target_sleep_duration: (settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)) ? 7.2 : settings.target_sleep_duration,
        target_active_minutes: (settings.target_active_minutes === undefined || isNaN(settings.target_active_minutes)) ? 30 : settings.target_active_minutes,
        target_water_ml: getTargetWaterMl(settings),
        // Cel wagowy (kg) - pole opcjonalne (0 = brak ustawionego celu), używane
        // przez ActivityTracker.jsx do prognozy "do celu" (regresja liniowa).
        // Bez wpisania tu nie wracałoby z /api/dashboard mimo zapisania w
        // tabeli settings przez POST /api/settings (patrz account.js).
        target_weight_kg: (settings.target_weight_kg === undefined || isNaN(settings.target_weight_kg)) ? 0 : settings.target_weight_kg,
        height_cm: isNaN(settings.height_cm) || !settings.height_cm || settings.height_cm <= 0 ? null : settings.height_cm,
        bmr,
        calories_eaten: totalEaten.calories,
        calories_burned_active: activeCalories,
        calories_burned_total: totalBurned,
        net_calories: netCalories,
        eaten_protein: totalEaten.protein,
        eaten_carbs: totalEaten.carbs,
        eaten_fat: totalEaten.fat,
        steps: displaySteps || 0,
        workouts,
        last_sync: health.last_sync,
        sleep_score: displaySleepScore,
        sleep_duration: displaySleepDuration,
        sleep_deep: displaySleepDeep,
        sleep_rem: displaySleepRem,
        readiness_score: displayReadinessScore,
        hrv: displayHrv,
        rhr: displayRhr,
        temperature_deviation: displayTempDev,
        respiratory_rate: displayRespiratoryRate,
        spo2_percentage: displaySpo2,
        wrist_temperature: displayWristTemperature,
        weight: displayWeight,
        fat_ratio: displayFatRatio,
        muscle_mass: displayMuscleMass,
        blood_pressure_systolic: displayBpSystolic,
        blood_pressure_diastolic: displayBpDiastolic,
        active_minutes: displayActiveMinutes || 0,
        distance_meters: displayDistanceMeters || 0,
        sedentary_minutes: displaySedentaryMinutes || 0,
        low_activity_minutes: displayLowActivityMinutes || 0,
        stress_high_minutes: displayStressHighMinutes,
        stress_recovery_minutes: displayStressRecoveryMinutes,
        stress_summary: displayStressSummary,
        water_ml: health.water_ml || 0,
        supplements: health.supplements || null,
        has_oura: !!hasOuraRow,
        has_withings: !!hasWithingsRow,
        activity_source: health.activity_source || null,
        latest_body_measurement: latestBodyMeasurement || null,
        calorie_streak_days: calorieStreakDays,
        sleep_streak_days: sleepStreakDays,
        user_max_hr: userMaxHr
      },
      meals,
      aiAdvice
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania danych dashboardu.' });
  }
});

// Porównanie odżywiania tydzień/miesiąc - bieżący okres (ostatnie 7/30 dni
// licząc do wybranej daty) vs poprzedni okres tej samej długości.
router.get('/api/dashboard/nutrition-comparison', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();

    const weekCurrentStart = shiftDate(today, -6);
    const weekPreviousEnd = shiftDate(weekCurrentStart, -1);
    const weekPreviousStart = shiftDate(weekPreviousEnd, -6);

    const monthCurrentStart = shiftDate(today, -29);
    const monthPreviousEnd = shiftDate(monthCurrentStart, -1);
    const monthPreviousStart = shiftDate(monthPreviousEnd, -29);

    const [weekCurrent, weekPrevious, monthCurrent, monthPrevious] = await Promise.all([
      aggregateNutrition(req.user.id, weekCurrentStart, today),
      aggregateNutrition(req.user.id, weekPreviousStart, weekPreviousEnd),
      aggregateNutrition(req.user.id, monthCurrentStart, today),
      aggregateNutrition(req.user.id, monthPreviousStart, monthPreviousEnd)
    ]);

    const pctChange = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return null;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    res.json({
      date: today,
      week: {
        current: weekCurrent,
        previous: weekPrevious,
        calories_change_pct: pctChange(weekCurrent.avg?.calories, weekPrevious.avg?.calories)
      },
      month: {
        current: monthCurrent,
        previous: monthPrevious,
        calories_change_pct: pctChange(monthCurrent.avg?.calories, monthPrevious.avg?.calories)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania porównania odżywiania.' });
  }
});

// Bilans kaloryczny narastająco za ostatnie 7 i 30 dni względem celu.
router.get('/api/dashboard/calorie-balance', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);
    const bmr = getBmr(settings);

    const [week, month] = await Promise.all([
      aggregateCalorieBalance(req.user.id, shiftDate(today, -6), today, targetCalories, bmr),
      aggregateCalorieBalance(req.user.id, shiftDate(today, -29), today, targetCalories, bmr)
    ]);

    res.json({ date: today, week, month });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania bilansu kalorycznego.' });
  }
});

// Insight: wpływ snu na odżywianie NASTĘPNEGO dnia (kalorie/cukier). Dzielimy
// noce z danymi o śnie (Oura) na "krótki sen" i "wystarczający sen" względem
// celu użytkownika (target_sleep_duration, domyślnie 7.2h - ten sam cel co na
// karcie "Czas snu"), a potem porównujemy średnie spożycie kalorii/cukru
// następnego dnia w obu grupach. To nie jest test statystyczny - to opisowe
// porównanie dwóch średnich na realnych danych użytkownika, więc wymagamy
// minimalnej liczby dni w KAŻDEJ grupie (MIN_NIGHTS_PER_GROUP), inaczej wynik
// byłby przypadkowy (np. 1 krótka noc z akurat sytą kolacją następnego dnia).
const MIN_NIGHTS_PER_GROUP = 5;
const SLEEP_INSIGHT_LOOKBACK_DAYS = 90;

router.get('/api/dashboard/sleep-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -SLEEP_INSIGHT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const sleepThreshold = isNaN(settings.target_sleep_duration) || !settings.target_sleep_duration
      ? 7.2
      : settings.target_sleep_duration;

    // Noce ze znanym czasem snu - data tej noclegówki to dzień, do którego Oura
    // przypisuje sen (rano po przebudzeniu), więc "następny dzień" w sensie
    // odżywiania to po prostu data+1.
    const sleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_duration IS NOT NULL`,
      [req.user.id, startDate, today]
    );

    if (sleepRows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_sleep_data', sleepThreshold });
    }

    // Posiłki zgrupowane po dniu - potrzebujemy sum kalorii/cukru dla KAŻDEGO
    // dnia w oknie (+1 dzień ponad zakres snu, żeby objąć "następny dzień" po
    // ostatniej nocy z danymi).
    const mealRows = await db.all(
      `SELECT date, SUM(calories) AS calories, SUM(sugar) AS sugar
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const mealsByDate = new Map(mealRows.map(r => [r.date, { calories: r.calories || 0, sugar: r.sugar || 0 }]));

    const shortSleepNext = [];
    const goodSleepNext = [];

    sleepRows.forEach(row => {
      const nextDay = shiftDate(row.date, 1);
      const nextMeals = mealsByDate.get(nextDay);
      // Dzień bez ŻADNEGO zapisanego posiłku (nie ma wpisu w mealsByDate) nie
      // wchodzi do porównania - "0 kcal następnego dnia" oznaczałoby tu brak
      // logowania, nie realny fakt "nic nie jadł", co fałszywie zaniżałoby
      // średnią danej grupy.
      if (!nextMeals) return;
      const bucket = row.sleep_duration < sleepThreshold ? shortSleepNext : goodSleepNext;
      bucket.push(nextMeals);
    });

    if (shortSleepNext.length < MIN_NIGHTS_PER_GROUP || goodSleepNext.length < MIN_NIGHTS_PER_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_nights',
        sleepThreshold,
        shortSleepNights: shortSleepNext.length,
        goodSleepNights: goodSleepNext.length,
        minNightsRequired: MIN_NIGHTS_PER_GROUP
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;

    const avgCaloriesShort = avg(shortSleepNext, 'calories');
    const avgCaloriesGood = avg(goodSleepNext, 'calories');
    const avgSugarShort = avg(shortSleepNext, 'sugar');
    const avgSugarGood = avg(goodSleepNext, 'sugar');

    res.json({
      hasEnoughData: true,
      sleepThreshold,
      shortSleepNights: shortSleepNext.length,
      goodSleepNights: goodSleepNext.length,
      avgCaloriesAfterShortSleep: avgCaloriesShort,
      avgCaloriesAfterGoodSleep: avgCaloriesGood,
      caloriesDiff: Math.round((avgCaloriesShort - avgCaloriesGood) * 10) / 10,
      avgSugarAfterShortSleep: avgSugarShort,
      avgSugarAfterGoodSleep: avgSugarGood,
      sugarDiff: Math.round((avgSugarShort - avgSugarGood) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sen-odżywianie.' });
  }
});

// Próg "wysokiego sodu" wg wytycznych WHO/AHA (górna granica dziennego spożycia
// dla populacji ogólnej) - świadomie NIE jest to ustawienie użytkownika, bo to
// uznany punkt odniesienia kliniczny, a nie cel personalny jak target_calories.
const SODIUM_HIGH_THRESHOLD_MG = 2300;
const MIN_DAYS_PER_SODIUM_GROUP = 5;
const SODIUM_BP_LOOKBACK_DAYS = 90;

// Alert/insight: sód -> ciśnienie następnego dnia. Dwie niezależne części:
// 1) "today" - czy DZIŚ spożycie sodu już przekroczyło próg WHO/AHA (działa
//    od razu, niezależnie od historii - to ostrzeżenie wg wytycznych, nie
//    odkrycie z danych użytkownika).
// 2) "insight" - porównanie średniego ciśnienia NASTĘPNEGO dnia po dniach z
//    wysokim sodem vs dniach z sodem w normie, na bazie realnej historii
//    użytkownika (Withings) - jak przy insighcie sen->odżywianie, wymaga
//    minimalnej liczby dni w każdej grupie.
router.get('/api/dashboard/sodium-bp-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -SODIUM_BP_LOOKBACK_DAYS);

    // Część 1: sód zjedzony dziś (niezależnie od tego, czy mamy już wystarczającą historię).
    const todayRow = await db.get(
      `SELECT SUM(sodium) AS sodium FROM meals WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    const todaySodium = todayRow && todayRow.sodium != null ? Math.round(todayRow.sodium) : null;
    const todayHighSodium = todaySodium != null && todaySodium >= SODIUM_HIGH_THRESHOLD_MG;

    // Część 2: historia sodu (dzień) -> ciśnienie (dzień+1).
    const sodiumRows = await db.all(
      `SELECT date, SUM(sodium) AS sodium FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const bpRows = await db.all(
      `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND blood_pressure_systolic IS NOT NULL AND blood_pressure_diastolic IS NOT NULL`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const bpByDate = new Map(bpRows.map(r => [r.date, { sys: r.blood_pressure_systolic, dia: r.blood_pressure_diastolic }]));

    const highSodiumNext = [];
    const normalSodiumNext = [];

    sodiumRows.forEach(row => {
      if (row.sodium == null) return;
      const nextDay = shiftDate(row.date, 1);
      const nextBp = bpByDate.get(nextDay);
      if (!nextBp) return;
      const bucket = row.sodium >= SODIUM_HIGH_THRESHOLD_MG ? highSodiumNext : normalSodiumNext;
      bucket.push(nextBp);
    });

    let insight;
    if (highSodiumNext.length < MIN_DAYS_PER_SODIUM_GROUP || normalSodiumNext.length < MIN_DAYS_PER_SODIUM_GROUP) {
      insight = {
        hasEnoughData: false,
        reason: 'not_enough_days',
        highSodiumDays: highSodiumNext.length,
        normalSodiumDays: normalSodiumNext.length,
        minDaysRequired: MIN_DAYS_PER_SODIUM_GROUP
      };
    } else {
      const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
      const avgSysHigh = avg(highSodiumNext, 'sys');
      const avgSysNormal = avg(normalSodiumNext, 'sys');
      const avgDiaHigh = avg(highSodiumNext, 'dia');
      const avgDiaNormal = avg(normalSodiumNext, 'dia');
      insight = {
        hasEnoughData: true,
        highSodiumDays: highSodiumNext.length,
        normalSodiumDays: normalSodiumNext.length,
        avgSystolicAfterHighSodium: avgSysHigh,
        avgSystolicAfterNormalSodium: avgSysNormal,
        systolicDiff: Math.round((avgSysHigh - avgSysNormal) * 10) / 10,
        avgDiastolicAfterHighSodium: avgDiaHigh,
        avgDiastolicAfterNormalSodium: avgDiaNormal,
        diastolicDiff: Math.round((avgDiaHigh - avgDiaNormal) * 10) / 10
      };
    }

    res.json({
      sodiumThresholdMg: SODIUM_HIGH_THRESHOLD_MG,
      today: { sodium: todaySodium, isHigh: todayHighSodium },
      insight
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sód-ciśnienie.' });
  }
});

// Trening uznajemy za "znaczący" (a nie incydentalną aktywność dnia) od tej
// liczby minut łącznie w danym dniu (apple_health_workouts.duration_minutes) -
// to próg odróżniający realny trening od np. krótkiego spaceru zarejestrowanego
// jako "workout" przez zegarek.
const SIGNIFICANT_WORKOUT_MIN_MINUTES = 20;
const MIN_DAYS_PER_RECOVERY_GROUP = 5;
const RECOVERY_LOOKBACK_DAYS = 90;

// Wskaźnik regeneracji: jak HRV/RHR dnia NASTĘPNEGO po znaczącym treningu
// wypadają na tle "normalnych" dni użytkownika (bez treningu dzień wcześniej).
// HRV niższe i/lub RHR wyższe niż baseline po treningu = sygnał niedostatecznej
// regeneracji (typowo po zbyt intensywnym/częstym treningu); odwrotnie = dobra
// adaptacja. To opisowe porównanie dwóch średnich z danych Oura użytkownika,
// nie diagnoza medyczna.
router.get('/api/dashboard/recovery-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -RECOVERY_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, SUM(duration_minutes) AS total_minutes
       FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY date HAVING total_minutes >= ?`,
      [req.user.id, startDate, today, SIGNIFICANT_WORKOUT_MIN_MINUTES]
    );

    if (workoutRows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_significant_workouts' });
    }

    const hrvRhrRows = await db.all(
      `SELECT date, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND hrv IS NOT NULL AND hrv > 0 AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const metricsByDate = new Map(hrvRhrRows.map(r => [r.date, { hrv: r.hrv, rhr: r.rhr }]));

    const postWorkoutDates = new Set(workoutRows.map(r => shiftDate(r.date, 1)));
    const postWorkout = [];
    const otherDays = [];

    hrvRhrRows.forEach(r => {
      if (postWorkoutDates.has(r.date)) {
        postWorkout.push(metricsByDate.get(r.date));
      } else {
        otherDays.push(metricsByDate.get(r.date));
      }
    });

    if (postWorkout.length < MIN_DAYS_PER_RECOVERY_GROUP || otherDays.length < MIN_DAYS_PER_RECOVERY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        postWorkoutDays: postWorkout.length,
        otherDays: otherDays.length,
        minDaysRequired: MIN_DAYS_PER_RECOVERY_GROUP
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgHrvPostWorkout = avg(postWorkout, 'hrv');
    const avgHrvOther = avg(otherDays, 'hrv');
    const avgRhrPostWorkout = avg(postWorkout, 'rhr');
    const avgRhrOther = avg(otherDays, 'rhr');

    // Najnowszy trening ze znaną regeneracją następnego dnia - konkretny,
    // aktualny punkt odniesienia pokazywany razem ze statystyką ogólną.
    const latestWorkout = [...workoutRows].sort((a, b) => (a.date < b.date ? 1 : -1))
      .find(w => metricsByDate.has(shiftDate(w.date, 1)));
    let latest = null;
    if (latestWorkout) {
      const nextDate = shiftDate(latestWorkout.date, 1);
      const m = metricsByDate.get(nextDate);
      latest = { workoutDate: latestWorkout.date, recoveryDate: nextDate, hrv: m.hrv, rhr: m.rhr };
    }

    res.json({
      hasEnoughData: true,
      postWorkoutDays: postWorkout.length,
      otherDays: otherDays.length,
      avgHrvPostWorkout,
      avgHrvOtherDays: avgHrvOther,
      hrvDiff: Math.round((avgHrvPostWorkout - avgHrvOther) * 10) / 10,
      avgRhrPostWorkout,
      avgRhrOtherDays: avgRhrOther,
      rhrDiff: Math.round((avgRhrPostWorkout - avgRhrOther) * 10) / 10,
      latest
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania wskaźnika regeneracji.' });
  }
});

// Próg minimalnej liczby dni z/bez danego suplementu, żeby w ogóle pokazać go
// w wynikach - jak w pozostałych insightach (sen-odżywianie, sód-ciśnienie,
// regeneracja), bez tego pojedynczy dzień z suplementem i dobrym snem
// wygenerowałby fałszywie mocny wniosek ("suplement X = +2 pkt snu!").
const MIN_DAYS_PER_SUPPLEMENT_GROUP = 3;
const SUPPLEMENTS_SLEEP_LOOKBACK_DAYS = 90;
// Maksymalna liczba suplementów pokazywanych w wyniku - tylko te z największą
// (co do wartości absolutnej) różnicą, żeby nie zasypywać użytkownika
// dziesiątkami marginalnych porównań.
const MAX_SUPPLEMENT_FINDINGS = 5;

// Insight: suplementy (wolny tekst, pole health_metrics.supplements) vs sen/
// regeneracja TEGO SAMEGO dnia. Pairing "ten sam dzień" (nie dzień+1) jest
// świadomy i zgodny z istniejącą konwencją już ustaloną w tym pliku (prompt AI
// dashboardu, ok. linii 456-519) oraz w services/summaries.js - suplementy
// zalogowane na dzień D są tam zestawiane z sleep_score/readiness_score z
// dnia D, nie D+1. Nie kopiujemy tu żadnego mechanizmu z konkurencyjnych apek -
// to wyłącznie własna analiza już zbieranych przez Dietetyk-AI danych
// (suplementy z routes/health.js + sleep_score/readiness_score z Oura).
//
// Parsowanie tekstu suplementów: split po przecinku + trim, identycznie jak
// w istniejącej logice frontu (Dashboard.jsx, handleSaveSupplements) - jedyna
// ustalona w kodzie konwencja separatora, nie wprowadzamy tu nowej.
router.get('/api/dashboard/supplements-sleep-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -SUPPLEMENTS_SLEEP_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, supplements, sleep_score, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND supplements IS NOT NULL AND TRIM(supplements) != ''
       AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    if (rows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_supplement_data' });
    }

    // Wszystkie dni w oknie z choć jednym znanym wskaźnikiem snu/regeneracji -
    // potrzebne jako "wszechświat" do policzenia grupy "BEZ" danego suplementu
    // (dzień bez wpisanych suplementów liczy się jako "bez" KAŻDEGO z nich;
    // brak wpisu w polu supplements traktujemy jako realny fakt "nie brał",
    // nie jako brak danych - w przeciwieństwie do np. brakującego logowania
    // posiłków w innych insightach).
    const allDaysRows = await db.all(
      `SELECT date, supplements, sleep_score, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    const parseSupplements = (text) =>
      (text || '').split(',').map((s) => s.trim()).filter(Boolean);

    // Zbiór unikalnych suplementów (porównanie bez rozróżniania wielkości liter,
    // ale do wyświetlenia używamy pierwszej napotkanej wersji zapisu, żeby nie
    // psuć np. nazw własnych).
    const displayNameByKey = new Map();
    rows.forEach((r) => {
      parseSupplements(r.supplements).forEach((s) => {
        const key = s.toLowerCase();
        if (!displayNameByKey.has(key)) displayNameByKey.set(key, s);
      });
    });

    const avg = (arr, key) => {
      const vals = arr.map((x) => x[key]).filter((v) => v != null);
      if (vals.length === 0) return null;
      return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    };

    const findings = [];
    for (const [key, displayName] of displayNameByKey.entries()) {
      const withDays = [];
      const withoutDays = [];
      allDaysRows.forEach((r) => {
        const tokens = parseSupplements(r.supplements).map((s) => s.toLowerCase());
        (tokens.includes(key) ? withDays : withoutDays).push(r);
      });

      if (withDays.length < MIN_DAYS_PER_SUPPLEMENT_GROUP || withoutDays.length < MIN_DAYS_PER_SUPPLEMENT_GROUP) {
        continue;
      }

      const avgSleepWith = avg(withDays, 'sleep_score');
      const avgSleepWithout = avg(withoutDays, 'sleep_score');
      const avgReadinessWith = avg(withDays, 'readiness_score');
      const avgReadinessWithout = avg(withoutDays, 'readiness_score');
      const sleepDiff = avgSleepWith != null && avgSleepWithout != null
        ? Math.round((avgSleepWith - avgSleepWithout) * 10) / 10
        : null;
      const readinessDiff = avgReadinessWith != null && avgReadinessWithout != null
        ? Math.round((avgReadinessWith - avgReadinessWithout) * 10) / 10
        : null;

      // Suplement bez żadnej liczonej różnicy (np. brak danych sleep_score
      // ANI readiness_score w obu grupach) nie wnosi nic do wyniku.
      if (sleepDiff == null && readinessDiff == null) continue;

      findings.push({
        supplement: displayName,
        daysWith: withDays.length,
        daysWithout: withoutDays.length,
        avgSleepScoreWith: avgSleepWith,
        avgSleepScoreWithout: avgSleepWithout,
        sleepScoreDiff: sleepDiff,
        avgReadinessScoreWith: avgReadinessWith,
        avgReadinessScoreWithout: avgReadinessWithout,
        readinessScoreDiff: readinessDiff
      });
    }

    if (findings.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_supplement',
        minDaysRequired: MIN_DAYS_PER_SUPPLEMENT_GROUP
      });
    }

    // Sortowanie po największej (co do wartości absolutnej) różnicy snu, a przy
    // jej braku - regeneracji. Najbardziej "zauważalne" wyniki na początku.
    findings.sort((a, b) => {
      const scoreOf = (f) => Math.max(Math.abs(f.sleepScoreDiff || 0), Math.abs(f.readinessScoreDiff || 0));
      return scoreOf(b) - scoreOf(a);
    });

    res.json({
      hasEnoughData: true,
      lookbackDays: SUPPLEMENTS_SLEEP_LOOKBACK_DAYS,
      findings: findings.slice(0, MAX_SUPPLEMENT_FINDINGS)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu suplementy-sen.' });
  }
});

// Adaptacyjna korekta celu kalorycznego: porównuje DEKLAROWANY bilans kaloryczny
// (na bazie zalogowanych posiłków: zjedzone - (BMR + kalorie aktywne)) z bilansem
// WYNIKAJĄCYM Z REALNEJ zmiany wagi (regresja liniowa po pomiarach wagi, slope
// kg/dzień razy przybliżenie 7700 kcal/kg). Rozjazd między tymi dwiema liczbami
// (gap) zwykle oznacza niedoszacowanie/przeszacowanie porcji, nieuwzględnione
// "podjadanie" albo nieprecyzyjny BMR - a nie że cel kaloryczny jest źle ustawiony
// per se. Sugerujemy więc korektę CELU tak, aby przy dotychczasowym sposobie
// logowania realny efekt zbliżył się do oryginalnie zamierzonego tempa.
// Wymagamy solidnej próbki w obu wymiarach (dni z posiłkami i pomiary wagi
// rozciągnięte na sensowny okres) - inaczej szum pomiarowy (np. wahania wody)
// dałby fałszywą sugestię.
const CALORIE_RECAL_LOOKBACK_DAYS = 21;
const KCAL_PER_KG = 7700; // szacunkowa wartość energetyczna 1 kg tkanki - powszechnie używane przybliżenie
const MIN_LOGGED_DAYS = 10;
const MIN_WEIGHT_MEASUREMENTS = 4;
const MIN_WEIGHT_SPAN_DAYS = 10;
const MIN_MEANINGFUL_GAP_KCAL = 100;

router.get('/api/dashboard/calorie-target-suggestion', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -(CALORIE_RECAL_LOOKBACK_DAYS - 1));

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const currentTargetCalories = getTargetCalories(settings);
    const bmr = getBmr(settings);

    const balance = await aggregateCalorieBalance(req.user.id, startDate, today, currentTargetCalories, bmr);
    if (balance.days_with_data < MIN_LOGGED_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_logged_days', daysLogged: balance.days_with_data, minDaysRequired: MIN_LOGGED_DAYS });
    }
    const loggedDailyBalance = balance.balance_vs_burned / balance.days_with_data;

    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    if (weightRows.length < MIN_WEIGHT_MEASUREMENTS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_weight_data', weightMeasurements: weightRows.length, minWeightMeasurementsRequired: MIN_WEIGHT_MEASUREMENTS });
    }
    const baseTime = new Date(weightRows[0].date).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const points = weightRows.map(r => ({ x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r.weight }));
    const spanDays = points[points.length - 1].x;
    if (spanDays < MIN_WEIGHT_SPAN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'weight_span_too_short', spanDays: Math.round(spanDays), minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS });
    }
    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) {
      return res.json({ hasEnoughData: false, reason: 'flat_weight_data' });
    }
    const slope = (n * sumXY - sumX * sumY) / denom; // kg/dzień
    const actualDailyBalance = slope * KCAL_PER_KG;
    const gap = actualDailyBalance - loggedDailyBalance;

    if (Math.abs(gap) < MIN_MEANINGFUL_GAP_KCAL) {
      return res.json({
        hasEnoughData: true,
        suggestionNeeded: false,
        loggedDailyBalance: Math.round(loggedDailyBalance),
        actualDailyBalance: Math.round(actualDailyBalance),
        gap: Math.round(gap)
      });
    }

    const suggestedTargetCalories = Math.round(currentTargetCalories - gap);

    res.json({
      hasEnoughData: true,
      suggestionNeeded: true,
      daysLogged: balance.days_with_data,
      weightMeasurements: weightRows.length,
      loggedDailyBalance: Math.round(loggedDailyBalance),
      actualDailyBalance: Math.round(actualDailyBalance),
      gap: Math.round(gap),
      currentTargetCalories,
      suggestedTargetCalories
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wyznaczania korekty celu kalorycznego.' });
  }
});

// ============================================================================
// Runda 7: nowe insighty bazujące WYŁĄCZNIE na danych już zbieranych przez
// aplikację (water_ml, sedentary_minutes, fiber, respiratory_rate,
// temperature_deviation, stress_high_minutes, liczba posiłków/dzień, historia
// streaków kalorycznych) - zero nowych integracji, zero kopiowania funkcji
// z konkurencyjnych aplikacji dietetycznych. Każdy insight trzyma się
// konwencji z istniejących endpointów wyżej: gating na minimalnej próbce,
// hasEnoughData, polskie komentarze, try/catch z polskim komunikatem błędu.
// ============================================================================

// Mediana - używana tam, gdzie nie ma sensownego progu klinicznego/ustawienia
// użytkownika do podziału na grupy (np. "dużo siedzenia" jest różne dla osoby
// z pracą biurową vs fizyczną) - porównujemy więc użytkownika do JEGO WŁASNEJ
// mediany z okresu, nie do sztywnej wartości.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanAndStdDev(values) {
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / values.length;
  return { mean: m, stdDev: Math.sqrt(variance) };
}

function linearRegressionSlope(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function toRegressionPoints(rows, valueKey) {
  const baseTime = new Date(rows[0].date).getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  return rows.map(r => ({ x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r[valueKey] }));
}

const MIN_DAYS_PER_HYDRATION_GROUP = 5;
const HYDRATION_LOOKBACK_DAYS = 90;

// Insight: nawodnienie (water_ml) vs gotowość/HRV TEGO SAMEGO dnia oraz RHR dnia
// NASTĘPNEGO. Podział względem WŁASNEGO celu nawodnienia użytkownika
// (target_water_ml z ustawień, domyślnie 2500 ml) - nie sztywnego progu
// klinicznego, bo potrzeba nawodnienia jest bardzo indywidualna.
router.get('/api/dashboard/hydration-readiness-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -HYDRATION_LOOKBACK_DAYS);

    const settingsRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'target_water_ml'`, [req.user.id]);
    const targetWaterMl = settingsRow && !isNaN(Number(settingsRow.value)) ? Number(settingsRow.value) : DEFAULT_TARGET_WATER_ML;

    const rows = await db.all(
      `SELECT date, water_ml, readiness_score, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND water_ml IS NOT NULL AND water_ml > 0`,
      [req.user.id, startDate, today]
    );
    const rhrByDate = new Map(rows.filter(r => r.rhr != null && r.rhr > 0).map(r => [r.date, r.rhr]));

    const hydrated = [];
    const underHydrated = [];
    rows.forEach(r => {
      if (r.readiness_score == null && r.hrv == null) return;
      const nextRhr = rhrByDate.get(shiftDate(r.date, 1));
      const entry = { readiness: r.readiness_score, hrv: r.hrv, nextRhr: nextRhr != null ? nextRhr : null };
      (r.water_ml >= targetWaterMl ? hydrated : underHydrated).push(entry);
    });

    if (hydrated.length < MIN_DAYS_PER_HYDRATION_GROUP || underHydrated.length < MIN_DAYS_PER_HYDRATION_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        hydratedDays: hydrated.length,
        underHydratedDays: underHydrated.length,
        minDaysRequired: MIN_DAYS_PER_HYDRATION_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgReadinessHydrated = avgOf(hydrated, 'readiness');
    const avgReadinessUnder = avgOf(underHydrated, 'readiness');
    const avgHrvHydrated = avgOf(hydrated, 'hrv');
    const avgHrvUnder = avgOf(underHydrated, 'hrv');
    const avgNextRhrHydrated = avgOf(hydrated, 'nextRhr');
    const avgNextRhrUnder = avgOf(underHydrated, 'nextRhr');

    res.json({
      hasEnoughData: true,
      targetWaterMl,
      hydratedDays: hydrated.length,
      underHydratedDays: underHydrated.length,
      avgReadinessHydrated,
      avgReadinessUnderHydrated: avgReadinessUnder,
      readinessDiff: avgReadinessHydrated != null && avgReadinessUnder != null ? Math.round((avgReadinessHydrated - avgReadinessUnder) * 10) / 10 : null,
      avgHrvHydrated,
      avgHrvUnderHydrated: avgHrvUnder,
      hrvDiff: avgHrvHydrated != null && avgHrvUnder != null ? Math.round((avgHrvHydrated - avgHrvUnder) * 10) / 10 : null,
      avgNextDayRhrHydrated: avgNextRhrHydrated,
      avgNextDayRhrUnderHydrated: avgNextRhrUnder,
      nextDayRhrDiff: avgNextRhrHydrated != null && avgNextRhrUnder != null ? Math.round((avgNextRhrHydrated - avgNextRhrUnder) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu nawodnienie-regeneracja.' });
  }
});

const MIN_DAYS_PER_SEDENTARY_GROUP = 5;
const SEDENTARY_LOOKBACK_DAYS = 90;

// Insight: czas siedzący (sedentary_minutes) vs jakość snu TEJ SAMEJ NOCY
// (sleep_score, sleep_deep, sleep_rem). Podział wg mediany WŁASNYCH wartości
// użytkownika z okresu.
router.get('/api/dashboard/sedentary-sleep-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -SEDENTARY_LOOKBACK_DAYS);

    const rawRows = await db.all(
      `SELECT date, sedentary_minutes, sleep_score, sleep_deep, sleep_rem FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sedentary_minutes IS NOT NULL AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    // sleep_deep/sleep_rem są w bazie zapisane w GODZINACH (patrz services/sync.js -
    // totalDeepSec / 3600), a odpowiedź tego endpointu jest opisana w UI jako "min" -
    // konwertujemy tu na minuty, żeby sleepDeepDiff/sleepRemDiff faktycznie były w
    // jednostce, w jakiej je wyświetlamy (wcześniej np. "+0.3 min" zamiast "+18 min").
    const rows = rawRows.map(r => ({
      ...r,
      sleep_deep: r.sleep_deep != null ? r.sleep_deep * 60 : r.sleep_deep,
      sleep_rem: r.sleep_rem != null ? r.sleep_rem * 60 : r.sleep_rem
    }));

    if (rows.length < MIN_DAYS_PER_SEDENTARY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_DAYS_PER_SEDENTARY_GROUP * 2
      });
    }

    const medianSedentary = median(rows.map(r => r.sedentary_minutes));
    const moreSitting = rows.filter(r => r.sedentary_minutes >= medianSedentary);
    const lessSitting = rows.filter(r => r.sedentary_minutes < medianSedentary);

    if (moreSitting.length < MIN_DAYS_PER_SEDENTARY_GROUP || lessSitting.length < MIN_DAYS_PER_SEDENTARY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreSittingDays: moreSitting.length,
        lessSittingDays: lessSitting.length,
        minDaysRequired: MIN_DAYS_PER_SEDENTARY_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgSleepScoreMore = avgOf(moreSitting, 'sleep_score');
    const avgSleepScoreLess = avgOf(lessSitting, 'sleep_score');
    const avgDeepMore = avgOf(moreSitting, 'sleep_deep');
    const avgDeepLess = avgOf(lessSitting, 'sleep_deep');
    const avgRemMore = avgOf(moreSitting, 'sleep_rem');
    const avgRemLess = avgOf(lessSitting, 'sleep_rem');

    res.json({
      hasEnoughData: true,
      medianSedentaryMinutes: Math.round(medianSedentary),
      moreSittingDays: moreSitting.length,
      lessSittingDays: lessSitting.length,
      avgSleepScoreMoreSitting: avgSleepScoreMore,
      avgSleepScoreLessSitting: avgSleepScoreLess,
      sleepScoreDiff: avgSleepScoreMore != null && avgSleepScoreLess != null ? Math.round((avgSleepScoreMore - avgSleepScoreLess) * 10) / 10 : null,
      avgSleepDeepMoreSitting: avgDeepMore,
      avgSleepDeepLessSitting: avgDeepLess,
      sleepDeepDiff: avgDeepMore != null && avgDeepLess != null ? Math.round((avgDeepMore - avgDeepLess) * 10) / 10 : null,
      avgSleepRemMoreSitting: avgRemMore,
      avgSleepRemLessSitting: avgRemLess,
      sleepRemDiff: avgRemMore != null && avgRemLess != null ? Math.round((avgRemMore - avgRemLess) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu siedzenie-sen.' });
  }
});

const MIN_DAYS_PER_FIBER_GROUP = 5;
const FIBER_SLEEP_LOOKBACK_DAYS = 90;

// Insight: błonnik (suma dzienna z posiłków) vs głęboki/REM sen TEJ SAMEJ NOCY.
// Inny niż istniejący sleep-insight (tam: sen -> kalorie/cukier NASTĘPNEGO
// dnia) - tu kierunek odwrotny (odżywianie -> sen tej doby) i inne pola fazy
// snu. Podział wg mediany WŁASNEGO spożycia błonnika użytkownika.
router.get('/api/dashboard/fiber-sleep-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -FIBER_SLEEP_LOOKBACK_DAYS);

    const fiberRows = await db.all(
      `SELECT date, SUM(fiber) AS fiber FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? AND fiber IS NOT NULL GROUP BY date HAVING fiber > 0`,
      [req.user.id, startDate, today]
    );
    const rawSleepRows = await db.all(
      `SELECT date, sleep_deep, sleep_rem FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND (sleep_deep IS NOT NULL OR sleep_rem IS NOT NULL)`,
      [req.user.id, startDate, today]
    );
    // Konwersja godzin -> minuty (patrz analogiczny komentarz w sedentary-sleep-insight) -
    // pole jest opisane w UI jako "min", a w bazie sleep_deep/sleep_rem są w godzinach.
    const sleepRows = rawSleepRows.map(r => ({
      ...r,
      sleep_deep: r.sleep_deep != null ? r.sleep_deep * 60 : r.sleep_deep,
      sleep_rem: r.sleep_rem != null ? r.sleep_rem * 60 : r.sleep_rem
    }));
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r]));

    const combined = fiberRows
      .filter(r => sleepByDate.has(r.date))
      .map(r => ({ fiber: r.fiber, ...sleepByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_FIBER_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_FIBER_GROUP * 2
      });
    }

    const medianFiber = median(combined.map(r => r.fiber));
    const moreFiber = combined.filter(r => r.fiber >= medianFiber);
    const lessFiber = combined.filter(r => r.fiber < medianFiber);

    if (moreFiber.length < MIN_DAYS_PER_FIBER_GROUP || lessFiber.length < MIN_DAYS_PER_FIBER_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreFiberDays: moreFiber.length,
        lessFiberDays: lessFiber.length,
        minDaysRequired: MIN_DAYS_PER_FIBER_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgDeepMore = avgOf(moreFiber, 'sleep_deep');
    const avgDeepLess = avgOf(lessFiber, 'sleep_deep');
    const avgRemMore = avgOf(moreFiber, 'sleep_rem');
    const avgRemLess = avgOf(lessFiber, 'sleep_rem');

    res.json({
      hasEnoughData: true,
      medianFiberGrams: Math.round(medianFiber * 10) / 10,
      moreFiberDays: moreFiber.length,
      lessFiberDays: lessFiber.length,
      avgSleepDeepMoreFiber: avgDeepMore,
      avgSleepDeepLessFiber: avgDeepLess,
      sleepDeepDiff: avgDeepMore != null && avgDeepLess != null ? Math.round((avgDeepMore - avgDeepLess) * 10) / 10 : null,
      avgSleepRemMoreFiber: avgRemMore,
      avgSleepRemLessFiber: avgRemLess,
      sleepRemDiff: avgRemMore != null && avgRemLess != null ? Math.round((avgRemMore - avgRemLess) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu błonnik-sen.' });
  }
});

const MIN_RECOMP_MEASUREMENTS = 4;
const MIN_RECOMP_SPAN_DAYS = 14;
const RECOMP_LOOKBACK_DAYS = 180;

// Detektor "rekompozycji ciała": czy trend OBWODU PASA i trend WAGI rozjeżdżają
// się (np. waga stabilna/rosnąca, a pas się zmniejsza - typowy sygnał przyrostu
// mięśni przy redukcji tkanki tłuszczowej, albo odwrotnie). Dwie NIEZALEŻNE
// regresje liniowe (jak w calorie-target-suggestion) - pomiary wagi i obwodów
// zwykle nie są robione tego samego dnia, łączenie po dacie odsiałoby dane.
router.get('/api/dashboard/body-recomposition-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -RECOMP_LOOKBACK_DAYS);

    const waistRows = await db.all(
      `SELECT date, waist FROM body_measurements WHERE user_id = ? AND date >= ? AND date <= ? AND waist IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (waistRows.length < MIN_RECOMP_MEASUREMENTS || weightRows.length < MIN_RECOMP_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_measurements',
        waistMeasurements: waistRows.length,
        weightMeasurements: weightRows.length,
        minMeasurementsRequired: MIN_RECOMP_MEASUREMENTS
      });
    }

    const waistPoints = toRegressionPoints(waistRows, 'waist');
    const weightPoints = toRegressionPoints(weightRows, 'weight');
    const waistSpanDays = waistPoints[waistPoints.length - 1].x;
    const weightSpanDays = weightPoints[weightPoints.length - 1].x;

    if (waistSpanDays < MIN_RECOMP_SPAN_DAYS || weightSpanDays < MIN_RECOMP_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        waistSpanDays: Math.round(waistSpanDays),
        weightSpanDays: Math.round(weightSpanDays),
        minSpanDaysRequired: MIN_RECOMP_SPAN_DAYS
      });
    }

    const waistSlopePerDay = linearRegressionSlope(waistPoints);
    const weightSlopePerDay = linearRegressionSlope(weightPoints);
    if (waistSlopePerDay === null || weightSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    // Rozjazd: pas się zmniejsza, a waga rośnie/stabilna (lub odwrotnie) -
    // sygnał rekompozycji, a nie zwykłego "chudnięcia/przybierania" widocznego
    // jednocześnie w obu miarach.
    const waistTrend = waistSlopePerDay < -0.02 ? 'down' : waistSlopePerDay > 0.02 ? 'up' : 'flat';
    const weightTrend = weightSlopePerDay < -0.02 ? 'down' : weightSlopePerDay > 0.02 ? 'up' : 'flat';
    const divergentTrend = waistTrend !== 'flat' && weightTrend !== 'flat' && waistTrend !== weightTrend;

    res.json({
      hasEnoughData: true,
      waistMeasurements: waistRows.length,
      weightMeasurements: weightRows.length,
      waistSlopeCmPerWeek: Math.round(waistSlopePerDay * 7 * 100) / 100,
      weightSlopeKgPerWeek: Math.round(weightSlopePerDay * 7 * 100) / 100,
      waistTrend,
      weightTrend,
      divergentTrend
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wykrywania rekompozycji ciała.' });
  }
});

const STRAIN_BASELINE_LOOKBACK_DAYS = 30;
const MIN_DAYS_FOR_STRAIN_BASELINE = 14;
const STRAIN_STD_DEV_THRESHOLD = 1; // odchylenia standardowe od własnej średniej użytkownika

// Wczesny alert "przeciążenie/możliwa infekcja": odchylenie DZISIEJSZYCH
// wartości (częstość oddechów, odchylenie temperatury nadgarstka, gotowość) od
// WŁASNEJ średniej użytkownika z ostatnich dni (z-score - podejście statystyczne
// analogiczne do wykrywania anomalii posiłków w utils/mealAnomaly.js, tu
// zastosowane do danych Oura). Opisowy sygnał na bazie własnej historii
// użytkownika, NIE diagnoza medyczna.
router.get('/api/dashboard/early-strain-alert', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const baselineStart = shiftDate(today, -STRAIN_BASELINE_LOOKBACK_DAYS);
    const baselineEnd = shiftDate(today, -1);

    const todayRow = await db.get(
      `SELECT respiratory_rate, temperature_deviation, readiness_score FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    if (!todayRow || todayRow.respiratory_rate == null || todayRow.temperature_deviation == null || todayRow.readiness_score == null) {
      return res.json({ hasEnoughData: false, reason: 'no_today_data' });
    }

    const baselineRows = await db.all(
      `SELECT respiratory_rate, temperature_deviation, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND respiratory_rate IS NOT NULL AND temperature_deviation IS NOT NULL AND readiness_score IS NOT NULL`,
      [req.user.id, baselineStart, baselineEnd]
    );

    if (baselineRows.length < MIN_DAYS_FOR_STRAIN_BASELINE) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_baseline_days',
        baselineDays: baselineRows.length,
        minDaysRequired: MIN_DAYS_FOR_STRAIN_BASELINE
      });
    }

    const respStats = meanAndStdDev(baselineRows.map(r => r.respiratory_rate));
    const tempStats = meanAndStdDev(baselineRows.map(r => r.temperature_deviation));
    const readinessStats = meanAndStdDev(baselineRows.map(r => r.readiness_score));

    const respZ = respStats.stdDev > 0 ? (todayRow.respiratory_rate - respStats.mean) / respStats.stdDev : 0;
    const tempZ = tempStats.stdDev > 0 ? (todayRow.temperature_deviation - tempStats.mean) / tempStats.stdDev : 0;
    const readinessZ = readinessStats.stdDev > 0 ? (todayRow.readiness_score - readinessStats.mean) / readinessStats.stdDev : 0;

    // Alert tylko gdy WSZYSTKIE trzy wskaźniki naraz odbiegają w niepokojącym
    // kierunku - pojedynczy odstający wskaźnik to zwykły szum dnia, nie sygnał.
    const alert = respZ >= STRAIN_STD_DEV_THRESHOLD && tempZ >= STRAIN_STD_DEV_THRESHOLD && readinessZ <= -STRAIN_STD_DEV_THRESHOLD;

    res.json({
      hasEnoughData: true,
      baselineDays: baselineRows.length,
      today: {
        respiratoryRate: todayRow.respiratory_rate,
        temperatureDeviation: todayRow.temperature_deviation,
        readinessScore: todayRow.readiness_score
      },
      baseline: {
        avgRespiratoryRate: Math.round(respStats.mean * 10) / 10,
        avgTemperatureDeviation: Math.round(tempStats.mean * 100) / 100,
        avgReadinessScore: Math.round(readinessStats.mean * 10) / 10
      },
      respiratoryRateZScore: Math.round(respZ * 100) / 100,
      temperatureDeviationZScore: Math.round(tempZ * 100) / 100,
      readinessScoreZScore: Math.round(readinessZ * 100) / 100,
      alert
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wyznaczania wczesnego alertu przeciążenia.' });
  }
});

const MIN_DAYS_PER_STRESS_GROUP = 5;
const STRESS_NUTRITION_LOOKBACK_DAYS = 90;

// Insight: minuty wysokiego stresu (stress_high_minutes, dotąd tylko
// wyświetlane, nieużywane w żadnym insighcie) vs spożycie sodu/cukru TEGO
// SAMEGO dnia - sprawdza potoczną hipotezę "stres -> sięganie po słodkie/
// słone jedzenie" na bazie własnych danych użytkownika. Podział wg mediany
// WŁASNYCH minut stresu z okresu.
router.get('/api/dashboard/stress-nutrition-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -STRESS_NUTRITION_LOOKBACK_DAYS);

    const stressRows = await db.all(
      `SELECT date, stress_high_minutes FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND stress_high_minutes IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const nutritionRows = await db.all(
      `SELECT date, SUM(sodium) AS sodium, SUM(sugar) AS sugar FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const nutritionByDate = new Map(nutritionRows.map(r => [r.date, r]));

    const combined = stressRows
      .filter(r => nutritionByDate.has(r.date))
      .map(r => ({ stressMinutes: r.stress_high_minutes, ...nutritionByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_STRESS_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_STRESS_GROUP * 2
      });
    }

    const medianStress = median(combined.map(r => r.stressMinutes));
    const highStress = combined.filter(r => r.stressMinutes >= medianStress);
    const lowStress = combined.filter(r => r.stressMinutes < medianStress);

    if (highStress.length < MIN_DAYS_PER_STRESS_GROUP || lowStress.length < MIN_DAYS_PER_STRESS_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        highStressDays: highStress.length,
        lowStressDays: lowStress.length,
        minDaysRequired: MIN_DAYS_PER_STRESS_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgSodiumHigh = avgOf(highStress, 'sodium');
    const avgSodiumLow = avgOf(lowStress, 'sodium');
    const avgSugarHigh = avgOf(highStress, 'sugar');
    const avgSugarLow = avgOf(lowStress, 'sugar');

    res.json({
      hasEnoughData: true,
      medianStressMinutes: Math.round(medianStress),
      highStressDays: highStress.length,
      lowStressDays: lowStress.length,
      avgSodiumHighStress: avgSodiumHigh,
      avgSodiumLowStress: avgSodiumLow,
      sodiumDiff: avgSodiumHigh != null && avgSodiumLow != null ? Math.round((avgSodiumHigh - avgSodiumLow) * 10) / 10 : null,
      avgSugarHighStress: avgSugarHigh,
      avgSugarLowStress: avgSugarLow,
      sugarDiff: avgSugarHigh != null && avgSugarLow != null ? Math.round((avgSugarHigh - avgSugarLow) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu stres-odżywianie.' });
  }
});

const MIN_DAYS_PER_MEAL_FREQ_GROUP = 5;
const MEAL_FREQ_LOOKBACK_DAYS = 90;
// Pasmo trafienia w cel kaloryczny +/-15% - identyczne jak przy istniejącym
// streaku kalorycznym (computeStreak w głównym handlerze /api/dashboard).
const CALORIE_TARGET_BAND = 0.15;

// Insight: liczba posiłków zalogowanych w ciągu dnia (meals.date, COUNT) vs
// trafienie w cel kaloryczny tego dnia - sprawdza, czy więcej mniejszych
// posiłków dziennie koreluje z lepszym trzymaniem się celu ("podjadanie
// kontrolowane" vs 1-2 duże posiłki).
router.get('/api/dashboard/meal-frequency-adherence-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -MEAL_FREQ_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const rows = await db.all(
      `SELECT date, COUNT(*) AS meal_count, SUM(calories) AS total_calories
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_DAYS_PER_MEAL_FREQ_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_FREQ_GROUP * 2
      });
    }

    const onTarget = [];
    const offTarget = [];
    rows.forEach(r => {
      if (r.total_calories == null) return;
      const hit = r.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) && r.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      (hit ? onTarget : offTarget).push(r);
    });

    if (onTarget.length < MIN_DAYS_PER_MEAL_FREQ_GROUP || offTarget.length < MIN_DAYS_PER_MEAL_FREQ_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        onTargetDays: onTarget.length,
        offTargetDays: offTarget.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_FREQ_GROUP
      });
    }

    const avgOf = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgMealCountOnTarget = avgOf(onTarget, 'meal_count');
    const avgMealCountOffTarget = avgOf(offTarget, 'meal_count');

    res.json({
      hasEnoughData: true,
      targetCalories,
      onTargetDays: onTarget.length,
      offTargetDays: offTarget.length,
      avgMealCountOnTarget,
      avgMealCountOffTarget,
      mealCountDiff: Math.round((avgMealCountOnTarget - avgMealCountOffTarget) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu częstość posiłków-cel kaloryczny.' });
  }
});

const MIN_DAYS_PER_STREAK_GROUP = 5;
const STREAK_DRIFT_LOOKBACK_DAYS = 120;
const STREAK_MIN_LENGTH = 3; // od ilu kolejnych dni w paśmie celu liczymy to jako "passę"

// Insight: HRV/gotowość w dniach będących CZĘŚCIĄ passy trzymania się celu
// kalorycznego (3+ kolejne dni w paśmie +/-15%) vs w dniu BEZPOŚREDNIO PO
// przerwaniu takiej passy. Własna, samodzielna logika wykrywania passy (NIE
// computeStreak z głównego handlera dashboardu, który liczy tylko długość
// AKTUALNEJ passy względem jednej daty referencyjnej i nie jest eksportowany) -
// tu potrzebujemy historii wszystkich przeszłych pass i ich końców.
router.get('/api/dashboard/streak-drift-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -STREAK_DRIFT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const metricsRows = await db.all(
      `SELECT date, hrv, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND (hrv IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );
    const metricsByDate = new Map(metricsRows.map(r => [r.date, r]));

    // Wymagamy KOLEJNYCH dni kalendarzowych (bez dziur) do liczenia passy -
    // dziura w logowaniu przerywa passę tak samo jak dzień poza paśmem celu.
    let prevDate = null;
    let currentStreak = 0;
    const streakDayMetrics = [];
    const breakDayMetrics = [];

    calorieRows.forEach(row => {
      const inBand = row.total_calories != null &&
        row.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) &&
        row.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      const isConsecutive = prevDate !== null && shiftDate(prevDate, 1) === row.date;

      if (inBand) {
        currentStreak = isConsecutive ? currentStreak + 1 : 1;
        if (currentStreak >= STREAK_MIN_LENGTH) {
          const m = metricsByDate.get(row.date);
          if (m) streakDayMetrics.push(m);
        }
      } else {
        // "Dzień po przerwaniu" liczymy tylko, jeśli WCZORAJ była ustalona
        // passa (>= STREAK_MIN_LENGTH) i dziś jest kolejnym dniem kalendarzowym po niej.
        if (isConsecutive && currentStreak >= STREAK_MIN_LENGTH) {
          const m = metricsByDate.get(row.date);
          if (m) breakDayMetrics.push(m);
        }
        currentStreak = 0;
      }
      prevDate = row.date;
    });

    if (streakDayMetrics.length < MIN_DAYS_PER_STREAK_GROUP || breakDayMetrics.length < MIN_DAYS_PER_STREAK_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        streakDays: streakDayMetrics.length,
        breakDays: breakDayMetrics.length,
        minDaysRequired: MIN_DAYS_PER_STREAK_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgHrvStreak = avgOf(streakDayMetrics, 'hrv');
    const avgHrvBreak = avgOf(breakDayMetrics, 'hrv');
    const avgReadinessStreak = avgOf(streakDayMetrics, 'readiness_score');
    const avgReadinessBreak = avgOf(breakDayMetrics, 'readiness_score');

    res.json({
      hasEnoughData: true,
      targetCalories,
      streakMinLength: STREAK_MIN_LENGTH,
      streakDays: streakDayMetrics.length,
      breakDays: breakDayMetrics.length,
      avgHrvDuringStreak: avgHrvStreak,
      avgHrvAfterBreak: avgHrvBreak,
      hrvDiff: avgHrvStreak != null && avgHrvBreak != null ? Math.round((avgHrvStreak - avgHrvBreak) * 10) / 10 : null,
      avgReadinessDuringStreak: avgReadinessStreak,
      avgReadinessAfterBreak: avgReadinessBreak,
      readinessDiff: avgReadinessStreak != null && avgReadinessBreak != null ? Math.round((avgReadinessStreak - avgReadinessBreak) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu passa-regeneracja.' });
  }
});

const RHR_RECENT_WINDOW_DAYS = 7;
const RHR_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_RHR_DAYS = 4;
const MIN_BASELINE_RHR_DAYS = 14;

// Insight (Runda 8): trend spoczynkowego tętna (rhr) - średnia z ostatnich 7 dni vs
// własna baseline z poprzedzających 28 dni. Niezależny od early-strain-alert (tamten
// klucz się o intensywność treningu) i od recovery-insight (tamten porównuje
// HRV/RHR PO treningu vs spoczynku) - tu czysty trend RHR w czasie, użyteczny jako
// wczesny sygnał przemęczenia/choroby/nadmiernego stresu, NIEZALEŻNIE od aktywności.
// Próg "podniesionego" RHR liczony względem WŁASNEGO odchylenia standardowego
// użytkownika (meanAndStdDev), nie sztywnej liczby uderzeń/min - naturalny rozrzut
// RHR bardzo różni się między osobami.
router.get('/api/dashboard/rhr-drift-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const recentStart = shiftDate(today, -(RHR_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(RHR_BASELINE_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT date, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.rhr);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd).map(r => r.rhr);

    if (recent.length < MIN_RECENT_RHR_DAYS || baseline.length < MIN_BASELINE_RHR_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        recentDays: recent.length,
        baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_RHR_DAYS,
        minBaselineDaysRequired: MIN_BASELINE_RHR_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
    const avgRecentRhr = avg(recent);
    const avgBaselineRhr = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const rhrDiff = Math.round((avgRecentRhr - avgBaselineRhr) * 10) / 10;
    const isElevated = baselineStdDev > 0 ? rhrDiff > baselineStdDev : rhrDiff > 2;

    res.json({
      hasEnoughData: true,
      recentDays: recent.length,
      baselineDays: baseline.length,
      avgRecentRhr,
      avgBaselineRhr,
      rhrDiff,
      baselineStdDev: Math.round(baselineStdDev * 10) / 10,
      isElevated
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu tętna spoczynkowego.' });
  }
});

const MIN_DAYS_PER_MEAL_TIMING_GROUP = 5;
const MEAL_TIMING_LOOKBACK_DAYS = 90;

// Insight (Runda 8): godzina ostatniego posiłku w ciągu dnia (MAX(timestamp) z meals)
// vs jakość snu TEJ SAMEJ NOCY (sleep_score, sleep_deep). Podział wg mediany WŁASNYCH
// godzin ostatniego posiłku użytkownika z okresu - nie sztywnego progu (np. "po
// 20:00"), bo nawyki żywieniowe/dobowe są bardzo indywidualne. Inny kierunek niż
// istniejący sleep-insight (tam: sen -> odżywianie NASTĘPNEGO dnia).
router.get('/api/dashboard/meal-timing-sleep-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const startDate = shiftDate(today, -MEAL_TIMING_LOOKBACK_DAYS);

    const mealRows = await db.all(
      `SELECT date, MAX(timestamp) AS last_meal_timestamp FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const sleepRows = await db.all(
      `SELECT date, sleep_score, sleep_deep FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r]));

    // Godzina ostatniego posiłku jako liczba dziesiętna (np. 21:30 -> 21.5) - do
    // liczenia mediany i podziału na grupy.
    const toHourFraction = (ts) => {
      const match = /\s(\d{2}):(\d{2})/.exec(ts || '');
      if (!match) return null;
      return Number(match[1]) + Number(match[2]) / 60;
    };

    const entries = [];
    mealRows.forEach(r => {
      const hour = toHourFraction(r.last_meal_timestamp);
      const sleep = sleepByDate.get(r.date);
      if (hour == null || !sleep) return;
      // sleep_deep jest w bazie w GODZINACH (services/sync.js: totalDeepSec / 3600) -
      // konwertujemy na minuty, bo avgSleepDeepLaterEating/sleepDeepDiff w odpowiedzi
      // są opisane w UI jako "min" (patrz analogiczna poprawka w sedentary-sleep-insight
      // i fiber-sleep-insight).
      entries.push({ hour, sleep_score: sleep.sleep_score, sleep_deep: sleep.sleep_deep != null ? sleep.sleep_deep * 60 : sleep.sleep_deep });
    });

    if (entries.length < MIN_DAYS_PER_MEAL_TIMING_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: entries.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_TIMING_GROUP * 2
      });
    }

    const medianHour = median(entries.map(e => e.hour));
    const laterEaters = entries.filter(e => e.hour >= medianHour);
    const earlierEaters = entries.filter(e => e.hour < medianHour);

    if (laterEaters.length < MIN_DAYS_PER_MEAL_TIMING_GROUP || earlierEaters.length < MIN_DAYS_PER_MEAL_TIMING_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        laterDays: laterEaters.length,
        earlierDays: earlierEaters.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_TIMING_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgScoreLater = avgOf(laterEaters, 'sleep_score');
    const avgScoreEarlier = avgOf(earlierEaters, 'sleep_score');
    const avgDeepLater = avgOf(laterEaters, 'sleep_deep');
    const avgDeepEarlier = avgOf(earlierEaters, 'sleep_deep');

    const formatHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

    res.json({
      hasEnoughData: true,
      medianLastMealHour: formatHour(medianHour),
      laterEatingDays: laterEaters.length,
      earlierEatingDays: earlierEaters.length,
      avgSleepScoreLaterEating: avgScoreLater,
      avgSleepScoreEarlierEating: avgScoreEarlier,
      sleepScoreDiff: avgScoreLater != null && avgScoreEarlier != null ? Math.round((avgScoreLater - avgScoreEarlier) * 10) / 10 : null,
      avgSleepDeepLaterEating: avgDeepLater,
      avgSleepDeepEarlierEating: avgDeepEarlier,
      sleepDeepDiff: avgDeepLater != null && avgDeepEarlier != null ? Math.round((avgDeepLater - avgDeepEarlier) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu godzina posiłku-sen.' });
  }
});

// Insight (Runda 9): samodzielny trend ciśnienia krwi (ostatnie 7 dni vs poprzedzające
// 28 dni) - w przeciwieństwie do istniejącego sodium-bp-insight (sód jako zmienna
// wyjaśniająca), tutaj liczy się czysty trend w czasie, niezależnie od przyczyny.
// Klasyfikacja kategorii to uproszczone progi AHA (American Heart Association) -
// orientacyjna etykieta, nie diagnoza medyczna.
const BP_RECENT_WINDOW_DAYS = 7;
const BP_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_BP_DAYS = 3;
const MIN_BASELINE_BP_DAYS = 7;

function classifyBloodPressure(systolic, diastolic) {
  if (systolic == null || diastolic == null) return null;
  if (systolic >= 180 || diastolic >= 120) return 'Przełom nadciśnieniowy';
  if (systolic >= 140 || diastolic >= 90) return 'Nadciśnienie 2. stopnia';
  if (systolic >= 130 || diastolic >= 80) return 'Nadciśnienie 1. stopnia';
  if (systolic >= 120) return 'Podwyższone';
  return 'Prawidłowe';
}

router.get('/api/dashboard/bp-trend-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const recentStart = shiftDate(today, -(BP_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(BP_BASELINE_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND blood_pressure_systolic IS NOT NULL AND blood_pressure_diastolic IS NOT NULL
       AND blood_pressure_systolic > 0 AND blood_pressure_diastolic > 0`,
      [req.user.id, baselineStart, today]
    );

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd);

    if (recent.length < MIN_RECENT_BP_DAYS || baseline.length < MIN_BASELINE_BP_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        recentDays: recent.length,
        baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_BP_DAYS,
        minBaselineDaysRequired: MIN_BASELINE_BP_DAYS
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, r) => s + r[key], 0) / arr.length) * 10) / 10;
    const avgRecentSystolic = avg(recent, 'blood_pressure_systolic');
    const avgRecentDiastolic = avg(recent, 'blood_pressure_diastolic');
    const avgBaselineSystolic = avg(baseline, 'blood_pressure_systolic');
    const avgBaselineDiastolic = avg(baseline, 'blood_pressure_diastolic');

    res.json({
      hasEnoughData: true,
      recentDays: recent.length,
      baselineDays: baseline.length,
      avgRecentSystolic,
      avgRecentDiastolic,
      avgBaselineSystolic,
      avgBaselineDiastolic,
      systolicDiff: Math.round((avgRecentSystolic - avgBaselineSystolic) * 10) / 10,
      diastolicDiff: Math.round((avgRecentDiastolic - avgBaselineDiastolic) * 10) / 10,
      recentCategory: classifyBloodPressure(avgRecentSystolic, avgRecentDiastolic),
      baselineCategory: classifyBloodPressure(avgBaselineSystolic, avgBaselineDiastolic)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu ciśnienia krwi.' });
  }
});

// Insight: realne strefy kardio (Karvonen) zsumowane z treningów Apple Health z ostatnich
// 14 dni. W przeciwieństwie do statycznej tabeli referencyjnej "Strefy Tętna" (na bazie
// wzoru, nie pomiaru), tu liczą się REALNE minuty zmierzone tętnem w trakcie treningów -
// patrz computeWorkoutHrZones w routes/appleHealth.js. Wymaga włączonego przełącznika
// "Include Workout Metrics" w Health Auto Export; bez niego workouty mają same NULL-e
// w kolumnach zoneN_minutes i nie wchodzą do sumy (warunek zone1_minutes IS NOT NULL).
const HR_ZONES_INSIGHT_WINDOW_DAYS = 14;
const MIN_WORKOUTS_WITH_ZONES = 2;

router.get('/api/dashboard/hr-zones-insight', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateString();
    const windowStart = shiftDate(today, -(HR_ZONES_INSIGHT_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND zone1_minutes IS NOT NULL`,
      [req.user.id, windowStart, today]
    );

    if (rows.length < MIN_WORKOUTS_WITH_ZONES) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_with_zones',
        workoutsWithZoneData: rows.length,
        minWorkoutsRequired: MIN_WORKOUTS_WITH_ZONES
      });
    }

    const zoneMinutes = { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 };
    for (const r of rows) {
      zoneMinutes.zone1 += r.zone1_minutes || 0;
      zoneMinutes.zone2 += r.zone2_minutes || 0;
      zoneMinutes.zone3 += r.zone3_minutes || 0;
      zoneMinutes.zone4 += r.zone4_minutes || 0;
      zoneMinutes.zone5 += r.zone5_minutes || 0;
    }
    Object.keys(zoneMinutes).forEach(k => { zoneMinutes[k] = Math.round(zoneMinutes[k]); });

    const totalMinutes = Object.values(zoneMinutes).reduce((s, v) => s + v, 0);
    let dominantZone = null;
    let dominantMax = -1;
    Object.entries(zoneMinutes).forEach(([zone, mins], idx) => {
      if (mins > dominantMax) { dominantMax = mins; dominantZone = idx + 1; }
    });

    res.json({
      hasEnoughData: true,
      windowDays: HR_ZONES_INSIGHT_WINDOW_DAYS,
      workoutsWithZoneData: rows.length,
      zoneMinutes,
      totalMinutes,
      dominantZone
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu stref kardio.' });
  }
});

module.exports = router;
