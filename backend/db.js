const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Konfiguracja katalogu i ścieżki do bazy danych (trwałość danych w Dockerze)
const dbDir = process.env.DATABASE_DIR || __dirname;
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'dietetyk.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Błąd połączenia z bazą SQLite:', err.message);
  } else {
    console.log(`Połączono z bazą danych SQLite pod ścieżką: ${dbPath}`);
  }
});

// Pomocnicza funkcja do asynchronicznych zapytań (run)
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

// Pomocnicza funkcja do pobierania jednego wiersza (get)
const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Pomocnicza funkcja do pobierania wielu wierszy (all)
const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Inicjalizacja tabel i migracje
const initDb = async () => {
  // 1. Tabela Użytkowników
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      sync_token TEXT UNIQUE NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      avatar_base64 TEXT,
      email TEXT,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      invitation_token TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      force_password_change INTEGER DEFAULT 0,
      force_2fa INTEGER DEFAULT 0
    )
  `);

  // Migracja: Dodanie kolumn do tabeli users (jeśli nie istnieją)
  try {
    await run(`ALTER TABLE users ADD COLUMN avatar_base64 TEXT`);
  } catch (e) {}

  try {
    await run(`ALTER TABLE users ADD COLUMN email TEXT`);
  } catch (e) {}

  try {
    await run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
  } catch (e) {}

  try {
    await run(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'`);
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN invitation_token TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN created_at TEXT");
  } catch (e) {}

  try {
    await run("UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN force_password_change INTEGER DEFAULT 0");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN force_2fa INTEGER DEFAULT 0");
  } catch (e) {}


  // 1a. Tabela globalnej konfiguracji (np. ustawienia Mailgun)
  await run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Wstawienie domyślnego konta admina.
  // Hasło NIE jest zapisane na sztywno w kodzie źródłowym. Przy pierwszym starcie
  // (gdy konto admina jeszcze nie istnieje w bazie) generujemy losowe, bezpieczne
  // hasło, wymuszamy jego zmianę przy pierwszym logowaniu (force_password_change = 1)
  // i wypisujemy je JEDNORAZOWO w logach serwera. Można je też nadpisać zmienną
  // środowiskową ADMIN_INITIAL_PASSWORD przy pierwszym uruchomieniu.
  const existingAdmin = await get(`SELECT id FROM users WHERE id = 1`);
  if (!existingAdmin) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const adminHash = await bcrypt.hash(initialPassword, 10);
    const adminSyncToken = crypto.randomBytes(16).toString('hex');

    await run(`
      INSERT INTO users (id, username, password_hash, sync_token, totp_enabled, email, role, status, force_password_change)
      VALUES (1, 'admin', ?, ?, 0, 'mbeczynski@gmail.com', 'admin', 'active', 1)
    `, [adminHash, adminSyncToken]);

    console.log('========================================================');
    console.log('[DB INIT] Utworzono konto admina. Tymczasowe hasło logowania:');
    console.log(`[DB INIT]   ${initialPassword}`);
    console.log('[DB INIT] Zostaniesz poproszony o zmianę hasła przy pierwszym logowaniu.');
    console.log('========================================================');
  }

  // Dla istniejących instalacji: zaktualizuj nazwę na admin, ustaw email oraz rolę 'admin'
  try {
    await run(`UPDATE users SET username = 'admin', email = 'mbeczynski@gmail.com', role = 'admin' WHERE id = 1`);
  } catch (e) {}

  // Usunięcie konta Paulina z domyślnych użytkowników (zgodnie z wymaganiem wdrożenia systemu zaproszeń)
  try {
    await run(`DELETE FROM users WHERE username = 'Paulina'`);
    console.log('[DB MIGRATE] Usunięto domyślnego użytkownika Paulina (będzie zaproszona przez system zaproszeń).');
  } catch (e) {}

  // 2. Tabela Posiłków (meals) z kolumną user_id
  await run(`
    CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      date TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now', 'localtime')),
      raw_text TEXT NOT NULL,
      calories INTEGER NOT NULL,
      protein REAL NOT NULL,
      carbs REAL NOT NULL,
      fat REAL NOT NULL,
      analysis_json TEXT NOT NULL,
      image_base64 TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migracja: Dodanie kolumny image_base64 do meals (jeśli nie istnieje)
  try {
    await run(`ALTER TABLE meals ADD COLUMN image_base64 TEXT`);
  } catch (e) {}

  // Migracja: Dodanie kolumny user_id do meals (jeśli nie istnieje)
  try {
    await run(`ALTER TABLE meals ADD COLUMN user_id INTEGER DEFAULT 1`);
    console.log('[DB MIGRATE] Dodano kolumnę user_id do tabeli meals.');
  } catch (e) {}

  // Przypisanie starych posiłków bez user_id do Marcina
  await run(`UPDATE meals SET user_id = 1 WHERE user_id IS NULL OR user_id = 0`);

  // Usuń nieużywaną tabelę synchronizacji Apple Health
  await run(`DROP TABLE IF EXISTS health_sync`);

  // 4. Tabela Ustawień (migracja z klucza głównego na key na composite (user_id, key))
  const settingsCols = await all(`PRAGMA table_info(settings)`);
  const hasUserIdInSettings = settingsCols.some(c => c.name === 'user_id');

  if (!hasUserIdInSettings) {
    console.log('[DB MIGRATE] Rozpoczęto migrację tabeli settings...');
    const tableExists = settingsCols.length > 0;
    if (tableExists) {
      await run(`ALTER TABLE settings RENAME TO settings_old`);
    }

    await run(`
      CREATE TABLE settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    if (tableExists) {
      await run(`
        INSERT INTO settings (user_id, key, value)
        SELECT 1, key, value FROM settings_old
      `);
      await run(`DROP TABLE settings_old`);
    }
    console.log('[DB MIGRATE] Zakończono migrację tabeli settings.');
  }

  // Wstawienie domyślnych celów użytkowników
  const defaultMarcinSettings = [
    { key: 'target_calories', value: '2500' },
    { key: 'target_protein', value: '150' },
    { key: 'target_carbs', value: '250' },
    { key: 'target_fat', value: '80' },
    { key: 'bmr', value: '1800' }
  ];
  for (const s of defaultMarcinSettings) {
    await run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (1, ?, ?)`, [s.key, s.value]);
  }

  // UWAGA: Usunięto wstawianie domyślnych ustawień na sztywno dla user_id = 2 ("Paulina").
  // Konto Paulina jest usuwane przy każdym starcie (patrz wyżej) i nowi użytkownicy
  // dołączają wyłącznie przez system zaproszeń/rejestracji (routes/auth.js), który sam
  // wstawia własne wartości domyślne dla nowo utworzonego user_id. Pozostawienie tego
  // hardkodowanego wstawienia dla user_id = 2 powodowało realny błąd: pierwszy nowy
  // użytkownik zarejestrowany w świeżej instalacji dostawał id = 2 (AUTOINCREMENT) i przez
  // "INSERT OR IGNORE" w register-public dziedziczył błędnie te martwe, nieaktualne wartości
  // (2000 kcal / 120g białka) zamiast swoich właściwych domyślnych ustawień (2500/150g).

  // 5. Tabela Sesji (Sessions) z terminem ważności
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      is_verified_2fa INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migracja: Dodanie kolumny is_verified_2fa do sessions (jeśli nie istnieje)
  try {
    await run(`ALTER TABLE sessions ADD COLUMN is_verified_2fa INTEGER DEFAULT 0`);
  } catch (e) {}

  // 6. Tabela Tokenów OAuth (Oura, Withings)
  await run(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      user_id INTEGER NOT NULL,
      service TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT,
      PRIMARY KEY(user_id, service),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 7. Tabela Codziennych Wskaźników Zdrowotnych (health_metrics)
  await run(`
    CREATE TABLE IF NOT EXISTS health_metrics (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      steps INTEGER DEFAULT 0,
      active_calories INTEGER DEFAULT 0,
      total_calories_burned INTEGER DEFAULT 0,
      sleep_score INTEGER DEFAULT NULL,
      sleep_duration REAL DEFAULT NULL,
      sleep_deep REAL DEFAULT NULL,
      sleep_rem REAL DEFAULT NULL,
      readiness_score INTEGER DEFAULT NULL,
      hrv REAL DEFAULT NULL,
      rhr REAL DEFAULT NULL,
      temperature_deviation REAL DEFAULT NULL,
      weight REAL DEFAULT NULL,
      fat_ratio REAL DEFAULT NULL,
      muscle_mass REAL DEFAULT NULL,
      last_sync TEXT DEFAULT NULL,
      ai_advice TEXT DEFAULT NULL,
      ai_advice_generated_at TEXT DEFAULT NULL,
      PRIMARY KEY(user_id, date),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN active_minutes INTEGER DEFAULT 0");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_advice TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_advice_generated_at TEXT");
  } catch (e) {}

  // 8. Tabela Pomiarów Obwodów Ciała (body_measurements)
  await run(`
    CREATE TABLE IF NOT EXISTS body_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      chest REAL DEFAULT NULL,
      waist REAL DEFAULT NULL,
      hips REAL DEFAULT NULL,
      biceps REAL DEFAULT NULL,
      thigh REAL DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date)
    )
  `);

  console.log('Baza danych SQLite została pomyślnie zmigrowana i zainicjalizowana.');
};

const cleanupOldImages = async () => {
  try {
    const result = await run(`
      UPDATE meals 
      SET image_base64 = NULL 
      WHERE image_base64 IS NOT NULL 
        AND timestamp < datetime('now', '-14 days', 'localtime')
    `);
    if (result.changes > 0) {
      console.log(`[CLEANUP] Usunięto obrazy z ${result.changes} posiłków starszych niż 14 dni.`);
      await run('VACUUM');
      console.log('[CLEANUP] Wykonano VACUUM bazy danych.');
    } else {
      console.log('[CLEANUP] Brak starych zdjęć do usunięcia.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Błąd podczas czyszczenia starych zdjęć:', err);
  }
};

module.exports = {
  initDb,
  cleanupOldImages,
  run,
  get,
  all,
  db
};
