// Logika budowania kontekstu historii dla czatu Dietetyka AI (routes/chat.js) -
// wydzielona do osobnego modułu (analogicznie do utils/mealAnomaly.js), żeby dało
// się ją testować jednostkowo bez uruchamiania całego serwera Express/bazy danych.

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
// wagi, kroków, snu i treningów), żeby nie zaśmiecać promptu liniami "brak danych".
function buildWeeklyTrendSummary(historyMetrics, historyMeals, historyWorkouts, startDateStr, endDateStr) {
  const mealsByDate = {};
  historyMeals.forEach(m => {
    if (!mealsByDate[m.date]) mealsByDate[m.date] = [];
    mealsByDate[m.date].push(m);
  });
  const metricsByDate = {};
  historyMetrics.forEach(hm => { metricsByDate[hm.date] = hm; });
  const workoutsByDate = {};
  historyWorkouts.forEach(w => {
    if (!workoutsByDate[w.date]) workoutsByDate[w.date] = [];
    workoutsByDate[w.date].push(w);
  });

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
    let workoutCount = 0, workoutMinutes = 0;
    const workoutTypes = new Set();

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
      const dayWorkouts = workoutsByDate[dateStr];
      if (dayWorkouts && dayWorkouts.length > 0) {
        workoutCount += dayWorkouts.length;
        dayWorkouts.forEach(w => {
          workoutMinutes += w.duration_minutes || 0;
          if (w.workout_type) workoutTypes.add(w.workout_type);
        });
      }
    }

    if (daysWithMeals === 0 && weightVals.length === 0 && stepsVals.length === 0 && sleepVals.length === 0 && workoutCount === 0) {
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
    if (workoutCount > 0) parts.push(`treningi: ${workoutCount} (łącznie ${Math.round(workoutMinutes)} min, typy: ${Array.from(workoutTypes).join(', ') || 'nieznane'})`);

    summary += `- Okres ${bucketStartDate} – ${bucketEndDate}: ${parts.join(', ')}\n`;
  }
  return summary;
}

module.exports = {
  MAX_CHAT_MESSAGE_LENGTH,
  CHAT_DEFAULT_LOOKBACK_DAYS,
  CHAT_EXTENDED_LOOKBACK_DAYS,
  messageNeedsLongHistory,
  buildWeeklyTrendSummary
};
