const express = require('express');
const router = express.Router();
const db = require('../db');

// Publiczny endpoint health-check (BEZ autoryzacji - musi być zamontowany w
// server.js PRZED `app.use('/api', requireAuth)`). Używany przez:
//  - Docker HEALTHCHECK w docker/backend.Dockerfile,
//  - docker-compose.yml (healthcheck: dietetyk-backend),
//  - krok "Weryfikacja health-checku po wdrożeniu" w .github/workflows/docker-publish.yml.
//
// Sprawdza nie tylko, że proces Node odpowiada, ale też że baza SQLite jest
// faktycznie dostępna do zapytań - dzięki temu kontener może "żyć" (proces
// działa), ale healthcheck i tak zgłosi błąd, jeśli np. plik bazy danych jest
// uszkodzony albo wolumen ./data nie został poprawnie zamontowany.
router.get('/api/healthz', async (req, res) => {
  try {
    await db.get('SELECT 1 AS ok');
    res.json({
      status: 'ok',
      db: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[HEALTHCHECK] Błąd zapytania do bazy danych:', err.message);
    res.status(503).json({ status: 'error', db: 'error', error: err.message });
  }
});

module.exports = router;
