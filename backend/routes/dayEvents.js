const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// "Tag dnia" - użytkownik oznacza zakres dat kontekstem (choroba/wakacje/późne
// zaśnięcie), żeby wybrane insighty na dashboardzie mogły wykluczyć te dni z
// liczenia baseline/normy (patrz dashboard.js, helper wykluczania dat). `type`
// jest zamkniętym enumem - insighty mapują konkretne typy na konkretne
// wykluczenia, więc dowolny wolny tekst tutaj rozwałkowałby tę logikę.
const VALID_TYPES = ['illness', 'vacation', 'late_sleep'];

// Walidacja formatu 'YYYY-MM-DD' - nie liczymy się tu z tym, czy data istnieje
// kalendarzowo (np. 2026-02-30) - SQLite i tak porównuje takie wartości
// leksykograficznie poprawnie dla zapytań zakresowych, a dokładna walidacja
// kalendarzowa nie jest warta dodatkowej złożoności dla tego formularza.
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const MAX_NOTE_LENGTH = 500;

// Lista zdarzeń dnia użytkownika, najnowsze (wg start_date) pierwsze.
router.get('/api/day-events', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, type, start_date, end_date, note, created_at
      FROM day_events
      WHERE user_id = ?
      ORDER BY start_date DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania zdarzeń dnia.' });
  }
});

// Dodanie nowego zdarzenia (zakres dat + typ + opcjonalna notatka).
router.post('/api/day-events', requireAuth, async (req, res) => {
  const { type, start_date, end_date, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Nieprawidłowy typ zdarzenia. Dozwolone: ${VALID_TYPES.join(', ')}.` });
  }
  if (!DATE_REGEX.test(start_date) || !DATE_REGEX.test(end_date)) {
    return res.status(400).json({ error: 'Daty muszą być w formacie RRRR-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ error: 'Data końcowa nie może być wcześniejsza niż data początkowa.' });
  }

  const trimmedNote = note ? String(note).trim() : null;
  if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `Notatka jest za długa (maks. ${MAX_NOTE_LENGTH} znaków).` });
  }

  try {
    const result = await db.run(`
      INSERT INTO day_events (user_id, type, start_date, end_date, note)
      VALUES (?, ?, ?, ?, ?)
    `, [req.user.id, type, start_date, end_date, trimmedNote || null]);
    res.json({
      id: result.id,
      type,
      start_date,
      end_date,
      note: trimmedNote || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu zdarzenia dnia.' });
  }
});

// Edycja istniejącego zdarzenia - ta sama walidacja co przy tworzeniu, i tak samo
// tylko własne (WHERE user_id = ? chroni przed edycją zdarzenia innego użytkownika
// przez zgadnięcie/przejście po id).
router.put('/api/day-events/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Nieprawidłowe id zdarzenia.' });
  }

  const { type, start_date, end_date, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Nieprawidłowy typ zdarzenia. Dozwolone: ${VALID_TYPES.join(', ')}.` });
  }
  if (!DATE_REGEX.test(start_date) || !DATE_REGEX.test(end_date)) {
    return res.status(400).json({ error: 'Daty muszą być w formacie RRRR-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ error: 'Data końcowa nie może być wcześniejsza niż data początkowa.' });
  }

  const trimmedNote = note ? String(note).trim() : null;
  if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `Notatka jest za długa (maks. ${MAX_NOTE_LENGTH} znaków).` });
  }

  try {
    const result = await db.run(`
      UPDATE day_events
      SET type = ?, start_date = ?, end_date = ?, note = ?
      WHERE id = ? AND user_id = ?
    `, [type, start_date, end_date, trimmedNote || null, id, req.user.id]);

    if (!result.changes) {
      return res.status(404).json({ error: 'Zdarzenie nie zostało znalezione.' });
    }

    res.json({
      id,
      type,
      start_date,
      end_date,
      note: trimmedNote || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd edycji zdarzenia dnia.' });
  }
});

// Usunięcie zdarzenia - tylko własne (WHERE user_id = ? chroni przed usunięciem
// zdarzenia innego użytkownika przez zgadnięcie/przejście po id).
router.delete('/api/day-events/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Nieprawidłowe id zdarzenia.' });
  }
  try {
    const result = await db.run(`DELETE FROM day_events WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!result.changes) {
      return res.status(404).json({ error: 'Zdarzenie nie zostało znalezione.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania zdarzenia dnia.' });
  }
});

module.exports = router;
