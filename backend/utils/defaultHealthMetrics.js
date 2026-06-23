// Domyślny obiekt health_metrics - używany jako fallback w routes/dashboard.js i
// routes/chat.js, gdy w bazie nie istnieje jeszcze wiersz health_metrics dla danej
// (user, data) - np. zanim pierwsza synchronizacja Oura/Withings/Apple Health danego
// dnia zapisze realne dane. Wcześniej oba pliki definiowały ten obiekt niezależnie,
// z lekko różniącymi się polami - to jest UNIA wszystkich pól używanych w obu
// miejscach (pełniejsza wersja z dashboard.js jako baza).
function getDefaultHealthMetrics() {
  return {
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
    respiratory_rate: null,
    spo2_percentage: null,
    wrist_temperature: null,
    weight: null,
    fat_ratio: null,
    muscle_mass: null,
    active_minutes: 0,
    distance_meters: 0,
    sedentary_minutes: 0,
    low_activity_minutes: 0,
    stress_high_minutes: null,
    stress_recovery_minutes: null,
    stress_summary: null,
    water_ml: 0,
    last_sync: null,
    activity_source: null,
    ai_advice: null,
    ai_advice_generated_at: null
  };
}

module.exports = { getDefaultHealthMetrics };
