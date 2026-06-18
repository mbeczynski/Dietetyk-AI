# 🥗 Dietetyk AI (AI Dietician)

Projekt zaawansowanej estetycznie aplikacji webowej, która analizuje Twoją dietę na bazie wprowadzanych posiłków (z wykorzystaniem **Gemini AI**), śledzi parametry zdrowotne z sensorów **Oura Ring** oraz **Withings** (inteligentna waga i skład ciała) oraz wizualizuje trendy na interaktywnych wykresach.

Aplikacja wspiera pełne szyfrowanie HTTPS (SSL Let's Encrypt) i jest przystosowana do wdrożenia na serwerze VPS za pomocą Docker Compose.

---

## 🚀 Główne Funkcje

1. **Dziennik Posiłków AI**: Wprowadzasz posiłki naturalnym językiem (np. *"Rano zjadłem 2 kromki chleba razowego z awokado i jajkiem sadzonym"*). Gemini AI automatycznie rozbija to na składniki, wylicza kalorie, makroskładniki (białko, węglowodany, tłuszcz), ocenia posiłek i generuje wskazówki.
2. **Bezpośrednia Integracja Oura Ring**: Pobieranie wskaźników regeneracji, takich jak wynik gotowości (Readiness), wynik snu (Sleep score), fazy snu (głęboki, REM), tętno spoczynkowe (RHR) oraz zmienność tętna (HRV).
3. **Bezpośrednia Integracja Withings**: Automatyczne pobieranie wskaźników składu ciała: wagi (kg), procentowej zawartości tkanki tłuszczowej oraz masy mięśniowej (kg).
4. **Wykresy Postępów (Custom SVG)**: Wbudowane, w pełni responsywne i wydajne wykresy SVG śledzące:
   - **Spalanie Tłuszczu**: Trend wagi powiązany z procentową zawartością tłuszczu w organizmie (wykres dwuosiowy).
   - **Przyrost Mięśni**: Trend czystej masy mięśniowej w czasie.
5. **Codzienna Analiza Gemini AI**: Model analizuje Twoje posiłki, parametry snu z Oura i skład ciała z Withings, dostarczając spersonalizowanych rekomendacji.
6. **Panel Admina**: Pozwala na dynamiczną konfigurację poświadczeń API dla Oura i Withings bezpośrednio z poziomu interfejsu (bez restartowania kontenerów).

---

## 🛠️ Architektura i Technologie

- **Backend**: Node.js + Express
- **Baza Danych**: SQLite (lokalny plik w katalogu `/data` zamontowanym jako wolumen)
- **Frontend**: React (Vite) stylizowany w nowoczesnym ciemnym motywie z efektem glassmorphismu
- **Konteneryzacja**: Docker + Docker Compose (Nginx z SSL reverse proxy + Node.js API + sqlite-web na porcie 8081)

---

## 💻 Jak Uruchomić Lokalnie (Development)

### Wymagania
- Zainstalowany **Node.js** (wersja 18+) oraz **npm**

### Szybki start
1. Nadaj uprawnienia do wykonania skryptu startowego i uruchom go:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
2. Skopiuj szablon środowiskowy i wklej swój klucz API z Google AI Studio w `backend/.env`:
   ```env
   GEMINI_API_KEY=TUTAJ_TWÓJ_KLUCZ_API
   ```
3. Uruchom serwer backendowy:
   ```bash
   cd backend
   npm start
   ```
4. Aplikacja będzie dostępna pod adresem: `http://localhost:3000` (z automatycznym proxy dla frontendu).

---

## ☁️ Wdrożenie na serwerze VPS (Docker Compose)

Obrazy backendu i frontendu są budowane i publikowane automatycznie przez GitHub
Actions (`.github/workflows/docker-publish.yml`) przy każdym pushu na `main` i
wypychane do `ghcr.io`. Serwer produkcyjny **nie buduje już kodu lokalnie** —
potrzebuje tylko `docker-compose.yml`, plików `.env` i katalogu `./data`, żeby
ściągnąć i podnieść gotowe obrazy.

> Ścieżka katalogu na serwerze to zawsze `/opt/dietetyk-ai` (małymi literami),
> niezależnie od tego, że repozytorium na GitHubie nazywa się `Dietetyk-AI`.
> Podawaj tę ścieżkę explicite jako argument `git clone` (jak poniżej) - nigdy
> nie pozwalaj git'owi nazwać katalogu samodzielnie na podstawie nazwy repo,
> bo wtedy powstanie wielkością liter niezgodny `Dietetyk-AI`. To samo
> `/opt/dietetyk-ai` jest zaszyte w joby `deploy` w workflow CI/CD oraz w
> `scripts/setup-deploy-user.sh`.

### Krok 0: Pierwsze uruchomienie - dedykowany użytkownik `deploy`
Jeśli to pierwsza konfiguracja serwera (lub migrujesz ze starszego, mniej
bezpiecznego ustawienia gdzie CI/CD logowało się jako `root`), uruchom na VPS
jako root skrypt `scripts/setup-deploy-user.sh` z tego repozytorium - tworzy on
nieprivilegiowanego użytkownika `deploy` (w grupie `docker`), przenosi
aplikację do `/opt/dietetyk-ai` i ustawia uprawnienia katalogu `./data` pod
nieprivilegiowanego użytkownika `node` wewnątrz kontenera backendu. Szczegóły
i kolejne kroki ręczne (Secrets w GitHub, autoryzacja klucza SSH) są opisane
w komentarzach na początku tego skryptu.

### Krok 1: Klonowanie repozytorium na VPS
Potrzebne tylko po to, by mieć `docker-compose.yml`, `docker/nginx.conf` i
`backend/.env` - kod aplikacji jest już zapakowany w obrazach z `ghcr.io`.
```bash
git clone https://github.com/mbeczynski/Dietetyk-AI.git /opt/dietetyk-ai
cd /opt/dietetyk-ai
```

### Krok 2: Przygotowanie Certyfikatów Let's Encrypt
Zainstaluj `certbot` na maszynie hosta VPS i wygeneruj certyfikat dla swojej domeny:
```bash
apt-get update && apt-get install -y certbot
certbot certonly --standalone -d dietetyk.renacode.com
```

### Krok 3: Plik Konfiguracyjny `.env` na VPS
Utwórz plik `/opt/dietetyk-ai/.env` i zdefiniuj ścieżki do wygenerowanych certyfikatów oraz klucz Gemini:
```env
SSL_CERT_PATH=/etc/letsencrypt/live/dietetyk.renacode.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/dietetyk.renacode.com/privkey.pem
```
W katalogu `/opt/dietetyk-ai/backend/.env` utwórz konfigurację dla backendu:
```env
PORT=3000
GEMINI_API_KEY=twój_klucz_api_gemini
GEMINI_MODEL=gemini-1.5-flash
SYNC_TOKEN=twoje_bezpieczne_haslo_synchronizacji
APP_PASSWORD=dietetyk-admin
```
Katalog `./data` musi być zapisywalny dla uid 1000 (`chown -R 1000:1000 ./data`) -
kontener backendu działa wewnątrz jako nieprivilegiowany użytkownik `node`, nie root.

### Krok 4: Uruchomienie kontenerów
```bash
docker compose pull
docker compose up -d
```
Po tym kroku każdy kolejny push na `main` automatycznie odświeży kontenery przez
CI/CD (job `deploy` w `docker-publish.yml`) - ręczne `docker compose pull/up`
jest potrzebne tylko przy pierwszym uruchomieniu.
Aplikacja zostanie automatycznie uruchomiona na portach `80` i `443` (z automatycznym przekierowaniem na HTTPS).
Opcjonalnie panel przeglądania bazy SQLite (sqlite-web) jest dostępny pod adresem `http://<IP_VPS>:8081`.

---

## 🔐 Logowanie do GUI i Dostęp Admina

Konta użytkowników i domyślne hasła logowania są zdefiniowane lokalnie (zapisane w bazie danych). Dostępne loginy oraz hasła znajdziesz w pliku `passwords.txt` znajdującym się w katalogu głównym projektu (ten plik jest ignorowany przez git za pomocą `.gitignore` i nie zostanie upubliczniony).

Po zalogowaniu na konto administratora (`admin`), możesz przejść do zakładki **Ustawienia** lub do **Panelu Admina** (dostępnego w menu nawigacyjnym dla konta o roli `admin`), aby zarządzać konfiguracją całej aplikacji. Poświadczenia deweloperskie Oura Ring i Withings (potrzebne do integracji) są wprowadzane przez każdego użytkownika samodzielnie w zakładce **Ustawienia**.

---

## 🔌 Konfiguracja Integracji Oura, Withings i Gemini AI (Instrukcja Krok po Kroku)

Aby dane o Twoim śnie, aktywności oraz składzie ciała były pobierane automatycznie z zewnętrznych sensorów, a sztuczna inteligencja mogła analizować Twoją dietę na bazie Twojego prywatnego klucza API, wprowadź odpowiednie poświadczenia w zakładce **Ustawienia**.

### 1. Integracja Oura Ring (Sen, HRV, Aktywność)
1. Zaloguj się na swoje konto Oura na stronie [Oura Developer Portal](https://developer.ouraring.com/applications).
2. Kliknij przycisk **"Create New Application"**.
3. Wypełnij pola szczegółów aplikacji (np. Nazwa: `Dietetyk AI`, Opis: `Aplikacja do monitorowania diety i zdrowia`).
4. W polu **"Redirect URIs"** dodaj poniższy adres zwrotny (zamień `dietetyk.renacode.com` na adres swojej domeny, jeśli wdrożyłeś ją pod inną):
   `https://dietetyk.renacode.com/api/auth/oura/callback`
5. Zapisz aplikację. Zostanie wygenerowany **Client ID** oraz **Client Secret**.
6. Skopiuj je i wklej w zakładce **Ustawienia** w sekcji Oura Ring w aplikacji Dietetyk AI, a następnie kliknij **"Zapisz poświadczenia integracji"** i kliknij **"Połącz z Oura"**, aby autoryzować połączenie.

### 2. Integracja Withings (Waga i Skład Ciała)
1. Zaloguj się na swoje konto Withings na stronie [Withings Developer Portal](https://developer.withings.com/).
2. Przejdź do panelu partnerskiego (**"Partner Dashboard"**).
3. Utwórz nową aplikację deweloperską.
4. Jako **"Callback URL"** (lub Redirect URI) podaj:
   `https://dietetyk.renacode.com/api/auth/withings/callback`
5. Wybierz zakresy danych (scopes) dotyczące wagi i składu ciała.
6. Po utworzeniu aplikacji otrzymasz **Client ID** (identyfikator klienta) oraz **Client Secret** (klucz prywatny).
7. Skopiuj te dane i wprowadź je w zakładce **Ustawienia** w sekcji Withings w aplikacji Dietetyk AI, kliknij **"Zapisz poświadczenia integracji"**, a następnie kliknij **"Połącz z Withings"**, aby autoryzować połączenie.

### 3. Integracja z Gemini AI (Klucz API)
1. Wejdź na stronę [Google AI Studio](https://aistudio.google.com/).
2. Zaloguj się za pomocą swojego konta Google.
3. Kliknij przycisk **"Get API Key"**.
4. Kliknij **"Create API Key"** (możesz utworzyć klucz w nowym projekcie Google Cloud lub wybrać istniejący).
5. Skopiuj nowo wygenerowany klucz API.
6. Wklej go w zakładce **Ustawienia** w sekcji Gemini AI w aplikacji Dietetyk AI i kliknij **"Zapisz poświadczenia integracji"**. Gdy klucz jest ustawiony, analizy posiłków oraz wskazówki dietetyczne na Dashboardzie będą działały z Twoim własnym limitem zapytań.

---

## 🌍 Hosting i Współpraca (Contributions)

- **Hosting**: Aplikacja produkcyjna jest hostowana pod adresem: [https://dietetyk.renacode.com](https://dietetyk.renacode.com).
- **Współpraca (Pull Requests)**: Zachęcamy do tworzenia Pull Requestów (PR) z dowolnymi zmianami, ulepszeniami lub nowymi funkcjami, które chcesz wprowadzić.
- **Gałąź Główna**: Główna gałąź repozytorium (`master` / `main`) jest chroniona (protected), co oznacza, że wszystkie zmiany muszą być wprowadzane za pomocą Pull Requestów i przechodzić weryfikację.
