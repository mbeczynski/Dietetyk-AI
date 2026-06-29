const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Brak klucza GEMINI_API_KEY w pliku .env!");
  process.exit(1);
}

async function main() {
  console.log("Pobieranie listy modeli dla klucza API:", apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4));
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.error) {
      console.error("Błąd API Google:", data.error);
      return;
    }

    console.log("\nDostępne modele obsługujące generateContent:");
    if (data.models && data.models.length > 0) {
      data.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .forEach(m => {
          console.log(`  - ${m.name.replace('models/', '')} (${m.displayName})`);
        });
    } else {
      console.log("Brak modeli lub błąd odpowiedzi:", data);
    }
  } catch (err) {
    console.error("Wystąpił błąd podczas zapytania:", err);
  }
}

main();
