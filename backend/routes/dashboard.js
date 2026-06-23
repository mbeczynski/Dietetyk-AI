const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
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
      return { id: r.id, raw_text: r.raw_text, timestamp: r.timestamp, image_base64: r.image_base64, ...analysis };
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
      `SELECT date, chest, waist, hips, biceps, thigh FROM body_measurements WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
      [req.user.id]
    );

    // Realne treningi z danego dnia (zsynchronizowane przez webhook Apple Health,
    // patrz routes/appleHealth.js). Liczone tutaj (przed promptem AI), żeby dało się
    // przekazać dzisiejsze treningi do advicePrompt, nie tylko do odpowiedzi JSON.
    const workoutRows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories
       FROM apple_health_workouts WHERE user_id = ? AND date = ? ORDER BY updated_at DESC`,
      [req.user.id, date]
    );
    const workouts = workoutRows.map(w => ({
      type: w.workout_type || 'Trening',
      duration_mins: Math.round(w.duration_minutes || 0),
      calories: Math.round(w.active_calories || 0)
    }));

    const activeCalories = displayActiveCalories || 0;
    const bmr = settings.bmr || 1800;
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
    const targetCaloriesForStreak = settings.target_calories || 2000;
    const calorieStreakDays = computeStreak(calorieMap, date, (total) =>
      total >= targetCaloriesForStreak * 0.85 && total <= targetCaloriesForStreak * 1.15
    );

    const sleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const sleepMap = new Map(sleepRows.map(r => [r.date, r.sleep_duration]));
    const targetSleepForStreak = isNaN(settings.target_sleep_duration) || !settings.target_sleep_duration ? 7.2 : settings.target_sleep_duration;
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

        const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${displayName} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${settings.target_calories} kcal
- Cel Białka: ${settings.target_protein}g, Węglowodanów: ${settings.target_carbs}g, Tłuszczu: ${settings.target_fat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g, Błonnik: ${totalEaten.fiber}g, Cukry: ${totalEaten.sugar}g, Sód: ${totalEaten.sodium}mg)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${displaySteps || 0}
- Aktywność dzisiaj: ${displayActiveMinutes || 0} min aktywności, Dystans: ${displayDistanceMeters ? (Math.round(displayDistanceMeters / 100) / 10) + ' km' : '0 km'}, Czas siedzący: ${displaySedentaryMinutes || 0} min, Niska intensywność: ${displayLowActivityMinutes || 0} min
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${isNaN(settings.target_water_ml) || !settings.target_water_ml ? 2500 : settings.target_water_ml}ml)
- Przyjęte suplementy dzisiaj: ${health.supplements || 'brak (użytkownik nie zapisał dzisiaj żadnych suplementów)'}
- Treningi zarejestrowane dzisiaj (Apple Health): ${workouts.length > 0 ? workouts.map(w => `${w.type} (${w.duration_mins} min, ${w.calories} kcal)`).join(', ') : 'brak zarejestrowanych treningów'}
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
    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
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
1. Intensywność wysiłku i strefy kardio po treningu na bazie aktywnych kalorii, zarejestrowanych treningów (typ, czas trwania, spalone kalorie) oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Precyzyjne zmiany w diecie na bazie dzisiejszych posiłków i treningu, w tym jakość diety pod kątem błonnika, cukrów prostych i sodu (np. zbyt mało błonnika w stosunku do kalorii, zbyt dużo cukrów prostych lub sodu w ostatnich dniach) - nie tylko makra, ale pełny obraz odżywiania.
3. Porównanie dzisiejszego odżywiania i aktywności z wczorajszymi oraz z trendem 7/30-dniowym - jeśli dieta z ostatnich dni nie była optymalna (np. za mało białka w stosunku do celu, zbyt mało kcal po dużym treningu lub nadmiar kalorii przy braku ruchu), wskaż to konstruktywnie i doradź konkretną korektę.
4. Wnioski z trendu wagi, składu ciała i obwodów ciała z ostatnich pomiarów Withings oraz jakości snu, regeneracji i poziomu stresu z Oura (zwróć uwagę, czy obecny trend przybliża użytkownika do celu w dłuższej perspektywie 7/30 dni).
5. Przyjęte suplementy: przeanalizuj CAŁĄ historię suplementów (nie tylko dziś/wczoraj, ale wszystkie dostępne wpisy z ostatnich dni) i skomentuj krótko ich przydatność, regularność przyjmowania i czas przyjmowania w odniesieniu do treningu i samopoczucia użytkownika.
6. Ciśnienie tętnicze: jeśli dostępne są pomiary ciśnienia, oceń czy wartości są w normie (orientacyjnie <120/80 mmHg optymalnie, 120-129/<80 podwyższone prawidłowe, ≥130/80 nadciśnienie) i czy trend z ostatnich pomiarów jest stabilny, rosnący czy spadkowy - jeśli widzisz niepokojący trend lub wartości podwyższone, zalecaj konsultację lekarską (nie diagnozuj).
7. Regeneracja i stres: jeśli dostępne są dane o stresie (Oura), SpO2, częstości oddechów czy temperaturze nadgarstka, skomentuj ogólny stan regeneracji organizmu i zasugeruj, czy potrzebny jest dzień odpoczynku.
8. Konsekwencja (streaki): jeśli użytkownik ma passę trafiania w cel kaloryczny lub cel snu, doceń to krótko - jeśli passa jest przerwana lub bliska zera, zachęcająco zasugeruj, jak wrócić na właściwe tory.

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
        generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly)
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
        target_steps: isNaN(settings.target_steps) || !settings.target_steps ? 10000 : settings.target_steps,
        target_active_calories: isNaN(settings.target_active_calories) || !settings.target_active_calories ? 500 : settings.target_active_calories,
        target_sleep_duration: isNaN(settings.target_sleep_duration) || !settings.target_sleep_duration ? 7.2 : settings.target_sleep_duration,
        target_active_minutes: isNaN(settings.target_active_minutes) || !settings.target_active_minutes ? 30 : settings.target_active_minutes,
        target_water_ml: isNaN(settings.target_water_ml) || !settings.target_water_ml ? 2500 : settings.target_water_ml,
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
    const targetCalories = isNaN(settings.target_calories) || !settings.target_calories ? 2000 : settings.target_calories;
    const bmr = isNaN(settings.bmr) || !settings.bmr ? 1800 : settings.bmr;

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

module.exports = router;
