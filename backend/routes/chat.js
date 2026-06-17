const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getLocalDateString } = require('../utils/dates');
const { generateContentWithFallback } = require('../config');

router.post('/api/chat', requireAuth, async (req, res) => {
  const { message, date, history } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Treść wiadomości jest wymagana.' });
  }

  const queryDate = date || getLocalDateString();

  try {
    // Pobierz cele użytkownika
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    const bmr = settings.bmr || 1800;

    // Pobierz dzisiejsze dane zdrowotne
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]) || {
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
      muscle_mass: null
    };

    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    mealRows.forEach(r => {
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
    });

    const activeCalories = health.active_calories || 0;
    const totalBurned = health.total_calories_burned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Pobierz najświeższe dane dla wagi, tłuszczu i mięśni (jeśli dzisiejsze są null)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;

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

    // Pobranie trendów z ostatnich 7 dni przed wybraną datą
    const pastDateLimit = new Date(new Date(queryDate).getTime() - 7 * 24 * 60 * 60 * 1000);
    const pastDateStr = pastDateLimit.toISOString().slice(0, 10);

    const historyMetrics = await db.all(`
      SELECT date, steps, active_calories, weight, sleep_score, sleep_duration, readiness_score
      FROM health_metrics
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    const historyMeals = await db.all(`
      SELECT date, raw_text, calories, protein, carbs, fat
      FROM meals
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    let weeklyTrendSummary = '';
    if (historyMetrics.length > 0 || historyMeals.length > 0) {
      weeklyTrendSummary = '\nHistoria i trendy użytkownika z ostatnich 7 dni (przed wybraną datą):\n';
      
      const mealsByDate = {};
      historyMeals.forEach(m => {
        if (!mealsByDate[m.date]) mealsByDate[m.date] = [];
        mealsByDate[m.date].push(m);
      });

      const allPastDates = new Set([...historyMetrics.map(hm => hm.date), ...Object.keys(mealsByDate)]);
      const sortedPastDates = Array.from(allPastDates).sort();

      sortedPastDates.forEach(dStr => {
        const hm = historyMetrics.find(h => h.date === dStr);
        const dayMeals = mealsByDate[dStr] || [];
        
        let dayLog = `- Data ${dStr}: `;
        if (hm) {
          const parts = [];
          if (hm.steps) parts.push(`Kroki: ${hm.steps}`);
          if (hm.active_calories) parts.push(`Kalorie aktywne: ${hm.active_calories} kcal`);
          if (hm.weight) parts.push(`Waga: ${hm.weight} kg`);
          if (hm.sleep_score) parts.push(`Sen: ${hm.sleep_score}/100`);
          if (hm.readiness_score) parts.push(`Gotowość: ${hm.readiness_score}/100`);
          dayLog += parts.join(', ');
        }
        if (dayMeals.length > 0) {
          const totalCal = dayMeals.reduce((sum, m) => sum + m.calories, 0);
          const totalP = dayMeals.reduce((sum, m) => sum + m.protein, 0);
          const totalC = dayMeals.reduce((sum, m) => sum + m.carbs, 0);
          const totalF = dayMeals.reduce((sum, m) => sum + m.fat, 0);
          dayLog += ` | Posiłki (${dayMeals.length}): łącznie zjedzone ${totalCal} kcal (B: ${totalP}g, W: ${totalC}g, T: ${totalF}g)`;
        }
        weeklyTrendSummary += dayLog + '\n';
      });
    }

    // Formatowanie historii czatu z tej sesji
    let historyContext = '';
    if (Array.isArray(history) && history.length > 0) {
      // Filtrowanie pustych wpisów
      const filteredHistory = history.filter(h => h.text && h.text.trim().length > 0);
      historyContext = '\nHistoria rozmowy w tej sesji (od najstarszej):\n' + filteredHistory.map(h => {
        const roleName = h.sender === 'user' ? 'Użytkownik' : 'Dietetyk AI';
        return `${roleName}: ${h.text}`;
      }).join('\n') + '\n';
    }

    // Pobierz klucz API użytkownika (jeśli posiada)
    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? apiKeyRow.value : null;

    const chatPrompt = `
Jesteś profesjonalnym, empatycznym i zorientowanym na cele dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Pomagasz użytkownikowi ${req.user.username} w optymalizacji jego diety, regeneracji, snu i treningów.

Informacje o profilu i celach użytkownika:
- Cel kaloryczny spożycia: ${settings.target_calories || 2000} kcal
- Cel makroskładników: Białko: ${settings.target_protein || 150}g, Węglowodany: ${settings.target_carbs || 250}g, Tłuszcz: ${settings.target_fat || 80}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualne statystyki użytkownika na dzień ${queryDate}:
- Spożycie: ${totalEaten.calories} kcal (B: ${totalEaten.protein}g, W: ${totalEaten.carbs}g, T: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Sumaryczny wydatek energetyczny: ${totalBurned} kcal (BMR + Aktywne)
- Bilans netto: ${netCalories} kcal
- Kroki: ${health.steps || 0}
- Waga: ${displayWeight || 'brak danych'} kg, % Tłuszczu: ${displayFatRatio || 'brak danych'}%, Masa mięśniowa: ${displayMuscleMass || 'brak danych'} kg
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score : 'brak danych'} (Czas: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score : 'brak danych'}
- Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms
${weeklyTrendSummary}
${historyContext}
Pytanie użytkownika: "${message}"

Odpowiedz zwięźle, merytorycznie i praktycznie w języku polskim (maksymalnie 3-4 krótkie akapity). Skup się na bezpośrednich zaleceniach odnoszących się do powyższych danych zdrowotnych użytkownika. Nawiąż do historii rozmowy lub trendów z ubiegłego tygodnia, jeśli to istotne i odpowiada na pytanie. Możesz używać formatowania markdown (listy wypunktowane, pogrubienia). Odpowiedź powinna być profesjonalna, życzliwa i motywująca.
`;

    const forceCustomKeyOnly = req.user.role !== 'admin';
    const aiResponse = await generateContentWithFallback(chatPrompt, false, null, userApiKey, forceCustomKeyOnly);
    res.json({ response: aiResponse.trim() });
  } catch (err) {
    console.error('[CHAT ERROR]', err);
    res.status(500).json({ error: 'Nie udało się uzyskać odpowiedzi od Dietetyka AI.' });
  }
});

module.exports = router;
