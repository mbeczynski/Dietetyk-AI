// Runda 12 (audyt): listy kluczy "sekretnych" (maskowanych jako '********' przy odczycie
// i nigdy nie nadpisywanych, gdy frontend odeśle z powrotem samą maskę) były niezależnie
// duplikowane wewnątrz dwóch plików - routes/account.js (3 miejsca: GET/POST /api/settings
// oraz GET /api/user/export) i routes/admin.js (2 miejsca: GET/POST /api/admin/config).
// Realne ryzyko duplikacji: ktoś dodaje nowy sekret (np. nowy klucz integracji) i
// aktualizuje tylko jedno z kilku miejsc w danym pliku - efekt to sekret wyciekający
// w plaintext z jednego z endpointów, mimo że pozostałe go maskują.
//
// Dwie OSOBNE listy (nie jedna wspólna), bo dotyczą dwóch różnych domen ustawień:
// - USER_SECRET_SETTING_KEYS: sekrety integracji PER UŻYTKOWNIK, w tabeli `settings`
//   (każdy użytkownik konfiguruje własne klucze Oura/Withings/Gemini).
// - APP_SECRET_CONFIG_KEYS: sekrety konfiguracji GLOBALNEJ aplikacji, w tabeli
//   `app_config` (Mailgun/Google OAuth konfigurowane raz przez admina dla całej appki).

const USER_SECRET_SETTING_KEYS = ['gemini_api_key', 'oura_client_secret', 'withings_client_secret'];
const APP_SECRET_CONFIG_KEYS = ['mailgun_api_key', 'google_client_secret'];

// Zwraca zamaskowaną wartość ('********'), jeśli `key` jest sekretem z podanej listy
// i ma niepustą wartość - w przeciwnym razie zwraca wartość bez zmian.
function maskSecretValue(key, value, secretKeys) {
  if (secretKeys.includes(key) && value) {
    return '********';
  }
  return value;
}

// Sprawdza, czy dany zapis powinien zostać POMINIĘTY przy zapisie (POST) - tj. czy
// to sekret, dla którego frontend odesłał z powrotem samą maskę (a nie nową wartość).
function isMaskedSecretWrite(key, value, secretKeys) {
  return secretKeys.includes(key) && value === '********';
}

module.exports = {
  USER_SECRET_SETTING_KEYS,
  APP_SECRET_CONFIG_KEYS,
  maskSecretValue,
  isMaskedSecretWrite
};
