const PDFDocument = require('pdfkit');
const db = require('../db');
const { getUserSettings, aggregateNutritionAndHealth } = require('./summaries');

// Eksport PDF dla lekarza/dietetyka - dokument do samodzielnego pobrania i pokazania
// profesjonaliście. Świadomie BEZ tekstu generowanego przez Gemini (w przeciwieństwie
// do maili podsumowujących w tym samym module) - to dokument o charakterze quasi-
// medycznym, więc zawiera wyłącznie surowe, policzone dane z aplikacji (te same
// źródła co raporty e-mail), bez ryzyka, że model językowy "doda" coś, czego
// użytkownik nie zalogował. Wykorzystuje wyłącznie dane już zbierane przez aplikację -
// żadnych nowych pól/formularzy, żadnego kopiowania funkcji z konkurencji.
const PDF_REPORT_MAX_DAYS = 180;
const PDF_REPORT_DEFAULT_DAYS = 30;

// Etykiety obwodów ciała - identyczne jak w ActivityTracker.jsx (getMeasureLabel),
// żeby raport PDF nazywał te same pomiary tak samo jak frontend.
const MEASUREMENT_FIELDS = [
  ['chest', 'Klatka piersiowa'],
  ['shoulders', 'Barki'],
  ['waist', 'Talia / Pas'],
  ['waist_above', 'Pas +2cm'],
  ['waist_below', 'Pas -2cm'],
  ['hips', 'Biodra'],
  ['biceps', 'Biceps'],
  ['biceps_left', 'Biceps lewy'],
  ['biceps_right', 'Biceps prawy'],
  ['thigh', 'Udo']
];

async function buildHealthReportPdf(userId, requestedDays) {
  const days = Math.min(Math.max(parseInt(requestedDays, 10) || PDF_REPORT_DEFAULT_DAYS, 1), PDF_REPORT_MAX_DAYS);

  const user = await db.get(
    `SELECT username, first_name, last_name, body_goal_text FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const settings = await getUserSettings(userId);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Te same tabele/kolumny co w raportach e-mail (summaries.js) - bez image_base64/
  // analysis_json, które ten raport nigdy nie wyświetla.
  const [meals, healthMetrics, bodyMeasurements] = await Promise.all([
    db.all(
      `SELECT calories, protein, carbs, fat, fiber, sugar, sodium FROM meals WHERE user_id = ? AND date >= ?`,
      [userId, startDate]
    ),
    db.all(`SELECT * FROM health_metrics WHERE user_id = ? AND date >= ? ORDER BY date ASC`, [userId, startDate]),
    db.all(`SELECT * FROM body_measurements WHERE user_id = ? AND date >= ? ORDER BY date ASC`, [userId, startDate])
  ]);

  const stats = aggregateNutritionAndHealth(meals, healthMetrics, days);
  const firstMeasurement = bodyMeasurements.length > 0 ? bodyMeasurements[0] : null;
  const lastMeasurement = bodyMeasurements.length > 0 ? bodyMeasurements[bodyMeasurements.length - 1] : null;

  return new Promise((resolve, reject) => {
    // Zadeklarowane przed try, żeby catch mógł posprzątać (doc.destroy()),
    // jeśli błąd wystąpi już PO utworzeniu dokumentu (np. w trakcie .text()).
    let doc;
    try {
      doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const sectionTitle = (text) => {
        doc.moveDown(0.8);
        doc.fontSize(13).fillColor('#1e293b').font('Helvetica-Bold').text(text);
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor('#0f172a').font('Helvetica');
      };
      const row = (label, value) => {
        doc.text(`${label}: ${value}`);
      };

      // --- Nagłówek ---
      doc.fontSize(20).fillColor('#1e293b').font('Helvetica-Bold').text('Dietetyk AI - Raport zdrowotno-żywieniowy');
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#64748b').font('Helvetica');
      doc.text(`Pacjent: ${[user.first_name, user.last_name].filter(Boolean).join(' ') || user.username} (login: ${user.username})`);
      doc.text(`Okres raportu: ${startDate} - ${today} (${days} dni)`);
      doc.text(`Wygenerowano: ${new Date().toLocaleString('pl-PL')}`);

      // --- Cele ---
      sectionTitle('Cele dobowe');
      row('Cel kaloryczny', `${settings.targetCalories} kcal`);
      row('Makroskładniki', `Białko ${settings.targetProtein} g, Węglowodany ${settings.targetCarbs} g, Tłuszcz ${settings.targetFat} g`);
      row('BMR (podstawowa przemiana materii)', `${settings.bmr} kcal`);
      row('Cel nawodnienia', `${settings.targetWaterMl} ml`);
      if (settings.targetWeightKg) {
        row('Docelowa waga', `${settings.targetWeightKg} kg`);
      }

      // --- Średnie z okresu ---
      sectionTitle(`Średnie dzienne z okresu (${days} dni, wyłącznie dni z zalogowanymi danymi)`);
      row('Energia', `${stats.avgEatenCalories} kcal`);
      row('Białko / Węglowodany / Tłuszcz', `${stats.avgProtein} g / ${stats.avgCarbs} g / ${stats.avgFat} g`);
      row('Błonnik / Cukry / Sód', `${stats.avgFiber} g / ${stats.avgSugar} g / ${stats.avgSodium} mg`);
      row('Kroki', `${stats.avgSteps}`);
      row('Aktywne kalorie spalone', `${stats.avgActiveCalories} kcal`);
      row('Nawodnienie', `${stats.avgWaterMl} ml`);
      row('Liczba dni z treningiem', `${stats.workoutsCount}`);

      // --- Sen, regeneracja, skład ciała ---
      sectionTitle('Sen, regeneracja i skład ciała (Oura / Withings)');
      row('Średni wynik snu', stats.avgSleepScore !== null ? `${stats.avgSleepScore}/100` : 'brak danych');
      row('Średni wynik gotowości', stats.avgReadinessScore !== null ? `${stats.avgReadinessScore}/100` : 'brak danych');
      row('Średnia waga ciała', stats.avgWeight !== null ? `${stats.avgWeight} kg` : 'brak danych');
      if (stats.weightChange !== null) {
        row('Zmiana wagi w okresie', `${stats.weightChange > 0 ? '+' : ''}${stats.weightChange} kg`);
      }
      row('Średni procent tkanki tłuszczowej', stats.avgFatRatio !== null ? `${stats.avgFatRatio}%` : 'brak danych');
      if (stats.fatRatioChange !== null) {
        row('Zmiana % tkanki tłuszczowej', `${stats.fatRatioChange > 0 ? '+' : ''}${stats.fatRatioChange} pp`);
      }
      row('Średnia masa mięśniowa', stats.avgMuscleMass !== null ? `${stats.avgMuscleMass} kg` : 'brak danych');
      if (stats.muscleMassChange !== null) {
        row('Zmiana masy mięśniowej', `${stats.muscleMassChange > 0 ? '+' : ''}${stats.muscleMassChange} kg`);
      }
      row(
        'Średnie ciśnienie tętnicze',
        stats.avgBpSystolic !== null ? `${stats.avgBpSystolic}/${stats.avgBpDiastolic} mmHg` : 'brak danych'
      );

      // --- Pomiary obwodów ciała ---
      if (firstMeasurement && lastMeasurement) {
        sectionTitle('Pomiary obwodów ciała (pierwszy vs ostatni pomiar w okresie)');
        row('Data pierwszego / ostatniego pomiaru', `${firstMeasurement.date} / ${lastMeasurement.date}`);
        MEASUREMENT_FIELDS.forEach(([key, label]) => {
          const startVal = firstMeasurement[key];
          const endVal = lastMeasurement[key];
          if (startVal !== null && startVal !== undefined && endVal !== null && endVal !== undefined) {
            const diff = Math.round((endVal - startVal) * 10) / 10;
            row(label, `${startVal} cm -> ${endVal} cm (${diff > 0 ? '+' : ''}${diff} cm)`);
          }
        });
      }

      // --- Suplementy ---
      if (stats.supplementsLogged.length > 0) {
        sectionTitle('Suplementy zapisane w okresie');
        // Limit 30 wpisów - przy maksymalnym oknie 180 dni lista mogłaby być
        // bardzo długa, a to wciąż ma być zwięzły dokument do pokazania lekarzowi.
        stats.supplementsLogged.slice(0, 30).forEach((s) => doc.text(`- ${s}`));
        if (stats.supplementsLogged.length > 30) {
          doc.text(`... oraz ${stats.supplementsLogged.length - 30} kolejnych wpisów.`);
        }
      }

      // --- Opisany cel sylwetki ---
      if (user.body_goal_text) {
        sectionTitle('Opisany cel sylwetki użytkownika');
        doc.text(user.body_goal_text, { width: 495 });
      }

      // --- Zastrzeżenie ---
      doc.moveDown(1.5);
      doc.fontSize(8).fillColor('#94a3b8').text(
        'Dokument wygenerowany automatycznie przez aplikację Dietetyk AI na podstawie danych samodzielnie wprowadzanych i synchronizowanych przez użytkownika (m.in. Oura, Withings, Apple Health). Nie stanowi diagnozy medycznej ani porady lekarskiej - ma charakter wyłącznie informacyjny, jako materiał pomocniczy do rozmowy z lekarzem lub dietetykiem.',
        { width: 495 }
      );

      doc.end();
    } catch (err) {
      // Strumień pisze do bufora w pamięci (nie do pliku), więc nic tu realnie
      // nie "wycieka" bez destroy() - to tylko porządkowe domknięcie strumienia,
      // żeby nie został w niezdefiniowanym stanie po błędzie w trakcie budowania PDF.
      if (doc) doc.destroy();
      reject(err);
    }
  });
}

module.exports = { buildHealthReportPdf, PDF_REPORT_MAX_DAYS, PDF_REPORT_DEFAULT_DAYS };
