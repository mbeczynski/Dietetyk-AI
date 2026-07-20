// Testy szyfrowania sekretów w bazie (utils/encryption.js, Runda 18 - naprawa z
// audytu: tokeny OAuth i klucze API były trzymane w SQLite jawnym tekstem).
// Czysto jednostkowe - bez bazy danych/sieci, można uruchomić: node tests/test-encryption.js

// utils/encryption.js wymaga APP_PASSWORD (fail-fast) - ładujemy .env jawnie, tak jak
// robi to config.js, żeby ten test dało się uruchomić samodzielnie, niezależnie od
// tego, czy coś wcześniejszego w łańcuchu require już załadowało dotenv.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function run() {
  console.log('\n--- TESTY: utils/encryption.js ---');
  const { encrypt, decrypt } = require('../utils/encryption');

  const secret = 'AIzaSy-fake-test-key-1234567890';
  const encrypted = encrypt(secret);

  assert(typeof encrypted === 'string' && encrypted.startsWith('enc:v1:'), 'encrypt() zwraca wartość z rozpoznawalnym prefiksem enc:v1:');
  assert(!encrypted.includes(secret), 'zaszyfrowana wartość nie zawiera oryginalnego sekretu jawnym tekstem');
  assert(decrypt(encrypted) === secret, 'decrypt(encrypt(x)) === x (round-trip)');

  // Dwa szyfrowania tej samej wartości muszą dać RÓŻNY ciphertext (losowy IV) -
  // inaczej dwa identyczne sekrety (np. ten sam klucz API u dwóch użytkowników)
  // byłyby rozpoznawalne po samym wyglądzie zaszyfrowanej wartości w bazie.
  const encryptedAgain = encrypt(secret);
  assert(encrypted !== encryptedAgain, 'to samo wejście szyfrowane dwukrotnie daje różny ciphertext (losowy IV)');
  assert(decrypt(encryptedAgain) === secret, 'drugi ciphertext też odszyfrowuje się poprawnie');

  // Legacy passthrough: wartości zapisane PRZED wdrożeniem szyfrowania (zwykły
  // plaintext, bez prefiksu) muszą dalej działać bez migracji bazy.
  assert(decrypt('plain-legacy-value') === 'plain-legacy-value', 'decrypt() zwraca niezaszyfrowany (legacy) plaintext bez zmian');

  // Puste/brakujące wartości - częsty przypadek (np. użytkownik nie skonfigurował
  // własnego klucza Gemini) - nie mogą wywalić się wyjątkiem.
  assert(encrypt('') === '', 'encrypt() na pustym stringu zwraca pusty string (no-op)');
  assert(encrypt(null) === null, 'encrypt() na null zwraca null (no-op)');
  assert(decrypt('') === '', 'decrypt() na pustym stringu zwraca pusty string (no-op)');
  assert(decrypt(null) === null, 'decrypt() na null zwraca null (no-op)');

  // Integralność: zmanipulowany ciphertext (np. bit-flip przy nieautoryzowanym
  // dostępie do pliku bazy) musi zostać wykryty (AES-GCM auth tag), nie po cichu
  // zwrócić uszkodzone/błędne dane.
  const tampered = encrypted.slice(0, -4) + (encrypted.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  let threw = false;
  try {
    decrypt(tampered);
  } catch (e) {
    threw = true;
  }
  assert(threw, 'zmanipulowany ciphertext rzuca błędem zamiast cicho zwrócić błędne dane (auth tag GCM)');

  console.log('\n🎉 TESTY SZYFROWANIA ZAKOŃCZONE SUKCESEM!\n');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY SZYFROWANIA NIEUDANE');
  process.exit(1);
}
