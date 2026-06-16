const db = require('./db');

async function runTest() {
  console.log('\n--- TEST BAZY DANYCH: POMIARY OBWODÓW CIAŁA ---');
  try {
    await db.initDb();

    // Wybierz testową datę
    const testDate = '2026-06-16';
    const testUserId = 1; // admin

    console.log(`Wstawianie testowego pomiaru dla użytkownika ${testUserId} na datę ${testDate}...`);

    // 1. Wstawienie/Aktualizacja pomiaru
    await db.run(`
      INSERT INTO body_measurements (user_id, date, chest, waist, hips, biceps, thigh)
      VALUES (?, ?, 105.5, 88.0, 96.5, 38.5, 58.0)
      ON CONFLICT(user_id, date) DO UPDATE SET
        chest = excluded.chest,
        waist = excluded.waist,
        hips = excluded.hips,
        biceps = excluded.biceps,
        thigh = excluded.thigh
    `, [testUserId, testDate]);

    console.log('✅ Wstawienie/Aktualizacja powiodła się.');

    // 2. Pobranie pomiaru
    const row = await db.get(`
      SELECT * FROM body_measurements 
      WHERE user_id = ? AND date = ?
    `, [testUserId, testDate]);

    console.log('Pobrane dane z bazy:', row);

    if (row && row.chest === 105.5 && row.waist === 88.0 && row.hips === 96.5 && row.biceps === 38.5 && row.thigh === 58.0) {
      console.log('✅ Weryfikacja danych powiodła się.');
    } else {
      throw new Error('Pobrane dane nie zgadzają się z zapisanymi!');
    }

    // 3. Posprzątanie (usunięcie)
    console.log('Usuwanie testowego wpisu...');
    await db.run(`
      DELETE FROM body_measurements 
      WHERE user_id = ? AND date = ?
    `, [testUserId, testDate]);

    const rowAfterDelete = await db.get(`
      SELECT 1 FROM body_measurements 
      WHERE user_id = ? AND date = ?
    `, [testUserId, testDate]);

    if (!rowAfterDelete) {
      console.log('✅ Usunięcie wpisu i czyszczenie powiodło się.');
    } else {
      throw new Error('Wpis nie został usunięty z bazy danych!');
    }

    console.log('\n=====================================');
    console.log('🎉 TESTY POMIARÓW CIAŁA ZAKOŃCZONE SUKCESEM!');
    console.log('=====================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TESTY POMIARÓW CIAŁA NIEUDANE:', err.message);
    process.exit(1);
  }
}

runTest();
