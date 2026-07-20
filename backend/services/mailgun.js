const db = require('../db');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { decrypt } = require('../utils/encryption');

async function sendMailgunEmail({ to, subject, html }) {
  // Pobieramy tylko kolumny faktycznie potrzebne w tym miejscu (Runda 17, naprawa
  // z audytu) - wcześniej `SELECT * FROM app_config` ściągał WSZYSTKIE wiersze
  // konfiguracji (w tym np. google_client_secret, force_2fa), mimo że ta funkcja
  // używa wyłącznie ustawień Mailgun. `app_config` to tabela key-value (PRIMARY
  // KEY(key)), więc filtrujemy po kluczu, nie po kolumnie.
  const configRows = await db.all(
    `SELECT key, value FROM app_config WHERE key IN ('mailgun_api_key', 'mailgun_domain', 'mailgun_region', 'mailgun_from')`
  );
  const config = {};
  configRows.forEach(r => {
    config[r.key] = r.value;
  });

  const apiKey = decrypt(config.mailgun_api_key);
  const domain = config.mailgun_domain;
  const region = config.mailgun_region || 'us';
  const from = config.mailgun_from || `"Dietetyk AI" <noreply@${domain || 'dietetyk.ai'}>`;

  if (!apiKey || !domain) {
    throw new Error('Silnik e-mail (Mailgun) nie został jeszcze skonfigurowany przez administratora.');
  }

  const apiBase = region.toLowerCase() === 'eu'
    ? 'https://api.eu.mailgun.net/v3'
    : 'https://api.mailgun.net/v3';

  const url = `${apiBase}/${domain}/messages`;
  
  const formData = new URLSearchParams();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);

  const authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;

  console.log(`[MAILGUN] Wysyłanie e-maila do ${to} za pomocą domeny ${domain}...`);

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Błąd Mailgun API: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`[MAILGUN] Wysłano pomyślnie. ID: ${result.id}`);
  return result;
}

module.exports = { sendMailgunEmail };
