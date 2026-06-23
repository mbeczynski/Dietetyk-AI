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
7. **Synchronizacja z Apple Health**: kroki, kalorie i minuty aktywności można też zaciągać z Apple Health za pomocą webhooka - konfiguracja w zakładce Ustawienia.
8. **Synchronizacja z Google Fit**: analogicznie do Apple Health, aplikacja może też pobierać kroki i kalorie z Google Fit (synchronizacja godzinowa przez OAuth2, bez konieczności instalowania dodatkowej apki-pośrednika) - połączenie konta z poziomu zakładki Ustawienia.
9. **Połączenie konta z Google**: istniejące konto (założone login/hasłem) można dodatkowo połączyć z kontem Google w zakładce Ustawienia, żeby logować się jednym kliknięciem bez utraty historii posiłków i ustawień.

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
   chmod +x scripts/start.sh
   ./scripts/start.sh
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
Opcjonalny panel przeglądania bazy SQLite (sqlite-web) jest dostępny **tylko lokalnie** na
VPS pod adresem `http://127.0.0.1:8081` (świadomie niewystawiony publicznie - sqlite-web nie
ma własnej autoryzacji). Dostęp zdalny wymaga tunelu SSH z Twojego komputera:
```bash
ssh -L 8081:localhost:8081 deploy@<IP_VPS>
```
a następnie otwarcia `http://localhost:8081` lokalnie.

### Krok 5: Kopie zapasowe bazy danych
Backend sam tworzy kopie zapasowe pliku SQLite (przy starcie i co 24h, rotacja -
ostatnie 14 kopii) w katalogu `./data/backups` na VPS (patrz `backend/db.js`,
funkcja `backupDatabase`). To chroni przed uszkodzeniem/błędną migracją bazy,
ale **nie** przed awarią całego serwera/dysku - katalog `./data` to wciąż
jeden, lokalny wolumen. Dla realnego bezpieczeństwa danych zdrowotnych
użytkowników zalecane jest dodatkowo skopiowanie tego katalogu poza serwer,
np. cronem na VPS:
```bash
# /etc/cron.d/dietetyk-offsite-backup (przykład - dopasuj miejsce docelowe)
0 4 * * * root rsync -a /opt/dietetyk-ai/data/backups/ user@backup-host:/backups/dietetyk-ai/
```

---

## 🔐 Logowanie do GUI i Dostęp Admina

Konta użytkowników i domyślne hasła logowania są zdefiniowane lokalnie (zapisane w bazie danych). Dostępne loginy oraz hasła znajdziesz w pliku `passwords.txt` znajdującym się w katalogu głównym projektu (ten plik jest ignorowany przez git za pomocą `.gitignore` i nie zostanie upubliczniony).

Po zalogowaniu na konto administratora (`admin`), możesz przejść do zakładki **Ustawienia** lub do **Panelu Admina** (dostępnego w menu nawigacyjnym dla konta o roli `admin`), aby zarządzać konfiguracją całej aplikacji. Poświadczenia deweloperskie Oura Ring i Withings (potrzebne do integracji) są wprowadzane przez każdego użytkownika samodzielnie w zakładce **Ustawienia**.

---

## 🔌 Konfiguracja Integracji Oura, Withings, Apple Health, Google Fit, Konta Google i Gemini AI (Instrukcja Krok po Kroku)

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

### 3. Integracja Apple Health (kroki, kalorie, minuty aktywności)
W przeciwieństwie do Oura i Withings, Apple Health nie udostępnia publicznego API w chmurze - dane wysyła telefon przez webhook, za pomocą darmowej apki **Health Auto Export** (pośrednik między HealthKit a naszym backendem).
1. Zainstaluj apkę **Health Auto Export** z App Store na swoim iPhone.
2. Zaloguj się do Dietetyk AI i przejdź do zakładki **Ustawienia**, sekcja **Apple Health**. Skopiuj wygenerowany tam URL webhooka (zawiera Twój prywatny token synchronizacji, np. `https://dietetyk.renacode.com/api/integrations/apple-health/<token>`) - przyciskiem "Kopiuj" lub ręcznie. Jeśli chcesz, możesz w tym miejscu wygenerować nowy, losowy token (np. po podejrzeniu wycieku starego URL).
3. W apce Health Auto Export przejdź do zakładki **Automations** i utwórz nową automatyzację typu **REST API**.
4. Wklej skopiowany URL jako adres docelowy, format danych ustaw na **JSON**.
5. Wybierz metryki: **Steps**, **Active Energy**, **Basal Energy Burned**, **Apple Exercise Time**. Jeśli chcesz też uwzględniać treningi (np. bieganie, siłownię), dodaj drugą automatyzację typu **Treningi (Workouts)** wskazującą na ten sam URL.
6. Włącz automatyczne wysyłanie w tle (np. co godzinę) - dane trafią od razu do `health_metrics` z `activity_source = 'apple'` i będą widoczne na Dashboardzie bez potrzeby otwierania apki Dietetyk AI.

> Gdy zarówno Apple Health, jak i Oura są aktywne, dane z Apple Health są traktowane jako bardziej wiarygodne dla kroków/kalorii/minut aktywności (docierają od razu, podczas gdy Oura finalizuje dobowe podsumowanie zwykle następnego ranka) - Oura uzupełnia te wartości tylko wtedy, gdy Apple Health jeszcze nic nie przysłało dla danego dnia.

### 4. Integracja Google Fit (kroki, kalorie)
W przeciwieństwie do Apple Health (webhook) oraz Oura/Withings (poświadczenia per-użytkownik), Google Fit korzysta z OAuth2 i tych samych globalnych poświadczeń Google (Client ID/Secret), które administrator konfiguruje raz dla całej aplikacji w **Panelu Admina** (te same, co przy logowaniu Google) - dzięki temu zwykły użytkownik nie musi rejestrować własnej aplikacji deweloperskiej.
1. Administrator musi mieć skonfigurowane w **Panelu Admina** `google_client_id`/`google_client_secret` z [Google Cloud Console](https://console.cloud.google.com/), z dozwolonym przekierowaniem (Authorized redirect URI) ustawionym na `https://dietetyk.renacode.com/api/auth/google-fit/callback` oraz włączonym Fitness API (zakres `https://www.googleapis.com/auth/fitness.activity.read`).
2. Każdy użytkownik przechodzi do zakładki **Ustawienia**, sekcja **Google Fit**, i klika **"Połącz z Google Fit"**.
3. Po wybraniu konta Google i zaakceptowaniu uprawnień, dane trafiają automatycznie do `health_metrics` (synchronizacja co godzinę, w oknie 5:00-22:00, oraz natychmiast po połączeniu).
4. Połączenie można w każdej chwili odłączyć przyciskiem **"Odłącz integrację"** w tej samej sekcji.

> Granice doby dla danych z Google Fit są liczone przez API Google w UTC (Google nie udostępnia parametru strefy czasowej dla agregacji), co może powodować niewielkie (1-2h) przesunięcie względem dni liczonych w czasie Europe/Warsaw używanym w resztą aplikacji (Oura, Withings, Apple Health) - akceptowalny kompromis.
>
> Apple Health i Google Fit mają taki sam priorytet (oba mogą nadpisywać się wzajemnie, "kto ostatni zapisał") - tylko Apple Health ma pierwszeństwo przed Oura, zgodnie z opisem w punkcie 3.

### 5. Połączenie istniejącego konta z Google
Jeśli masz już konto założone loginem/hasłem (lub przez zaproszenie administratora) i chcesz dodatkowo móc logować się jednym kliknięciem przez Google, bez utraty historii posiłków i ustawień:
1. Zaloguj się normalnie (login/hasło) i przejdź do zakładki **Ustawienia**, sekcja **Konto Google**.
2. Kliknij **"Połącz z Google"** i wybierz konto Google, które chcesz powiązać.
3. Od tego momentu możesz logować się zarówno hasłem, jak i przyciskiem "Zaloguj się przez Google" na ekranie logowania - oba sposoby prowadzą do tego samego konta.
4. Połączenie można odłączyć przyciskiem **"Odłącz Google"** w tej samej sekcji (logowanie będzie wtedy możliwe tylko hasłem).

> To jest osobny mechanizm od logowania przez Google "od zera" - jeśli dane konto Google jest już powiązane z innym użytkownikiem Dietetyk AI, próba połączenia zwróci błąd (jeden google_id może być przypisany tylko do jednego konta).

### 6. Integracja z Gemini AI (Klucz API)
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
