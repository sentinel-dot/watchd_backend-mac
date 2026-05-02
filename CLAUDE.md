# Watchd

Tinder-style Movie-Matching-App: zwei User swipen in einem gemeinsamen "Room" auf Filme und erhalten eine Match-Benachrichtigung (inkl. Streaming-Verfügbarkeit via JustWatch) wenn beide denselben Film liken.

> **Diese Datei aktuell halten.** Nach jeder Codeänderung aktualisieren: neue Routes, Views, Env-Vars, umbenannte Dateien, behobene Bugs, neue bekannte Fehler.

---

## Tech Layers

### Backend (`watchd_backend-mac/`)

- **Framework**: Express + Socket.io
- **Sprache**: TypeScript (Node.js 22 via `.nvmrc`, `engines.node >=22`, CI auf Node 22)
- **Datenbank**: MySQL (mysql2 Pool, 10 Connections, UTC timezone)
- **Auth**: JWT — Access-Token (kurz) + Refresh-Rotation mit theft detection via `family_id`
- **Push**: APNs via `@parse/node-apn` (lazy-initialized beim ersten Aufruf)
- **Mail**: Nodemailer; SMTP oder Console-Fallback wenn `SMTP_HOST` leer
- **Cache**: LRU (2000 Einträge, 1h TTL) für TMDB; 1h pro `movieId` für JustWatch
- **Code-Quality**: ESLint (Flat Config + `typescript-eslint`) + Prettier; CI prüft `lint`, `format:check`, `typecheck`, `test`
- **Deployment**: Railway — `https://watchd.up.railway.app` (`npm run build` → `npm start`, kein Dockerfile)
- **Testing**: Vitest + Supertest gegen echte `watchd_test`-DB (Socket.io, APNs, Mail, TMDB, JustWatch, partnership-stack gemockt — `appendPartnershipStack` wird per `vi.importActual` in `partnership-stack-append.integration.test.ts` real gegen DB + gemocktes `global.fetch` getestet, `generatePartnershipStack` analog in `partnership-stack-generate.integration.test.ts` (Happy Path / Regen-Wipe / Exhausted / Fehlerpropagation); `movies.integration.test.ts` sichert den Lazy-Refill-Trigger in den Movie-Routes mit gemocktem `appendPartnershipStack` ab: `<=10` unseen, `stack_exhausted`, atomarer Lock bei Parallel-Requests, 403 für Nicht-Mitglieder. `socket.integration.test.ts` testet den echten `initSocket` (JWT-Verify + Partnership-Membership) via `vi.importActual` auf einem dedizierten httpServer + `socket.io-client` — der in `setup.ts` gestartete Shared-Server bleibt ohne Socket-Attachment. `partnerships.integration.test.ts` deckt alle 8 Endpoints (request/accept/decline/cancel-request/list/detail/filters/delete) inkl. 4xx-Pfaden, Push-Spy, Socket-Spy und Cascade-Verifikation ab). `pool: 'threads'`, `fileParallelism: false`, `isolate: false` — single Worker teilt Module (inkl. DB-Pool + httpServer) über alle Files. `setup.ts` initialisiert Server einmalig (idempotentes `beforeAll`, kein `afterAll` — Prozess-Exit räumt auf). Mock-Factories sind **idempotent** (Instanzen in `globalThis.__watchdMocks` gecached) — sonst erzeugt jede Factory-Ausführung pro File frische `vi.fn()`s und entkoppelt sie vom einmalig erzeugten App-Instanz → flaky Socket/Mail-Spy-Tests je nach File-Reihenfolge. **`share-code.unit.test.ts` darf nicht `vi.spyOn(pool, 'query')` mit `mockRestore()` nutzen — unter `isolate: false` leakt der Spy file-übergreifend. Stattdessen `pool.query` direkt mit einem `vi.fn()` ersetzen und in `afterEach` per gespeicherter Referenz zurückschreiben.** `createApp({ skipRateLimiter: true })` für Tests. Design: echte Test-DB statt Mock (Migrations-Parität mit Prod); nur externe / Side-effect-Module gemockt. **Nicht getestet**: `token-cleanup.ts` (scheduled, kein deterministischer Testpunkt), APNs/Mail/TMDB/JustWatch (gemockt — Unit-Tests darüber bringen keinen Mehrwert), iOS (kein MVP-ROI), E2E, echte Concurrency jenseits der abgesicherten `stack_generating`-/`INSERT IGNORE`-Pfade.

### iOS App (`watchd/`)

- **Framework**: SwiftUI (iOS 16+, Xcode 16+)
- **Architektur**: MVVM — alle ViewModels `@MainActor ObservableObject`
- **Netzwerk**: `URLSession` actor (`APIService`), Socket.io (vendored, v16.1.1)
- **Storage**: Keychain (`com.watchd.app`)
- **Theme**: Velvet Hour — Base `#14101E`, Champagne-Accent `#D3A26B`, Bluu Next Display + Manrope Body

---

## Projektstruktur

```
watchd_backend-mac/src/
├── index.ts              # Dünner Wrapper: dotenv, createApp(), initSocket, Signal-Handler,
│                         # start() mit applyDevSchemaIfEnabled + scheduleTokenCleanup + listen
├── app.ts                # createApp({ skipRateLimiter? }) Factory:
│                         # Middleware, Routes, /health, /.well-known/...,
│                         # /reset-password, /add/:code,
│                         # 404, Error-Middleware; returns { app, httpServer, parsedOrigins }
│                         # Rate limits: auth 10/15min per IP, swipes 120/min per IP,
│                         # /api/partnerships/request 10/min per IP
│                         # (skipRateLimiter=true für Tests)
├── config.ts             # Alle Env-Vars validiert beim Start (startup throw wenn Required fehlt)
├── logger.ts             # Pino (pino-pretty in development)
├── middleware/
│   └── auth.ts           # JWT-Middleware; extrahiert userId, email
├── db/
│   ├── connection.ts     # mysql2 Pool
│   ├── schema.sql        # 9 Tabellen (Partnerships-Schema): users, refresh_tokens,
│   │                     # password_reset_tokens, partnerships, partnership_members,
│   │                     # partnership_stack, swipes, matches, favorites
│   └── apply-schema.ts   # Dev-only: auto-apply wenn WATCHD_APPLY_SCHEMA=1
├── routes/
│   ├── auth.ts           # register (mit share_code-Generierung), login, refresh,
│   │                     # forgot-password, reset-password, logout, delete-account
│   │                     # (kein /guest, kein /upgrade — Gast-Zugang entfällt)
│   ├── users.ts          # PATCH /me, POST /me/device-token,
│   │                     # GET /me/share-code, POST /me/share-code/regenerate
│   ├── partnerships.ts   # request (Code-Lookup → pending), accept (Addressee → active +
│   │                     # initialer Stack), decline (hard-delete), cancel-request
│   │                     # (Requester-only), list ({incoming,outgoing,active}),
│   │                     # detail, update-filters (regen Stack), delete (cascade +
│   │                     # PARTNERSHIP_ENDED + disconnectSockets)
│   ├── movies.ts         # feed?partnershipId=&afterPosition= (paginiert),
│   │                     # /partnerships/:partnershipId/next-movie (einzeln).
│   │                     # Refill-Trigger: wenn unseenMovies ≤ 10 → atomares stack_generating-Lock
│   │                     # → fire-and-forget appendPartnershipStack(); stack_exhausted blockiert Trigger
│   ├── swipes.ts         # POST /swipes (partnershipId) → Matchmaking + Push
│   └── matches.ts        # list (:partnershipId), mark-watched, add/remove/list favorites
├── services/
│   ├── tmdb.ts           # TMDB API Client mit LRU-Cache
│   ├── justwatch.ts      # JustWatch GraphQL; flatrate + free; iconPath für /icons/*.png
│   ├── matchmaking.ts    # Kernlogik: alle Members swiped right → INSERT IGNORE (race-safe)
│   │                     # auf partnership_id; liest aus partnership_members + swipes
│   ├── partnership-stack.ts # generatePartnershipStack(partnershipId, filters): 5 TMDB-Pages
│   │                     # → gefiltert → DB. appendPartnershipStack(partnershipId): Lazy Refill
│   │                     # — liest filters + stack_next_page aus partnerships, fetcht nächsten
│   │                     # Batch (5 Seiten), INSERT IGNORE, setzt stack_next_page /
│   │                     # stack_generating / stack_exhausted zurück
│   ├── share-code.ts     # generateShareCode() (8-char Crockford Base32),
│   │                     # generateUniqueShareCode() mit max 5 Retries gegen
│   │                     # users.share_code UNIQUE + Profanity-Blocklist
│   ├── apns.ts           # APNs Push-Service: sendMatchPush (mit partnershipId+movieId
│   │                     # Payload), sendPartnershipRequestPush, sendPartnershipAcceptedPush
│   ├── mail.ts           # Password-Reset-Mail; deep link: watchd://reset-password?token=TOKEN
│   └── token-cleanup.ts  # Scheduled Job (alle 6h, erster Run 30s nach Start):
│                         # expired refresh tokens + used reset tokens
│                         # (kein Guest-Cleanup mehr — Gast-Zugang entfällt)
├── socket/
│   ├── index.ts          # JWT-Auth + (optional) Partnership-Membership-Check beim JOIN.
│   │                     # JOIN-Payload: { token, partnershipId? }. Joint immer
│   │                     # `user:<userId>` (für PARTNERSHIP_REQUEST/ACCEPTED) und —
│   │                     # falls partnershipId — zusätzlich `partnership:<id>`.
│   │                     # Emits: joined, error, match, partner_joined, partner_left,
│   │                     #        partnership_ended, partnership_request,
│   │                     #        partnership_accepted, filters_updated
│   └── events.ts         # Enum aller Socket.io Event-Namen
└── tests/
    ├── global-setup.ts   # CREATE DATABASE watchd_test + schema.sql anwenden
    ├── setup.ts          # createApp({skipRateLimiter:true}) + alle Mocks zentral
    │                     # (socket, apns, mail, tmdb, justwatch, partnership-stack)
    │                     # Module wird einmalig pro Worker evaluiert (isolate:false) —
    │                     # beforeAll startet den Server nur wenn !httpServer.listening;
    │                     # beforeEach: truncateAll() + clearAllMocks(); kein afterAll
    ├── helpers.ts        # createUser, createPartnership, createPendingRequest,
    │                     # seedStackMovie (partnership_stack), seedSwipe
    │                     # (partnershipId), seedMatch (partnershipId)
    ├── unit/             # auth.unit (decodeRefreshToken), middleware.unit,
    │                     # partnership-stack.unit (buildTmdbUrl),
    │                     # share-code.unit (Alphabet, Länge, Profanity,
    │                     # Kollisions-Retry, Throw nach 5 Kollisionen)
    └── integration/      # auth (Register-share_code, Cascade auf Partnerships),
                          # swipes-matchmaking, partnerships (alle 8 Endpoints +
                          # 4xx-Pfade), movies (Pagination, Swipe-Filter,
                          # Lazy-Refill-Trigger, Member-403), matches (watched-
                          # Toggle, Favorites, Offset-Pagination mit expliziten
                          # Timestamps, Limit-Clamp auf 50, Member-403),
                          # users (PATCH /me, device-token, share-code GET/regen),
                          # partnership-stack-append (Lazy-Refill: Lock,
                          # Page-Increment, Exhausted-Flag, Dedup, Fehlerpfad),
                          # partnership-stack-generate (Initial-Generation:
                          # Happy Path, Regen-Wipe, Exhausted, Fehler-
                          # propagation — beide nutzen vi.importActual +
                          # gemocktes global.fetch),
                          # socket (JOIN-Handshake: JWT-Verify + Partnership-
                          # Membership, optionale partnershipId für user-only
                          # channel — nutzt vi.importActual + eigenen httpServer
                          # + socket.io-client; Shared-Server bleibt unberührt)

watchd/watchd/
├── watchdApp.swift       # @main; deep link handling (`watchd://reset-password?token=...`,
│                         # `watchd://add/CODE`, Universal Links `/reset-password`,
│                         # `/add/:code`); add-Code wird bis nach Login gequeued
├── ContentView.swift     # Root: AuthView (nicht auth) / MainTabView (auth); ResetPassword-Sheet
├── AppDelegate.swift     # APNs-Token → hex → POST /users/me/device-token; foreground
│                         # notifications; Push-Tap-Routing für match /
│                         # partnership_request / partnership_accepted
├── AppNavigation.swift   # App-interne Navigation-Events + queued Deep-Link/Push-Ziele
├── Config/
│   ├── APIConfig.swift          # Base URLs (Debug: localhost:3000, Release: Railway); #if DEBUG
│   ├── Theme.swift              # struct Theme + einzige Instanz Theme.velvetHour; ThemeFonts
│   ├── Color+Tokens.swift       # VelvetHourPalette enum + ThemeColors.velvetHour
│   ├── ThemeEnvironment.swift   # @Environment(\.theme) EnvironmentKey + Extension
│   ├── ThemeManager.swift       # Leer-Stub (kein Switching mehr nötig)
│   └── FontRegistry.swift       # registerAll() — BluuNext + Manrope (6 Dateien)
├── Fonts/                 # BluuNext-Bold/-BoldItalic + Manrope-Regular/Medium/SemiBold/Bold
├── Models/               # Codable structs (snake_case → camelCase via keyDecodingStrategy)
│   ├── AuthModels.swift          # Auth requests/responses, User struct
│   ├── MovieModels.swift         # Movie, StreamingOption, SwipeResponse/SwipeInfo, MatchInfo
│   ├── PartnershipModels.swift   # Partnership, PartnerUser, PartnershipFilters,
│   │                             # PartnershipsListResponse, PartnershipDetailResponse,
│   │                             # AddPartnerRequest, ShareCodeResponse,
│   │                             # PartnershipRequest/Accepted/EndedSocketEvent
│   └── MatchModels.swift         # Match (partnershipId), MatchMovie, Favorite,
│                                 # SocketMatchEvent, FavoritesResponse
├── Services/
│   ├── APIService.swift      # actor — thread-safe async/await URLSession; Auto-refresh bei 401
│   │                         # isRefreshing-Flag verhindert parallele Refreshes; Timeout: 30s
│   │                         # Partnership-Methoden: fetchPartnerships, fetchPartnership,
│   │                         # requestPartnership, acceptPartnership, declinePartnership,
│   │                         # cancelPartnershipRequest, deletePartnership,
│   │                         # updatePartnershipFilters, fetchShareCode, regenerateShareCode,
│   │                         # fetchFeedForPartnership, fetchNextMovieForPartnership,
│   │                         # swipeForPartnership, fetchMatchesForPartnership
│   ├── KeychainHelper.swift  # Keys: jwt_token, jwt_refresh_token, user_id, user_name, user_email
│   ├── NetworkMonitor.swift  # @MainActor ObservableObject; NWPathMonitor → @Published isConnected
│   └── SocketService.swift   # @MainActor Singleton; connect(token:partnershipId:)
│                             # Publishers: matchPublisher, partnerFiltersUpdatedPublisher,
│                             # partnerLeftPublisher, partnerJoinedPublisher,
│                             # partnershipRequestPublisher, partnershipAcceptedPublisher,
│                             # partnershipEndedPublisher
│                             # Lifecycle: connect() bei Login/Session-Restore (AuthViewModel);
│                             # disconnect() bei Logout/deleteAccount/unauthorizedError.
│                             # SwipeView upgraded auf user+partnership Channel (partnershipId)
└── ViewModels/
    ├── AuthViewModel.swift       # Singleton (AuthViewModel.shared); loadSession() aus Keychain;
    │                             # login, register, updateName, logout, deleteAccount;
    │                             # requestPushPermissionIfNeeded();
    │                             # setupUnauthorizedListener() reagiert auf 401s;
    │                             # Socket-Lifecycle: connect() in loadSession()+persistSession(),
    │                             # disconnect() in logout()+deleteAccount()+handleUnauthorized()
    ├── PartnersViewModel.swift   # loadPartnerships() liefert {incoming, outgoing, active};
    │                             # acceptRequest / declineRequest / cancelRequest /
    │                             # deletePartnership / updateFilters mit optimistic update;
    │                             # subscribt partnershipRequest / partnershipAccepted /
    │                             # partnershipEnded; min 450ms Ladeanimation
    ├── AddPartnerViewModel.swift # Code-Eingabe (Crockford-Base32, 8 Chars normalisiert);
    │                             # submit(onSuccess:) → requestPartnership
    ├── SwipeViewModel.swift      # init(partnership:); fetchFeed(afterPosition) paginiert
    │                             # (20/page), lazy load bei ≤5; handleDrag + commitSwipe —
    │                             # 100pt Threshold, 0.25s fly-out
    │                             # Subscriptions: match, partnerFiltersUpdated, partnerLeft,
    │                             # partnershipEnded; reconnectSocketIfNeeded() beim App-Foreground
    ├── MatchesViewModel.swift    # init(partnershipId:); fetchMatches() paginiert; mehr
    │                             # laden bei letzten 5; min 450ms
    └── FavoritesViewModel.swift  # loadFavorites(), toggleFavorite(), removeFavorite(),
                                   # isFavorite(); paginiert; mehr laden bei letzten 5; min 450ms

Views/                         # alle SwiftUI-Screens (Xcode 16 erfasst neue Dateien automatisch)
├── AuthView.swift             # Premium Auth-Landing im Velvet-Hour-Stil mit rotierendem
│                              # Hero-Wort; Apple-/Google-Dock als Phase-9/10-Skeletons;
│                              # Login/Register als sekundäre Sheets
├── MainTabView.swift          # Auth-Root: 3 Tabs (Partner / Favoriten / Profil), je eigene
│                              # NavigationStack; UITabBarAppearance Theme-getintet
├── PartnersView.swift         # Partner-Tab: Section-List Eingehend/Partner/Ausstehend,
│                              # AddPartnerSheet-Trigger, Overflow-Links
├── AddPartnerSheet.swift      # 8-char Share-Code-Eingabe; optional Deep-Link-vorausgefüllt
├── PartnerFiltersView.swift   # Filter-Editor → Stack neu generieren
├── PendingRequestsView.swift  # Overflow: alle eingehenden Anfragen (Accept/Decline)
├── OutgoingRequestsView.swift # Overflow: alle ausgehenden Anfragen (Cancel)
├── AllPartnersView.swift      # Overflow: alle aktiven Partner
├── ProfileView.swift          # Profil-Tab: Konto, Dein Code (Copy + Regenerate),
│                              # Rechtliches, Abmelden, Konto löschen
├── SwipeView.swift            # init(partnership:). Karten-Stack, Drag-Gesture, Match-Modal
├── MatchView.swift            # Radial-Bloom + Staggered-Reveal + .success-Haptik
├── MatchesListView.swift      # Paginiert, watched togglen, Detail-Navigation
├── FavoritesListView.swift    # Paginiert, toggleFavorite, Detail-Navigation
├── MovieDetailView.swift      # Film-Details + Streaming-Anbieter
├── MovieCardView.swift        # Swipe-Karte (Poster, Titel, Rating, Overlay-Badges)
├── PasswordResetViews.swift   # Forgot-Password-Request + Reset via Deep-Link-Token
├── LegalView.swift            # Datenschutz / Impressum / AGB
├── NativeTextField.swift      # UIViewRepresentable Wrapper für bessere Keyboard-Handles
├── KeyboardWarmupView.swift   # Hidden UIKit helper: reduziert First-Tap-Lag
└── SharedComponents.swift     # Wiederverwendbare UI-Bausteine (Buttons, Loader, Empty-States)

watchd_backend-mac/docs/
└── troubleshooting.md    # Runtime-Incident-Playbook (Socket, Push, room_stack, etc.)
```

---

## Entwicklung

```bash
# Backend
npm run dev            # Hot-reload via ts-node-dev
npm run lint           # ESLint für src/ + vitest.config.ts
npm run lint:fix       # Lint-Fixes automatisch anwenden
npm run format         # Prettier auf Repo-Dateien anwenden
npm run format:check   # Prettier-Check ohne Änderungen
npm run typecheck      # Type-check only (kein emit) — nach jeder Änderung ausführen
npm run build          # Compile → dist/
npm start              # Production
npm test               # vitest run (einmalig gegen watchd_test)
npm run test:watch     # vitest watch mode
npm run test:coverage  # vitest + v8 coverage

# Einmaliger Test-DB-Bootstrap (lokal, via sudo):
sudo mariadb <<'SQL'
CREATE DATABASE IF NOT EXISTS watchd_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'dev_test'@'localhost' IDENTIFIED BY 'dev_test_pw';
GRANT ALL PRIVILEGES ON watchd_test.* TO 'dev_test'@'localhost';
FLUSH PRIVILEGES;
SQL
# Danach läuft `npm test` ohne sudo. global-setup.ts wendet schema.sql
# bei jedem Run neu an (DROP+CREATE TABLE).
npm run download-icons # Streaming-Provider-Icons von JustWatch herunterladen

# Datenbank (einmalig oder nach Schema-Änderungen)
mysql -u root -p watchd < src/db/schema.sql
# Alternativ: WATCHD_APPLY_SCHEMA=1 in .env → auto-apply beim Dev-Start

# iOS
open watchd/watchd.xcodeproj   # dann ⌘R in Xcode
```

---

## Umgebungsvariablen

Alle Vars in `src/config.ts` validiert. Start wirft Error wenn Required fehlt.

**Required:**

```
JWT_SECRET=
JWT_REFRESH_SECRET=
TMDB_API_KEY=           # v3 API key (Fallback; als ?api_key= wenn READ_ACCESS_TOKEN nicht gesetzt)
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
```

**Optional (mit Defaults):**

```
PORT=3000
NODE_ENV=development
CORS_ORIGINS=*
DB_PORT=3306
LOG_LEVEL=info
TMDB_READ_ACCESS_TOKEN=   # Bevorzugter Bearer-Token für TMDB v4; überschreibt api_key
APP_URL=https://watchd.app   # Auf Railway auf https://watchd.up.railway.app setzen — wird für Universal Links genutzt

SMTP_HOST=                # Leer → Mail wird auf Console geloggt statt gesendet
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=noreply@watchd.app

APNS_KEY_ID=              # 10-char Key ID aus Apple Developer Portal
APNS_TEAM_ID=             # 10-char Team ID
APNS_PRIVATE_KEY=         # Base64-encoded .p8 Inhalt (einzeilig, keine Newlines)
APNS_PRODUCTION=false     # false = sandbox (Xcode-Gerät), true = TestFlight/App Store

WATCHD_APPLY_SCHEMA=      # "1" oder "true" → auto-apply schema.sql beim Dev-Start
BCRYPT_ROUNDS=12          # bcrypt cost factor (Default 12); niedriger für Tests
```

**APNS_PRIVATE_KEY encoding:**

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'
```

---

## Deployment (Railway)

- **Produktiv-URL**: `https://watchd.up.railway.app`
- **Auto-Deploy**: jeder Push auf `main` triggert einen Railway-Build. Keine CLI, kein Docker — Nixpacks erkennt Node automatisch
- **Build**: `npm run build` → `npm start` (aus `package.json` scripts)

### Env-Vars-Workflow

Source of Truth sind die Railway-Variables. Workflow:

1. Änderung zuerst in Railway Dashboard → Variables setzen (triggert automatisch Redeploy)
2. Lokale `.env` per Hand synchron halten (copy-paste der geänderten Werte), damit Dev-Build mit gleicher Config läuft
3. `.env` ist in `.gitignore` — kommt nie ins Repo; `.env.example` listet alle unterstützten Keys mit Defaults

### Logs

- **Live-Logs**: Railway Dashboard → Deployments → aktuelles Deployment → Logs-Tab
- **Pino-Logs**: im Prod werden strukturierte JSON-Logs ausgegeben (in Dev: `pino-pretty`). Railway rendert sie als Plain-Text
- **Health-Check** (extern, ohne Logs): `curl https://watchd.up.railway.app/health` → `{status, db, tmdb, uptime}`

### Rollback

**Nicht** via `git revert` — das ist langsam (neuer Build) und kann selbst fehlschlagen.

Stattdessen: **Railway Dashboard → Deployments → vorherigen grünen Deploy auswählen → "Redeploy"**. Railway nutzt den bereits gebauten Container, Downtime ~30 s. Danach in Ruhe den problematischen Commit analysieren und regulär fixen.

### Redeploy ohne Code-Änderung

Wenn nur Env-Vars oder externe Abhängigkeiten (TMDB-Key rotiert, APNs-Key neu) das Problem sind: Railway Dashboard → Deployments → aktuellen Deploy → "Redeploy". Kein Commit nötig.

### Deploy-Troubleshooting

| Symptom                                                              | Wahrscheinliche Ursache                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy failed beim Build-Step                                        | TypeScript-Fehler — lokal `npm run typecheck` laufen lassen, fixen, erneut pushen                                                                  |
| Deploy grün, aber `/health` meldet `db: error`                       | `DB_*` Env-Vars auf Railway falsch oder DB-Service nicht erreichbar                                                                                |
| Deploy grün, aber `/health` meldet `tmdb: error`                     | `TMDB_API_KEY` oder `TMDB_READ_ACCESS_TOKEN` fehlt/falsch                                                                                          |
| Match-Push kommt nicht an (App zeigt Match, aber keine Notification) | `APNS_PRODUCTION` passt nicht zum Key-Typ. Sandbox-Key braucht `false`, Production-Key `true`. **Keine Fehlermeldung auf beiden Seiten** — lautlos |
| Password-Reset-Mail kommt nicht an                                   | `SMTP_HOST` leer → Mail wird nur auf Console geloggt. Railway-Logs prüfen, dann SMTP-Vars setzen                                                   |

Für Runtime-/Codepfad-Incidents siehe `docs/troubleshooting.md`.

---

## API-Routen

| Method   | Path                                                 | Beschreibung                                                                                                         |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/auth/register`                                 | Vollkonto anlegen (name, email, password) — generiert Share-Code                                                     |
| `POST`   | `/api/auth/login`                                    | Email + Password Login                                                                                               |
| `POST`   | `/api/auth/refresh`                                  | Token-Rotation (theft detection via family_id)                                                                       |
| `POST`   | `/api/auth/forgot-password`                          | Password-Reset-Mail senden                                                                                           |
| `POST`   | `/api/auth/reset-password`                           | Password mit One-Time-Token zurücksetzen                                                                             |
| `POST`   | `/api/auth/logout`                                   | Aktuellen Refresh-Token revoken                                                                                      |
| `DELETE` | `/api/auth/delete-account`                           | Account + alle Daten löschen (GDPR/Apple)                                                                            |
| `PATCH`  | `/api/users/me`                                      | Username ändern                                                                                                      |
| `POST`   | `/api/users/me/device-token`                         | APNs Device-Token registrieren                                                                                       |
| `GET`    | `/api/users/me/share-code`                           | Eigener Share-Code (`{ shareCode }`)                                                                                 |
| `POST`   | `/api/users/me/share-code/regenerate`                | Code neu generieren — alter wird sofort ungültig                                                                     |
| `POST`   | `/api/partnerships/request`                          | Anfrage via `{ shareCode }` — 400 (eigener Code), 404 (Code unbekannt), 409 (Partnerschaft existiert), Push + Socket |
| `POST`   | `/api/partnerships/:id/accept`                       | Addressee bestätigt → status=active, Stack generieren, Socket + Push an Requester                                    |
| `POST`   | `/api/partnerships/:id/decline`                      | Addressee lehnt ab → hard-delete                                                                                     |
| `DELETE` | `/api/partnerships/:id/cancel-request`               | Requester zieht ausstehende Anfrage zurück → hard-delete                                                             |
| `GET`    | `/api/partnerships`                                  | `{ incoming: [...], outgoing: [...], active: [...] }` mit Partner-User                                               |
| `GET`    | `/api/partnerships/:id`                              | Detail: `{ partnership: { ..., partner: { id, name } } }`                                                            |
| `PATCH`  | `/api/partnerships/:id/filters`                      | Filter updaten → Stack neu generieren + `filters_updated` emittieren                                                 |
| `DELETE` | `/api/partnerships/:id`                              | Partnerschaft beenden (cascade-delete) + `partnership_ended` + `disconnectSockets`                                   |
| `GET`    | `/api/movies/partnerships/:partnershipId/next-movie` | Nächster ungeswiped Film (inkl. Streaming)                                                                           |
| `GET`    | `/api/movies/feed?partnershipId=&afterPosition=`     | 20 ungeswiped Filme paginiert (inkl. Streaming); Keyset-Cursor via `afterPosition`; Response enthält `lastPosition`  |
| `POST`   | `/api/swipes`                                        | Body `{ partnershipId, movieId, direction }`; rechts → Matchmaking + Push                                            |
| `GET`    | `/api/matches/:partnershipId`                        | Matches paginiert (default 20, max 50)                                                                               |
| `PATCH`  | `/api/matches/:matchId`                              | watched/unwatched togglen                                                                                            |
| `POST`   | `/api/matches/favorites`                             | Film zu Favoriten hinzufügen                                                                                         |
| `DELETE` | `/api/matches/favorites/:movieId`                    | Favorit entfernen                                                                                                    |
| `GET`    | `/api/matches/favorites/list`                        | Favoriten paginiert (default 20, max 50)                                                                             |
| `GET`    | `/health`                                            | Liveness: `{status, db: ok\|error, tmdb: ok\|error, uptime}`                                                         |

---

## Kernlogik & Flows

**Match-Flow:**
`POST /swipes` → `matchmaking.checkAndCreateMatch()` → alle `partnership_members` swiped right → `INSERT IGNORE INTO matches (partnership_id, movie_id)` (atomic, race-safe via `UNIQUE KEY unique_partnership_movie`) → `affectedRows=0` = anderer Request hat gewonnen → early return → Film-Details + JustWatch-Offers holen → `match` Socket.io Event an `partnership:<id>` → `device_token` aller Partnership-Members → `sendMatchPush()` via APNs (Payload enthält `partnershipId` + `movieId`).

**Partnership-Lifecycle:**

- `pending` (Anfrage gesendet, nur Requester ist `partnership_members`) → `active` (Addressee accepted, Stack wird initial generiert, beide Members)
- `active` → gelöscht (einer der beiden ruft `DELETE /api/partnerships/:id` → cascade räumt Members/Stack/Swipes/Matches; `partnership_ended`-Socket-Event + `disconnectSockets` auf `partnership:<id>`)
- `pending` → gelöscht (Addressee declined oder Requester cancelled — beide Wege: hard-delete via cascade)
- `GET /api/partnerships` liefert getrennt `incoming` / `outgoing` / `active` — Client rendert die Sections separat.

**JWT-Strategie:**
Short-lived Access-Tokens + Refresh-Token-Rotation. Wiederverwendung eines revoked Tokens innerhalb derselben `family_id` invalidiert die gesamte Familie (theft detection).

**Concurrency-Limit:**
`matches.ts` und `movies.ts` nutzen `mapWithConcurrency(items, 6, fn)` — parallele TMDB/JustWatch-Calls auf 6 begrenzt.

**App-Flow:**

```
App Launch → ContentView
├── NICHT AUTH → AuthView
│   ├── Premium Landing: rotierendes Hero-Wort + Apple/Google-Dock (Phase 9/10 vorbereitet)
│   ├── Anmelden-Sheet (email + password)
│   ├── Registrieren-Sheet
│   ├── Passwort vergessen → Reset-Mail → deep link → ResetPasswordView
│   └── kein Gast-Zugang mehr
└── AUTH → MainTabView (3 Tabs, je eigene NavigationStack)
    ├── Tab "Partner" → PartnersView (Section-List)
    │   ├── Eingehende Anfragen → Accept / Decline / Overflow → PendingRequestsView
    │   ├── Partner-Karte → SwipeView(partnership:) (TabBar hidden)
    │   │   ├── Karten-Stack (3 Karten, gestaffelt): Drag ±100pt
    │   │   ├── Right-Swipe → Matchmaking → Socket.io match → MatchView Sheet
    │   │   │   └── MatchView: Radial-Bloom + Staggered-Reveal + Streaming-Optionen
    │   │   │       ├── "Weiter schauen" → zurück zur SwipeView
    │   │   │       └── "Alle Matches" → MatchesListView
    │   │   ├── Herz-Button (Karte) → Favorit togglen
    │   │   ├── Toolbar-Herz → MatchesListView → MovieDetailView
    │   │   └── Socket Events: partner_joined/left, partnership_ended, filters_updated
    │   ├── Ausstehende Anfragen → Cancel / Overflow → OutgoingRequestsView
    │   ├── Bottom-CTA „Partner hinzufügen" → AddPartnerSheet
    │   ├── ContextMenu/SwipeActions: Filter → PartnerFiltersView, Partner entfernen
    │   └── Overflow „Alle Partner" → AllPartnersView
    ├── Tab "Favoriten" → FavoritesListView (global, partnership-entkoppelt) → MovieDetailView
    └── Tab "Profil" → ProfileView
        ├── Konto: Name editieren, Email anzeigen
        ├── Dein Code: Copy + Regenerate (Confirm-Alert)
        ├── Rechtliches → Datenschutz / Nutzungsbedingungen / Impressum / Datenquellen
        └── Session: Abmelden | Konto löschen (Destructive-Alert)

Deep Links:
  watchd://reset-password?token=TOKEN → ResetPasswordView Sheet
  watchd://add/CODE                   → AddPartnerSheet mit Code-Prefill; queued bis nach Login
  https://watchd.up.railway.app/add/CODE → Universal Link auf denselben Add-Partner-Flow
```

**Push Notifications (iOS):**
`AuthViewModel.requestPushPermissionIfNeeded()` nach Login:

- `.authorized` → sofort `registerForRemoteNotifications()` (Token refresh)
- `.notDetermined` → erst Permission-Request, dann registrieren

`AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken` → Token zu Hex → `POST /api/users/me/device-token`

Xcode-Pflicht: Push Notifications Capability via Signing & Capabilities → erzeugt `watchd.entitlements` mit `aps-environment`. Ohne das schlägt `registerForRemoteNotifications()` lautlos fehl.

---

## Code-Standards

- Alle Env-Vars nur über `config.ts` — nie `process.env.XYZ` direkt
- Parallele TMDB/JustWatch-Calls immer mit `mapWithConcurrency(..., 6, ...)`
- Alle DB-Queries via `db/connection.ts` Pool — keine direkten Verbindungen
- SwiftUI: alle async-Aufrufe auf `@MainActor` — kein `DispatchQueue.main.async`
- Neue `.swift`-Dateien in `watchd/watchd/` werden von Xcode 16 automatisch erfasst — kein Projektfile-Edit nötig
- TypeScript: kein implizites `any`

---

## Häufige Fehler vermeiden

- NICHT: `process.env.XYZ` direkt — immer über `config.ts`
- NICHT: TMDB/JustWatch-Calls unlimitiert parallel — `mapWithConcurrency` nutzen
- NICHT: Neue Swift-Dateien manuell zum Xcode-Projekt hinzufügen
- NICHT: APNs-Sandbox-Key mit `APNS_PRODUCTION=true` kombinieren — **schlägt lautlos fehl, kein Error auf beiden Seiten**
- NICHT: `TMDB_API_KEY` und `TMDB_READ_ACCESS_TOKEN` verwechseln — Bearer-Token ist bevorzugt
- NICHT: `pool.end()` / `httpServer.close()` in Test-Hooks — zerstört den geteilten Worker-State, alle Files nach dem ersten bekommen „Pool is closed"
- NICHT: `vi.mock` in Test-Files für Services die `src/tests/setup.ts` bereits mockt (room-stack, socket, apns, mail, tmdb, justwatch) — überschreibt den idempotenten `globalThis.__watchdMocks`-Cache und entkoppelt App-Instanz von Test-Spies
- NICHT: Skill-Regeln umgehen — für neue Tests `/test-integration` oder `/test-unit` nutzen
- IMMER: Nach Backend-Änderungen `npm run typecheck` ausführen
- IMMER: Test-Änderungen zweimal hintereinander laufen lassen (Determinismus-Check)
- IMMER: AGENTS.md aktualisieren wenn sich Routes, Views, Env-Vars, Architektur oder Bugs ändern

---

## Zusammenarbeit

- **Mentor-Modus**: Als kritischer, ehrlicher Mentor agieren. Nicht defaultmäßig zustimmen. Schwächen, blinde Flecken und falsche Annahmen aktiv identifizieren. Ideen herausfordern wenn nötig — direkt und klar, nicht hart. Beim Kritisieren immer erklären warum und eine bessere Alternative vorschlagen.
- **Planung zuerst**: Vor Änderungen >~50 Zeilen kurzen Plan vorlegen und Freigabe abwarten
- **Kein Scope-Creep**: Nur das Geforderte — keine Bonus-Refactors, keine ungefragten Kommentare, keine Verbesserungen am umliegenden Code
- **Sub-Agents**: Nur für breite Codebase-Exploration (`Explore`-Agent) oder Architektur-Planung (`Plan`-Agent) — für normale Tasks inline arbeiten
- **Definition of Done**: lint + format:check + typecheck grün (Backend) + AGENTS.md aktualisiert + kein neuer Scope eingeschlichen
- **Dokumentationspflicht**: AGENTS.md wird nach jeder Änderung automatisch aktualisiert — ohne explizite Aufforderung. Vor jeder Planung Status-Einträge aktiv gegen den Code verifizieren, nie blind der Doku vertrauen.

---

## Offene Punkte

| Status        | Thema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **in Arbeit** | Partnerships-Refactor: Rooms → persistente Partnerschaften, Gast-Zugang weg, Share-Codes mit Double-Opt-In, Apple Sign-In. Plan + Phasen: `docs/partnerships-refactor-plan.md` (Parent-Repo). Branch: `refactor/partnerships`. **Phasen 1–8 fertig** (Phase 8 am 2026-04-30): Backend (Schema/Services/Routes/Socket/Tests, 117 Tests grün), iOS-Stack (Models/Services/ViewModels/Views) und Deep-Link/Push-Routing sind umgebaut. `watchd://add/CODE` und Universal Link `/add/:code` öffnen `AddPartnerSheet` mit Prefill oder werden bis nach Login gequeued. Push-Taps für `partnership_request` öffnen/markieren den Partner-Tab, `partnership_accepted` und `match` öffnen die betroffene Partnerschaft. iOS-Build zuletzt grün am 2026-04-28 via `xcodebuild -quiet -project watchd/watchd.xcodeproj -scheme watchd -configuration Debug -destination generic/platform=iOS -derivedDataPath .deriveddata-ios CODE_SIGNING_ALLOWED=NO build` (außerhalb Sandbox wegen CoreSimulator-Zugriff). Phase 9 (Apple Sign-In) als nächstes. |
| **erledigt**  | CI: GitHub Actions mit MySQL-8-Service-Container (`.github/workflows/test.yml`), Typecheck + Tests auf jedem PR; Branch-Protection auf `main` blockiert direkte Pushes (siehe `CONTRIBUTING.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **erledigt**  | Design Overhaul iOS: Einziges Theme **Velvet Hour** (cool dark, Champagne-Accent, Bluu Next + Manrope) + Bottom-Tab-Navigation. Design-Kontext in `watchd/.impeccable.md`. Phasen 0–5 + Vereinfachung abgeschlossen (2026-04-24): Theme-Foundation, MainTabView + ProfileView + RoomsView, alle Screens editorial redesigned, WatchdTheme-Shim gelöscht, ThemeManager entfernt (kein Switcher), Theme statisch injiziert (`.environment(\.theme, .velvetHour)` + `.preferredColorScheme(.dark)`). BluuNext (Bold + BoldItalic) + Manrope (Regular/Medium/SemiBold/Bold) liegen unter `watchd/watchd/Fonts/`, `FontRegistry.registerAll()` registriert sie beim App-Launch. Keine Backend-Änderungen.                                                                                                                                                                                                            |
| **post-MVP**  | Room-Namen editieren in UI (Route existiert, UI fehlt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **post-MVP**  | Pino-Logs strukturiert in Datei / Logdienst (aktuell nur stdout)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **post-MVP**  | App Store Assets (Screenshots, App-Icon alle Größen)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
