#!/usr/bin/env node

// Jednorazowy, idempotentny skrypt migracyjny: szyfruje sekrety zapisane w bazie
// PRZED wdrożeniem utils/encryption.js (Runda 18 - naprawa z audytu). Bez tego
// skryptu istniejące tokeny OAuth (oauth_tokens) i klucze API (settings.gemini_api_key,
// settings.oura_client_secret, settings.withings_client_secret, app_config.mailgun_api_key,
// app_config.google_client_secret) zostałyby zaszyfrowane dopiero przy NASTĘPNYM zapisie
// (odświeżenie tokenu OAuth, ponowne zapisanie ustawień) - co dla rzadko odświeżanych
// wartości (np. klucz Gemini ustawiony raz i nigdy nieedytowany) mogłoby oznaczać
// tygodnie/miesiące zwłoki.
//
// Bezpieczne do wielokrotnego uruchomienia: pomija wartości, które są już zaszyfrowane
// (rozpoznawalne po prefiksie enc:v1: - patrz utils/encryption.js) lub puste.
// Nigdy nie loguje żadnej odszyfrowanej/jawnej wartości sekretu.
//
// Użycie:
//   cd backend && node scripts/encrypt-existing-secrets.js
//   (na produkcji: uruchomić WEWNĄTRZ kontenera backendu, żeby DATABASE_DIR
//   wskazywało na właściwy plik .db, np. `docker compose exec dietetyk-backend
//   node scripts/encrypt-existing-secrets.js`)

const db = require('../db');
const { encrypt } = require('../utils/encryption');
const { USER_SECRET_SETTING_KEYS, APP_SECRET_CONFIG_KEYS } = require('../utils/secretKeys');

const ENC_PREFIX = 'enc:v1:';
const isAlreadyEncrypted = (value) => typeof value === 'string' && value.startsWith(ENC_PREFIX);

async function migrateSettings() {
  let migrated = 0;
  const placeholders = USER_SECRET_SETTING_KEYS.map(() => '?').join(',');
  const rows = await db.all(`SELECT user_id, key, value FROM settings WHERE key IN (${placeholders})`, USER_SECRET_SETTING_KEYS);
  for (const row of rows) {
    if (!row.value || isAlreadyEncrypted(row.value)) continue;
    await db.run(`UPDATE settings SET value = ? WHERE user_id = ? AND key = ?`, [encrypt(row.value), row.user_id, row.key]);
    migrated++;
  }
  console.log(`[settings] Zaszyfrowano ${migrated}/${rows.length} pasujących wierszy (pominięto już zaszyfrowane/puste).`);
}

async function migrateAppConfig() {
  let migrated = 0;
  const placeholders = APP_SECRET_CONFIG_KEYS.map(() => '?').join(',');
  const rows = await db.all(`SELECT key, value FROM app_config WHERE key IN (${placeholders})`, APP_SECRET_CONFIG_KEYS);
  for (const row of rows) {
    if (!row.value || isAlreadyEncrypted(row.value)) continue;
    await db.run(`UPDATE app_config SET value = ? WHERE key = ?`, [encrypt(row.value), row.key]);
    migrated++;
  }
  console.log(`[app_config] Zaszyfrowano ${migrated}/${rows.length} pasujących wierszy (pominięto już zaszyfrowane/puste).`);
}

async function migrateOauthTokens() {
  let migrated = 0;
  const rows = await db.all(`SELECT user_id, service, access_token, refresh_token FROM oauth_tokens`);
  for (const row of rows) {
    const needsAccess = row.access_token && !isAlreadyEncrypted(row.access_token);
    const needsRefresh = row.refresh_token && !isAlreadyEncrypted(row.refresh_token);
    if (!needsAccess && !needsRefresh) continue;
    await db.run(
      `UPDATE oauth_tokens SET access_token = ?, refresh_token = ? WHERE user_id = ? AND service = ?`,
      [
        needsAccess ? encrypt(row.access_token) : row.access_token,
        needsRefresh ? encrypt(row.refresh_token) : row.refresh_token,
        row.user_id,
        row.service
      ]
    );
    migrated++;
  }
  console.log(`[oauth_tokens] Zaszyfrowano ${migrated}/${rows.length} wierszy (pominięto już zaszyfrowane/puste).`);
}

async function run() {
  await db.initDb();
  console.log('Rozpoczynam jednorazowe szyfrowanie istniejących sekretów w bazie...\n');
  await migrateSettings();
  await migrateAppConfig();
  await migrateOauthTokens();
  console.log('\n✅ Gotowe. Bezpiecznie uruchomić ponownie - już zaszyfrowane wartości zostaną pominięte.');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('❌ Migracja nie powiodła się:', err);
  process.exit(1);
});
