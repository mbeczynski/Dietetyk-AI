const db = require('../db');
const { formatDateString, timestampToDateString } = require('../utils/dates');
const { getOrRefreshToken } = require('./oauthHelpers');

async function syncOura(userId) {
  const accessToken = await getOrRefreshToken(userId, 'oura');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Oura. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 7);

  const startDate = formatDateString(past);
  const endDate = formatDateString(now);

  console.log(`[SYNC OURA] Pobieranie danych gotowości/snu/aktywności dla użytkownika ${userId} od ${startDate} do ${endDate}...`);

  try {
    const sleepRes = await fetch(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!sleepRes.ok) {
      const errText = await sleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania snu Oura (Status ${sleepRes.status}): ${detail}`);
    }
    const sleepData = await sleepRes.json();

    const dailySleepRes = await fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!dailySleepRes.ok) {
      const errText = await dailySleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania dziennego podsumowania snu Oura (Status ${dailySleepRes.status}): ${detail}`);
    }
    const dailySleepData = await dailySleepRes.json();

    const actRes = await fetch(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!actRes.ok) {
      const errText = await actRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania aktywności Oura (Status ${actRes.status}): ${detail}`);
    }
    const actData = await actRes.json();

    const readRes = await fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!readRes.ok) {
      const errText = await readRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania gotowości Oura (Status ${readRes.status}): ${detail}`);
    }
    const readData = await readRes.json();

    const metricsByDate = {};
    for (let i = 0; i <= 7; i++) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      const dateStr = formatDateString(d);
      metricsByDate[dateStr] = {
        steps: null,
        active_calories: null,
        total_calories: null,
        sleep_score: null,
        sleep_duration: null,
        sleep_deep: null,
        sleep_rem: null,
        readiness_score: null,
        hrv: null,
        rhr: null,
        temperature_deviation: null
      };
    }

    if (sleepData && sleepData.data) {
      sleepData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].sleep_duration = item.total_sleep_duration ? Math.round((item.total_sleep_duration / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_deep = item.deep_sleep_duration ? Math.round((item.deep_sleep_duration / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_rem = item.rem_sleep_duration ? Math.round((item.rem_sleep_duration / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].rhr = item.lowest_heart_rate || null;
          metricsByDate[dateStr].hrv = item.average_hrv || null;
        }
      });
    }

    if (dailySleepData && dailySleepData.data) {
      dailySleepData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].sleep_score = item.score || null;
        }
      });
    }

    if (actData && actData.data) {
      actData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].steps = item.steps || 0;
          metricsByDate[dateStr].active_calories = item.active_calories || 0;
          metricsByDate[dateStr].total_calories = item.total_calories || 0;
          metricsByDate[dateStr].active_minutes = Math.round(((item.medium_activity_time || 0) + (item.high_activity_time || 0)) / 60) || 0;
        }
      });
    }

    if (readData && readData.data) {
      readData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].readiness_score = item.score || null;
          metricsByDate[dateStr].temperature_deviation = item.temperature?.deviation || null;
        }
      });
    }

    const lastSyncTime = new Date().toISOString();
    for (const [dateStr, metrics] of Object.entries(metricsByDate)) {
      if (metrics.steps !== null || metrics.sleep_score !== null || metrics.readiness_score !== null) {
        await db.run(`
          INSERT INTO health_metrics (
            user_id, date, steps, active_calories, total_calories_burned, 
            sleep_score, sleep_duration, sleep_deep, sleep_rem, 
            readiness_score, hrv, rhr, temperature_deviation, active_minutes, last_sync
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            steps = COALESCE(excluded.steps, steps),
            active_calories = COALESCE(excluded.active_calories, active_calories),
            total_calories_burned = COALESCE(excluded.total_calories_burned, total_calories_burned),
            sleep_score = COALESCE(excluded.sleep_score, sleep_score),
            sleep_duration = COALESCE(excluded.sleep_duration, sleep_duration),
            sleep_deep = COALESCE(excluded.sleep_deep, sleep_deep),
            sleep_rem = COALESCE(excluded.sleep_rem, sleep_rem),
            readiness_score = COALESCE(excluded.readiness_score, readiness_score),
            hrv = COALESCE(excluded.hrv, hrv),
            rhr = COALESCE(excluded.rhr, rhr),
            temperature_deviation = COALESCE(excluded.temperature_deviation, temperature_deviation),
            active_minutes = COALESCE(excluded.active_minutes, active_minutes),
            last_sync = excluded.last_sync
        `, [
          userId, dateStr, 
          metrics.steps, metrics.active_calories, metrics.total_calories,
          metrics.sleep_score, metrics.sleep_duration, metrics.sleep_deep, metrics.sleep_rem,
          metrics.readiness_score, metrics.hrv, metrics.rhr, metrics.temperature_deviation,
          metrics.active_minutes || 0,
          lastSyncTime
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC OURA ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja danych Withings
async function syncWithings(userId) {
  const accessToken = await getOrRefreshToken(userId, 'withings');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Withings. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 30);
  const startTimestamp = Math.floor(past.getTime() / 1000);

  console.log(`[SYNC WITHINGS] Pobieranie pomiarów wagi dla użytkownika ${userId}...`);

  try {
    const response = await fetch('https://wbsapi.withings.net/v2/measure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`
      },
      body: new URLSearchParams({
        action: 'getmeas',
        meastypes: '1,6,76', // 1: waga (kg), 6: % tłuszczu, 76: mięśnie (kg)
        category: '1',
        lastupdate: String(startTimestamp)
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Withings: ${errText}`);
    }

    const resJson = await response.json();
    if (resJson.status !== 0) {
      throw new Error(`Withings API status: ${resJson.status}`);
    }

    const measureGrps = resJson.body?.measuregrps || [];
    const lastSyncTime = new Date().toISOString();

    for (const grp of measureGrps) {
      const dateStr = timestampToDateString(grp.date);
      let weight = null;
      let fatRatio = null;
      let muscleMass = null;

      grp.measures.forEach(m => {
        const val = m.value * Math.pow(10, m.unit);
        if (m.type === 1) weight = Math.round(val * 100) / 100;
        if (m.type === 6) fatRatio = Math.round(val * 100) / 100;
        if (m.type === 76) muscleMass = Math.round(val * 100) / 100;
      });

      if (weight !== null || fatRatio !== null || muscleMass !== null) {
        await db.run(`
          INSERT INTO health_metrics (user_id, date, weight, fat_ratio, muscle_mass, last_sync)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            weight = COALESCE(excluded.weight, weight),
            fat_ratio = COALESCE(excluded.fat_ratio, fat_ratio),
            muscle_mass = COALESCE(excluded.muscle_mass, muscle_mass),
            last_sync = excluded.last_sync
        `, [userId, dateStr, weight, fatRatio, muscleMass, lastSyncTime]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC WITHINGS ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja Oura dla wszystkich użytkowników (wywoływana przez wspólny harmonogram godzinowy, 5:00-22:00)
async function syncAllOura() {
  console.log('[CRON OURA] Synchronizacja danych Oura Ring...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'oura'`);
    for (const t of tokens) {
      await syncOura(t.user_id);
    }
    console.log(`[CRON OURA] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Oura:', err);
  }
}

// Synchronizacja Withings dla wszystkich użytkowników (wywoływana przez wspólny harmonogram godzinowy, 5:00-22:00)
async function syncAllWithings() {
  console.log('[CRON WITHINGS] Synchronizacja danych Withings...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'withings'`);
    for (const t of tokens) {
      await syncWithings(t.user_id);
    }
    console.log(`[CRON WITHINGS] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Withings:', err);
  }
}

module.exports = {
  syncOura,
  syncWithings,
  syncAllOura,
  syncAllWithings
};
