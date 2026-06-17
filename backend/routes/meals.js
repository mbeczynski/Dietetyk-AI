const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { generateContentWithFallback } = require('../config');

router.post('/api/meals', async (req, res) => {
  const { rawText, date, image } = req.body;
  const targetDate = date || getLocalDateString();

  if ((!rawText || rawText.trim() === '') && !image) {
    return res.status(400).json({ error: 'Opis posiłku lub zdjęcie nie może być puste.' });
  }

  try {
    console.log(`[API LOG] POST /api/meals - Rozpoczęto analizę dla użytkownika ${req.user.username} (${targetDate})`);

    let imagePart = null;
    if (image) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];
        imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        };
        console.log(`[API LOG] Pomyślnie przetworzono zdjęcie. Typ: ${mimeType}, Rozmiar Base64: ${base64Data.length} znaków.`);
      } else {
        console.warn(`[API WARNING] Nieprawidłowy format pliku obrazu.`);
      }
    }

    let prompt = '';
    if (imagePart) {
      prompt = `
Przeanalizuj dołączone zdjęcie posiłku pod kątem wartości odżywczych. 
${rawText ? `Użytkownik opisał ten posiłek następująco: "${rawText}"` : 'Użytkownik nie podał opisu tekstowego, zidentyfikuj dania na zdjęciu samodzielnie.'}

Zwróć odpowiedź w formacie JSON zawierającym szacunkowe wartości odżywcze posiłku. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "calories": (liczba całkowita - kcal dla całego posiłku),
  "protein": (liczba - gramy białka),
  "carbs": (liczba - gramy węglowodanów),
  "fat": (liczba - gramy tłuszczu),
  "food_items": [
    {
      "name": "nazwa zidentyfikowanego składnika (np. jajko sadzone, ziemniaki gotowane, pierś z kurczaka)",
      "portion": "wielkość porcji oszacowana na podstawie zdjęcia (np. 2 sztuki, 150g, 1 szklanka)",
      "calories": (liczba - kcal),
      "protein": (liczba - g),
      "carbs": (liczba - g),
      "fat": (liczba - g)
    }
  ],
  "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania). Oceń zbilansowanie posiłku na zdjęciu, zalety, wady i ewentualne sugestie ulepszenia.",
  "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe, a 10 to super zdrowe i zbilansowane)
}
`;
    } else {
      prompt = `
Analizujesz posiłek użytkownika pod kątem wartości odżywczych. 
Użytkownik napisał: "${rawText}"

Zwróć odpowiedź w formacie JSON zawierającym szacunkowe wartości odżywcze posiłku. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "calories": (liczba całkowita - kcal dla całego posiłku),
  "protein": (liczba - gramy białka),
  "carbs": (liczba - gramy węglowodanów),
  "fat": (liczba - gramy tłuszczu),
  "food_items": [
    {
      "name": "nazwa składnika (np. jajko, chleb pszenny)",
      "portion": "wielkość porcji podana przez użytkownika lub domyślna szacowana (np. 2 sztuki, 100g)",
      "calories": (liczba - kcal),
      "protein": (liczba - g),
      "carbs": (liczba - g),
      "fat": (liczba - g)
    }
  ],
  "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania). Ocen zbilansowanie posiłku, zalety, wady i ewentualne sugestie ulepszenia.",
  "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe np. fast food, a 10 to super zdrowe i zbilansowane)
}
`;
    }

    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? apiKeyRow.value : null;
    const forceCustomKeyOnly = req.user.role !== 'admin';
    const responseText = await generateContentWithFallback(prompt, true, imagePart, userApiKey, forceCustomKeyOnly);
    let analysis;
    try {
      analysis = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[API ERROR] Błąd parsowania odpowiedzi AI:', responseText);
      throw new Error('AI nie zwróciło poprawnego formatu JSON.');
    }

    const mealDescription = rawText || "Posiłek ze zdjęcia";

    // Zapisz posiłek w bazie
    const result = await db.run(`
      INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, analysis_json, image_base64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      targetDate,
      mealDescription,
      analysis.calories || 0,
      analysis.protein || 0,
      analysis.carbs || 0,
      analysis.fat || 0,
      JSON.stringify(analysis),
      image || null
    ]);

    console.log(`[API LOG] Dodano posiłek o ID: ${result.id} dla ${req.user.username}. Kalorie: ${analysis.calories} kcal`);

    res.status(201).json({
      id: result.id,
      date: targetDate,
      raw_text: mealDescription,
      image_base64: image || null,
      ...analysis
    });

  } catch (err) {
    console.error('[API ERROR] Błąd analizy posiłku przez AI:', err);
    res.status(500).json({ error: 'Wystąpił błąd podczas analizowania posiłku przez AI: ' + err.message });
  }
});

// 2. Pobieranie listy posiłków z danego dnia
router.get('/api/meals', async (req, res) => {
  const date = req.query.date || getLocalDateString();
  try {
    const rows = await db.all(`
      SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY timestamp DESC
    `, [req.user.id, date]);

    const meals = rows.map(r => {
      let analysis = {};
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      return {
        id: r.id,
        date: r.date,
        timestamp: r.timestamp,
        raw_text: r.raw_text,
        image_base64: r.image_base64,
        ...analysis
      };
    });

    res.json(meals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania posiłków.' });
  }
});

// 3. Usuwanie posiłku
router.delete('/api/meals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM meals WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Nie znaleziono posiłku.' });
    }
    res.json({ success: true, message: 'Posiłek został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania posiłku.' });
  }
});

module.exports = router;
