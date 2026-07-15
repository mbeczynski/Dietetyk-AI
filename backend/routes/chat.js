const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getLocalDateString } = require('../utils/dates');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
const { generateContentWithFallback } = require('../config');
const { getTargetCalories, getBmr, getTargetWaterMl } = require('../utils/defaultSettings');
const { getDayEventsInRange, formatDayEventsForPrompt } = require('../utils/dayEvents');

// Limit znaków pojedynczej wiadomości czatu - bez tego nic nie ograniczało długości
// `message` trafiającego prosto do promptu Gemini (limit body to 20MB, ustawiony w
// server.js z myślą o webhooku Apple Health, nie o czacie) - użytkownik mógłby
// wysłać ogromny tekst, drastycznie zwiększając koszt/czas wywołania AI albo
// powodując błąd po stronie Gemini.
const MAX_CHAT_MESSAGE_LENGTH = 2000;

// Czat z dostępem do długiej historii: domyślnie czat widzi tylko ostatnie 7 dni
// (CHAT_DEFAULT_LOOKBACK_DAYS) - wystarczające dla typowych pytań o "dzisiaj"/
// "ostatnie dni" i utrzymujące prompt krótkim. Gdy treść wiadomości wskazuje, że
// użytkownik pyta o szerszy okres (miesiąc, trend, konkretna nazwa miesiąca itp.),
// rozszerzamy okno do CHAT_EXTENDED_LOOKBACK_DAYS (90 dni - ta sama wartość co w
// innych funkcjach "długoterminowych" w aplikacji, np. SLEEP_INSIGHT_LOOKBACK_DAYS
// w dashboard.js). Przy rozszerzonym oknie zamieniamy też szczegółowy log DZIENNY
// na zwarte podsumowanie TYGODNIOWE (patrz buildWeeklyTrendSummary) - dziesiątki
// pojedynczych dni w prompcie niepotrzebnie zwiększałyby koszt/czas odpowiedzi
// Gemini bez realnej wartości dla odpowiedzi.
const CHAT_DEFAULT_LOOKBACK_DAYS = 7;
const CHAT_EXTENDED_LOOKBACK_DAYS = 90;

const LONG_HISTORY_KEYWORDS = [
  'miesiąc', 'miesiącu', 'miesiące', 'miesięcy', 'miesiącach',
  'tygodni', 'tygodnie', 'tygodniach', 'kwartał', 'kwartale',
  '30 dni', '60 dni', '90 dni', 'dłuższy okres', 'dłuższym okresie',
  'od dawna', 'dawniej', 'histori', 'trend', 'w ciągu', 'ostatnich tygodni',
  'styczni', 'lutego', 'lutym', 'marca', 'marcu', 'kwietnia', 'kwietniu',
  'maja', 'maju', 'czerwca', 'czerwcu', 'lipca', 'lipcu', 'sierpnia', 'sierpniu',
  'września', 'wrześniu', 'października', 'październiku', 'listopada', 'listopadzie',
  'grudnia', 'grudniu', ' rok', 'roku', 'porównaj', 'porównanie'
];

// Heurystyka na bazie słów kluczowych - nie idealna (np. nie złapie pytania o
// konkretną datę bez słowa-wskazówki), ale prosta, deterministyczna i bez kosztu
// dodatkowego wywołania AI tylko do klasyfikacji intencji.
function messageNeedsLongHistory(msg) {
  const lower = msg.toLowerCase();
  return LONG_HISTORY_KEYWORDS.some(kw => lower.includes(kw));
}

// Podsumowanie tygodniowe (okna 7-dniowe od najstarszej daty w zakresie) - używane
// przy rozszerzonym oknie historii. Pomija okna bez żadnych danych (brak posiłków,
// wagi, kroków i snu), żeby nie zaśmiecać promptu liniami "brak danych".
function buildWeeklyTrendSummary(historyMetrics, historyMeals, startDateStr, endDateStr) {
  const mealsByDate = {};
  historyMeals.forEach(m => {
    if (!mealsByDate[m.date]) mealsByDate[m.date] = [];
    mealsByDate[m.date].push(m);
  });
  const metricsByDate = {};
  historyMetrics.forEach(hm => { metricsByDate[hm.date] = hm; });

  const msPerDay = 24 * 60 * 60 * 1000;
  const startTime = new Date(startDateStr).getTime();
  const endTime = new Date(endDateStr).getTime();
  const totalDays = Math.round((endTime - startTime) / msPerDay);

  let summary = '';
  for (let bucketStart = 0; bucketStart < totalDays; bucketStart += 7) {
    const bucketLen = Math.min(7, totalDays - bucketStart);
    const bucketStartDate = new Date(startTime + bucketStart * msPerDay).toISOString().slice(0, 10);
    const bucketEndDate = new Date(startTime + (bucketStart + bucketLen) * msPerDay).toISOString().slice(0, 10);

    let daysWithMeals = 0, calSum = 0, pSum = 0, cSum = 0, fSum = 0;
    const weightVals = [];
    const stepsVals = [];
    const sleepVals = [];

    for (let d = bucketStart; d < bucketStart + bucketLen; d++) {
      const dateStr = new Date(startTime + d * msPerDay).toISOString().slice(0, 10);
      const dayMeals = mealsByDate[dateStr];
      if (dayMeals && dayMeals.length > 0) {
        daysWithMeals++;
        calSum += dayMeals.reduce((s, m) => s + m.calories, 0);
        pSum += dayMeals.reduce((s, m) => s + m.protein, 0);
        cSum += dayMeals.reduce((s, m) => s + m.carbs, 0);
        fSum += dayMeals.reduce((s, m) => s + m.fat, 0);
      }
      const hm = metricsByDate[dateStr];
      if (hm) {
        if (hm.weight) weightVals.push(hm.weight);
        if (hm.steps) stepsVals.push(hm.steps);
        if (hm.sleep_score) sleepVals.push(hm.sleep_score);
      }
    }

    if (daysWithMeals === 0 && weightVals.length === 0 && stepsVals.length === 0 && sleepVals.length === 0) {
      continue;
    }

    const avg = (arr) => (arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length);
    const parts = [];
    if (daysWithMeals > 0) {
      parts.push(`śr. spożycie ${Math.round(calSum / daysWithMeals)} kcal/dzień (B:${Math.round(pSum / daysWithMeals)}g W:${Math.round(cSum / daysWithMeals)}g T:${Math.round(fSum / daysWithMeals)}g), zalogowano ${daysWithMeals}/${bucketLen} dni`);
    }
    if (weightVals.length > 0) parts.push(`waga śr. ${Math.round(avg(weightVals) * 10) / 10} kg`);
    if (stepsVals.length > 0) parts.push(`kroki śr. ${Math.round(avg(stepsVals))}`);
    if (sleepVals.length > 0) parts.push(`sen śr. ${Math.round(avg(sleepVals))}/100`);

    summary += `- Okres ${bucketStartDate} – ${bucketEndDate}: ${parts.join(', ')}\n`;
  }
  return summary;
}

router.post('/api/chat', requireAuth, async (req, res) => {
  const { message, date, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Treść wiadomości jest wymagana.' });
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Wiadomość jest zbyt długa (maks. ${MAX_CHAT_MESSAGE_LENGTH} znaków).` });
  }

  const queryDate = date || getLocalDateString();

  try {
    // Pobierz cele użytkownika
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    const bmr = getBmr(settings);

    // Pobierz dzisiejsze dane zdrowotne
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]) || getDefaultHealthMetrics();

    // Tylko kolumny liczbowe potrzebne do bilansu kalorycznego czatu - bez
    // image_base64/analysis_json, które tu nigdy nie są używane (patrz forEach niżej).
    const mealRows = await db.all(`SELECT calories, protein, carbs, fat FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]);
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

    const latestBodyMeasurement = await db.get(
      `SELECT date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below FROM body_measurements WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
      [req.user.id]
    );

    // Okno historii: domyślnie 7 dni, rozszerzone do 90 dni jeśli treść wiadomości
    // wskazuje na pytanie o dłuższy okres (patrz messageNeedsLongHistory powyżej).
    const useExtendedHistory = messageNeedsLongHistory(message);
    const lookbackDays = useExtendedHistory ? CHAT_EXTENDED_LOOKBACK_DAYS : CHAT_DEFAULT_LOOKBACK_DAYS;
    const pastDateLimit = new Date(new Date(queryDate).getTime() - lookbackDays * 24 * 60 * 60 * 1000);
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
      if (useExtendedHistory) {
        // Pytanie wskazuje na dłuższy okres - zwarte podsumowanie tygodniowe
        // (patrz buildWeeklyTrendSummary) zamiast logu dzień po dniu, żeby nie
        // rozdąć prompta przy oknie do 90 dni.
        weeklyTrendSummary = `\nPodsumowanie tygodniowe użytkownika z ostatnich ${lookbackDays} dni (przed wybraną datą) - Twoje pytanie wskazuje na potrzebę szerszego kontekstu czasowego niż tylko ostatni tydzień:\n`
          + buildWeeklyTrendSummary(historyMetrics, historyMeals, pastDateStr, queryDate);
      } else {
        weeklyTrendSummary = `\nHistoria i trendy użytkownika z ostatnich ${lookbackDays} dni (przed wybraną datą):\n`;

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
    }

    // Formatowanie historii czatu z tej sesji
    let historyContext = '';
    if (Array.isArray(history) && history.length > 0) {
      // Filtrowanie pustych wpisów
      let filteredHistory = history.filter(h => h.text && h.text.trim().length > 0);
      
      // Wykluczamy ostatnią wiadomość z historii, jeśli jest identyczna z bieżącym zapytaniem użytkownika
      // (ponieważ bieżące zapytanie jest już dołączone na końcu promptu jako "Pytanie użytkownika")
      if (
        filteredHistory.length > 0 &&
        filteredHistory[filteredHistory.length - 1].sender === 'user' &&
        filteredHistory[filteredHistory.length - 1].text.trim() === message.trim()
      ) {
        filteredHistory.pop();
      }

      // Przycinamy historię do ostatnich 15 wiadomości, by uniknąć rozdęcia promptu (prompt bloat)
      filteredHistory = filteredHistory.slice(-15);

      if (filteredHistory.length > 0) {
        historyContext = '\nHistoria rozmowy w tej sesji (od najstarszej):\n' + filteredHistory.map(h => {
          const roleName = h.sender === 'user' ? 'Użytkownik' : 'Dietetyk AI';
          // Przycinamy długie wiadomości w historii do 500 znaków jako dodatkowa ochrona
          const text = h.text.length > 500 ? h.text.slice(0, 500) + '...' : h.text;
          // B-W2: Wiadomości użytkownika owinięte w user_input zapobiegają prompt injection
          return h.sender === 'user' ? `${roleName}: <user_input>${text}</user_input>` : `${roleName}: ${text}`;
        }).join('\n') + '\n';
      }
    }

    // "Tag dnia" (day_events) z analizowanego okna historii [pastDateStr, queryDate] -
    // żeby AI w czacie też wiedziało o dniach oznaczonych jako choroba/wakacje/późne
    // zaśnięcie i nie sugerowało korekt na bazie nietypowych danych z tych dni
    // (patrz utils/dayEvents.js, ten sam mechanizm co w dashboard.js).
    const dayEventsInWindow = await getDayEventsInRange(req.user.id, pastDateStr, queryDate);
    const dayEventsContext = formatDayEventsForPrompt(dayEventsInWindow);

    // Pobierz klucz API użytkownika (jeśli posiada)
    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? apiKeyRow.value : null;

    // Cel sylwetki (opis tekstowy, ustawiany w Ustawieniach - patrz routes/account.js).
    // W czacie wykorzystujemy tylko tekst, NIE zdjęcie referencyjne - w odróżnieniu od
    // dashboard.js (gdzie porada AI generowana jest raz dziennie, w tle, z cache),
    // czat odpowiada na KAŻDĄ wiadomość użytkownika "na żywo", więc dociąganie obrazu
    // do każdego zapytania Gemini niepotrzebnie zwiększałoby czas odpowiedzi i koszt.
    const bodyGoalRow = await db.get(`SELECT body_goal_text FROM users WHERE id = ?`, [req.user.id]);
    const bodyGoalText = bodyGoalRow && bodyGoalRow.body_goal_text ? bodyGoalRow.body_goal_text : null;

    // Imię (jeśli ustawione w Ustawieniach) ma priorytet nad loginem technicznym.
    const displayName = req.user.first_name || req.user.username;
    const chatPrompt = `
Jesteś profesjonalnym, empatycznym i zorientowanym na cele dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Pomagasz użytkownikowi ${displayName} w optymalizacji jego diety, regeneracji, snu i treningów.

Informacje o profilu i celach użytkownika:
- Cel kaloryczny spożycia: ${getTargetCalories(settings)} kcal
- Cel makroskładników: Białko: ${settings.target_protein ?? 150}g, Węglowodany: ${settings.target_carbs ?? 250}g, Tłuszcz: ${settings.target_fat ?? 80}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal
- Cel sylwetki opisany przez użytkownika: ${bodyGoalText || 'nie opisany w Ustawieniach'}

Aktualne statystyki użytkownika na dzień ${queryDate}:
- Spożycie: ${totalEaten.calories} kcal (B: ${totalEaten.protein}g, W: ${totalEaten.carbs}g, T: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Sumaryczny wydatek energetyczny: ${totalBurned} kcal (BMR + Aktywne)
- Bilans netto: ${netCalories} kcal
- Kroki: ${health.steps || 0}
- Waga: ${displayWeight || 'brak danych'} kg, % Tłuszczu: ${displayFatRatio || 'brak danych'}%, Masa mięśniowa: ${displayMuscleMass || 'brak danych'} kg
- Obwody ciała (ostatni pomiar${latestBodyMeasurement ? ' z dnia ' + latestBodyMeasurement.date : ''}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Pas +2cm (powyżej pępka): ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Pas -2cm (poniżej pępka): ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Barki: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps lewy: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps prawy: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'brak wypełnionych pól' : 'brak danych w bazie'}
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score : 'brak danych'} (Czas: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score : 'brak danych'}
- Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms
- Wypita woda: ${health.water_ml || 0}ml (cel: ${getTargetWaterMl(settings)}ml)
- Samopoczucie (ręczna ocena użytkownika, skala 1-5): Energia: ${health.energy_level != null ? health.energy_level + '/5' : 'nie oceniono'}, Nastrój: ${health.mood != null ? health.mood + '/5' : 'nie oceniono'}
${weeklyTrendSummary}
${dayEventsContext}
${historyContext}
Pytanie użytkownika: <user_input>${message}</user_input>

Odpowiedz zwięźle, merytorycznie i praktycznie w języku polskim (maksymalnie 3-4 krótkie akapity). Skup się na bezpośrednich zaleceniach odnoszących się do powyższych danych zdrowotnych użytkownika. Nawiąż do historii rozmowy lub trendów z powyższego podsumowania historii, jeśli to istotne i odpowiada na pytanie. Jeśli użytkownik opisał swój cel sylwetki, odnoś rekomendacje do tego celu tam, gdzie to ma sens dla zadanego pytania - ale nie wspominaj o nim, jeśli pytanie go nie dotyczy. Możesz używać formatowania markdown (listy wypunktowane, pogrubienia). Odpowiedź powinna być profesjonalna, życzliwa i motywująca.
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
