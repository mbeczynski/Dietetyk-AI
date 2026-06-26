// Domyślne wartości celów użytkownika (kalorie/BMR/woda) - używane jako fallback w
// routes/dashboard.js i routes/chat.js, gdy w tabeli settings brakuje danego klucza
// albo zapisana wartość nie jest liczbą (NaN). Wcześniej każdy plik (a często każdy
// endpoint w obrębie tego samego pliku) definiował własny fallback "na sztywno" -
// część miejsc używała 2000 kcal, inne 2500 kcal, mimo że db.js/auth.js zawsze
// SEEDUJE nowego użytkownika wartością 2500 (patrz initDb/registerUser). Efekt: jeśli
// ktoś usunął wpis target_calories z ustawień, różne karty Dashboardu i czat AI
// pokazywały różne cele kaloryczne dla tego samego użytkownika w tym samym momencie.
// Wszystkie trzy stałe poniżej są teraz JEDYNYM miejscem definiującym te domyślne
// wartości - muszą zostać zsynchronizowane z seedem w db.js/auth.js, jeśli się zmienią.
const DEFAULT_TARGET_CALORIES = 2500;
const DEFAULT_BMR = 1800;
const DEFAULT_TARGET_WATER_ML = 2500;

function getTargetCalories(settings) {
  const value = settings && settings.target_calories;
  return value === undefined || value === null || isNaN(value) || !value ? DEFAULT_TARGET_CALORIES : value;
}

function getBmr(settings) {
  const value = settings && settings.bmr;
  return value === undefined || value === null || isNaN(value) || !value ? DEFAULT_BMR : value;
}

function getTargetWaterMl(settings) {
  const value = settings && settings.target_water_ml;
  return value === undefined || value === null || isNaN(value) || !value ? DEFAULT_TARGET_WATER_ML : value;
}

module.exports = {
  DEFAULT_TARGET_CALORIES,
  DEFAULT_BMR,
  DEFAULT_TARGET_WATER_ML,
  getTargetCalories,
  getBmr,
  getTargetWaterMl
};
