#!/usr/bin/env bash
#
# setup-deploy-user.sh
#
# Jednorazowy skrypt konfiguracyjny dla NOWEGO serwera VPS (lub migracji ze
# starszego ustawienia, w którym CI/CD logowało się po SSH jako "root").
# Uruchom jako root:
#
#   sudo bash scripts/setup-deploy-user.sh
#
# Co robi:
#   1. Tworzy nieprivilegiowanego użytkownika systemowego "deploy" (bez prawa
#      do sudo), członka grupy "docker" - wystarczające uprawnienia, by
#      wykonywać `docker compose pull/up/logs`, ale nie więcej.
#   2. Przenosi (lub klonuje, jeśli jeszcze nie istnieje) repozytorium do
#      /opt/dietetyk-ai - to ta sama ścieżka, która jest na sztywno zaszyta
#      w jobie "deploy" w .github/workflows/docker-publish.yml.
#   3. Ustawia właściciela katalogu /opt/dietetyk-ai na użytkownika "deploy",
#      a katalog ./data (wolumen montowany do kontenera backendu) na
#      uid:gid 1000:1000 - to jest użytkownik "node" wbudowany w obraz
#      node:20-slim, na którym backend działa (patrz docker/backend.Dockerfile),
#      a NIE na użytkownika "deploy". Bez tego backend nie ma prawa zapisu
#      do bazy SQLite w ./data.
#   4. Przygotowuje katalog ~/.ssh/ użytkownika "deploy" pod klucz CI/CD
#      (samego klucza nie generuje - patrz "Kolejne kroki ręczne" poniżej).
#
# Kolejne kroki RĘCZNE (skrypt ich nie wykonuje automatycznie):
#   a) Wygeneruj NOWĄ, dedykowaną parę kluczy SSH tylko do CI/CD (nie używaj
#      swojego osobistego klucza):
#        ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key -N ""
#   b) Dopisz klucz PUBLICZNY (deploy_key.pub) do
#        /home/deploy/.ssh/authorized_keys
#   c) Klucz PRYWATNY (deploy_key) wklej jako sekret VPS_SSH_KEY w
#      Settings -> Secrets and variables -> Actions w repo na GitHubie.
#   d) Ustaw też sekrety VPS_HOST, VPS_USER=deploy oraz (opcjonalnie)
#      VPS_SSH_PORT - patrz komentarz na początku docker-publish.yml.
#   e) Upewnij się, że w /opt/dietetyk-ai istnieje plik backend/.env
#      (lub odpowiednio zamontowany) z prawdziwymi sekretami produkcyjnymi
#      (APP_PASSWORD / OAUTH_STATE_SECRET, APP_URL, dane SMTP itd.) - skrypt
#      go nie tworzy, bo nie ma znać Twoich sekretów.
#
# Skrypt jest idempotentny - bezpiecznie odpalić go drugi raz (np. po migracji
# z root-owego ustawienia), nie nadpisze istniejącego repozytorium ani konta.

set -euo pipefail

APP_DIR="/opt/dietetyk-ai"
DEPLOY_USER="deploy"
REPO_URL="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "BŁĄD: ten skrypt musi być uruchomiony jako root (sudo bash $0)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "BŁĄD: Docker nie jest zainstalowany na tym serwerze. Zainstaluj Docker" >&2
  echo "i docker compose plugin przed uruchomieniem tego skryptu." >&2
  exit 1
fi

# 1. Użytkownik "deploy" (bez sudo, tylko grupa "docker")
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "[1/4] Użytkownik '$DEPLOY_USER' już istnieje - pomijam tworzenie."
else
  echo "[1/4] Tworzenie nieprivilegiowanego użytkownika '$DEPLOY_USER'..."
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$DEPLOY_USER"
else
  echo "OSTRZEŻENIE: grupa 'docker' nie istnieje - sprawdź instalację Dockera." >&2
fi

# 2. Katalog aplikacji
echo "[2/4] Przygotowanie $APP_DIR..."
if [ -d "$APP_DIR/.git" ]; then
  echo "  $APP_DIR już jest repozytorium git - pomijam klonowanie."
elif [ -n "$REPO_URL" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
else
  mkdir -p "$APP_DIR"
  echo "  OSTRZEŻENIE: katalog $APP_DIR pusty i nie podano adresu repozytorium."
  echo "  Sklonuj je ręcznie: git clone <adres-repo> $APP_DIR"
  echo "  (Ważne: podaj ścieżkę docelową $APP_DIR explicite, inaczej git użyje"
  echo "  nazwy z GitHuba, czyli wielką literą - Dietetyk-AI - co nie zgadza"
  echo "  się ze ścieżką zaszytą w workflow CI/CD.)"
fi

# 3. Uprawnienia: katalog repo dla "deploy", dane dla uid 1000 (node w kontenerze)
echo "[3/4] Ustawianie właścicieli katalogów..."
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"
mkdir -p "$APP_DIR/data"
chown -R 1000:1000 "$APP_DIR/data"

# 4. Katalog ~/.ssh dla klucza CI/CD
echo "[4/4] Przygotowanie ~/.ssh dla '$DEPLOY_USER'..."
DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
mkdir -p "$DEPLOY_HOME/.ssh"
touch "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 700 "$DEPLOY_HOME/.ssh"
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_HOME/.ssh"

cat <<EOF

Gotowe. Konto '$DEPLOY_USER' utworzone, $APP_DIR i $APP_DIR/data mają
poprawne uprawnienia.

Następne kroki RĘCZNE (patrz pełny opis w komentarzu na początku tego
skryptu):
  1. Wygeneruj dedykowaną parę kluczy SSH dla CI/CD.
  2. Dopisz klucz publiczny do: $DEPLOY_HOME/.ssh/authorized_keys
  3. Klucz prywatny + adres serwera dodaj jako sekrety GitHub Actions
     (VPS_HOST, VPS_USER=deploy, VPS_SSH_KEY, opcjonalnie VPS_SSH_PORT).
  4. Umieść w $APP_DIR plik backend/.env z prawdziwymi sekretami produkcyjnymi.
EOF
