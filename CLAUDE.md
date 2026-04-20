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
- **Deployment**: Railway — `https://watchd.up.railway.app` (`npm run build` → `npm start`, kein Dockerfile)
- **Testing**: Vitest + Supertest gegen echte `watchd_test`-DB (Socket.io, APNs, Mail, TMDB, JustWatch, room-stack gemockt — `appendRoomStack` wird per `vi.importActual` in `room-stack-append.integration.test.ts` real gegen DB + gemocktes `global.fetch` getestet; `movies.integration.test.ts` sichert den Lazy-Refill-Trigger in den Movie-Routes mit gemocktem `appendRoomStack` ab: `<=10` unseen, `stack_exhausted`, atomarer Lock bei Parallel-Requests). `pool: 'threads'`, `fileParallelism: false`, `isolate: false` — single Worker teilt Module (inkl. DB-Pool + httpServer) über alle Files. `setup.ts` initialisiert Server einmalig (idempotentes `beforeAll`, kein `afterAll` — Prozess-Exit räumt auf). Mock-Factories sind **idempotent** (Instanzen in `globalThis.__watchdMocks` gecached) — sonst erzeugt jede Factory-Ausführung pro File frische `vi.fn()`s und entkoppelt sie vom einmalig erzeugten App-Instanz → flaky Socket/Mail-Spy-Tests je nach File-Reihenfolge. `createApp({ skipRateLimiter: true })` für Tests. Design: echte Test-DB statt Mock (Migrations-Parität mit Prod); nur externe / Side-effect-Module gemockt. **Nicht getestet**: `token-cleanup.ts` (scheduled, kein deterministischer Testpunkt), APNs/Mail/TMDB/JustWatch (gemockt — Unit-Tests darüber bringen keinen Mehrwert), iOS (kein MVP-ROI), E2E, echte Concurrency jenseits der abgesicherten `stack_generating`-/`INSERT IGNORE`-Pfade.

### iOS App (`watchd/`)
- **Framework**: SwiftUI (iOS 16+, Xcode 16+)
- **Architektur**: MVVM — alle ViewModels `@MainActor ObservableObject`
- **Netzwerk**: `URLSession` actor (`APIService`), Socket.io (vendored, v16.1.1)
- **Storage**: Keychain (`com.watchd.app`)
- **Theme**: Netflix-style — Background `#141414`, Primary Red `#E50914`

---

## Projektstruktur

```
watchd_backend-mac/src/
├── index.ts              # Dünner Wrapper: dotenv, createApp(), initSocket, Signal-Handler,
│                         # start() mit applyDevSchemaIfEnabled + scheduleTokenCleanup + listen
├── app.ts                # createApp({ skipRateLimiter? }) Factory:
│                         # Middleware, Routes, /health, /.well-known/..., /reset-password,
│                         # 404, Error-Middleware; returns { app, httpServer, parsedOrigins }
│                         # Rate limits: auth 10/15min per IP, swipes 120/min per IP
│                         # (skipRateLimiter=true für Tests)
├── config.ts             # Alle Env-Vars validiert beim Start (startup throw wenn Required fehlt)
├── logger.ts             # Pino (pino-pretty in development)
├── middleware/
│   └── auth.ts           # JWT-Middleware; extrahiert userId, email, isGuest
├── db/
│   ├── connection.ts     # mysql2 Pool
│   ├── schema.sql        # 9 Tabellen: users, refresh_tokens, password_reset_tokens,
│   │                     # rooms, room_members, room_stack, swipes, matches, favorites
│   └── apply-schema.ts   # Dev-only: auto-apply wenn WATCHD_APPLY_SCHEMA=1
├── routes/
│   ├── auth.ts           # register, login, guest, refresh, upgrade,
│   │                     # forgot-password, reset-password, logout, delete-account
│   ├── users.ts          # PATCH /me, POST /me/device-token
│   ├── rooms.ts          # create, join, list, get, rename, update-filters, leave, archive-delete
│   ├── movies.ts         # feed (paginiert), next-movie (einzeln)
│   │                     # Refill-Trigger: wenn unseenMovies ≤ 10 → atomares stack_generating-Lock
│   │                     # → fire-and-forget appendRoomStack(); stack_exhausted blockiert Trigger
│   ├── swipes.ts         # POST /swipes → Matchmaking + Push
│   └── matches.ts        # list, mark-watched, add/remove/list favorites
├── services/
│   ├── tmdb.ts           # TMDB API Client mit LRU-Cache
│   ├── justwatch.ts      # JustWatch GraphQL; flatrate + free; iconPath für /icons/*.png
│   ├── matchmaking.ts    # Kernlogik: alle Members swiped right → INSERT IGNORE (race-safe)
│   ├── room-stack.ts     # generateRoomStack(roomId, filters): 5 TMDB-Pages → gefiltert → DB
│   │                     # appendRoomStack(roomId): Lazy Refill — liest filters + stack_next_page
│   │                     # aus DB, fetcht nächsten Batch (5 Seiten), INSERT IGNORE, setzt
│   │                     # stack_next_page / stack_generating / stack_exhausted zurück
│   ├── apns.ts           # APNs Push-Service
│   ├── mail.ts           # Password-Reset-Mail; deep link: watchd://reset-password?token=TOKEN
│   └── token-cleanup.ts  # Scheduled Job (alle 6h, erster Run 30s nach Start):
│                         # expired refresh tokens, used reset tokens,
│                         # guest accounts >7d ohne aktive Session
├── socket/
│   ├── index.ts          # JWT-Auth + Room-Membership-Check beim JOIN
│   │                     # Emits: joined, error, match, partner_joined, partner_left,
│   │                     #        room_dissolved, filters_updated
│   └── events.ts         # Enum aller Socket.io Event-Namen
└── tests/
    ├── global-setup.ts   # CREATE DATABASE watchd_test + schema.sql anwenden
    ├── setup.ts          # createApp({skipRateLimiter:true}) + alle Mocks zentral
    │                     # (socket, apns, mail, tmdb, justwatch, room-stack)
    │                     # Module wird einmalig pro Worker evaluiert (isolate:false) —
    │                     # beforeAll startet den Server nur wenn !httpServer.listening;
    │                     # beforeEach: truncateAll() + clearAllMocks(); kein afterAll
    ├── helpers.ts        # createUser, createGuestUser, createRoom, joinRoom,
    │                     # seedStackMovie, seedSwipe, seedMatch
    ├── unit/             # auth.unit (decodeRefreshToken), middleware.unit,
    │                     # room-stack.unit (buildTmdbUrl)
    └── integration/      # auth, swipes-matchmaking, rooms, movies
                          # (Pagination, Swipe-Filter, Lazy-Refill-Trigger), matches,
                          # users (PATCH /me, device-token),
                          # room-stack-append (Lazy-Refill: Lock, Page-Increment,
                          # Exhausted-Flag, Dedup, Fehlerpfad — nutzt
                          # vi.importActual + gemocktes global.fetch)

watchd/watchd/
├── watchdApp.swift       # @main; deep link handling; environment objects: AuthViewModel, NetworkMonitor
├── ContentView.swift     # Root: AuthView (nicht auth) / HomeView (auth); ResetPassword-Sheet
├── AppDelegate.swift     # APNs-Token → hex → POST /users/me/device-token; foreground notifications
├── Config/
│   ├── APIConfig.swift   # Base URLs (Debug: localhost:3000, Release: Railway); #if DEBUG
│   └── WatchdTheme.swift # Design System (Farben, Fonts, Gradients)
├── Models/               # Codable structs (snake_case → camelCase via keyDecodingStrategy)
│   ├── AuthModels.swift  # Auth requests/responses, User struct
│   ├── MovieModels.swift # Movie, StreamingOption, SwipeRequest/Response, MatchInfo
│   ├── RoomModels.swift  # Room, RoomFilters, RoomMember, join/leave/detail responses
│   └── MatchModels.swift # Match, MatchMovie, Favorite, SocketMatchEvent, FavoritesResponse
├── Services/
│   ├── APIService.swift      # actor — thread-safe async/await URLSession; Auto-refresh bei 401
│   │                         # isRefreshing-Flag verhindert parallele Refreshes; Timeout: 30s
│   ├── KeychainHelper.swift  # Keys: jwt_token, jwt_refresh_token, user_id, user_name,
│   │                         #       user_email, is_guest
│   ├── NetworkMonitor.swift  # @MainActor ObservableObject; NWPathMonitor → @Published isConnected
│   └── SocketService.swift   # @MainActor Singleton; Publishers: matchPublisher,
│                             # filtersUpdatedPublisher, partnerLeftPublisher,
│                             # partnerJoinedPublisher, roomDissolvedPublisher
│                             # Lazy connect — nur beim Betreten der SwipeView
└── ViewModels/
    ├── AuthViewModel.swift    # Singleton (AuthViewModel.shared); loadSession() aus Keychain;
    │                          # login, register, guestLogin, upgradeAccount, updateName,
    │                          # logout, deleteAccount; requestPushPermissionIfNeeded();
    │                          # setupUnauthorizedListener() reagiert auf 401s
    ├── HomeViewModel.swift    # loadRooms(), loadArchivedRooms(), createRoom, joinRoom,
    │                          # selectRoom, updateRoomName, leaveRoom; min 450ms Ladeanimation
    ├── SwipeViewModel.swift   # fetchFeed(roomId, page) — paginiert (20/page), lazy load bei ≤5
    │                          # handleDrag + commitSwipe — 100pt Threshold, 0.25s fly-out
    │                          # Subscriptions: match, filtersUpdated, partnerLeft, roomDissolved
    │                          # reconnectSocketIfNeeded() beim App-Foreground
    ├── MatchesViewModel.swift # fetchMatches() paginiert; mehr laden bei letzten 5; min 450ms
    └── FavoritesViewModel.swift # loadFavorites(), toggleFavorite(), removeFavorite(), isFavorite()
                                 # paginiert; mehr laden bei letzten 5; min 450ms

Views/                         # alle SwiftUI-Screens (Xcode 16 erfasst neue Dateien automatisch)
├── AuthView.swift             # Login / Register / Guest / Forgot-Password Entry-Screen
├── HomeView.swift             # Room-Liste, Navigation zu Swipe / Archiv / Einstellungen
├── SwipeView.swift            # Karten-Stack (3 gestaffelt), Drag-Gesture, Match-Modal-Trigger
├── MatchView.swift            # Vollbild-Match mit Konfetti + Streaming-Optionen
├── MatchesListView.swift      # Paginiert, watched togglen, Detail-Navigation
├── FavoritesListView.swift    # Paginiert, toggleFavorite, Detail-Navigation
├── MovieDetailView.swift      # Film-Details + Streaming-Anbieter
├── MovieCardView.swift        # Einzelne Swipe-Karte (Poster, Titel, Rating, Herz-Button)
├── CreateRoomSheet.swift      # Neuer Room: Name + Filter (Genres, Jahre, Streaming)
├── RoomFiltersView.swift      # Filter-Editor für bestehenden Room → Stack neu generieren
├── ArchivedRoomsView.swift    # Liste + Hard-Delete archivierter Rooms
├── UpgradeAccountView.swift   # Guest → Vollkonto (Email + Password hinzufügen)
├── PasswordResetViews.swift   # Forgot-Password-Request + Reset via Deep-Link-Token
├── LegalView.swift            # Datenschutz / Impressum / AGB
├── NativeTextField.swift      # UIViewRepresentable Wrapper für bessere Keyboard-Handles
└── SharedComponents.swift     # Wiederverwendbare UI-Bausteine (Buttons, Loader, Empty-States)
```

---

## Entwicklung

```bash
# Backend
npm run dev            # Hot-reload via ts-node-dev
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

| Symptom | Wahrscheinliche Ursache |
|---------|------------------------|
| Deploy failed beim Build-Step | TypeScript-Fehler — lokal `npm run typecheck` laufen lassen, fixen, erneut pushen |
| Deploy grün, aber `/health` meldet `db: error` | `DB_*` Env-Vars auf Railway falsch oder DB-Service nicht erreichbar |
| Deploy grün, aber `/health` meldet `tmdb: error` | `TMDB_API_KEY` oder `TMDB_READ_ACCESS_TOKEN` fehlt/falsch |
| Match-Push kommt nicht an (App zeigt Match, aber keine Notification) | `APNS_PRODUCTION` passt nicht zum Key-Typ. Sandbox-Key braucht `false`, Production-Key `true`. **Keine Fehlermeldung auf beiden Seiten** — lautlos |
| Password-Reset-Mail kommt nicht an | `SMTP_HOST` leer → Mail wird nur auf Console geloggt. Railway-Logs prüfen, dann SMTP-Vars setzen |

---

## API-Routen

| Method | Path | Beschreibung |
|--------|------|--------------|
| `POST` | `/api/auth/register` | Vollkonto anlegen (name, email, password) |
| `POST` | `/api/auth/login` | Email + Password Login |
| `POST` | `/api/auth/guest` | Anonymer Guest (generierter dt. Name) |
| `POST` | `/api/auth/refresh` | Token-Rotation (theft detection via family_id) |
| `POST` | `/api/auth/upgrade` | Guest → Vollkonto (email + password hinzufügen) |
| `POST` | `/api/auth/forgot-password` | Password-Reset-Mail senden |
| `POST` | `/api/auth/reset-password` | Password mit One-Time-Token zurücksetzen |
| `POST` | `/api/auth/logout` | Aktuellen Refresh-Token revoken |
| `DELETE` | `/api/auth/delete-account` | Account + alle Daten löschen (GDPR/Apple) |
| `PATCH` | `/api/users/me` | Username ändern |
| `POST` | `/api/users/me/device-token` | APNs Device-Token registrieren |
| `POST` | `/api/rooms` | Room erstellen (optional: name, filters) → room_stack generieren |
| `POST` | `/api/rooms/join` | Beitreten via 6-char Code (max 2 Members) |
| `GET` | `/api/rooms` | Aktive Rooms des Users auflisten |
| `GET` | `/api/rooms/:id` | Room-Details + Member-Liste |
| `PATCH` | `/api/rooms/:id` | Room umbenennen |
| `PATCH` | `/api/rooms/:id/filters` | Filter updaten → room_stack neu generieren + `filters_updated` emittieren |
| `DELETE` | `/api/rooms/:id/leave` | Room verlassen (hard-delete wenn nie genutzt; archivieren wenn genutzt) |
| `DELETE` | `/api/rooms/:id/archive` | Archivierten Room hard-deleten |
| `GET` | `/api/movies/rooms/:roomId/next-movie` | Nächster ungeswiped Film (inkl. Streaming) |
| `GET` | `/api/movies/feed?roomId=&afterPosition=` | 20 ungeswiped Filme paginiert (inkl. Streaming); Keyset-Cursor via `afterPosition`; Response enthält `lastPosition` |
| `POST` | `/api/swipes` | Swipe aufzeichnen (left\|right); rechts → Matchmaking + Push |
| `GET` | `/api/matches/:roomId` | Matches paginiert (default 20, max 50) |
| `PATCH` | `/api/matches/:matchId` | watched/unwatched togglen |
| `POST` | `/api/matches/favorites` | Film zu Favoriten hinzufügen |
| `DELETE` | `/api/matches/favorites/:movieId` | Favorit entfernen |
| `GET` | `/api/matches/favorites/list` | Favoriten paginiert (default 20, max 50) |
| `GET` | `/health` | Liveness: `{status, db: ok\|error, tmdb: ok\|error, uptime}` |

---

## Kernlogik & Flows

**Match-Flow:**
`POST /swipes` → `matchmaking.checkAndCreateMatch()` → alle Members swiped right → `INSERT IGNORE INTO matches` (atomic, race-safe via `UNIQUE KEY unique_room_movie`) → `affectedRows=0` = anderer Request hat gewonnen → early return → Film-Details + JustWatch-Offers holen → `match` Socket.io Event an `room:<id>` → `device_token` aller Members → `sendMatchPush()` via APNs

**Room-Status-Machine:**
- `waiting` (1 Member) → `active` (2. Member tritt bei)
- `active` → `waiting` (ein Member verlässt)
- `waiting`/`active` → `dissolved` (letzter Member verlässt nach Nutzung)
- Nie genutzte Rooms werden sofort hard-deleted
- `GET /api/rooms` filtert nach `room_members.is_active = true` — wer verlassen hat, sieht den Raum nicht mehr in der aktiven Liste (taucht erst im Archiv auf, wenn er dissolved ist)

**JWT-Strategie:**
Short-lived Access-Tokens + Refresh-Token-Rotation. Wiederverwendung eines revoked Tokens innerhalb derselben `family_id` invalidiert die gesamte Familie (theft detection).

**Concurrency-Limit:**
`matches.ts` und `movies.ts` nutzen `mapWithConcurrency(items, 6, fn)` — parallele TMDB/JustWatch-Calls auf 6 begrenzt.

**App-Flow:**
```
App Launch → ContentView
├── NICHT AUTH → AuthView
│   ├── Login (email + password)
│   ├── Register-Sheet
│   ├── Passwort vergessen → Reset-Mail → deep link → ResetPasswordView
│   └── Guest Login (anonymer dt. Name)
└── AUTH → HomeView
    ├── Room-Karte → SwipeView
    │   ├── Karten-Stack (3 Karten, gestaffelt): Drag ±100pt
    │   ├── Right-Swipe → Matchmaking → Socket.io match → MatchView Modal
    │   │   └── MatchView: Konfetti + Streaming-Optionen
    │   │       ├── "Weiter swipen" → zurück zur SwipeView
    │   │       └── "Alle Matches" → MatchesListView
    │   ├── Herz-Button (Karte) → Favorit togglen
    │   ├── Toolbar-Herz → MatchesListView → MovieDetailView
    │   └── Socket Events: partner_joined/left, room_dissolved, filters_updated
    ├── Room erstellen → CreateRoomSheet (Name + Filter) → SwipeView
    ├── Room beitreten → JoinRoomSheet (6-char Code) → SwipeView
    ├── Filter bearbeiten → RoomFiltersView → Stack neu generieren
    ├── Favoriten → FavoritesListView → MovieDetailView
    ├── Archivierte Rooms → ArchivedRoomsView
    └── Einstellungen: Name, Upgrade (Guest), Legal, Logout

Deep Links:
  watchd://join/ROOMCODE              → auto-join (oder Code für Post-Login queuen)
  watchd://reset-password?token=TOKEN → ResetPasswordView Sheet
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
- IMMER: CLAUDE.md aktualisieren wenn sich Routes, Views, Env-Vars, Architektur oder Bugs ändern

---

## Zusammenarbeit

- **Mentor-Modus**: Als kritischer, ehrlicher Mentor agieren. Nicht defaultmäßig zustimmen. Schwächen, blinde Flecken und falsche Annahmen aktiv identifizieren. Ideen herausfordern wenn nötig — direkt und klar, nicht hart. Beim Kritisieren immer erklären warum und eine bessere Alternative vorschlagen.
- **Planung zuerst**: Vor Änderungen >~50 Zeilen kurzen Plan vorlegen und Freigabe abwarten
- **Kein Scope-Creep**: Nur das Geforderte — keine Bonus-Refactors, keine ungefragten Kommentare, keine Verbesserungen am umliegenden Code
- **Sub-Agents**: Nur für breite Codebase-Exploration (`Explore`-Agent) oder Architektur-Planung (`Plan`-Agent) — für normale Tasks inline arbeiten
- **Definition of Done**: typecheck grün (Backend) + CLAUDE.md aktualisiert + kein neuer Scope eingeschlichen
- **Dokumentationspflicht**: CLAUDE.md wird nach jeder Änderung automatisch aktualisiert — ohne explizite Aufforderung. Vor jeder Planung Status-Einträge aktiv gegen den Code verifizieren, nie blind der Doku vertrauen.

---

## Offene Punkte

| Status | Thema |
|--------|-------|
| **erledigt** | CI: GitHub Actions mit MySQL-8-Service-Container (`.github/workflows/test.yml`), Typecheck + Tests auf jedem PR; Branch-Protection auf `main` blockiert direkte Pushes (siehe `CONTRIBUTING.md`) |
| **post-MVP** | Room-Namen editieren in UI (Route existiert, UI fehlt) |
| **post-MVP** | Pino-Logs strukturiert in Datei / Logdienst (aktuell nur stdout) |
| **post-MVP** | App Store Assets (Screenshots, App-Icon alle Größen) |
