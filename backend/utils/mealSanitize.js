// Sanityzacja odpowiedzi AI (Gemini) i walidacja zdjęcia posiłku (routes/meals.js) -
// wydzielone do osobnego modułu (analogicznie do utils/mealAnomaly.js), żeby dało się
// je testować jednostkowo bez uruchamiania całego serwera Express/bazy danych.

// Model AI (Gemini) czasem zwraca nierealistyczne lub ujemne wartości kalorii/makro
// (np. błąd parsowania wielkości porcji, halucynacja liczby) - bez tego zabezpieczenia
// taka wartość trafiałaby bezpośrednio do bazy i psuła agregacje (sumy dzienne, bilans
// kaloryczny, streaki) na dashboardzie/podsumowaniach. Odcinamy do sensownego zakresu,
// a gdy wartości nie da się sparsować jako liczby, używamy fallbacku (domyślnie 0).
function sanitizeNumber(val, min, max, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

// Wariant dla pól, które mogą być prawdziwie nieznane (błonnik/cukry/sód - AI nie zawsze
// jest w stanie je oszacować) - w przeciwieństwie do sanitizeNumber NIE fabrykujemy zera,
// jeśli AI nie podało wartości, ale gdy wartość JEST podana, wciąż odcinamy ją do sensownego
// zakresu. Bez tego ujemna/nierealistyczna/nie-numeryczna wartość z odpowiedzi Gemini
// trafiałaby bezpośrednio do bazy (w przeciwieństwie do calories/protein/carbs/fat, które
// już były sanityzowane) i psuła agregacje w summaries.js/dashboard.js (sumy/średnie błonnika,
// cukrów, sodu używane teraz w pełnym podsumowaniu AI).
function sanitizeNullableNumber(val, min, max) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.min(Math.max(num, min), max);
}

// Whitelist dozwolonych typów MIME dla zdjęcia posiłku (B-S5) - bez tego dowolny
// content-type zakodowany w data URL trafiałby jako inlineData wprost do Gemini.
const ALLOWED_MEAL_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Limit rozmiaru pojedynczego zdjęcia posiłku zapisywanego w bazie SQLite jako base64.
// Bez tego limitu jedyną granicą był globalny express.json({limit:'20mb'}) w server.js
// (myślany pod webhooki, nie pod pojedyncze zdjęcia) - użytkownik mógłby dodawać zdjęcia
// w oryginalnej rozdzielczości telefonu (10-20MB), co przy kilku posiłkach dziennie
// szybko rozdęłoby plik bazy SQLite (jeden plik, brak osobnego storage na obrazy).
// 7MB base64 odpowiada ok. 5.25MB danych binarnych po dekodowaniu - wystarczające dla
// zdjęcia jedzenia w rozsądnej jakości, a wciąż chroni przed ekstremalnie dużymi plikami.
const MAX_MEAL_IMAGE_BASE64_CHARS = 7 * 1024 * 1024;

module.exports = {
  sanitizeNumber,
  sanitizeNullableNumber,
  ALLOWED_MEAL_IMAGE_MIME_TYPES,
  MAX_MEAL_IMAGE_BASE64_CHARS
};
