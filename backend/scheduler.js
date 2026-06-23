const db = require('./db');
const { getLocalDateString } = require('./utils/dates');
const { syncAllOura, syncAllWithings, syncAllGoogleFit } = require('./services/sync');
const { sendWeeklySummaryForUser, sendDailySummaryForUser, sendMonthlySummaryForUser } = require('./services/summaries');
const { sendWeeklyAdminReport } = require('./services/adminReport');

async function checkAndSendAutomatedSummaries() {
  try {
    const users = await db.all(`SELECT id, username, email FROM users WHERE status = 'active'`);
    const todayStr = getLocalDateString();
    
    const now = new Date();
    // getDay(): 0 (niedziela) do 6 (sobota). Mapujemy 0 na 7, pozostałe bez zmian.
    const currentDay = now.getDay() === 0 ? 7 : now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    console.log(`[SCHEDULER] Sprawdzanie harmonogramów podsumowań. Dzień tygodnia: ${currentDay}, Czas: ${currentTimeStr}, Data: ${todayStr}`);

    for (const user of users) {
      const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [user.id]);
      const settings = {};
      settingsRows.forEach(r => {
        settings[r.key] = r.value;
      });

      const enabled = settings.weekly_summary_enabled === '1'; // ogólna flaga włączenia podsumowań
      const scheduledDay = Number(settings.weekly_summary_day || 1); // domyślnie poniedziałek (1)
      const scheduledTime = settings.weekly_summary_time || '18:00';
      
      const lastWeeklySent = settings.last_weekly_summary_sent || '';
      const lastDailySent = settings.last_daily_summary_sent || '';

      // --- Podsumowanie Miesięczne (niezależna flaga włączenia od tygodniowej/dziennej) ---
      const monthlyEnabled = settings.monthly_summary_enabled === '1';
      const monthlyScheduledDayRaw = Number(settings.monthly_summary_day || 1); // domyślnie 1. dzień miesiąca
      const monthlyScheduledTime = settings.monthly_summary_time || '09:00';
      const lastMonthlySent = settings.last_monthly_summary_sent || ''; // klucz idempotencji: 'YYYY-MM' (nie pełna data!)
      const currentYearMonthStr = todayStr.slice(0, 7); // 'YYYY-MM'

      if (monthlyEnabled) {
        // Dopasowanie do ostatniego dnia miesiąca, gdy skonfigurowany dzień (np. 31) nie istnieje
        // w danym miesiącu (luty, kwiecień, itd.) - w takim przypadku wysyłka następuje
        // w ostatnim dniu danego miesiąca.
        const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const effectiveMonthlyDay = Math.min(monthlyScheduledDayRaw, daysInCurrentMonth);

        if (now.getDate() === effectiveMonthlyDay) {
          if (currentTimeStr >= monthlyScheduledTime) {
            if (lastMonthlySent !== currentYearMonthStr) {
              console.log(`[SCHEDULER] Uruchamianie wysyłki miesięcznej dla ${user.username} (${user.email || 'brak e-maila'})`);
              if (user.email) {
                try {
                  await sendMonthlySummaryForUser(user.id);
                  // Zapisz informacje o wysłaniu w settings (klucz 'YYYY-MM', żeby wysłać raz w miesiącu kalendarzowym)
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_monthly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, currentYearMonthStr]);
                  console.log(`[SCHEDULER] Z powodzeniem wysłano miesięczne podsumowanie dla ${user.username} i ustawiono last_monthly_summary_sent na ${currentYearMonthStr}`);
                } catch (sendErr) {
                  console.error(`[SCHEDULER ERROR] Błąd podczas wysyłania miesięcznego dla ${user.username}:`, sendErr.message);
                }
              } else {
                console.warn(`[SCHEDULER WARNING] Nie można wysłać miesięcznego podsumowania dla ${user.username} - brak zdefiniowanego e-maila.`);
              }
            }
          }
        }
      }

      if (enabled) {
        // --- 1. Podsumowanie Codzienne ---
        if (currentTimeStr >= scheduledTime) {
          if (lastDailySent !== todayStr) {
            console.log(`[SCHEDULER] Uruchamianie wysyłki codziennej dla ${user.username} (${user.email || 'brak e-maila'})`);
            if (user.email) {
              try {
                await sendDailySummaryForUser(user.id);
                // Zapisz informacje o wysłaniu w settings
                await db.run(`
                  INSERT INTO settings (user_id, key, value)
                  VALUES (?, 'last_daily_summary_sent', ?)
                  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                `, [user.id, todayStr]);
                console.log(`[SCHEDULER] Z powodzeniem wysłano codzienne podsumowanie dla ${user.username} i ustawiono last_daily_summary_sent na ${todayStr}`);
              } catch (sendErr) {
                console.error(`[SCHEDULER ERROR] Błąd podczas wysyłania codziennego dla ${user.username}:`, sendErr.message);
              }
            } else {
              console.warn(`[SCHEDULER WARNING] Nie można wysłać codziennego podsumowania dla ${user.username} - brak zdefiniowanego e-maila.`);
            }
          }
        }

        // --- 2. Podsumowanie Tygodniowe ---
        if (currentDay === scheduledDay) {
          if (currentTimeStr >= scheduledTime) {
            if (lastWeeklySent !== todayStr) {
              console.log(`[SCHEDULER] Uruchamianie wysyłki tygodniowej dla ${user.username} (${user.email || 'brak e-maila'})`);
              if (user.email) {
                try {
                  await sendWeeklySummaryForUser(user.id);
                  // Zapisz informacje o wysłaniu w settings
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_weekly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, todayStr]);
                  console.log(`[SCHEDULER] Z powodzeniem wysłano tygodniowe podsumowanie dla ${user.username} i ustawiono last_weekly_summary_sent na ${todayStr}`);
                } catch (sendErr) {
                  console.error(`[SCHEDULER ERROR] Błąd podczas wysyłania tygodniowego dla ${user.username}:`, sendErr.message);
                }
              } else {
                console.warn(`[SCHEDULER WARNING] Nie można wysłać tygodniowego podsumowania dla ${user.username} - brak zdefiniowanego e-maila.`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Błąd w checkAndSendAutomatedSummaries:', err);
  }
}

// --- HARMONOGRAM GODZINOWY SYNCHRONIZACJI (5:00 - 22:00, potem przerwa nocna) ---
const SYNC_WINDOW_START_HOUR = 5;  // 5:00 rano
const SYNC_WINDOW_END_HOUR = 22;   // do 22:00 (10 wieczorem) włącznie

function isWithinSyncWindow(date = new Date()) {
  const hour = date.getHours();
  return hour >= SYNC_WINDOW_START_HOUR && hour <= SYNC_WINDOW_END_HOUR;
}

// Zapamiętujemy ostatnią godzinę (0-23), dla której wykonano synchronizację,
// żeby uruchamiać ją maksymalnie raz na godzinę zegarową.
let lastSyncedHourKey = null;

async function runHourlySyncIfDue() {
  const now = new Date();
  const hourKey = `${getLocalDateString()}T${now.getHours()}`;

  if (!isWithinSyncWindow(now)) {
    return; // Przerwa nocna (22:00 - 5:00) - brak synchronizacji
  }

  if (hourKey === lastSyncedHourKey) {
    return; // Synchronizacja dla tej godziny już wykonana
  }

  lastSyncedHourKey = hourKey;
  console.log(`[SCHEDULER] Uruchamianie godzinowej synchronizacji danych (godzina ${now.getHours()}:00)...`);
  try {
    await syncAllOura();
    await syncAllWithings();
    await syncAllGoogleFit();
    await checkAndSendAutomatedSummaries();
    await runWeeklyAdminReportIfDue();
    console.log('[SCHEDULER] Godzinowa synchronizacja i podsumowania zakończone.');
  } catch (err) {
    console.error('[SCHEDULER ERROR] Błąd podczas godzinowej synchronizacji:', err);
  }
}

async function runWeeklyAdminReportIfDue() {
  try {
    const todayStr = getLocalDateString(); // 'YYYY-MM-DD'
    const now = new Date();
    
    // getDay() = 1 (Poniedziałek)
    const currentDay = now.getDay() === 0 ? 7 : now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
    
    // Chcemy wysyłać w każdy poniedziałek (1) od godziny 08:00
    if (currentDay === 1 && currentTimeStr >= '08:00') {
      const lastSentRow = await db.get(`SELECT value FROM app_config WHERE key = 'last_admin_report_sent'`);
      const lastSentDate = lastSentRow ? lastSentRow.value : '';

      // Wyślij tylko raz w dany poniedziałek
      if (lastSentDate !== todayStr) {
        console.log(`[SCHEDULER] Uruchamianie tygodniowego raportu logów i bezpieczeństwa dla administratorów...`);
        await sendWeeklyAdminReport();
        
        await db.run(`
          INSERT INTO app_config (key, value)
          VALUES ('last_admin_report_sent', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `, [todayStr]);
        console.log(`[SCHEDULER] Z powodzeniem wysłano raport administratora i zaktualizowano last_admin_report_sent na ${todayStr}`);
      }
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Błąd podczas sprawdzania/wysyłania raportu administratora:', err.message);
  }
}

module.exports = {
  checkAndSendAutomatedSummaries,
  isWithinSyncWindow,
  runHourlySyncIfDue,
  runWeeklyAdminReportIfDue
};
