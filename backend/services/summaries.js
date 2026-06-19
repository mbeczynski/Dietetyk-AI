const db = require('../db');
const { genAI, generateContentWithFallback } = require('../config');
const { getLocalDateString } = require('../utils/dates');
const { sendMailgunEmail } = require('./mailgun');

async function sendWeeklySummaryForUser(userId, customEmail = null) {
  const user = await db.get(`SELECT username, email, role, first_name FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }

  // Pobranie danych z ostatnich 7 dni
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  const meals = await db.all(`
    SELECT * FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });

  const targetCalories = settings.target_calories || 2500;
  const targetProtein = settings.target_protein || 150;
  const targetCarbs = settings.target_carbs || 250;
  const targetFat = settings.target_fat || 80;
  const bmr = settings.bmr || 1800;
  const targetWaterMl = settings.target_water_ml || 2500;

  // Obliczenie średnich żywieniowych
  let totalEatenCal = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
  meals.forEach(m => {
    totalEatenCal += m.calories;
    totalProtein += m.protein;
    totalCarbs += m.carbs;
    totalFat += m.fat;
  });

  // Obliczenie średnich zdrowotnych
  let totalSteps = 0, totalActiveCal = 0, totalWaterMl = 0;
  let sleepScoreSum = 0, sleepScoreCount = 0;
  let readinessScoreSum = 0, readinessScoreCount = 0;
  let weightSum = 0, weightCount = 0;
  let fatRatioSum = 0, fatRatioCount = 0;
  let muscleMassSum = 0, muscleMassCount = 0;

  healthMetrics.forEach(h => {
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
    }
    if (h.fat_ratio !== null) {
      fatRatioSum += h.fat_ratio;
      fatRatioCount++;
    }
    if (h.muscle_mass !== null) {
      muscleMassSum += h.muscle_mass;
      muscleMassCount++;
    }
  });

  const workoutsCount = healthMetrics.filter(h => (h.active_calories || 0) > 0).length;
  const numDays = 7;
  const avgEatenCalories = Math.round(totalEatenCal / numDays);
  const avgProtein = Math.round((totalProtein / numDays) * 10) / 10;
  const avgCarbs = Math.round((totalCarbs / numDays) * 10) / 10;
  const avgFat = Math.round((totalFat / numDays) * 10) / 10;

  const avgSteps = Math.round(totalSteps / numDays);
  const avgActiveCalories = Math.round(totalActiveCal / numDays);
  const avgTotalBurned = bmr + avgActiveCalories;
  const avgNetCalories = avgEatenCalories - avgTotalBurned;
  const avgWaterMl = Math.round(totalWaterMl / numDays);

  const avgSleepScore = sleepScoreCount > 0 ? Math.round(sleepScoreSum / sleepScoreCount) : null;
  const avgReadinessScore = readinessScoreCount > 0 ? Math.round(readinessScoreSum / readinessScoreCount) : null;
  const avgWeight = weightCount > 0 ? Math.round((weightSum / weightCount) * 10) / 10 : null;
  const avgFatRatio = fatRatioCount > 0 ? Math.round((fatRatioSum / fatRatioCount) * 10) / 10 : null;
  const avgMuscleMass = muscleMassCount > 0 ? Math.round((muscleMassSum / muscleMassCount) * 10) / 10 : null;

  // Generowanie porady AI
  let aiSummary = "Tygodniowy raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!";
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? apiKeyRow.value : null;
  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && (meals.length > 0 || totalActiveCal > 0 || sleepScoreCount > 0)) {
    try {
      const advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj tygodniowy raport żywieniowo-treningowy użytkownika ${user.first_name || user.username}, zwracając się do niego po imieniu:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Tygodniowe statystyki (średnie dzienne):
- Średnie dzienne spożycie energii: ${avgEatenCalories} kcal (Białko: ${avgProtein}g, Węglowodany: ${avgCarbs}g, Tłuszcz: ${avgFat}g)
- Średnia aktywność fizyczna (aktywne kalorie): ${avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${avgSteps}
- Średnie dobowe nawodnienie: ${avgWaterMl}ml (cel: ${targetWaterMl}ml)

Dane z Oura & Withings (średnie tygodniowe):
- Średni wynik snu (Sleep Score): ${avgSleepScore !== null ? avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${avgReadinessScore !== null ? avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${avgWeight !== null ? avgWeight + ' kg' : 'brak'}
- Średni procent tłuszczu: ${avgFatRatio !== null ? avgFatRatio + '%' : 'brak'}
- Średnia masa mięśniowa: ${avgMuscleMass !== null ? avgMuscleMass + ' kg' : 'brak'}

Napisz profesjonalny, zwięzły i motywujący tygodniowy raport w języku polskim. Skup się na:
1. Bilansie energetycznym (trzymanie celów).
2. Pokryciu makroskładników (ze szczególnym naciskiem na modyfikacje i sugestie dietetyczne, np. kiedy i jak dorzucić więcej białka w celu odbudowy mięśni lub jak zbilansować pozostałe makro).
3. Podsumowaniu aktywności treningowej, w tym szacunkowych strefach kardio po treningu (strefa spalania tłuszczu vs. wysoka intensywność tlenowa/beztlenowa) oszacowanych na podstawie spalonych aktywnych kalorii oraz wskaźników tętna spoczynkowego (RHR) i HRV z Oura.
4. Regeneracji i zmianach w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej).
5. Poziomie nawodnienia względem celu i jego wpływie na regenerację i wydolność.
6. Zakończ trzema konkretnymi rekomendacjami żywieniowo-treningowymi w punktach na nadchodzący tydzień.

Formatuj odpowiedź używając czytelnych akapitów, punktów i nagłówków. Pisz bezpośrednio do użytkownika.
`;
      const forceCustomKeyOnly = user.role !== 'admin';
      aiSummary = await generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly);
    } catch (err) {
      console.error('[API ERROR] Błąd generowania raportu tygodniowego AI:', err);
      aiSummary = 'Błąd podczas generowania podsumowania tygodniowego przez AI: ' + err.message;
    }
  }

  // Konwersja markdown z Gemini na HTML
  const formattedAiSummary = aiSummary
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\* ([^*]+)/g, '<li>$1</li>');

  // Budowanie maila HTML
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Tygodniowe Podsumowanie Dietetyk AI</title>
      <style>
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
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">Dietetyk AI: Podsumowanie Tygodniowe</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">Raport dla użytkownika <strong>${user.username}</strong></p>
        </div>

        <div class="section-title">📊 Twoje Statystyki (Średnia Dobowa)</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>Średnia</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Kalorie Spożyte</td>
              <td><strong>${avgEatenCalories} kcal</strong></td>
              <td>${targetCalories} kcal</td>
            </tr>
            <tr>
              <td>Białko</td>
              <td><strong>${avgProtein}g</strong></td>
              <td>${targetProtein}g</td>
            </tr>
            <tr>
              <td>Węglowodany</td>
              <td><strong>${avgCarbs}g</strong></td>
              <td>${targetCarbs}g</td>
            </tr>
            <tr>
              <td>Tłuszcz</td>
              <td><strong>${avgFat}g</strong></td>
              <td>${targetFat}g</td>
            </tr>
            <tr>
              <td>Kroki</td>
              <td><strong>${avgSteps}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Kalorie Spalone (Aktywne)</td>
              <td><strong>${avgActiveCalories} kcal</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Treningi w tygodniu</td>
              <td><strong>${workoutsCount}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Woda</td>
              <td><strong>${avgWaterMl}ml</strong></td>
              <td>${targetWaterMl}ml</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${formattedAiSummary}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;

  console.log(`[MAILGUN] Rozpoczęcie wysyłania tygodniowego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Tygodniowe Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// Pomocnicza funkcja generująca i wysyłająca codzienne podsumowanie
async function sendDailySummaryForUser(userId, customEmail = null) {
  const user = await db.get(`SELECT username, email, role, first_name FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }

  const date = getLocalDateString();

  // Pobranie celów
  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });

  const targetCalories = settings.target_calories || 2500;
  const targetProtein = settings.target_protein || 150;
  const targetCarbs = settings.target_carbs || 250;
  const targetFat = settings.target_fat || 80;
  const bmr = settings.bmr || 1800;
  const targetWaterMl = settings.target_water_ml || 2500;

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

  // Generowanie porady od Dietetyka AI na bazie dzisiejszych danych
  let aiAdvice = "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.";
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? apiKeyRow.value : null;
  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
    try {
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

      const forceCustomKeyOnly = user.role !== 'admin';
      aiAdvice = await generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly);
      aiAdvice = aiAdvice.trim();
    } catch (aiErr) {
      console.error('[API ERROR] Błąd generowania porady AI do maila:', aiErr);
      aiAdvice = 'Błąd generowania analizy AI.';
    }
  }

  // Konwersja markdown z Gemini na HTML
  const formattedAiAdvice = aiAdvice
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\* ([^*]+)/g, '<li>$1</li>');

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Codzienne Podsumowanie Dietetyk AI</title>
      <style>
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
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">Dietetyk AI: Podsumowanie Codzienne</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">Raport z dnia <strong>${date}</strong> dla <strong>${user.username}</strong></p>
        </div>

        <div class="section-title">📊 Twoje Statystyki Dzisiejsze</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>Dzisiaj</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Kalorie Spożyte</td>
              <td><strong>${totalEaten.calories} kcal</strong></td>
              <td>${targetCalories} kcal</td>
            </tr>
            <tr>
              <td>Białko</td>
              <td><strong>${totalEaten.protein}g</strong></td>
              <td>${targetProtein}g</td>
            </tr>
            <tr>
              <td>Węglowodany</td>
              <td><strong>${totalEaten.carbs}g</strong></td>
              <td>${targetCarbs}g</td>
            </tr>
            <tr>
              <td>Tłuszcz</td>
              <td><strong>${totalEaten.fat}g</strong></td>
              <td>${targetFat}g</td>
            </tr>
            <tr>
              <td>Kroki</td>
              <td><strong>${health.steps || 0}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Kalorie Spalone (Aktywne)</td>
              <td><strong>${activeCalories} kcal</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Waga ciała</td>
              <td><strong>${health.weight !== null ? health.weight + ' kg' : 'brak'}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Woda</td>
              <td><strong>${health.water_ml || 0}ml</strong></td>
              <td>${targetWaterMl}ml</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${formattedAiAdvice}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;

  console.log(`[MAILGUN] Rozpoczęcie wysyłania codziennego podsumowania do ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Codzienne Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// Pomocnicza funkcja generująca i wysyłająca miesięczne podsumowanie (analogicznie do tygodniowego, okno 30 dni)
async function sendMonthlySummaryForUser(userId, customEmail = null) {
  const user = await db.get(`SELECT username, email, role, first_name FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }

  // Pobranie danych z ostatnich 30 dni
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const meals = await db.all(`
    SELECT * FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, thirtyDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, thirtyDaysAgo]);

  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });

  const targetCalories = settings.target_calories || 2500;
  const targetProtein = settings.target_protein || 150;
  const targetCarbs = settings.target_carbs || 250;
  const targetFat = settings.target_fat || 80;
  const bmr = settings.bmr || 1800;
  const targetWaterMl = settings.target_water_ml || 2500;

  // Obliczenie średnich żywieniowych
  let totalEatenCal = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
  meals.forEach(m => {
    totalEatenCal += m.calories;
    totalProtein += m.protein;
    totalCarbs += m.carbs;
    totalFat += m.fat;
  });

  // Obliczenie średnich zdrowotnych
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
  const numDays = 30;
  const avgEatenCalories = Math.round(totalEatenCal / numDays);
  const avgProtein = Math.round((totalProtein / numDays) * 10) / 10;
  const avgCarbs = Math.round((totalCarbs / numDays) * 10) / 10;
  const avgFat = Math.round((totalFat / numDays) * 10) / 10;

  const avgSteps = Math.round(totalSteps / numDays);
  const avgActiveCalories = Math.round(totalActiveCal / numDays);
  const avgTotalBurned = bmr + avgActiveCalories;
  const avgNetCalories = avgEatenCalories - avgTotalBurned;
  const avgWaterMl = Math.round(totalWaterMl / numDays);

  const avgSleepScore = sleepScoreCount > 0 ? Math.round(sleepScoreSum / sleepScoreCount) : null;
  const avgReadinessScore = readinessScoreCount > 0 ? Math.round(readinessScoreSum / readinessScoreCount) : null;
  const avgWeight = weightCount > 0 ? Math.round((weightSum / weightCount) * 10) / 10 : null;
  const avgFatRatio = fatRatioCount > 0 ? Math.round((fatRatioSum / fatRatioCount) * 10) / 10 : null;
  const avgMuscleMass = muscleMassCount > 0 ? Math.round((muscleMassSum / muscleMassCount) * 10) / 10 : null;

  const weightChange = (firstWeight !== null && lastWeight !== null) ? Math.round((lastWeight - firstWeight) * 10) / 10 : null;
  const fatRatioChange = (firstFatRatio !== null && lastFatRatio !== null) ? Math.round((lastFatRatio - firstFatRatio) * 10) / 10 : null;
  const muscleMassChange = (firstMuscleMass !== null && lastMuscleMass !== null) ? Math.round((lastMuscleMass - firstMuscleMass) * 10) / 10 : null;

  // Generowanie porady AI
  let aiSummary = "Miesięczny raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!";
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? apiKeyRow.value : null;
  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && (meals.length > 0 || totalActiveCal > 0 || sleepScoreCount > 0)) {
    try {
      const advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj miesięczny raport żywieniowo-treningowy użytkownika ${user.first_name || user.username} (ostatnie 30 dni), zwracając się do niego po imieniu:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Miesięczne statystyki (średnie dzienne z ostatnich 30 dni):
- Średnie dzienne spożycie energii: ${avgEatenCalories} kcal (Białko: ${avgProtein}g, Węglowodany: ${avgCarbs}g, Tłuszcz: ${avgFat}g)
- Średnia aktywność fizyczna (aktywne kalorie): ${avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${avgSteps}
- Liczba dni z treningiem w miesiącu: ${workoutsCount}
- Średnie dobowe nawodnienie: ${avgWaterMl}ml (cel: ${targetWaterMl}ml)

Dane z Oura & Withings (średnie miesięczne i zmiana trendu od początku do końca okresu):
- Średni wynik snu (Sleep Score): ${avgSleepScore !== null ? avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${avgReadinessScore !== null ? avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${avgWeight !== null ? avgWeight + ' kg' : 'brak'} (zmiana w miesiącu: ${weightChange !== null ? (weightChange > 0 ? '+' : '') + weightChange + ' kg' : 'brak danych'})
- Średni procent tłuszczu: ${avgFatRatio !== null ? avgFatRatio + '%' : 'brak'} (zmiana w miesiącu: ${fatRatioChange !== null ? (fatRatioChange > 0 ? '+' : '') + fatRatioChange + ' pp' : 'brak danych'})
- Średnia masa mięśniowa: ${avgMuscleMass !== null ? avgMuscleMass + ' kg' : 'brak'} (zmiana w miesiącu: ${muscleMassChange !== null ? (muscleMassChange > 0 ? '+' : '') + muscleMassChange + ' kg' : 'brak danych'})

Napisz profesjonalny, zwięzły i motywujący miesięczny raport w języku polskim. Skup się na:
1. Ogólnym trendzie bilansu energetycznego w skali miesiąca (utrzymanie celów, konsekwencja).
2. Długoterminowych zmianach w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej w skali miesiąca) - odnieś się konkretnie do zmiany wagi/tłuszczu/mięśni podanej powyżej.
3. Konsekwencji w treningach i regeneracji (gotowość Oura) na przestrzeni miesiąca.
4. Poziomie nawodnienia względem celu w skali miesiąca i jego wpływie na regenerację.
5. Zakończ trzema konkretnymi, długoterminowymi rekomendacjami żywieniowo-treningowymi na nadchodzący miesiąc.

Formatuj odpowiedź używając czytelnych akapitów, punktów i nagłówków. Pisz bezpośrednio do użytkownika.
`;
      const forceCustomKeyOnly = user.role !== 'admin';
      aiSummary = await generateContentWithFallback(advicePrompt, false, null, userApiKey, forceCustomKeyOnly);
    } catch (err) {
      console.error('[API ERROR] Błąd generowania raportu miesięcznego AI:', err);
      aiSummary = 'Błąd podczas generowania podsumowania miesięcznego przez AI: ' + err.message;
    }
  }

  // Konwersja markdown z Gemini na HTML
  const formattedAiSummary = aiSummary
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\* ([^*]+)/g, '<li>$1</li>');

  // Budowanie maila HTML
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Miesięczne Podsumowanie Dietetyk AI</title>
      <style>
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
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">Dietetyk AI: Podsumowanie Miesięczne</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">Raport za ostatnie 30 dni dla użytkownika <strong>${user.username}</strong></p>
        </div>

        <div class="section-title">📊 Twoje Statystyki (Średnia Dobowa, 30 dni)</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>Średnia</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Kalorie Spożyte</td>
              <td><strong>${avgEatenCalories} kcal</strong></td>
              <td>${targetCalories} kcal</td>
            </tr>
            <tr>
              <td>Białko</td>
              <td><strong>${avgProtein}g</strong></td>
              <td>${targetProtein}g</td>
            </tr>
            <tr>
              <td>Węglowodany</td>
              <td><strong>${avgCarbs}g</strong></td>
              <td>${targetCarbs}g</td>
            </tr>
            <tr>
              <td>Tłuszcz</td>
              <td><strong>${avgFat}g</strong></td>
              <td>${targetFat}g</td>
            </tr>
            <tr>
              <td>Kroki</td>
              <td><strong>${avgSteps}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Kalorie Spalone (Aktywne)</td>
              <td><strong>${avgActiveCalories} kcal</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Treningi w miesiącu</td>
              <td><strong>${workoutsCount}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Woda</td>
              <td><strong>${avgWaterMl}ml</strong></td>
              <td>${targetWaterMl}ml</td>
            </tr>
            <tr>
              <td>Zmiana wagi</td>
              <td><strong>${weightChange !== null ? (weightChange > 0 ? '+' : '') + weightChange + ' kg' : 'brak danych'}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Zmiana % tłuszczu</td>
              <td><strong>${fatRatioChange !== null ? (fatRatioChange > 0 ? '+' : '') + fatRatioChange + ' pp' : 'brak danych'}</strong></td>
              <td>-</td>
            </tr>
            <tr>
              <td>Zmiana masy mięśniowej</td>
              <td><strong>${muscleMassChange !== null ? (muscleMassChange > 0 ? '+' : '') + muscleMassChange + ' kg' : 'brak danych'}</strong></td>
              <td>-</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${formattedAiSummary}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;

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
