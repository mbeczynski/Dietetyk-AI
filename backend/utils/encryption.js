const crypto = require('crypto');

// Szyfrowanie sekretów trzymanych w bazie SQLite (tokeny OAuth Oura/Withings/Google Fit
// w `oauth_tokens`, oraz sekrety per-użytkownik i globalne w `settings`/`app_config` -
// patrz utils/secretKeys.js dla listy kluczy uznawanych za sekretne). Wcześniej wszystkie
// te wartości leżały w bazie jawnym tekstem - ktoś z dostępem do samego pliku .db
// (np. przez kontener dietetyk-db / backup) miał od razu gotowe tokeny dostępu do
// kont Oura/Withings użytkowników i klucze API Gemini/Mailgun/Google.
//
// Klucz wyprowadzamy z APP_PASSWORD (scrypt + stały, unikalny "context" string), a nie
// z nowej, osobnej zmiennej środowiskowej (np. ENCRYPTION_KEY) - APP_PASSWORD jest już
// dziś WYMAGANY do startu backendu (patrz OAUTH_STATE_SECRET w oauthHelpers.js) i jest
// ręcznie zarządzany w .env na produkcyjnym VPS (docker-compose.yml montuje
// backend/.env do kontenera). Dodanie nowego wymaganego sekretu ryzykowałoby, że
// backend przestanie startować po najbliższym deployu, dopóki ktoś ręcznie nie
// zaktualizuje pliku na serwerze. Osobny "context" string w scrypt zapewnia separację
// kluczy - klucz szyfrowania pól jest inny niż OAUTH_STATE_SECRET, mimo wspólnego
// sekretu bazowego.
const APP_SECRET = process.env.APP_PASSWORD;
if (!APP_SECRET) {
  throw new Error(
    'Brak APP_PASSWORD w zmiennych środowiskowych - wymagany m.in. do szyfrowania sekretów w bazie danych.'
  );
}

const ENCRYPTION_KEY = crypto.scryptSync(APP_SECRET, 'dietetyk-ai:field-encryption:v1', 32);
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENC_PREFIX = 'enc:v1:';

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// Zwraca wartość bez zmian, jeśli nie ma prefiksu ENC_PREFIX - obejmuje to zarówno
// puste/brakujące wartości, jak i dane zapisane PRZED wdrożeniem tego szyfrowania
// (legacy plaintext). Dzięki temu nie potrzeba osobnego skryptu migracyjnego: stare
// wartości dalej czytają się poprawnie i zostają zaszyfrowane przy najbliższym zapisie.
function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
