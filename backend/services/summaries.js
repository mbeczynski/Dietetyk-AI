const db = require('../db');
const { genAI, generateContentWithFallback } = require('../config');
const { getLocalDateString } = require('../utils/dates');
const { sendMailgunEmail } = require('./mailgun');

// ===== Wspólne funkcje pomocnicze (wydzielone z duplikacji w 3 funkcjach poniżej) =====

async function getUserAndEmail(userId, customEmail) {
  const user = await db.get(`SELECT username, email, role, first_name FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }
  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }
  return { user, emailToUse };
}

async function getUserSettings(userId) {
  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });
  return {
    targetCalories: settings.target_calories || 2500,
    targetProtein: settings.target_protein || 150,
    targetCarbs: settings.target_carbs || 250,
    targetFat: settings.target_fat || 80,
    bmr: settings.bmr || 1800,
    targetWaterMl: settings.target_water_ml || 2500
  };
}

// Agregacja statystyk żywieniowo-zdrowotnych z zakresu dni (używana przez raport tygodniowy i miesięczny)
function aggregateNutritionAndHealth(meals, healthMetrics, numDays) {
  let totalEatenCal = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
  meals.forEach(m => {
    totalEatenCal += m.calories;
    totalProtein += m.protein;
    totalCarbs += m.carbs;
    totalFat += m.fat;
  });

  let totalSteps = 0, totalActiveCal = 0, totalWaterMl = 0;
  let sleepScoreSum = 0, sleepScoreCount = 0;
  let readinessScoreSum = 0, readinessScoreCount = 0;
  let weightSum = 0, weightCount = 0;
  let fatRatioSum = 0, fatRatioCount = 0;
  let muscleMassSum = 0, muscleMassCount = 0;
  let firstWeight = null, lastWeight = null;
  let firstFatRatio = null, lastFatRatio = null;
  let firstMuscleMass = null, lastMuscleMass = null;

  const sortedHealthMetrics = [...healthMetrics].sort((a, b) => a.date.localeCompare(b.date));

  sortedHealthMetrics.forEach(h => {
    totalSteps += h.steps || 0;
    totalActiveCal += h.active_calories || 0;
    totalWaterMl += h.water_ml || 0;
    if (h.sleep_score !== null) {
      sleepScoreSum += h.sleep_score;
      sleepScoreCount++;
    }
    if (h.readiness_score !== null) {
      readinessScoreSum += h.readiness_score;
      readinessScoreCount++;
    }
    if (h.weight !== null) {
      weightSum += h.weight;
      weightCount++;
      if (firstWeight === null) firstWeight = h.weight;
      lastWeight = h.weight;
    }
    if (h.fat_ratio !== null) {
      fatRatioSum += h.fat_ratio;
      fatRatioCount++;
      if (firstFatRatio === null) firstFatRatio = h.fat_ratio;
      lastFatRatio = h.fat_ratio;
    }
    if (h.muscle_mass !== null) {
      muscleMassSum += h.muscle_mass;
      muscleMassCount++;
      if (firstMuscleMass === null) firstMuscleMass = h.muscle_mass;
      lastMuscleMass = h.muscle_mass;
    }
  });

  const workoutsCount = healthMetrics.filter(h => (h.active_calories || 0) > 0).length;

  const avgEatenCalories = Math.round(totalEatenCal / numDays);
  const avgProtein = Math.round((totalProtein / numDays) * 10) / 10;
  const avgCarbs = Math.round((totalCarbs / numDays) * 10) / 10;
  const avgFat = Math.round((totalFat / numDays) * 10) / 10;

  const avgSteps = Math.round(totalSteps / numDays);
  const avgActiveCalories = Math.round(totalActiveCal / numDays);
  const avgWaterMl = Math.round(totalWaterMl / numDays);

  const avgSleepScore = sleepScoreCount > 0 ? Math.round(sleepScoreSum / sleepScoreCount) : null;
  const avgReadinessScore = readinessScoreCount > 0 ? Math.round(readinessScoreSum / readinessScoreCount) : null;
  const avgWeight = weightCount > 0 ? Math.round((weightSum / weightCount) * 10) / 10 : null;
  const avgFatRatio = fatRatioCount > 0 ? Math.round((fatRatioSum / fatRatioCount) * 10) / 10 : null;
  const avgMuscleMass = muscleMassCount > 0 ? Math.round((muscleMassSum / muscleMassCount) * 10) / 10 : null;

  const weightChange = (firstWeight !== null && lastWeight !== null) ? Math.round((lastWeight - firstWeight) * 10) / 10 : null;
  const fatRatioChange = (firstFatRatio !== null && lastFatRatio !== null) ? Math.round((lastFatRatio - firstFatRatio) * 10) / 10 : null;
  const muscleMassChange = (firstMuscleMass !== null && lastMuscleMass !== null) ? Math.round((lastMuscleMass - firstMuscleMass) * 10) / 10 : null;

  return {
    avgEatenCalories, avgProtein, avgCarbs, avgFat,
    avgSteps, avgActiveCalories, avgWaterMl,
    avgSleepScore, avgReadinessScore, avgWeight, avgFatRatio, avgMuscleMass,
    workoutsCount, weightChange, fatRatioChange, muscleMassChange
  };
}

// Wywołanie AI z ujednoliconą logiką klucza API / fallbacku / obsługi błędów
async function generateAiSummaryText({ userId, user, prompt, shouldGenerate, fallbackMessage, errorLogLabel, errorMessagePrefix }) {
  let result = fallbackMessage;
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? apiKeyRow.value : null;

  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && shouldGenerate) {
    try {
      const forceCustomKeyOnly = user.role !== 'admin';
      result = await generateContentWithFallback(prompt, false, null, userApiKey, forceCustomKeyOnly);
    } catch (err) {
      console.error(errorLogLabel, err);
      result = errorMessagePrefix + err.message;
    }
  }
  return result;
}

// Konwersja markdown z Gemini na HTML (identyczna logika używana w 3 raportach)
function markdownToHtml(text) {
  return text
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\* ([^*]+)/g, '<li>$1</li>');
}

// Wspólny CSS dla wszystkich maili podsumowujących
const EMAIL_STYLE = `
  body {
    font-family: Arial, sans-serif;
    background-color: #0f172a;
    color: #f8fafc;
    margin: 0;
    padding: 20px;
  }
  .container {
    max-width: 600px;
    margin: 0 auto;
    background: #1e293b;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 16px;
    padding: 30px;
  }
  h2 {
    color: #a78bfa;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }
  .logo {
    font-size: 2.5rem;
    margin-bottom: 10px;
  }
  .title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #38bdf8;
    margin: 0;
  }
  .section-title {
    font-size: 1.1rem;
    color: #c084fc;
    border-bottom: 1px solid rgba(192, 132, 252, 0.2);
    padding-bottom: 6px;
    margin-top: 24px;
    margin-bottom: 16px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
  }
  th, td {
    padding: 10px;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    color: #f8fafc;
  }
  th {
    color: #94a3b8;
    font-weight: 600;
    font-size: 0.85rem;
    text-transform: uppercase;
  }
  td {
    font-size: 0.95rem;
  }
  .ai-box {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 20px;
    line-height: 1.6;
    font-size: 0.95rem;
    color: #e2e8f0;
  }
  .footer {
    text-align: center;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 0.8rem;
    color: #64748b;
  }
`;

// Wspólny generator szablonu HTML maila (tytuł, podtytuł, tabela statystyk, sekcja AI)
function buildSummaryEmailHtml({ title, headerSubtitleHtml, statsSectionTitle, valueColumnLabel, statRows, aiHtml }) {
  const rowsHtml = statRows.map(r => `
            <tr>
              <td>${r.label}</td>
              <td><strong>${r.value}</strong></td>
              <td>${r.target !== undefined ? r.target : '-'}</td>
            </tr>`).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
      <style>${EMAIL_STYLE}</style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">${title}</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">${headerSubtitleHtml}</p>
        </div>

        <div class="section-title">📊 ${statsSectionTitle}</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>${valueColumnLabel}</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${aiHtml}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;
}

// ===== Raport tygodniowy =====
async function sendWeeklySummaryForUser(userId, customEmail = null) {
  const { user, emailToUse } = await getUserAndEmail(userId, customEmail);
  const { targetCalories, targetProtein, targetCarbs, targetFat, bmr, targetWaterMl } = await getUserSettings(userId);

  // Pobranie danych z ostatnich 7 dni
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const meals = await db.all(`
    SELECT * FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const numDays = 7;
  const stats = aggregateNutritionAndHealth(meals, healthMetrics, numDays);
  const avgTotalBurned = bmr + stats.avgActiveCalories;
  const avgNetCalories = stats.avgEatenCalories - avgTotalBurned;

  const advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj tygodniowy raport żywieniowo-treningowy użytkownika ${user.first_name || user.username}, zwracając się do niego po imieniu:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Tygodniowe statystyki (średnie dzienne):
- Średnie dzienne spożycie energii: ${stats.avgEatenCalories} kcal (Białko: ${stats.avgProtein}g, Węglowodany: ${stats.avgCarbs}g, Tłuszcz: ${stats.avgFat}g)
- Średnia aktywność fizyczna (aktywne kalorie): ${stats.avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${stats.avgSteps}
- Średnie dobowe nawodnienie: ${stats.avgWaterMl}ml (cel: ${targetWaterMl}ml)

Dane z Oura & Withings (średnie tygodniowe):
- Średni wynik snu (Sleep Score): ${stats.avgSleepScore !== null ? stats.avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${stats.avgReadinessScore !== null ? stats.avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${stats.avgWeight !== null ? stats.avgWeight + ' kg' : 'brak'}
- Średni procent tłuszczu: ${stats.avgFatRatio !== null ? stats.avgFatRatio + '%' : 'brak'}
- Średnia masa mięśniowa: ${stats.avgMuscleMass !== null ? stats.avgMuscleMass + ' kg' : 'brak'}

Napisz profesjonalny, zwięzły i motywujący tygodniowy raport w języku polskim. Skup się na:
1. Bilansie energetycznym (trzymanie celów).
2. Pokryciu makroskładników (ze szczególnym naciskiem na modyfikacje i sugestie dietetyczne, np. kiedy i jak dorzucić więcej białka w celu odbudowy mięśni lub jak zbilansować pozostałe makro).
3. Podsumowaniu aktywności treningowej, w tym szacunkowych strefach kardio po treningu (strefa spalania tłuszczu vs. wysoka intensywność tlenowa/beztlenowa) oszacowanych na podstawie spalonych aktywnych kalorii oraz wskaźników tętna spoczynkowego (RHR) i HRV z Oura.
4. Regeneracji i zmianach w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej).
5. Poziomie nawodnienia względem celu i jego wpływie na regenerację i wydolność.
6. Zakończ trzema konkretnymi rekomendacjami żywieniowo-treningowymi w punktach na nadchodzący tydzień.

Formatuj odpowiedź używając czytelnych akapitów, punktów i nagłówków. Pisz bezpośrednio do użytkownika.
`;

  const aiSummary = await generateAiSummaryText({
    userId, user, prompt: advicePrompt,
    shouldGenerate: meals.length > 0 || stats.avgActiveCalories > 0 || stats.avgSleepScore !== null,
    fallbackMessage: "Tygodniowy raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!",
    errorLogLabel: '[API ERROR] Błąd generowania raportu tygodniowego AI:',
    errorMessagePrefix: 'Błąd podczas generowania podsumowania tygodniowego przez AI: '
  });

  const emailHtml = buildSummaryEmailHtml({
    title: 'Dietetyk AI: Podsumowanie Tygodniowe',
    headerSubtitleHtml: `Raport dla użytkownika <strong>${user.username}</strong>`,
    statsSectionTitle: 'Twoje Statystyki (Średnia Dobowa)',
    valueColumnLabel: 'Średnia',
    statRows: [
      { label: 'Kalorie Spożyte', value: `${stats.avgEatenCalories} kcal`, target: `${targetCalories} kcal` },
      { label: 'Białko', value: `${stats.avgProtein}g`, target: `${targetProtein}g` },
      { label: 'Węglowodany', value: `${stats.avgCarbs}g`, target: `${targetCarbs}g` },
      { label: 'Tłuszcz', value: `${stats.avgFat}g`, target: `${targetFat}g` },
      { label: 'Kroki', value: stats.avgSteps },
      { label: 'Kalorie Spalone (Aktywne)', value: `${stats.avgActiveCalories} kcal` },
      { label: 'Treningi w tygodniu', value: stats.workoutsCount },
      { label: 'Woda', value: `${stats.avgWaterMl}ml`, target: `${targetWaterMl}ml` }
    ],
    aiHtml: markdownToHtml(aiSummary)
  });

  console.log(`[MAILGUN] Rozpoczęcie wysyłania tygodniowego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Tygodniowe Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// ===== Raport codzienny =====
async function sendDailySummaryForUser(userId, customEmail = null) {
  const { user, emailToUse } = await getUserAndEmail(userId, customEmail);
  const { targetCalories, targetProtein, targetCarbs, targetFat, bmr, targetWaterMl } = await getUserSettings(userId);

  const date = getLocalDateString();

  // Posiłki z dzisiaj
  const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [userId, date]);
  let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const meals = mealRows.map(r => {
    let analysis = {};
    try {
      analysis = JSON.parse(r.analysis_json);
    } catch (e) {
      analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat };
    }
    totalEaten.calories += r.calories;
    totalEaten.protein += r.protein;
    totalEaten.carbs += r.carbs;
    totalEaten.fat += r.fat;
    return { id: r.id, raw_text: r.raw_text, ...analysis };
  });

  totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
  totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
  totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;

  // Dane zdrowotne z dzisiaj
  const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [userId, date]) || {
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
    water_ml: 0
  };

  const activeCalories = health.active_calories || 0;
  const totalBurned = health.total_calories_burned || (bmr + activeCalories);
  const netCalories = totalEaten.calories - totalBurned;

  const advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${user.first_name || user.username} dla dnia ${date}, zwracając się do niego po imieniu:
Cele użytkownika:
- Cel kaloryczny spożycia: ${targetCalories} kcal
- Cel Białka: ${targetProtein}g, Węglowodanów: ${targetCarbs}g, Tłuszczu: ${targetFat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${health.steps || 0}
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${targetWaterMl}ml)

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score + '/100' : 'Brak danych'} (Czas trwania: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms, Odchylenie temperatury ciała: ${health.temperature_deviation !== null ? health.temperature_deviation + ' °C' : 'brak'}
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${health.weight !== null ? health.weight + ' kg' : 'brak danych'}, Procent tłuszczu: ${health.fat_ratio !== null ? health.fat_ratio + '%' : 'brak danych'}, Masa mięśniowa: ${health.muscle_mass !== null ? health.muscle_mass + ' kg' : 'brak danych'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Napisz krótką, spersonalizowaną poradę dietetyczno-treningową (maksymalnie 4-5 zdań). Skup się na:
1. Analizie intensywności wysiłku i stref kardio po treningu na bazie aktywnych kalorii oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Sugerowaniu precyzyjnych zmian w diecie na bazie dzisiejszych posiłków i treningu (np. zalecenie dorzucenia większej ilości białka w celu wsparcia regeneracji włókien mięśniowych po ciężkim wysiłku beztlenowym lub redukcji węglowodanów w dni o niskim wysiłku aerobowym).
3. Uwzględnieniu gotowości Oura i trendów wagi/mięśni/tłuszczu z Withings.
Pisz bezpośrednio do użytkownika w języku polskim. Bądź konkretny, motywujący i merytoryczny.
`;

  let aiAdvice = await generateAiSummaryText({
    userId, user, prompt: advicePrompt,
    shouldGenerate: meals.length > 0 || activeCalories > 0 || health.sleep_score !== null,
    fallbackMessage: "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.",
    errorLogLabel: '[API ERROR] Błąd generowania porady AI do maila:',
    errorMessagePrefix: 'Błąd generowania analizy AI.'
  });
  aiAdvice = aiAdvice.trim();

  const emailHtml = buildSummaryEmailHtml({
    title: 'Dietetyk AI: Podsumowanie Codzienne',
    headerSubtitleHtml: `Raport z dnia <strong>${date}</strong> dla <strong>${user.username}</strong>`,
    statsSectionTitle: 'Twoje Statystyki Dzisiejsze',
    valueColumnLabel: 'Dzisiaj',
    statRows: [
      { label: 'Kalorie Spożyte', value: `${totalEaten.calories} kcal`, target: `${targetCalories} kcal` },
      { label: 'Białko', value: `${totalEaten.protein}g`, target: `${targetProtein}g` },
      { label: 'Węglowodany', value: `${totalEaten.carbs}g`, target: `${targetCarbs}g` },
      { label: 'Tłuszcz', value: `${totalEaten.fat}g`, target: `${targetFat}g` },
      { label: 'Kroki', value: health.steps || 0 },
      { label: 'Kalorie Spalone (Aktywne)', value: `${activeCalories} kcal` },
      { label: 'Waga ciała', value: health.weight !== null ? health.weight + ' kg' : 'brak' },
      { label: 'Woda', value: `${health.water_ml || 0}ml`, target: `${targetWaterMl}ml` }
    ],
    aiHtml: markdownToHtml(aiAdvice)
  });

  console.log(`[MAILGUN] Rozpoczęcie wysyłania codziennego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Codzienne Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// ===== Raport miesięczny (analogiczny do tygodniowego, okno 30 dni) =====
async function sendMonthlySummaryForUser(userId, customEmail = null) {
  const { user, emailToUse } = await getUserAndEmail(userId, customEmail);
  const { targetCalories, targetProtein, targetCarbs, targetFat, bmr, targetWaterMl } = await getUserSettings(userId);

  // Pobranie danych z ostatnich 30 dni
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const meals = await db.all(`
    SELECT * FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, thirtyDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, thirtyDaysAgo]);

  const numDays = 30;
  const stats = aggregateNutritionAndHealth(meals, healthMetrics, numDays);
  const avgTotalBurned = bmr + stats.avgActiveCalories;
  const avgNetCalories = stats.avgEatenCalories - avgTotalBurned;

  const advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj miesięczny raport żywieniowo-treningowy użytkownika ${user.first_name || user.username} (ostatnie 30 dni), zwracając się do niego po imieniu:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Miesięczne statystyki (średnie dzienne z ostatnich 30 dni):
- Średnie dzienne spożycie energii: ${stats.avgEatenCalories} kcal (Białko: ${stats.avgProtein}g, Węglowodany: ${stats.avgCarbs}g, Tłuszcz: ${stats.avgFat}g)
- Średnia aktywność fizyczna (aktywne kalorie): ${stats.avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${stats.avgSteps}
- Liczba dni z treningiem w miesiącu: ${stats.workoutsCount}
- Średnie dobowe nawodnienie: ${stats.avgWaterMl}ml (cel: ${targetWaterMl}ml)

Dane z Oura & Withings (średnie miesięczne i zmiana trendu od początku do końca okresu):
- Średni wynik snu (Sleep Score): ${stats.avgSleepScore !== null ? stats.avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${stats.avgReadinessScore !== null ? stats.avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${stats.avgWeight !== null ? stats.avgWeight + ' kg' : 'brak'} (zmiana w miesiącu: ${stats.weightChange !== null ? (stats.weightChange > 0 ? '+' : '') + stats.weightChange + ' kg' : 'brak danych'})
- Średni procent tłuszczu: ${stats.avgFatRatio !== null ? stats.avgFatRatio + '%' : 'brak'} (zmiana w miesiącu: ${stats.fatRatioChange !== null ? (stats.fatRatioChange > 0 ? '+' : '') + stats.fatRatioChange + ' pp' : 'brak danych'})
- Średnia masa mięśniowa: ${stats.avgMuscleMass !== null ? stats.avgMuscleMass + ' kg' : 'brak'} (zmiana w miesiącu: ${stats.muscleMassChange !== null ? (stats.muscleMassChange > 0 ? '+' : '') + stats.muscleMassChange + ' kg' : 'brak danych'})

Napisz profesjonalny, zwięzły i motywujący miesięczny raport w języku polskim. Skup się na:
1. Ogólnym trendzie bilansu energetycznego w skali miesiąca (utrzymanie celów, konsekwencja).
2. Długoterminowych zmianach w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej w skali miesiąca) - odnieś się konkretnie do zmiany wagi/tłuszczu/mięśni podanej powyżej.
3. Konsekwencji w treningach i regeneracji (gotowość Oura) na przestrzeni miesiąca.
4. Poziomie nawodnienia względem celu w skali miesiąca i jego wpływie na regenerację.
5. Zakończ trzema konkretnymi, długoterminowymi rekomendacjami żywieniowo-treningowymi na nadchodzący miesiąc.

Formatuj odpowiedź używając czytelnych akapitów, punktów i nagłówków. Pisz bezpośrednio do użytkownika.
`;

  const aiSummary = await generateAiSummaryText({
    userId, user, prompt: advicePrompt,
    shouldGenerate: meals.length > 0 || stats.avgActiveCalories > 0 || stats.avgSleepScore !== null,
    fallbackMessage: "Miesięczny raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!",
    errorLogLabel: '[API ERROR] Błąd generowania raportu miesięcznego AI:',
    errorMessagePrefix: 'Błąd podczas generowania podsumowania miesięcznego przez AI: '
  });

  const emailHtml = buildSummaryEmailHtml({
    title: 'Dietetyk AI: Podsumowanie Miesięczne',
    headerSubtitleHtml: `Raport za ostatnie 30 dni dla użytkownika <strong>${user.username}</strong>`,
    statsSectionTitle: 'Twoje Statystyki (Średnia Dobowa, 30 dni)',
    valueColumnLabel: 'Średnia',
    statRows: [
      { label: 'Kalorie Spożyte', value: `${stats.avgEatenCalories} kcal`, target: `${targetCalories} kcal` },
      { label: 'Białko', value: `${stats.avgProtein}g`, target: `${targetProtein}g` },
      { label: 'Węglowodany', value: `${stats.avgCarbs}g`, target: `${targetCarbs}g` },
      { label: 'Tłuszcz', value: `${stats.avgFat}g`, target: `${targetFat}g` },
      { label: 'Kroki', value: stats.avgSteps },
      { label: 'Kalorie Spalone (Aktywne)', value: `${stats.avgActiveCalories} kcal` },
      { label: 'Treningi w miesiącu', value: stats.workoutsCount },
      { label: 'Woda', value: `${stats.avgWaterMl}ml`, target: `${targetWaterMl}ml` },
      { label: 'Zmiana wagi', value: stats.weightChange !== null ? (stats.weightChange > 0 ? '+' : '') + stats.weightChange + ' kg' : 'brak danych' },
      { label: 'Zmiana % tłuszczu', value: stats.fatRatioChange !== null ? (stats.fatRatioChange > 0 ? '+' : '') + stats.fatRatioChange + ' pp' : 'brak danych' },
      { label: 'Zmiana masy mięśniowej', value: stats.muscleMassChange !== null ? (stats.muscleMassChange > 0 ? '+' : '') + stats.muscleMassChange + ' kg' : 'brak danych' }
    ],
    aiHtml: markdownToHtml(aiSummary)
  });

  console.log(`[MAILGUN] Rozpoczęcie wysyłania miesięcznego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Miesięczne Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

module.exports = {
  sendWeeklySummaryForUser,
  sendDailySummaryForUser,
  sendMonthlySummaryForUser
};
