const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
const db = require('../db');

async function testWithingsConnection() {
  console.log('\n--- TEST ZINTEGROWANIA WITHINGS ---');
  await db.initDb();

  // 1. Sprawdzanie zmiennych w .env
  const envClientId = process.env.WITHINGS_CLIENT_ID;
  const envClientSecret = process.env.WITHINGS_CLIENT_SECRET;

  // 2. Sprawdzanie w bazie danych
  const adminRow = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  let dbClientId = null;
  let dbClientSecret = null;
  if (adminRow) {
    const rows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [adminRow.id]);
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    dbClientId = settings.withings_client_id;
    dbClientSecret = settings.withings_client_secret;
  }

  const clientId = envClientId || dbClientId;
  const clientSecret = envClientSecret || dbClientSecret;

  console.log(`Zmienne środowiskowe (.env): Client ID: ${envClientId ? 'obecny' : 'brak'}, Client Secret: ${envClientSecret ? 'obecny' : 'brak'}`);
  console.log(`Baza danych (ustawienia admin): Client ID: ${dbClientId ? 'obecny' : 'brak'}, Client Secret: ${dbClientSecret ? 'obecny' : 'brak'}`);

  if (!clientId || !clientSecret) {
    console.error('❌ Błąd: Brak Client ID lub Client Secret dla Withings w .env lub bazie danych.');
    console.log('\nAby to naprawić, dodaj do pliku backend/.env następujące linie:');
    console.log('WITHINGS_CLIENT_ID=twoj_client_id_withings');
    console.log('WITHINGS_CLIENT_SECRET=twoj_client_secret_withings');
    process.exit(1);
  }

  console.log(`Używane Client ID: ${clientId}`);
  console.log('Wysyłam próbne zapytanie do Withings API w celu weryfikacji sieci...');

  try {
    const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'requesttoken',
        grant_type: 'authorization_code',
        code: 'mock_code_test_123',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'https://dietetyk.renacode.com/api/auth/withings/callback'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd połączenia HTTP z Withings API: ${response.status} - ${errText}`);
    }

    const resJson = await response.json();
    console.log('Otrzymano odpowiedź z Withings API:', resJson);

    // Błędy autoryzacji oznaczają poprawne nawiązanie połączenia (kod / client_secret są wysyłane, DNS działa)
    if (resJson.status === 293 || resJson.status === 100 || resJson.status === 200 || resJson.status === 503) {
      console.log('\n✅ Połączenie z Withings API powiodło się! (Otrzymano odpowiedź o statusie sieciowym/autoryzacji).');
      console.log('Integracja Withings jest poprawnie skonfigurowana od strony sieciowej.');
      process.exit(0);
    } else {
      console.warn('\n⚠️ Otrzymano nietypową odpowiedź z Withings API. Sprawdź poprawność kluczy.');
      process.exit(0);
    }
  } catch (err) {
    console.error('\n❌ Błąd połączenia z Withings API:', err.message);
    process.exit(1);
  }
}

testWithingsConnection();
