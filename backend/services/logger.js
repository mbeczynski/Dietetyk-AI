const db = require('../db');

/**
 * Zapisuje zdarzenie logu do konsoli oraz asynchronicznie do bazy danych.
 */
async function logEvent({ level, category, message, ip = null, userId = null, details = null }) {
  try {
    const consoleMsg = `[${level}][${category}] ${message}${ip ? ` (IP: ${ip})` : ''}${userId ? ` (UID: ${userId})` : ''}`;
    
    // Logowanie na standardowe wyjście konsoli (dla Dockera/PM2)
    if (level === 'ERROR') {
      console.error(consoleMsg, details || '');
    } else if (level === 'WARN' || level === 'SECURITY') {
      console.warn(consoleMsg, details || '');
    } else {
      console.log(consoleMsg, details || '');
    }

    // Konwersja detali do stringu
    let detailsStr = '';
    if (details) {
      if (details instanceof Error) {
        detailsStr = `${details.message}\n${details.stack}`;
      } else if (typeof details === 'object') {
        try {
          detailsStr = JSON.stringify(details);
        } catch (e) {
          detailsStr = String(details);
        }
      } else {
        detailsStr = String(details);
      }
    }

    // Bezpieczne wstawienie do bazy danych SQLite w tle (nie blokujemy wątku głównego)
    // Sprawdzamy czy db jest zainicjalizowany i posiada funkcję run
    if (db && typeof db.run === 'function') {
      db.run(
        `INSERT INTO app_logs (level, category, message, ip, user_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
        [level, category, message, ip, userId, detailsStr],
        (err) => {
          if (err) {
            console.error('[LOGGER DB ERROR] Nieudany zapis logu do bazy:', err.message);
          }
        }
      );
    }
  } catch (err) {
    console.error('[LOGGER CRITICAL ERROR] Krytyczny błąd loggera:', err.message);
  }
}

const logger = {
  info: (message, category = 'SYSTEM', details = null, ip = null, userId = null) => 
    logEvent({ level: 'INFO', category, message, ip, userId, details }),
  
  warn: (message, category = 'SYSTEM', details = null, ip = null, userId = null) => 
    logEvent({ level: 'WARN', category, message, ip, userId, details }),
  
  error: (message, category = 'SYSTEM', details = null, ip = null, userId = null) => 
    logEvent({ level: 'ERROR', category, message, ip, userId, details }),
  
  security: (message, category = 'SECURITY', details = null, ip = null, userId = null) => 
    logEvent({ level: 'SECURITY', category, message, ip, userId, details })
};

module.exports = logger;
