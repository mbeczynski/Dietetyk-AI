const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.get('/api/health/history', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT date, weight, fat_ratio, muscle_mass, sleep_score, sleep_duration, readiness_score, steps, active_calories, total_calories_burned, rhr, hrv, active_minutes
      FROM health_metrics 
      WHERE user_id = ? AND date >= date('now', '-90 days')
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania historii pomiarów zdrowotnych.' });
  }
});

// Historia obwodów ciała
router.get('/api/body-measurements', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, date, chest, waist, hips, biceps, thigh 
      FROM body_measurements 
      WHERE user_id = ? 
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania obwodów ciała.' });
  }
});

// Zapisz/aktualizuj obwody ciała
router.post('/api/body-measurements', requireAuth, async (req, res) => {
  const { date, chest, waist, hips, biceps, thigh } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  try {
    await db.run(`
      INSERT INTO body_measurements (user_id, date, chest, waist, hips, biceps, thigh)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        chest = COALESCE(excluded.chest, chest),
        waist = COALESCE(excluded.waist, waist),
        hips = COALESCE(excluded.hips, hips),
        biceps = COALESCE(excluded.biceps, biceps),
        thigh = COALESCE(excluded.thigh, thigh)
    `, [
      req.user.id,
      date,
      chest ? Number(chest) : null,
      waist ? Number(waist) : null,
      hips ? Number(hips) : null,
      biceps ? Number(biceps) : null,
      thigh ? Number(thigh) : null
    ]);
    res.json({ success: true, message: 'Pomiary obwodów ciała zostały zapisane.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu obwodów ciała.' });
  }
});

// Usuń pomiar obwodu ciała
router.delete('/api/body-measurements/:id', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM body_measurements WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Pomiar obwodu ciała został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania pomiaru obwodu ciała.' });
  }
});

module.exports = router;
