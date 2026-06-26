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

// WAL (Write-Ahead Logging) pozwala na równoczesne odczyty podczas zapisu
// (domyślny journal_mode SQLite blokuje cały plik na czas zapisu), a busy_timeout
// sprawia, że krótkie kolizje zapisów (np. godzinowa synchronizacja Oura/Withings/
// Google Fit nakładająca się na zapis użytkownika) czekają chwilę i się ponawiają,
// zamiast od razu zwracać błąd "SQLITE_BUSY: database is locked".
db.run('PRAGMA journal_mode = WAL;', (err) => {
  if (err) console.error('Błąd ustawiania PRAGMA journal_mode=WAL:', err.message);
});
db.run('PRAGMA busy_timeout = 5000;', (err) => {
  if (err) console.error('Błąd ustawiania PRAGMA busy_timeout:', err.message);
});
// SQLite domyślnie NIE wymusza kluczy obcych ani "ON DELETE CASCADE" zadeklarowanych
// w schemacie (CREATE TABLE) - trzeba to włączyć per-połączenie. Bez tego usunięcie
// użytkownika (np. nowa funkcja usuwania konta, patrz routes/account.js) zostawiałoby
// osierocone wiersze w sessions/oauth_tokens/meals/health_metrics/settings/
// body_measurements zamiast je kaskadowo usuwać.
db.run('PRAGMA foreign_keys = ON;', (err) => {
  if (err) console.error('Błąd ustawiania PRAGMA foreign_keys=ON:', err.message);
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
      force_2fa INTEGER DEFAULT 0,
      first_name TEXT,
      last_name TEXT
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

  // Migracja: logowanie przez Google (krok w stronę docelowego usunięcia logowania hasłem)
  try {
    await run("ALTER TABLE users ADD COLUMN google_id TEXT");
  } catch (e) {}

  // Migracja: imię i nazwisko - używane do personalizacji zwrotów AI dietetyka
  // ("Cześć Marcin, ..." zamiast bezosobowego tonu) oraz do wyświetlenia w profilu.
  // Oddzielone od `username` (login techniczny, niezmienny) - użytkownik może mieć
  // login typu "mbeczynski", a imię, którym chce być nazywany, to np. "Marcin".
  try {
    await run("ALTER TABLE users ADD COLUMN first_name TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN last_name TEXT");
  } catch (e) {}

  // Migracja: rok urodzenia - pole opcjonalne, używane wyłącznie do realnego
  // wyliczenia maksymalnego tętna (wzór 220 - wiek) na potrzeby stref kardio
  // na Dashboardzie, zamiast zahardkodowanej stałej HRmax=190 (patrz routes/dashboard.js).
  try {
    await run("ALTER TABLE users ADD COLUMN birth_year INTEGER");
  } catch (e) {}

  // Migracja: "Cel sylwetki" - opcjonalny opis tekstowy oraz zdjęcie referencyjne
  // (np. zdjęcie sylwetki, do której użytkownik chce dążyć). Trzymane bezpośrednio
  // na users (tak jak avatar_base64), a nie w tabeli settings (key-value), bo to
  // dane podobne do profilu, nie liczbowy cel/przełącznik. Wykorzystywane przez
  // dashboard.js (porada AI) i chat.js (czat z dietetykiem AI), żeby algorytm
  // realnie brał pod uwagę zarówno opis celu, jak i samo zdjęcie (analiza wizualna).
  try {
    await run("ALTER TABLE users ADD COLUMN body_goal_text TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN body_goal_photo_base64 TEXT");
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

    const forcePasswordChange = (process.env.CI === 'true' || process.env.ADMIN_INITIAL_PASSWORD) ? 0 : 1;
    await run(`
      INSERT INTO users (id, username, password_hash, sync_token, totp_enabled, email, role, status, force_password_change)
      VALUES (1, 'admin', ?, ?, 0, 'mbeczynski@gmail.com', 'admin', 'active', ?)
    `, [adminHash, adminSyncToken, forcePasswordChange]);

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

  // Migracja: mikroskładniki posiłków (błonnik, cukry, sód) - rozszerzony prompt AI
  // (routes/meals.js) zwraca te pola dodatkowo do kalorii/makro. Mogą być NULL dla
  // starszych posiłków przeanalizowanych przed tą zmianą.
  try {
    await run(`ALTER TABLE meals ADD COLUMN fiber REAL DEFAULT NULL`);
  } catch (e) {}
  try {
    await run(`ALTER TABLE meals ADD COLUMN sugar REAL DEFAULT NULL`);
  } catch (e) {}
  try {
    await run(`ALTER TABLE meals ADD COLUMN sodium REAL DEFAULT NULL`);
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

  // 5b. Tabela blokady brute-force logowania (login_attempts) - przeniesiona
  // z pamięci procesu (Map) do bazy, żeby blokady przetrwały restart kontenera
  // backendu (np. przy wgrywaniu nowej wersji) - patrz services/loginAttempts.js.
  await run(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    )
  `);

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
      supplements TEXT DEFAULT NULL,
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

  // Migracja: licznik wypitej wody (dzienny licznik, podobnie jak steps - zeruje się każdego dnia)
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN water_ml INTEGER DEFAULT 0");
  } catch (e) {}

  // Migracja: źródło danych aktywności (steps/active_calories/total_calories_burned/active_minutes)
  // dla danej daty - 'oura' albo 'apple'. Potrzebne do reguły z synchronizacji Apple Health
  // (webhook Health Auto Export, routes/appleHealth.js): Apple Health dociera szybciej, ale
  // Oura jest traktowana jako bardziej autorytatywna - gdy Oura faktycznie zwróci dane
  // aktywności dla danej daty, NADPISUJE wartości wcześniej zapisane z Apple Health. Webhook
  // Apple Health z kolei NIGDY nie nadpisuje wiersza, który już ma activity_source = 'oura'.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN activity_source TEXT DEFAULT NULL");
  } catch (e) {}

  // Migracja: częstość oddechów ze snu (Oura, pole average_breath z endpointu
  // /v2/usercollection/sleep, który już i tak wywołujemy w sync.js - wcześniej to
  // pole było ignorowane). Karta "Częstość oddechów" na Dashboardzie wcześniej
  // pokazywała zaszytą na sztywno wartość "13,8" - teraz pokazuje to realne pole.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN respiratory_rate REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: dobowe SpO2 z Oury (endpoint /v2/usercollection/daily_spo2, NOWE
  // zapytanie w sync.js - dostępne tylko dla pierścionków Gen 3, dla starszych
  // modeli pole zostanie NULL). Karta "Poziom tlenu we krwi" wcześniej pokazywała
  // zaszytą na sztywno wartość "98,4".
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN spo2_percentage REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: absolutna temperatura nadgarstka z Apple Watch (Health Auto Export,
  // metryka "Wrist Temperature" -> name: "wrist_temperature", patrz
  // routes/appleHealth.js). UWAGA: to jest inna wartość niż Oura
  // `temperature_deviation` (odchylenie od bazowej, nie wartość absolutna) -
  // dostępna tylko z Apple Watch Series 8+/Ultra i tylko jeśli użytkownik włączy tę
  // metrykę w automatyzacji Health Auto Export na telefonie. Karta "Temperatura
  // nadgarstka" wcześniej pokazywała zaszytą na sztywno wartość "35,4".
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN wrist_temperature REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: dystans (metry) - z Oury (equivalent_walking_distance), Google Fit
  // (distance.delta) albo Apple Health (walking_running_distance, webhook). Brane
  // z tego samego źródła co reszta aktywności (priorytet Apple > Oura/Google Fit,
  // patrz activity_source).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN distance_meters REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: rozbicie dnia na minuty wg intensywności aktywności (Oura
  // daily_activity: high/medium/low_activity_time, sedentary_time - w sekundach,
  // zapisujemy po konwersji na minuty). Pozwala pokazać, jak wyglądał dzień, a nie
  // tylko sumę "aktywnych minut". medium+high są już liczone razem jako
  // active_minutes (patrz sync.js) - tu dodajemy tylko brakujące kategorie.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN sedentary_minutes INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN low_activity_minutes INTEGER DEFAULT NULL");
  } catch (e) {}

  // Migracja: realny poziom stresu z Oury (endpoint /v2/usercollection/daily_stress,
  // dostępny tylko dla pierścionków z tą funkcją - inaczej pola zostają NULL).
  // To NIE jest powrót starej, zaszywanej na sztywno sekcji stresu (patrz komentarz
  // przy jej usunięciu w Dashboard.jsx) - to realne dane z API Oury.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN stress_high_minutes REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN stress_recovery_minutes REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN stress_summary TEXT DEFAULT NULL");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN supplements TEXT DEFAULT NULL");
  } catch (e) {}

  // Migracja: ciśnienie tętnicze z Withings (endpoint getmeas, meastype 9 = rozkurczowe
  // (diastolic, mmHg), meastype 10 = skurczowe (systolic, mmHg) - mierzone tym samym
  // ciśnieniomierzem Withings co waga/skład ciała, patrz services/sync.js syncWithings()).
  // Osobne kolumny (nie jedno pole tekstowe), żeby dało się je użyć w trendach/wykresach
  // tak samo jak weight/fat_ratio/muscle_mass.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN blood_pressure_systolic REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN blood_pressure_diastolic REAL DEFAULT NULL");
  } catch (e) {}

  // Domyślny cel wody (ml) dla istniejącego konta admina/Marcina, jeśli jeszcze nie ustawiony
  await run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (1, 'target_water_ml', '2500')`);

  // 7a. Tabela pojedynczych Treningów z Apple Health (Health Auto Export, "Typ danych:
  // Treningi" - patrz routes/appleHealth.js). Trzymamy tu KAŻDY trening osobno (klucz:
  // user_id + workout_id z payloadu) zamiast od razu sumować do health_metrics, żeby:
  //   1) ponowne wysłanie tego samego treningu przez automatyzację (np. retry, albo
  //      zasięg dat automatyzacji obejmujący ten sam trening więcej niż raz) tylko
  //      NADPISYWAŁO jego własny wiersz (ON CONFLICT DO UPDATE), a nie dodawało
  //      kalorie/minuty po raz drugi do dobowej sumy (podwójne liczenie),
  //   2) wiele różnych treningów tego samego dnia, dostarczonych w OSOBNYCH wywołaniach
  //      webhooka (np. automatyzacja odpala się po zakończeniu każdego treningu), mogło
  //      się prawidłowo zsumować - dobowa suma w health_metrics jest każdorazowo
  //      przeliczana na nowo jako SUM(...) po wszystkich treningach danego dnia z tej
  //      tabeli, a nie inkrementowana "na ślepo".
  await run(`
    CREATE TABLE IF NOT EXISTS apple_health_workouts (
      user_id INTEGER NOT NULL,
      workout_id TEXT NOT NULL,
      date TEXT NOT NULL,
      active_calories REAL DEFAULT 0,
      duration_minutes REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY(user_id, workout_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migracja: typ treningu (np. "Running", "Functional Strength Training" - pole
  // `name` z payloadu Health Auto Export, patrz routes/appleHealth.js). Dodane po
  // tym, jak audyt funkcjonalny wykazał, że /api/dashboard zawsze zwracał pustą
  // listę `workouts: []` na sztywno, mimo że ta tabela faktycznie zbiera treningi -
  // bez typu treningu sekcja "Ostatnia aktywność" na Dashboardzie nie mogłaby
  // pokazać sensownej ikony/etykiety (getWorkoutIcon/typ w Dashboard.jsx).
  try {
    await run("ALTER TABLE apple_health_workouts ADD COLUMN workout_type TEXT DEFAULT NULL");
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
      biceps_left REAL DEFAULT NULL,
      biceps_right REAL DEFAULT NULL,
      shoulders REAL DEFAULT NULL,
      waist_above REAL DEFAULT NULL,
      waist_below REAL DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date)
    )
  `);

  // Pomocnicze ALTER TABLE dla rozszerzonych obwodów ciała
  try { await run("ALTER TABLE body_measurements ADD COLUMN biceps_left REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN biceps_right REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN shoulders REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN waist_above REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN waist_below REAL DEFAULT NULL"); } catch (e) {}

  // 9. Tabela Logów Aplikacji (app_logs)
  await run(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime')),
      level TEXT NOT NULL,      -- INFO, WARN, ERROR, SECURITY
      category TEXT NOT NULL,   -- AUTH, API, SYSTEM, etc.
      message TEXT NOT NULL,
      ip TEXT,
      user_id INTEGER,
      details TEXT,             -- JSON string lub stack trace
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON app_logs(timestamp)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON app_logs(level)`);

  // 10. Tabela linków do udostępniania raportu PDF (Produkt: udostępnianie raportu
  // linkiem, read-only) - token zamiast sesji/ciasteczka, bo link ma działać dla
  // lekarza/dietetyki bez konta w aplikacji. `revoked` jako osobna flaga (nie samo
  // DELETE wiersza), żeby właściciel widział historię udostępnień w Ustawieniach,
  // a nie tylko aktualnie aktywne linki. `expires_at` wymagane (NOT NULL) - link bez
  // terminu ważności byłby trwałym, niewygasającym dostępem do danych zdrowotnych.
  await run(`
    CREATE TABLE IF NOT EXISTS shared_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      days INTEGER NOT NULL DEFAULT 30,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      expires_at TEXT NOT NULL,
      revoked INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_shared_reports_user ON shared_reports(user_id)`);

  // Indeksy pod zapytania zakresowe "WHERE user_id = ? AND date >= ?" (agregacje
  // 7/30/90-dniowe w dashboard.js/summaries.js/chat.js). health_metrics i
  // body_measurements mają już taki indeks "za darmo" (PRIMARY KEY(user_id, date)
  // dla health_metrics, UNIQUE(user_id, date) dla body_measurements tworzy
  // niejawny indeks) - brakowało go dla meals i apple_health_workouts, gdzie
  // (user_id, date) nie jest częścią klucza głównego/unikalności.
  await run(`CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON apple_health_workouts(user_id, date)`);

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

const cleanupOldLogs = async () => {
  try {
    const result = await run(`
      DELETE FROM app_logs 
      WHERE timestamp < datetime('now', '-30 days', 'localtime')
    `);
    if (result.changes > 0) {
      console.log(`[CLEANUP] Usunięto ${result.changes} wpisów logów starszych niż 30 dni.`);
    } else {
      console.log('[CLEANUP] Brak starych logów do usunięcia.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Błąd podczas czyszczenia starych logów:', err);
  }
};

// Automatyczne kopie zapasowe bazy SQLite (rotacja - domyślnie ostatnie 14 dni).
// Plik bazy żyje w wolumenie Dockera (./data), który nie jest sam w sobie
// kopią zapasową - awaria dysku/przypadkowe `rm -rf`/błąd migracji nadpisałby
// jedyną kopię danych. Kopie trzymane są w podkatalogu backups/ tego samego
// wolumenu - do realnej ochrony przed awarią hosta trzeba je jeszcze zgrywać
// poza serwer (patrz README, sekcja "Kopie zapasowe").
const backupDir = path.join(dbDir, 'backups');
const BACKUP_RETENTION_COUNT = 14;

const backupDatabase = async () => {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Wymuszenie zapisu zawartości WAL do głównego pliku bazy przed kopiowaniem -
    // inaczej kopia samego pliku .db (bez pliku -wal) mogłaby nie zawierać
    // najnowszych, jeszcze nie scalonych zapisów.
    await run('PRAGMA wal_checkpoint(FULL);');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `dietetyk-${timestamp}.db`);
    await fs.promises.copyFile(dbPath, backupPath);
    console.log(`[BACKUP] Zapisano kopię zapasową bazy danych: ${backupPath}`);

    // Rotacja - usuń najstarsze kopie powyżej limitu
    const files = (await fs.promises.readdir(backupDir))
      .filter(f => f.startsWith('dietetyk-') && f.endsWith('.db'))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - BACKUP_RETENTION_COUNT));
    for (const f of toDelete) {
      await fs.promises.unlink(path.join(backupDir, f));
      console.log(`[BACKUP] Usunięto starą kopię zapasową: ${f}`);
    }
  } catch (err) {
    console.error('[BACKUP ERROR] Błąd podczas tworzenia kopii zapasowej bazy danych:', err);
  }
};

module.exports = {
  initDb,
  cleanupOldImages,
  cleanupOldLogs,
  backupDatabase,
  run,
  get,
  all,
  db
};
