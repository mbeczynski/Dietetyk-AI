#!/usr/bin/env bash
# scripts/vps_backup_db.sh
#
# Skrypt do tworzenia kopii zapasowej produkcyjnej bazy SQLite na VPS
# z automatycznym czyszczeniem starych kopii (retencja).
#
# Można dodać do crontaba roota (np. codziennie o 3:00 w nocy):
#   0 3 * * * /opt/dietetyk-ai/scripts/vps_backup_db.sh >> /var/log/db_backup.log 2>&1
#

set -e

# --- KONFIGURACJA ---
DB_DIR="/opt/dietetyk-ai/data"
DB_FILE="$DB_DIR/dietetyk.db"
BACKUP_DIR="$DB_DIR/backups"
RETENTION_DAYS=14
# ---------------------

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/dietetyk-vps-$TIMESTAMP.db"

echo "=== [$(date)] Rozpoczęcie tworzenia kopii zapasowej ==="

# 1. Upewnij się, że katalog na backupy istnieje
if [ ! -d "$BACKUP_DIR" ]; then
    echo "Tworzenie katalogu na kopie zapasowe: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
fi

# 2. Sprawdź, czy baza danych istnieje
if [ ! -f "$DB_FILE" ]; then
    echo "BŁĄD: Plik bazy danych nie istnieje pod ścieżką: $DB_FILE"
    exit 1
fi

# 3. Wykonanie checkpointa w kontenerze (jeśli kontener działa) w celu scalenia WAL do pliku głównego .db
if docker ps --format '{{.Names}}' | grep -q '^dietetyk-backend$'; then
    echo "Wymuszanie zapisu WAL (checkpoint) w działającym kontenerze backendu..."
    # Wywołujemy node w kontenerze, żeby bezpiecznie wykonać checkpoint bez potrzeby instalowania sqlite3
    docker exec dietetyk-backend node -e "
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('/app/data/dietetyk.db');
        db.run('PRAGMA wal_checkpoint(FULL);', (err) => {
            if (err) console.error('Błąd checkpointa:', err.message);
            else console.log('WAL checkpoint zakończony sukcesem.');
            db.close();
        });
    " || echo "Ostrzeżenie: Nie udało się wykonać checkpointa w kontenerze."
else
    echo "Kontener dietetyk-backend nie działa, kopiuję plik bazy bezpośrednio."
fi

# 4. Bezpieczne kopiowanie pliku bazy danych
echo "Kopiowanie pliku bazy danych do: $BACKUP_FILE"
cp "$DB_FILE" "$BACKUP_FILE"

# 5. Ustawienie bezpiecznych uprawnień (tylko właściciel może czytać/pisać)
chmod 600 "$BACKUP_FILE"
# Przypisanie właściciela deploy:deploy (jeśli skrypt odpala root)
if [ "$(id -u)" -eq 0 ]; then
    chown deploy:deploy "$BACKUP_FILE" 2>/dev/null || true
fi

echo "Kopia zapasowa utworzona pomyślnie."

# 6. Usuwanie starych kopii zapasowych (retencja)
echo "Czyszczenie kopii zapasowych starszych niż $RETENTION_DAYS dni..."
# Szukamy zarówno kopii manualnych/vps (dietetyk-vps-*.db) jak i automatycznych z backendu (dietetyk-*.db)
# ale upewniamy się, że nie usuniemy samej bazy głównej ani innych ważnych plików.
find "$BACKUP_DIR" -type f -name "dietetyk-*.db" -mtime +$RETENTION_DAYS -print -delete

echo "=== [$(date)] Backup zakończony pomyślnie. ==="
echo ""
