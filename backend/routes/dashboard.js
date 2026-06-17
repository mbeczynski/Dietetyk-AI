const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { genAI, generateContentWithFallback } = require('../config');

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
      weight: null,
      fat_ratio: null,
      muscle_mass: null,
      active_minutes: 0,
      last_sync: null,
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
    let displayActiveMinutes = health.active_minutes;

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
    // displayActiveMinutes: brak dociągania z poprzednich dni - patrz komentarz powyżej.

    const activeCalories = displayActiveCalories || 0;
    const bmr = settings.bmr || 1800;
    const totalBurned = displayTotalCaloriesBurned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

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
        const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${req.user.username} dla dnia ${date}:
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

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'Brak danych'} (Czas trwania: ${displaySleepDuration || 0}h, Głęboki: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Odchylenie temperatury ciała: ${displayTempDev !== null ? displayTempDev + ' °C' : 'brak'}
- Wynik Gotowości (Readiness): ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${displayWeight !== null ? displayWeight + ' kg' : 'brak danych'}, Procent tłuszczu: ${displayFatRatio !== null ? displayFatRatio + '%' : 'brak danych'}, Masa mięśniowa: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'brak danych'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Napisz krótką, spersonalizowaną poradę dietetyczno-treningową (maksymalnie 4-5 zdań). Skup się na:
1. Analizie intensywności wysiłku i stref kardio po treningu na bazie aktywnych kalorii oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Sugerowaniu precyzyjnych zmian w diecie na bazie dzisiejszych posiłków i treningu (np. zalecenie dorzucenia większej ilości białka w celu wsparcia regeneracji włókien mięśniowych po ciężkim wysiłku beztlenowym lub redukcji węglowodanów w dni o niskim wysiłku aerobowym).
3. Uwzględnieniu gotowości Oura i trendów wagi/mięśni/tłuszczu z Withings.
Pisz bezpośrednio do użytkownika w języku polskim. Bądź konkretny, motywujący i merytoryczny.
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
        bmr,
        calories_eaten: totalEaten.calories,
        calories_burned_active: activeCalories,
        calories_burned_total: totalBurned,
        net_calories: netCalories,
        eaten_protein: totalEaten.protein,
        eaten_carbs: totalEaten.carbs,
        eaten_fat: totalEaten.fat,
        steps: displaySteps || 0,
        workouts: [],
        last_sync: health.last_sync,
        sleep_score: displaySleepScore,
        sleep_duration: displaySleepDuration,
        sleep_deep: displaySleepDeep,
        sleep_rem: displaySleepRem,
        readiness_score: displayReadinessScore,
        hrv: displayHrv,
        rhr: displayRhr,
        temperature_deviation: displayTempDev,
        weight: displayWeight,
        fat_ratio: displayFatRatio,
        muscle_mass: displayMuscleMass,
        active_minutes: displayActiveMinutes || 0,
        has_oura: !!hasOuraRow,
        has_withings: !!hasWithingsRow
      },
      meals,
      aiAdvice
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania danych dashboardu.' });
  }
});

module.exports = router;
