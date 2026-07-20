// Testy logiki czatu Dietetyka AI (utils/chatHistory.js, używane przez routes/chat.js).
// Czysto jednostkowe - bez bazy danych/sieci/Gemini, można uruchomić: node tests/test-chat.js

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function testMessageNeedsLongHistory() {
  console.log('\n--- TEST: messageNeedsLongHistory ---');
  const { messageNeedsLongHistory } = require('../utils/chatHistory');

  assert(messageNeedsLongHistory('Co jadłem w tym miesiącu?') === true, 'wykrywa słowo kluczowe "miesiącu"');
  assert(messageNeedsLongHistory('Pokaż mój trend wagi') === true, 'wykrywa słowo kluczowe "trend"');
  assert(messageNeedsLongHistory('Porównaj marzec i kwiecień') === true, 'wykrywa słowo kluczowe "porównaj"');
  assert(messageNeedsLongHistory('Jak wyglądała moja dieta w marcu?') === true, 'wykrywa nazwę miesiąca w odmianie ("marcu")');
  assert(messageNeedsLongHistory('Co dziś jadłem?') === false, 'krótkie, bieżące pytanie NIE rozszerza okna historii');
  assert(messageNeedsLongHistory('Ile kalorii mam dzisiaj do końca dnia?') === false, 'pytanie o dziś nie zawiera słów kluczowych długiego okresu');
  assert(messageNeedsLongHistory('CO JADŁEM W TYM TYGODNIU') === true, 'wykrywanie jest niewrażliwe na wielkość liter (toLowerCase)');
}

function testBuildWeeklyTrendSummaryIncludesWorkouts() {
  console.log('\n--- TEST: buildWeeklyTrendSummary (agregacja treningów) ---');
  const { buildWeeklyTrendSummary } = require('../utils/chatHistory');

  // Jeden trening (Running, 40 min) w oknie 7-dniowym - żadnych posiłków/metryk,
  // żeby sprawdzić, że SAM trening wystarczy, by okno nie zostało pominięte
  // (przed naprawą "brak workoutCount" w warunku pomijania okno by zniknęło z promptu).
  const historyWorkouts = [
    { date: '2026-07-16', workout_type: 'Running', duration_minutes: 40, active_calories: 400, avg_heart_rate: 150, max_heart_rate: 170 }
  ];
  const summary = buildWeeklyTrendSummary([], [], historyWorkouts, '2026-07-13', '2026-07-20');

  assert(summary.includes('treningi: 1'), 'podsumowanie zawiera liczbę treningów w oknie');
  assert(summary.includes('40 min'), 'podsumowanie zawiera łączny czas treningu');
  assert(summary.includes('Running'), 'podsumowanie zawiera typ treningu');

  // Okno bez ŻADNYCH danych (posiłki/metryki/treningi) musi zostać pominięte -
  // to istniejące zachowanie sprzed dodania treningów, nie może się zepsuć.
  const emptySummary = buildWeeklyTrendSummary([], [], [], '2026-07-13', '2026-07-20');
  assert(emptySummary === '', 'okno bez żadnych danych (w tym bez treningów) jest pomijane, nie generuje pustej linii');
}

function testBuildWeeklyTrendSummaryAggregatesMealsAndMetrics() {
  console.log('\n--- TEST: buildWeeklyTrendSummary (posiłki + metryki, bez regresji) ---');
  const { buildWeeklyTrendSummary } = require('../utils/chatHistory');

  const historyMetrics = [
    { date: '2026-07-14', weight: 80, steps: 10000, sleep_score: 85 },
    { date: '2026-07-15', weight: 79.5, steps: 8000, sleep_score: 90 }
  ];
  const historyMeals = [
    { date: '2026-07-14', calories: 2000, protein: 150, carbs: 200, fat: 60 },
    { date: '2026-07-15', calories: 2200, protein: 160, carbs: 220, fat: 65 }
  ];
  const summary = buildWeeklyTrendSummary(historyMetrics, historyMeals, [], '2026-07-13', '2026-07-20');

  assert(summary.includes('zalogowano 2/7 dni'), 'liczy poprawnie dni z zalogowanymi posiłkami w 7-dniowym oknie');
  assert(summary.includes('waga śr.'), 'zawiera średnią wagę, gdy dane wagi są dostępne');
  assert(/śr\. spożycie 2100 kcal/.test(summary), 'poprawnie liczy średnie kalorie dzienne z dostępnych dni ((2000+2200)/2=2100)');
}

function testMaxChatMessageLength() {
  console.log('\n--- TEST: MAX_CHAT_MESSAGE_LENGTH ---');
  const { MAX_CHAT_MESSAGE_LENGTH } = require('../utils/chatHistory');
  assert(MAX_CHAT_MESSAGE_LENGTH === 2000, 'limit długości wiadomości czatu ma oczekiwaną wartość (regresja na literówkę/przypadkową zmianę)');
}

try {
  testMessageNeedsLongHistory();
  testBuildWeeklyTrendSummaryIncludesWorkouts();
  testBuildWeeklyTrendSummaryAggregatesMealsAndMetrics();
  testMaxChatMessageLength();
  console.log('\n🎉 TESTY CZATU ZAKOŃCZONE SUKCESEM!\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY CZATU NIEUDANE');
  process.exit(1);
}
