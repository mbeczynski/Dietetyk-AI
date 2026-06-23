// Wspólny helper do wywołań fetch() z limitem czasu.
//
// UWAGA: natywny fetch() w Node.js NIE ma żadnego domyślnego timeoutu - jeśli
// zewnętrzne API (Oura, Withings, Google Fit, Mailgun) "zawiesi się" i nigdy nie
// odpowie, await fetch(...) czeka w nieskończoność. Ponieważ synchronizacja
// wielu użytkowników (sync.js/scheduler.js) przetwarza ich SEKWENCYJNIE w pętli
// for...of (jeden po drugim, await w każdej iteracji), zawieszone zapytanie dla
// JEDNEGO użytkownika blokowałoby godzinową synchronizację dla WSZYSTKICH
// pozostałych użytkowników bezterminowo - kolejny harmonogram (`runHourlySyncIfDue`,
// wywoływany co 5 minut) i tak nie odpalił by się ponownie, bo `lastSyncedHourKey`
// zostaje ustawiony PRZED wykonaniem synchronizacji, ale poprzednie wywołanie
// nigdy by się nie zakończyło. Limit czasu poniżej gwarantuje, że pojedyncze
// zawieszone zapytanie nie zablokuje całego procesu - zostanie przerwane i
// potraktowane jak błąd (catch w syncOura/syncWithings/syncGoogleFit/mailgun.js).
const DEFAULT_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Przekroczono limit czasu żądania (${timeoutMs}ms): ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
