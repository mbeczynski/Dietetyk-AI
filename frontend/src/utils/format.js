// Wspólne helpery formatujące, używane w wielu komponentach (Dashboard, Trends,
// ActivityTracker) - wydzielone, żeby nie duplikować tej samej logiki w 3 miejscach
// i nie ryzykować, że jedna kopia zostanie poprawiona, a inne nie.

// Formatowanie wartości w godzinach (np. 7.5) do postaci "7h 30m".
// Wejście może przyjść jako null/undefined/NaN (np. brak synchronizacji danego dnia) -
// w takim przypadku zwracamy '--' zamiast wywalać się na Math.floor(null) -> "0h NaNm".
export function formatHoursMins(hoursDecimal) {
  if (hoursDecimal === null || hoursDecimal === undefined || isNaN(hoursDecimal)) {
    return '--';
  }
  const hours = Math.floor(hoursDecimal);
  const mins = Math.round((hoursDecimal - hours) * 60);
  return `${hours}h ${mins}m`;
}
