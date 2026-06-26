const db = require('../db');

// Detektor anomalii w posiłkach (produktowa funkcja oparta wyłącznie na danych już
// zbieranych przez aplikację - bez nowego wprowadzania danych przez użytkownika).
// Współdzielony przez routes/meals.js (POST/GET pojedynczych posiłków) i
// routes/dashboard.js (lista posiłków dnia w /api/dashboard) - tak jak
// getDefaultHealthMetrics, żeby nie duplikować tej samej logiki w dwóch miejscach.
//
// Dwa niezależne sygnały, oceniane i pokazywane OSOBNO, bo mają różne przyczyny:
// 1) Niezgodność kalorii z deklarowanych makro (białko*4 + węgle*4 + tłuszcz*9 vs
//    podane kalorie) - typowo wskazuje na błąd estymacji AI (np. źle przeliczona
//    wielkość porcji), a nie na nietypowy posiłek jako taki.
// 2) Statystyczny odstrój kalorii posiłku względem WŁASNEJ historii użytkownika
//    (z-score na bazie ostatnich ANOMALY_LOOKBACK_DAYS dni) - wymaga minimalnej
//    liczby wcześniejszych posiłków (MIN_MEALS_FOR_STATS_ANOMALY), inaczej pierwsze
//    kilka wpisów w aplikacji zawsze wyglądałoby jak "anomalia" względem samych siebie.
const ANOMALY_LOOKBACK_DAYS = 60;
const MIN_MEALS_FOR_STATS_ANOMALY = 8;
const ANOMALY_Z_SCORE_THRESHOLD = 2.5;
const MACRO_MISMATCH_MIN_KCAL_DIFF = 150;
const MACRO_MISMATCH_MIN_RATIO = 0.35;

// Przesunięcie daty (string YYYY-MM-DD) o N dni - ta sama, sprawdzona arytmetyka
// (Date.UTC) co shiftDate w dashboard.js, lokalna kopia żeby uniknąć zależności
// między modułami dla jednej małej funkcji pomocniczej.
const shiftDateForAnomaly = (dateStr, deltaDays) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
};

// Bazowy rozkład kalorii na posiłek z historii użytkownika, liczony ZE WSZYSTKICH
// dni PRZED `beforeDate` (nie włączając go) - dzięki temu posiłki z dnia, dla
// którego liczymy anomalie, nigdy nie wpływają na własny punkt odniesienia.
async function getCalorieBaseline(userId, beforeDate) {
  const startDate = shiftDateForAnomaly(beforeDate, -ANOMALY_LOOKBACK_DAYS);
  const rows = await db.all(
    `SELECT calories FROM meals WHERE user_id = ? AND date >= ? AND date < ?`,
    [userId, startDate, beforeDate]
  );
  const n = rows.length;
  if (n < MIN_MEALS_FOR_STATS_ANOMALY) return { hasEnoughData: false, n };
  const mean = rows.reduce((s, r) => s + (r.calories || 0), 0) / n;
  const variance = rows.reduce((s, r) => s + Math.pow((r.calories || 0) - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);
  return { hasEnoughData: true, n, mean, stddev };
}

// Sprawdza pojedynczy posiłek względem dwóch sygnałów opisanych w komentarzu
// powyżej. Zwraca tablicę (może być pusta) - posiłek może mieć 0, 1 albo oba
// sygnały naraz (to są niezależne, różne problemy).
function detectMealAnomalies(meal, baseline) {
  const anomalies = [];
  const reportedCalories = meal.calories || 0;

  const impliedCalories = (meal.protein || 0) * 4 + (meal.carbs || 0) * 4 + (meal.fat || 0) * 9;
  const macroDiff = Math.abs(impliedCalories - reportedCalories);
  if (reportedCalories > 0 && macroDiff >= MACRO_MISMATCH_MIN_KCAL_DIFF && (macroDiff / reportedCalories) >= MACRO_MISMATCH_MIN_RATIO) {
    anomalies.push({
      type: 'macro_mismatch',
      message: `Suma kalorii z makroskładników (~${Math.round(impliedCalories)} kcal) różni się od podanych ${Math.round(reportedCalories)} kcal - możliwy błąd oszacowania przez AI.`
    });
  }

  if (baseline && baseline.hasEnoughData && baseline.stddev > 0) {
    const z = (reportedCalories - baseline.mean) / baseline.stddev;
    if (Math.abs(z) >= ANOMALY_Z_SCORE_THRESHOLD) {
      anomalies.push({
        type: z > 0 ? 'unusually_high_calories' : 'unusually_low_calories',
        message: z > 0
          ? `Ten posiłek (${Math.round(reportedCalories)} kcal) jest znacznie większy niż Twój zwykły posiłek (śr. ~${Math.round(baseline.mean)} kcal).`
          : `Ten posiłek (${Math.round(reportedCalories)} kcal) jest znacznie mniejszy niż Twój zwykły posiłek (śr. ~${Math.round(baseline.mean)} kcal).`
      });
    }
  }

  return anomalies;
}

module.exports = { getCalorieBaseline, detectMealAnomalies };
