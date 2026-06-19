const crypto = require('crypto');
const db = require('../db');

// Helper do pobierania konfiguracji z bazy app_config
async function getAppConfig(key) {
  if (key === 'app_url' && process.env.APP_URL) {
    return process.env.APP_URL;
  }
  const row = await db.get(`SELECT value FROM app_config WHERE key = ?`, [key]);
  return row ? row.value : null;
}

// Helper do pobierania ustawień konkretnego użytkownika
async function getUserSetting(userId, key) {
  const row = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = ?`, [userId, key]);
  return row ? row.value : null;
}

// Bezpieczne generowanie i weryfikacja stanu OAuth (stateless)
function generateOAuthState(userId, service = 'oura') {
  const salt = Math.random().toString(36).substring(2);
  const data = `${userId}:${service}:${salt}`;
  const hmac = crypto.createHmac('sha256', process.env.APP_PASSWORD || 'default_secret').update(data).digest('hex');
  return `${userId}:${service}:${salt}:${hmac}`;
}

function verifyOAuthState(state) {
  if (!state) return null;
  const parts = state.split(':');
  if (parts.length === 3) {
    const [userId, salt, hmac] = parts;
    const expectedHmac = crypto.createHmac('sha256', process.env.APP_PASSWORD || 'default_secret').update(`${userId}:${salt}`).digest('hex');
    if (hmac === expectedHmac) {
      return { userId: parseInt(userId, 10), service: 'oura' };
    }
  } else if (parts.length === 4) {
    const [userId, service, salt, hmac] = parts;
    const expectedHmac = crypto.createHmac('sha256', process.env.APP_PASSWORD || 'default_secret').update(`${userId}:${service}:${salt}`).digest('hex');
    if (hmac === expectedHmac) {
      return { userId: parseInt(userId, 10), service };
    }
  }
  return null;
}

// Pobieranie / Odświeżanie tokenu OAuth
async function getOrRefreshToken(userId, service) {
  const token = await db.get(`SELECT * FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
  if (!token) return null;

  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // Jeśli token jest ważny dłużej niż 5 minut, zwracamy go
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  console.log(`[OAUTH] Odświeżanie tokenu dla użytkownika ${userId}, serwis: ${service}...`);
  try {
    if (service === 'oura') {
      const clientId = await getUserSetting(userId, 'oura_client_id');
      const clientSecret = await getUserSetting(userId, 'oura_client_secret');
      if (!clientId || !clientSecret) throw new Error('Brak Client ID lub Secret dla Oura.');

      const response = await fetch('https://api.ouraring.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Błąd odświeżania Oura: ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'oura'
      `, [data.access_token, data.refresh_token || token.refresh_token, newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'withings') {
      const clientId = await getUserSetting(userId, 'withings_client_id');
      const clientSecret = await getUserSetting(userId, 'withings_client_secret');
      if (!clientId || !clientSecret) throw new Error('Brak Client ID lub Secret dla Withings.');

      const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token.refresh_token
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Błąd odświeżania Withings: ${errorText}`);
      }

      const resJson = await response.json();
      if (resJson.status !== 0) {
        throw new Error(`Błąd Withings API: ${resJson.error || 'Status ' + resJson.status}`);
      }

      const data = resJson.body;
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'withings'
      `, [data.access_token, data.refresh_token || token.refresh_token, newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'google_fit') {
      // W przeciwieństwie do Oura/Withings, Google Fit korzysta z GLOBALNEJ konfiguracji
      // Google (Panel Admina), tej samej co logowanie Google - nie z poświadczeń per-użytkownik.
      const clientId = await getAppConfig('google_client_id');
      const clientSecret = await getAppConfig('google_client_secret');
      if (!clientId || !clientSecret) throw new Error('Brak Client ID lub Secret dla Google (konfiguracja globalna).');

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Błąd odświeżania Google Fit: ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      // Google przy odświeżaniu zwykle NIE zwraca nowego refresh_token - zachowujemy stary.
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'google_fit'
      `, [data.access_token, data.refresh_token || token.refresh_token, newExpiresAt, userId]);

      return data.access_token;
    }
  } catch (err) {
    console.error(`[OAUTH ERROR] Błąd odświeżania tokenu dla ${service} (użytkownik ${userId}):`, err.message);
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
    return null;
  }
  return null;
}

module.exports = {
  getAppConfig,
  getUserSetting,
  generateOAuthState,
  verifyOAuthState,
  getOrRefreshToken
};
