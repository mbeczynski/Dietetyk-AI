const db = require('./db');
const logger = require('./services/logger');
const { sendWeeklyAdminReport } = require('./services/adminReport');

async function runTest() {
  console.log('Rozpoczynam test modułu logów i raportu administratora...');
  
  try {
    // 1. Uruchom migrację tabel
    await db.initDb();

    // 2. Dodaj kilka testowych logów o różnych poziomach
    console.log('Dodawanie testowych logów...');
    
    await logger.info('System wystartował pomyślnie.', 'SYSTEM');
    await logger.warn('Dostęp do integracji Withings bliski wygaśnięcia.', 'INTEGRATIONS', null, '127.0.0.1', 1);
    
    // Dodanie błędów (ERROR)
    await logger.error(
      'Błąd odpytywania Gemini API - 404 Model Not Found', 
      'GEMINI_AI', 
      new Error('models/gemini-1.5-flash is not found or is not supported for generateContent.'),
      '192.168.1.50',
      1
    );
    await logger.error(
      'Niepoprawny token autoryzacji sesji', 
      'HTTP_SERVER', 
      'Error: jwt expired at Object.verify...',
      '185.201.112.5',
      1
    );
    
    // Dodanie powtarzającego się błędu w celu weryfikacji grupowania (Top 10)
    for (let i = 0; i < 3; i++) {
      await logger.error(
        'Błąd połączenia z bazą SQLite (SQLITE_BUSY)',
        'DATABASE',
        'Error: database is locked',
        '127.0.0.1'
      );
    }

    // Dodanie zdarzeń bezpieczeństwa (SECURITY)
    await logger.security(
      'Nieudana próba logowania na konto: admin (użytkownik nie istnieje)',
      'AUTH_LOGIN_FAILURE',
      { username: 'admin' },
      '80.50.23.14'
    );
    await logger.security(
      'Blokada brute-force (lockout) dla: admin',
      'AUTH_LOCKOUT',
      { key: '80.50.23.14::admin', count: 5 },
      '80.50.23.14'
    );
    await logger.security(
      'Przekroczono limit żądań API (121/120)',
      'RATE_LIMIT',
      { path: '/api/meals', method: 'POST' },
      '45.67.234.12'
    );

    console.log('Logi zostały dodane do bazy danych.');

    // Wyświetl dodane logi z bazy
    const logs = await db.all('SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT 5');
    console.log('\nOstatnie 5 logów w bazie:', logs);

    // 3. Uruchom generowanie i wysyłkę raportu
    console.log('\nGenerowanie i wysyłanie raportu e-mail...');
    await sendWeeklyAdminReport();

    console.log('\nTest zakończony sukcesem!');
  } catch (err) {
    console.error('Błąd podczas uruchamiania testu:', err);
  }
}

runTest();
