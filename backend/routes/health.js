const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.get('/api/health/history', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT date, weight, fat_ratio, muscle_mass, blood_pressure_systolic, blood_pressure_diastolic, sleep_score, sleep_duration, sleep_deep, sleep_rem, readiness_score, steps, active_calories, total_calories_burned, rhr, hrv, active_minutes, supplements
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
      SELECT id, date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below
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
  const { date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  try {
    await db.run(`
      INSERT INTO body_measurements (
        user_id, date, chest, waist, hips, biceps, thigh, 
        biceps_left, biceps_right, shoulders, waist_above, waist_below
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        chest = COALESCE(excluded.chest, chest),
        waist = COALESCE(excluded.waist, waist),
        hips = COALESCE(excluded.hips, hips),
        biceps = COALESCE(excluded.biceps, biceps),
        thigh = COALESCE(excluded.thigh, thigh),
        biceps_left = COALESCE(excluded.biceps_left, biceps_left),
        biceps_right = COALESCE(excluded.biceps_right, biceps_right),
        shoulders = COALESCE(excluded.shoulders, shoulders),
        waist_above = COALESCE(excluded.waist_above, waist_above),
        waist_below = COALESCE(excluded.waist_below, waist_below)
    `, [
      req.user.id,
      date,
      chest !== undefined && chest !== null && chest !== '' ? Number(chest) : null,
      waist !== undefined && waist !== null && waist !== '' ? Number(waist) : null,
      hips !== undefined && hips !== null && hips !== '' ? Number(hips) : null,
      biceps !== undefined && biceps !== null && biceps !== '' ? Number(biceps) : null,
      thigh !== undefined && thigh !== null && thigh !== '' ? Number(thigh) : null,
      biceps_left !== undefined && biceps_left !== null && biceps_left !== '' ? Number(biceps_left) : null,
      biceps_right !== undefined && biceps_right !== null && biceps_right !== '' ? Number(biceps_right) : null,
      shoulders !== undefined && shoulders !== null && shoulders !== '' ? Number(shoulders) : null,
      waist_above !== undefined && waist_above !== null && waist_above !== '' ? Number(waist_above) : null,
      waist_below !== undefined && waist_below !== null && waist_below !== '' ? Number(waist_below) : null
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

// Dodanie wypitej wody (licznik dzienny, addytywny - wielokrotne kliknięcia w ciągu dnia się sumują)
router.post('/api/water/add', requireAuth, async (req, res) => {
  const { date, amount_ml } = req.body;
  const amount = Number(amount_ml);
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Ilość wody (amount_ml) musi być liczbą większą od zera.' });
  }
  // Górny limit na pojedynczy wpis - bez tego błąd UI/integracji (np. pomylenie ml
  // z litrami) mógłby dopisać absurdalną wartość do dziennego licznika wody.
  if (amount > 5000) {
    return res.status(400).json({ error: 'Nieprawidłowa ilość wody (maks. 5000 ml na wpis).' });
  }
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, water_ml)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET water_ml = COALESCE(water_ml, 0) + excluded.water_ml
    `, [req.user.id, date, Math.round(amount)]);

    const row = await db.get(`SELECT water_ml FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    res.json({ success: true, water_ml: row ? row.water_ml : amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu licznika wody.' });
  }
});

// Zresetowanie licznika wody dla danego dnia (np. cofnięcie błędnego wpisu)
router.post('/api/water/reset', requireAuth, async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, water_ml)
      VALUES (?, ?, 0)
      ON CONFLICT(user_id, date) DO UPDATE SET water_ml = 0
    `, [req.user.id, date]);
    res.json({ success: true, water_ml: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd resetowania licznika wody.' });
  }
});

// Zapisz/aktualizuj suplementy dla danego dnia
router.post('/api/supplements', requireAuth, async (req, res) => {
  const { date, supplements } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, supplements)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET supplements = excluded.supplements
    `, [req.user.id, date, supplements ? supplements.trim() : null]);
    res.json({ success: true, supplements: supplements ? supplements.trim() : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu suplementów.' });
  }
});

module.exports = router;
