#!/bin/bash
# deploy_pull.sh
#
# Nowy, "profesjonalny" deployment: kod jest budowany i publikowany jako obrazy
# Docker przez GitHub Actions (.github/workflows/docker-publish.yml) przy każdym
# pushu na main. Serwer NIE buduje już niczego z kodu - tylko ściąga gotowe
# obrazy z ghcr.io i podnosi kontenery.
#
# Wymaga jednorazowego zalogowania do ghcr.io (patrz sekcja "JEDNORAZOWA
# KONFIGURACJA" w komentarzu poniżej) zanim pierwszy raz uruchomisz ten skrypt,
# jeśli pakiety w ghcr.io są prywatne.
#
# Użycie (na serwerze, w katalogu z docker-compose.yml):
#   chmod +x deploy_pull.sh
#   ./deploy_pull.sh

set -e

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "BŁĄD: nie znaleziono ani 'docker-compose', ani wtyczki 'docker compose'."
  exit 1
fi
echo "Używam komendy: $COMPOSE"

echo ""
echo "=== 1. Szybki backup bazy danych przed aktualizacją ==="
BACKUP_DIR="/root/backup_dietetyk_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r ./data "$BACKUP_DIR/data" 2>/dev/null || echo "(brak ./data w tym katalogu - pomijam backup)"
echo "Backup: $BACKUP_DIR"

echo ""
echo "=== 2. Pobranie najnowszych obrazów z ghcr.io ==="
$COMPOSE pull dietetyk-backend dietetyk-frontend

echo ""
echo "=== 3. Restart kontenerów na nowych obrazach ==="
$COMPOSE up -d dietetyk-backend dietetyk-frontend

echo ""
echo "=== 4. Status i logi (Ctrl+C aby przerwać podgląd) ==="
$COMPOSE ps
echo ""
echo "Sprawdź https://dietetyk.renacode.com"
echo ""
$COMPOSE logs -f dietetyk-backend
