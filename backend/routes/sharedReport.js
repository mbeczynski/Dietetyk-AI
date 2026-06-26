const express = require('express');
const router = express.Router();
const { getActiveShareByToken } = require('../services/sharedReports');
const { buildHealthReportPdf } = require('../services/pdfReport');

// Publiczny, NIEUWIERZYTELNIONY endpoint do odbierania udostępnionego raportu PDF
// (Produkt: udostępnianie raportu linkiem, read-only) - odbiorca linku (lekarz/
// dietetyk) nie ma konta w aplikacji, więc autoryzacja sesją/Bearer tokenem tu nie
// działa. Zamiast tego token w samym adresie URL (patrz services/sharedReports.js)
// jednoznacznie identyfikuje i użytkownika, i konkretne udostępnienie.
//
// Dlatego ten router MUSI być zamontowany w server.js PRZED `app.use('/api', requireAuth)` -
// tak samo jak routes/healthcheck.js i routes/appleHealth.js. Ścieżka zaczyna się od
// `/api/public/` (a nie `/api/user/...` jak resztą tras account.js), żeby z samego
// adresu URL było widać, że to świadomie publiczny endpoint, a nie przeoczony brak
// autoryzacji.
//
// Limiter zapytań (apiRateLimiter w server.js) jest zamontowany na '/api' PRZED tym
// routerem, więc nadal obejmuje tę trasę - ważne, bo token jest jedyną barierą
// dostępu, a limiter utrudnia jego zgadywanie/bruteforce.
router.get('/api/public/shared-reports/:token', async (req, res) => {
  try {
    const share = await getActiveShareByToken(req.params.token);
    // Identyczna odpowiedź 404 dla "nie istnieje", "odwołany" i "wygasł" - patrz
    // komentarz w getActiveShareByToken.
    if (!share) {
      return res.status(404).json({ error: 'Link jest nieprawidłowy, wygasł albo został odwołany.' });
    }

    const pdfBuffer = await buildHealthReportPdf(share.userId, share.days);
    res.setHeader('Content-Type', 'application/pdf');
    // inline (nie attachment) - odbiorca linku zwykle chce po prostu zobaczyć raport
    // w przeglądarce, a nie wymusić pobranie pliku.
    res.setHeader('Content-Disposition', 'inline; filename="dietetyk-ai-raport.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[SHARED REPORT ERROR]', err);
    res.status(500).json({ error: 'Błąd generowania raportu PDF.' });
  }
});

module.exports = router;
