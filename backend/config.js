const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Wczytaj zmienne środowiskowe
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3000;

// Inicjalizacja Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY;
let genAI = null;
let model = null;

if (geminiApiKey) {
  try {
    genAI = new GoogleGenerativeAI(geminiApiKey);
    // Używamy modelu gemini-2.5-flash jako standardu i stabilnej wersji
    model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
    });
    console.log(`Zainicjalizowano Gemini API z modelem: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}`);
  } catch (err) {
    console.error('Błąd inicjalizacji Gemini API:', err.message);
  }
} else {
  console.warn('Ostrzeżenie: Brak GEMINI_API_KEY w pliku .env. Analiza AI nie będzie działać!');
}

// Pomocnicza funkcja do generowania treści z obsługą modeli zapasowych (fallback) i logowaniem
async function generateContentWithFallback(promptText, isJson = false, imagePart = null, customApiKey = null, forceCustomKeyOnly = false) {
  const apiKeyToUse = customApiKey || (forceCustomKeyOnly ? null : process.env.GEMINI_API_KEY);
  if (!apiKeyToUse) {
    throw new Error('Usługa AI jest obecnie niedostępna (brak klucza API). Upewnij się, że klucz jest wprowadzony w zakładce Ustawienia.');
  }

  const localGenAI = new GoogleGenerativeAI(apiKeyToUse);

  const modelsToTry = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash'
  ].filter(Boolean);

  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  console.log(`[AI LOG] Rozpoczęcie generowania z promptem o długości ${promptText.length} znaków.`);

  for (const modelName of uniqueModels) {
    try {
      console.log(`[AI LOG] Próba wysłania zapytania (JSON=${isJson}, Obraz=${!!imagePart}) do modelu: ${modelName}`);
      const tempModel = localGenAI.getGenerativeModel({ model: modelName });

      const config = {
        temperature: 0.2,
      };
      if (isJson) {
        config.responseMimeType = "application/json";
      }

      const parts = [{ text: promptText }];
      if (imagePart) {
        parts.push(imagePart);
      }

      const response = await tempModel.generateContent({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: config
      });

      const text = response.response.text();
      console.log(`[AI LOG] Sukces! Użyto modelu: ${modelName}. Długość odpowiedzi: ${text.length} znaków.`);
      return text;
    } catch (err) {
      console.warn(`[AI WARNING] Model ${modelName} zgłosił błąd: ${err.message}`);
      lastError = err;
      
      // Jeśli błąd dotyczy niepoprawnego klucza API lub braku autoryzacji (401/403),
      // nie ma sensu ponawiać próby dla innych modeli z tym samym kluczem.
      const errText = err.message || '';
      if (
        err.status === 401 ||
        err.status === 403 ||
        errText.includes('API key not valid') ||
        errText.includes('API_KEY_INVALID') ||
        errText.includes('API_KEY_SERVICE_BLOCKED') ||
        errText.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED')
      ) {
        console.error(`[AI ERROR] Krytyczny błąd klucza API. Przerywam próby dla innych modeli.`);
        break;
      }
    }
  }

  console.error(`[AI ERROR] Wszystkie dostępne modele (${uniqueModels.join(', ')}) zawiodły.`);
  throw lastError || new Error("Wszystkie skonfigurowane modele Gemini zwróciły błąd.");
}

module.exports = {
  PORT,
  genAI,
  model,
  generateContentWithFallback
};
