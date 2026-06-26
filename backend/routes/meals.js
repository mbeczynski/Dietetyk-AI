const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { generateContentWithFallback } = require('../config');
const { getCalorieBaseline, detectMealAnomalies } = require('../utils/mealAnomaly');

// Model AI (Gemini) czasem zwraca nierealistyczne lub ujemne wartości kalorii/makro
// (np. błąd parsowania wielkości porcji, halucynacja liczby) - bez tego zabezpieczenia
// taka wartość trafiałaby bezpośrednio do bazy i psuła agregacje (sumy dzienne, bilans
// kaloryczny, streaki) na dashboardzie/podsumowaniach. Odcinamy do sensownego zakresu,
// a gdy wartości nie da się sparsować jako liczby, używamy fallbacku (domyślnie 0).
function sanitizeNumber(val, min, max, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

// Limit rozmiaru pojedynczego zdjęcia posiłku zapisywanego w bazie SQLite jako base64.
// Bez tego limitu jedyną granicą był globalny express.json({limit:'20mb'}) w server.js
// (myślany pod webhooki, nie pod pojedyncze zdjęcia) - użytkownik mógłby dodawać zdjęcia
// w oryginalnej rozdzielczości telefonu (10-20MB), co przy kilku posiłkach dziennie
// szybko rozdęłoby plik bazy SQLite (jeden plik, brak osobnego storage na obrazy).
// 7MB base64 odpowiada ok. 5.25MB danych binarnych po dekodowaniu - wystarczające dla
// zdjęcia jedzenia w rozsądnej jakości, a wciąż chroni przed ekstremalnie dużymi plikami.
const MAX_MEAL_IMAGE_BASE64_CHARS = 7 * 1024 * 1024;

// Wariant dla pól, które mogą być prawdziwie nieznane (błonnik/cukry/sód - AI nie zawsze
// jest w stanie je oszacować) - w przeciwieństwie do sanitizeNumber NIE fabrykujemy zera,
// jeśli AI nie podało wartości, ale gdy wartość JEST podana, wciąż odcinamy ją do sensownego
// zakresu. Bez tego ujemna/nierealistyczna/nie-numeryczna wartość z odpowiedzi Gemini
// trafiałaby bezpośrednio do bazy (w przeciwieństwie do calories/protein/carbs/fat, które
// już były sanityzowane) i psuła agregacje w summaries.js/dashboard.js (sumy/średnie błonnika,
// cukrów, sodu używane teraz w pełnym podsumowaniu AI).
function sanitizeNullableNumber(val, min, max) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.min(Math.max(num, min), max);
}

// Detektor anomalii w posiłkach - logika (oba sygnały: niezgodność makro/kalorii
// i statystyczny odstrój vs własna historia) wydzielona do utils/mealAnomaly.js,
// bo jest współdzielona z routes/dashboard.js (lista posiłków dnia w /api/dashboard,
// z którego faktycznie korzysta MealLogger.jsx po stronie frontendu).

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

        if (base64Data.length > MAX_MEAL_IMAGE_BASE64_CHARS) {
          console.warn(`[API WARNING] Odrzucono zdjęcie posiłku - za duży rozmiar (${base64Data.length} znaków base64).`);
          return res.status(413).json({ error: 'Zdjęcie jest za duże. Maksymalny rozmiar to ok. 5MB - spróbuj zrobić zdjęcie w niższej rozdzielczości.' });
        }

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
Przeanalizuj dołączone zdjęcie pod kątem wartości odżywczych.
${rawText ? `Użytkownik podał dodatkowy kontekst/opis: "${rawText}"` : 'Użytkownik nie podał opisu tekstowego, zidentyfikuj dania na zdjęciu samodzielnie.'}

WAŻNE - zdjęcie może przedstawiać JEDEN posiłek (np. zdjęcie talerza) ALBO zrzut
ekranu z aplikacji do liczenia kalorii, pokazujący podział całego dnia na kilka
osobnych posiłków (np. sekcje "Śniadanie", "II Śniadanie", "Obiad", "Podwieczorek",
"Kolacja", każda z własnymi pozycjami i sumą kcal/makro).
- Jeśli widzisz na zdjęciu wyraźny podział na kilka sekcji/posiłków, zwróć w tablicy
  "meals" JEDEN obiekt na KAŻDĄ wykrytą sekcję, każdy z własnymi, osobnymi wartościami
  odżywczymi - NIE sumuj ich w jeden wpis. Jako "name" użyj etykiety posiłku widocznej
  na zdjęciu (np. "Śniadanie", "Obiad", "Kolacja").
- Jeśli na zdjęciu jest tylko jeden posiłek/danie, bez podziału na sekcje, zwróć
  tablicę "meals" z JEDNYM elementem, a jako "name" użyj krótkiej nazwy rozpoznanego
  dania (np. "Owsianka z bananem i orzechami").

Zwróć odpowiedź w formacie JSON. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "meals": [
    {
      "name": "nazwa posiłku/etykieta wykryta na zdjęciu (patrz instrukcja powyżej)",
      "calories": (liczba całkowita - kcal dla TEGO posiłku),
      "protein": (liczba - gramy białka),
      "carbs": (liczba - gramy węglowodanów),
      "fat": (liczba - gramy tłuszczu),
      "fiber": (liczba - gramy błonnika, szacunkowo na podstawie składników posiłku),
      "sugar": (liczba - gramy cukrów prostych, szacunkowo na podstawie składników posiłku),
      "sodium": (liczba - miligramy sodu, szacunkowo na podstawie składników posiłku),
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
      "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania) dotyczący TEGO posiłku. Oceń zbilansowanie, zalety, wady i ewentualne sugestie ulepszenia.",
      "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe, a 10 to super zdrowe i zbilansowane)
    }
  ]
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
  "fiber": (liczba - gramy błonnika, szacunkowo na podstawie składników posiłku),
  "sugar": (liczba - gramy cukrów prostych, szacunkowo na podstawie składników posiłku),
  "sodium": (liczba - miligramy sodu, szacunkowo na podstawie składników posiłku),
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

    // Przy zdjęciu AI może zwrócić kilka rozbitych posiłków (analysis.meals - patrz
    // prompt powyżej, np. zrzut ekranu z aplikacji do liczenia kalorii podzielony na
    // Śniadanie/Obiad/Kolację). Każdy wykryty posiłek zapisujemy jako OSOBNY wiersz
    // w tabeli meals, z własnymi makroskładnikami i własną nazwą (raw_text) wziętą
    // z detekcji AI, a nie z tekstu wpisanego przez użytkownika.
    let mealsToInsert;
    if (imagePart) {
      if (analysis && Array.isArray(analysis.meals) && analysis.meals.length > 0) {
        mealsToInsert = analysis.meals;
      } else {
        // Fallback: AI zwróciło płaski obiekt mimo instrukcji w prompcie (starszy
        // format) - traktujemy to jako jeden posiłek, żeby nie wywalić całego żądania.
        mealsToInsert = [{ ...analysis, name: analysis?.name || rawText || 'Posiłek ze zdjęcia' }];
      }
    } else {
      // Brak zdjęcia - posiłek wpisany tylko tekstem, bez detekcji wielu sekcji,
      // zachowanie identyczne jak wcześniej (jeden wiersz, nazwa = tekst użytkownika).
      mealsToInsert = [{ ...analysis, name: rawText }];
    }

    // Bazowy rozkład kalorii liczony RAZ dla całego żądania (nie per posiłek) - przy
    // zdjęciu rozbitym na kilka sekcji (Śniadanie/Obiad/Kolacja) wszystkie porównujemy
    // do tej samej, historycznej linii bazowej z dni PRZED targetDate.
    const calorieBaseline = await getCalorieBaseline(req.user.id, targetDate);

    const insertedMeals = [];
    for (const m of mealsToInsert) {
      const mealDescription = (imagePart ? (m.name || rawText || 'Posiłek ze zdjęcia') : (m.name || rawText));

      // Odcięcie wartości z odpowiedzi AI do sensownego zakresu przed zapisem do bazy
      // (patrz komentarz przy definicji sanitizeNumber powyżej).
      const safeCalories = sanitizeNumber(m.calories, 0, 5000, 0);
      const safeProtein = sanitizeNumber(m.protein, 0, 500, 0);
      const safeCarbs = sanitizeNumber(m.carbs, 0, 500, 0);
      const safeFat = sanitizeNumber(m.fat, 0, 500, 0);
      const safeFiber = sanitizeNullableNumber(m.fiber, 0, 100);
      const safeSugar = sanitizeNullableNumber(m.sugar, 0, 300);
      const safeSodium = sanitizeNullableNumber(m.sodium, 0, 15000);

      // Zapisz posiłek w bazie (błonnik/cukry/sód jako NULL, jeśli AI ich nie
      // oszacowało - bez fabrykowania zer, zgodnie z ustaloną zasadą projektu - ale
      // jeśli AI JEDNAK podało wartość, odcinamy ją do sensownego zakresu jak resztę makro)
      const result = await db.run(`
        INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json, image_base64)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        req.user.id,
        targetDate,
        mealDescription,
        safeCalories,
        safeProtein,
        safeCarbs,
        safeFat,
        safeFiber,
        safeSugar,
        safeSodium,
        JSON.stringify(m),
        image || null
      ]);

      // Odpowiedź do frontendu musi pokazywać te SAME (odcięte) wartości, które
      // wylądowały w bazie - inaczej dashboard od razu po dodaniu posiłku pokazałby
      // inną liczbę kcal/makro niż po jego odświeżeniu z bazy.
      insertedMeals.push({
        id: result.id,
        date: targetDate,
        raw_text: mealDescription,
        image_base64: image || null,
        ...m,
        calories: safeCalories,
        protein: safeProtein,
        carbs: safeCarbs,
        fat: safeFat,
        fiber: safeFiber,
        sugar: safeSugar,
        sodium: safeSodium,
        anomalies: detectMealAnomalies({ calories: safeCalories, protein: safeProtein, carbs: safeCarbs, fat: safeFat }, calorieBaseline)
      });
    }

    const totalCalories = insertedMeals.reduce((sum, m) => sum + (m.calories || 0), 0);
    console.log(`[API LOG] Dodano ${insertedMeals.length} posiłek(ów) dla ${req.user.username} (ID: ${insertedMeals.map(m => m.id).join(', ')}). Łącznie: ${totalCalories} kcal`);

    res.status(201).json({
      count: insertedMeals.length,
      meals: insertedMeals
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

    // Ta sama linia bazowa co przy zapisie (POST) - dni PRZED `date`, więc wynik
    // anomalii dla danego dnia jest stabilny niezależnie od tego, ile razy
    // odświeżymy widok (nie zmienia się przy każdym kolejnym posiłku tego samego dnia).
    const calorieBaseline = await getCalorieBaseline(req.user.id, date);

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
        ...analysis,
        // Kolumny bazy zawierają wartości PO sanityzacji (sanitizeNumber/sanitizeNullableNumber
        // przy zapisie) - mogą się różnić od niesanityzowanego analysis_json zwróconego przez AI.
        // Muszą nadpisać spread z `analysis`, inaczej GET zwróci inne wartości niż te faktycznie
        // użyte w agregacjach (dashboard, podsumowania).
        calories: r.calories,
        protein: r.protein,
        carbs: r.carbs,
        fat: r.fat,
        anomalies: detectMealAnomalies({ calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat }, calorieBaseline)
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

// Automatyzacja (Runda 9): lista najczęściej powtarzanych posiłków użytkownika
// (grupowanie po znormalizowanym raw_text - LOWER(TRIM(...)), bo użytkownik zwykle
// wpisuje tę samą nazwę posiłku z drobnymi różnicami wielkości liter/spacji, nie
// identyczny ciąg znaków), do szybkiego ponownego dodania bez ponownego wywołania AI
// (patrz POST /api/meals/repeat poniżej). Tylko posiłki powtórzone co najmniej 2 razy.
router.get('/api/meals/frequent', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
    const rows = await db.all(`
      SELECT
        MAX(id) AS latest_id,
        raw_text,
        COUNT(*) AS count,
        MAX(date) AS last_date,
        AVG(calories) AS avg_calories,
        AVG(protein) AS avg_protein,
        AVG(carbs) AS avg_carbs,
        AVG(fat) AS avg_fat
      FROM meals
      WHERE user_id = ? AND raw_text IS NOT NULL AND TRIM(raw_text) != ''
      GROUP BY LOWER(TRIM(raw_text))
      HAVING COUNT(*) >= 2
      ORDER BY count DESC, last_date DESC
      LIMIT ?
    `, [req.user.id, limit]);

    res.json(rows.map(r => ({
      mealId: r.latest_id,
      rawText: r.raw_text,
      count: r.count,
      lastDate: r.last_date,
      avgCalories: Math.round(r.avg_calories),
      avgProtein: Math.round(r.avg_protein * 10) / 10,
      avgCarbs: Math.round(r.avg_carbs * 10) / 10,
      avgFat: Math.round(r.avg_fat * 10) / 10
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania częstych posiłków.' });
  }
});

// Szybkie ponowne dodanie wcześniej zapisanego posiłku (na bazie jego id) - kopiuje
// wartości odżywcze z oryginalnego wpisu BEZ ponownego wywołania AI (inaczej niż
// POST /api/meals powyżej), bo posiłek już raz został przeanalizowany i użytkownik
// chce po prostu zalogować "to samo co ostatnio" (np. swoje stałe śniadanie) - szybciej
// i bez zużywania limitu/kosztu zapytań do Gemini.
router.post('/api/meals/repeat', async (req, res) => {
  const { mealId, date } = req.body;
  const targetDate = date || getLocalDateString();

  if (!mealId) {
    return res.status(400).json({ error: 'Brak wskazania posiłku do powtórzenia.' });
  }

  try {
    const original = await db.get(`SELECT * FROM meals WHERE id = ? AND user_id = ?`, [mealId, req.user.id]);
    if (!original) {
      return res.status(404).json({ error: 'Nie znaleziono oryginalnego posiłku do powtórzenia.' });
    }

    const calorieBaseline = await getCalorieBaseline(req.user.id, targetDate);

    const result = await db.run(`
      INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json, image_base64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      targetDate,
      original.raw_text,
      original.calories,
      original.protein,
      original.carbs,
      original.fat,
      original.fiber,
      original.sugar,
      original.sodium,
      original.analysis_json,
      original.image_base64
    ]);

    let analysis = {};
    try {
      analysis = JSON.parse(original.analysis_json);
    } catch (e) {
      analysis = {};
    }

    res.status(201).json({
      count: 1,
      meals: [{
        id: result.id,
        date: targetDate,
        raw_text: original.raw_text,
        image_base64: original.image_base64,
        ...analysis,
        calories: original.calories,
        protein: original.protein,
        carbs: original.carbs,
        fat: original.fat,
        fiber: original.fiber,
        sugar: original.sugar,
        sodium: original.sodium,
        anomalies: detectMealAnomalies({ calories: original.calories, protein: original.protein, carbs: original.carbs, fat: original.fat }, calorieBaseline)
      }]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd powtarzania posiłku.' });
  }
});

module.exports = router;
