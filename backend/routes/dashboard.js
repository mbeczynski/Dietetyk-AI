const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { genAI, generateContentWithFallback } = require('../config');

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
    `SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat
     FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const daysLogged = rows.length;
  const totals = rows.reduce((acc, r) => {
    acc.calories += r.calories || 0;
    acc.protein += r.protein || 0;
    acc.carbs += r.carbs || 0;
    acc.fat += r.fat || 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const avg = daysLogged > 0 ? {
    calories: Math.round(totals.calories / daysLogged),
    protein: Math.round((totals.protein / daysLogged) * 10) / 10,
    carbs: Math.round((totals.carbs / daysLogged) * 10) / 10,
    fat: Math.round((totals.fat / daysLogged) * 10) / 10
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

    // Posiłki z dzisiaj
    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
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
      return { id: r.id, raw_text: r.raw_text, timestamp: r.timestamp, image_base64: r.image_base64, ...analysis };
    });

    // Zaokrąglenie makr zjedzonych
    totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
    totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
    totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;

    // Dane zdrowotne z Oura & Withings z wybranego dnia
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]) || {
      steps: 0,
      active_calories: 0,
      total_calories_burned: 0,
      sleep_score: null,
      sleep_duration: null,
      sleep_deep: null,
      sleep_rem: null,
      readiness_score: null,
      hrv: null,
      rhr: null,
      temperature_deviation: null,
      respiratory_rate: null,
      spo2_percentage: null,
      wrist_temperature: null,
      weight: null,
      fat_ratio: null,
      muscle_mass: null,
      active_minutes: 0,
      distance_meters: 0,
      sedentary_minutes: 0,
      low_activity_minutes: 0,
      stress_high_minutes: null,
      stress_recovery_minutes: null,
      stress_summary: null,
      water_ml: 0,
      last_sync: null,
      activity_source: null,
      ai_advice: null,
      ai_advice_generated_at: null
    };

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);

    // Pobierz najświeższe nie-null/nie-zero wartości dla wszystkich wskaźników zdrowotnych (jeśli wybrane są puste)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;
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

      if (canUseAI && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
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

        const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${displayName} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${settings.target_calories} kcal
- Cel Białka: ${settings.target_protein}g, Węglowodanów: ${settings.target_carbs}g, Tłuszczu: ${settings.target_fat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${displaySteps || 0}
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${isNaN(settings.target_water_ml) || !settings.target_water_ml ? 2500 : settings.target_water_ml}ml)
- Przyjęte suplementy dzisiaj: ${health.supplements || 'brak (użytkownik nie zapisał dzisiaj żadnych suplementów)'}

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'Brak danych'} (Czas trwania: ${displaySleepDuration || 0}h, Głęboki: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Odchylenie temperatury ciała: ${displayTempDev !== null ? displayTempDev + ' °C' : 'brak'}
- Wynik Gotowości (Readiness): ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${displayWeight !== null ? displayWeight + ' kg' : 'brak danych'}, Procent tłuszczu: ${displayFatRatio !== null ? displayFatRatio + '%' : 'brak danych'}, Masa mięśniowa: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'brak danych'}

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
- Średnie odżywianie z ostatnich 7 dni: ${last7DaysNutrition.avg ? `${last7DaysNutrition.avg.calories} kcal (B: ${last7DaysNutrition.avg.protein}g, W: ${last7DaysNutrition.avg.carbs}g, T: ${last7DaysNutrition.avg.fat}g) na ${last7DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Średnie odżywianie z ostatnich 30 dni: ${last30DaysNutrition.avg ? `${last30DaysNutrition.avg.calories} kcal (B: ${last30DaysNutrition.avg.protein}g, W: ${last30DaysNutrition.avg.carbs}g, T: ${last30DaysNutrition.avg.fat}g) na ${last30DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Historia pomiarów wagi i składu ciała (ostatnie wpisy):
${weightHistory.map(w => `- ${w.date}: ${w.weight} kg (tłuszcz: ${w.fat_ratio || '-'}%, mięśnie: ${w.muscle_mass || '-'} kg)`).join('\n') || 'brak danych w bazie'}
- Ostatnia jakość snu i gotowości Oura:
${sleepHistory.map(s => `- ${s.date}: Sen ${s.sleep_score || '-'}, Gotowość ${s.readiness_score || '-'}`).join('\n') || 'brak danych w bazie'}

Napisz krótką, spersonalizowaną poradę dietetyczno-treningową (maksymalnie 4-5 zdań). Skup się na:
1. Analizie intensywności wysiłku i stref kardio po treningu na bazie aktywnych kalorii oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Sugerowaniu precyzyjnych zmian w diecie na bazie dzisiejszych posiłków i treningu (np. zalecenie dorzucenia większej ilości białka w celu wsparcia regeneracji włókien mięśniowych po ciężkim wysiłku beztlenowym lub redukcji węglowodanów w dni o niskim wysiłku aerobowym).
3. Porównaniu dzisiejszego odżywiania i aktywności z wczorajszymi. Jeśli wczorajsza dieta nie była optymalna (np. za mało białka w stosunku do celu, zbyt mało kcal po dużym treningu lub nadmiar kalorii przy braku ruchu), wskaż to konstruktywnie użytkownikowi i doradź korektę (np. "Twoje wczorajsze posiłki nie dostarczyły wystarczającej ilości białka, dlatego dzisiaj upewnij się, że dodasz do menu chudy twaróg lub odżywkę...").
4. Udostępnieniu wniosków z trendu wagi i składu ciała z ostatnich pomiarów Withings oraz jakości snu i regeneracji z Oura (zwróć uwagę, czy obecny trend przybliża użytkownika do celu w dłuższej perspektywie 7/30 dni).
5. Analizie przyjętych suplementów: jeśli użytkownik wpisał jakiekolwiek suplementy dzisiaj lub wczoraj (np. kreatyna, kwasy omega-3, witamina D3, magnez, odżywka białkowa), skomentuj krótko ich przydatność i czas przyjmowania w odniesieniu do jego dzisiejszego treningu i samopoczucia.

Pisz bezpośrednio do użytkownika w języku polskim, zwracając się do niego po imieniu (${displayName}) co najmniej raz. Bądź konkretny, motywujący i merytoryczny. Możesz swobodnie używać formatowania Markdown (np. **pogrubienia** kluczowych fraz, list punktowanych) - frontend renderuje tę odpowiedź jako Markdown.
`;

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
          });
      }
    }

    // Realne treningi z danego dnia (zsynchronizowane przez webhook Apple Health,
    // patrz routes/appleHealth.js) - wcześniej to pole było zawsze zaszyte na sztywno
    // jako pusta lista, mimo że apka faktycznie zbiera te dane od dawna.
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
        sleep_streak_days: sleepStreakDays
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
