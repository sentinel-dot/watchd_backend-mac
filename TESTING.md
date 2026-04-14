# Watchd — Test-Strategie

## Grundsatzentscheidungen

- **Echte Test-DB** (`watchd_test`) — kein DB-Mocking. Gleiche `schema.sql` wie Produktion. Grund: gemockte DB kann Migrations-Bugs und SQL-Eigenheiten nicht aufdecken.
- **TMDB / JustWatch mocken** — externe Services, nicht unter unserer Kontrolle. Tests müssen deterministisch sein.
- **Socket.io + APNs + Mail mocken** — Side-effects; ob unser Code `emit()` / `sendMatchPush()` aufruft testen wir, nicht ob die externen Bibliotheken intern korrekt arbeiten.
- **Framework**: `vitest` + `supertest` — native TypeScript, schnell, identische Jest-API.
- **Parallelität**: `fileParallelism: false` + `pool: 'forks'` — MySQL-Connections sind nicht thread-safe; sequentielle Ausführung ist bei 8 Test-Dateien der einzig verlässliche Ansatz. Kein nennenswerter Zeitverlust.

---

## Produktionscode-Änderungen (Voraussetzung für Tests)

Zwei Änderungen am Produktionscode sind zwingend erforderlich, bevor Tests implementiert werden können:

### 1. `src/app.ts` — App-Factory extrahieren

`index.ts` ist aktuell nicht testbar: Rate-Limiter, Socket.io-Init und `scheduleTokenCleanup` sind Seiteneffekte beim Import/Start. Lösung: App-Logik in eine Factory auslagern.

```
src/app.ts    → createApp({ skipRateLimiter?: boolean }) → { app, httpServer }
src/index.ts  → dünner Wrapper: createApp() + initSocket() + scheduleTokenCleanup() + listen()
```

In Tests: `createApp({ skipRateLimiter: true })` — kein Rate-Limiter, kein Cleanup-Job, kein Socket.io-Start.

**Warum `skipRateLimiter` zwingend**: Der Auth-Rate-Limiter erlaubt 10 Requests/15min per IP. Auth-Integration-Tests lösen > 10 Requests aus — ab dem 11. schlägt jeder Test lautlos mit 429 fehl.

### 2. `BCRYPT_ROUNDS` konfigurierbar machen

`config.ts` soll `BCRYPT_ROUNDS` als optionale Env-Var exportieren (Default: 12). In `.env.test` auf `4` setzen. Ohne das dauert jeder `createUser`-Aufruf in Tests ~300ms statt ~5ms.

### 3. `buildTmdbUrl` in `room-stack.ts` exportieren

Aktuell private. Einzige Änderung: `export function buildTmdbUrl(...)`.

---

## Dateistruktur

```
watchd_backend-mac/
├── vitest.config.ts
├── .env.test
└── src/
    ├── app.ts                                 # NEU: App-Factory (siehe oben)
    └── tests/
        ├── global-setup.ts                    # Einmalig vor allen Tests: DB erstellen + Schema anwenden
        ├── setup.ts                           # Pro Test-Datei: App booten, Mocks registrieren, truncateAll()
        ├── helpers.ts                         # createUser, createRoom, seedSwipe, seedMatch etc.
        ├── unit/
        │   ├── auth.unit.test.ts              # decodeRefreshToken
        │   ├── middleware.unit.test.ts        # authMiddleware (mock req/res) + 401-Verhalten
        │   └── room-stack.unit.test.ts        # buildTmdbUrl (nach Export)
        └── integration/
            ├── auth.integration.test.ts
            ├── rooms.integration.test.ts
            ├── swipes-matchmaking.integration.test.ts
            ├── movies.integration.test.ts
            └── matches.integration.test.ts
```

---

## Konfiguration

### vitest.config.ts

- `pool: 'forks'` (nicht `threads` — MySQL-Connections nicht thread-safe)
- `fileParallelism: false`
- `testTimeout: 10000`
- `hookTimeout: 15000` (Schema-Anwendung in globalSetup kann dauern)
- `setupFiles: ['./src/tests/setup.ts']`
- `globalSetup: './src/tests/global-setup.ts'`
- `include: ['src/tests/**/*.test.ts']`
- `envFile: '.env.test'`

### .env.test

```
NODE_ENV=test
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<testpass>
DB_NAME=watchd_test
JWT_SECRET=test-jwt-secret
JWT_REFRESH_SECRET=test-refresh-secret
TMDB_API_KEY=fake-key-not-used
BCRYPT_ROUNDS=4
```

Alle `requireEnv`-Variablen aus `config.ts` müssen gesetzt sein — sonst crasht der Import beim Test-Start.

### global-setup.ts

Wird **einmalig** vor allen Tests ausgeführt (auch im Watch-Mode nur beim ersten Start):

1. `CREATE DATABASE IF NOT EXISTS watchd_test`
2. `schema.sql` anwenden via `multipleStatements: true`
3. Verbindung schließen

**Wichtig**: Im Watch-Mode läuft `globalSetup` bei Dateiänderungen **nicht** erneut. Schema-Änderungen erfordern manuellen Test-Restart.

### setup.ts (pro Test-Datei)

1. `createApp({ skipRateLimiter: true })` aufrufen
2. Server auf **Port 0** starten (OS wählt freien Port — verhindert Port-Konflikte im Watch-Mode)
3. Globale Mocks registrieren (siehe Mock-Strategie)
4. `truncateAll()` exportieren
5. `afterAll`: Server schließen + Pool beenden (`pool.end()`) — verhindert Connection-Leak im Watch-Mode

---

## Mock-Strategie (zentral in setup.ts)

Alle Mocks werden einmalig in `setup.ts` via `vi.mock` registriert — kein Copy-Paste in jede Test-Datei.

| Modul | Mock | Begründung |
|-------|------|------------|
| `../services/room-stack` | `generateRoomStack` + `appendRoomStack` → No-Op (`Promise.resolve()`) | Ruft TMDB auf; Stack wird via `seedStackMovie` manuell befüllt |
| `../socket` | `getIo()` → `{ to: vi.fn(() => ({ emit: vi.fn() })) }`, `disconnectUserSockets` → `vi.fn()` | Side-effect; Tests assertieren ob `emit` aufgerufen wurde |
| `../services/apns` | `sendMatchPush` → `vi.fn().mockResolvedValue(undefined)` | Side-effect; keine Rückwirkung auf Response |
| `../services/mail` | `sendPasswordResetEmail` → `vi.fn().mockResolvedValue(undefined)` | Side-effect; in forgot-password-Tests assertieren ob aufgerufen |
| `../services/tmdb` | `getMovieById` → statisches Film-Objekt, `getPopularMovies` → statische Liste | Deterministisch; Feed-Tests brauchen konsistente Daten |
| `../services/justwatch` | `getStreamingOffers` → `[]` | Deterministisch; Streaming-Daten sind kein Test-Fokus |

**Konsequenz für Stack-Seeding**: Da `generateRoomStack` ein No-Op ist, hat jeder neu erstellte Room einen leeren Stack. Tests die Feed oder Swipes testen, müssen Stack-Daten **explizit** via `seedStackMovie(roomId, movieId, position)` setzen. Das ist gewollt — es macht Test-Abhängigkeiten sichtbar.

---

## helpers.ts

```typescript
// Erstellt User via echten /register-Endpoint — Token-Paar ist garantiert DB-konsistent
createUser(agent, overrides?: { name?, email?, password? })
  → { accessToken, refreshToken, userId }

// Erstellt Guest via /guest
createGuestUser(agent)
  → { accessToken, refreshToken, userId }

// Direkter DB-Insert — kein HTTP, da nur Vorbedingung
seedStackMovie(roomId, movieId, position)
seedSwipe(userId, movieId, roomId, direction)
seedMatch(roomId, movieId)

// HTTP-basiert — testen den echten Flow
createRoom(agent, token, filters?)  → room
joinRoom(agent, token, code)        → room

// TRUNCATE aller 8 Tabellen in einem Query (SET FOREIGN_KEY_CHECKS=0)
// Reihenfolge: password_reset_tokens, refresh_tokens, favorites,
//              room_stack, matches, swipes, room_members, rooms, users
truncateAll()
```

`createUser` ruft den echten `/register`-Endpoint auf — kein manuelles JWT-Signing. Vorteil: wenn Register bricht, schlagen alle Tests fehl, statt still falsche Tokens zu nutzen.

---

## Unit Tests

**Nur für pure Funktionen ohne I/O.**

| Test | Datei | Was |
|------|-------|-----|
| `decodeRefreshToken` | `auth.unit.test.ts` | Pure base64-Parsing, Fehlerszenarien |
| `authMiddleware` | `middleware.unit.test.ts` | Mock req/res; kein Token → 401, abgelaufener Token → 401, gültiger Token → `next()` |
| `buildTmdbUrl` | `room-stack.unit.test.ts` | Viele Filterkombinationen, pure URL-Konstruktion |

---

## Integration Tests — Prioritäten

### Priorität 1 — Pflicht vor erstem CI-Lauf

#### Auth (`auth.integration.test.ts`)

```
POST /api/auth/register
  ✓ Happy path → 201 + Token-Paar
  ✓ Duplicate email → 409
  ✓ Passwort zu kurz → 400
  ✓ Ungültige Email → 400

POST /api/auth/login
  ✓ Happy path → Token-Paar
  ✓ Falsches Passwort → 401
  ✓ Unbekannte Email → 401 (gleiche Message — kein User-Enumeration-Leak)

POST /api/auth/guest
  ✓ Liefert is_guest=true + gültiges Token-Paar

POST /api/auth/refresh  ← kritischster Pfad
  ✓ Happy path → neues Token-Paar, altes in DB revoked
  ✓ Token-Wiederverwendung → 401 + gesamte family_id revoked (Theft Detection)
  ✓ Abgelaufener Token → 401
  ✓ Ungültiges Format → 401

POST /api/auth/forgot-password
  ✓ Bekannte Email → 200 (Mail-Mock assertieren ob aufgerufen)
  ✓ Unbekannte Email → 200 (gleiche Response — kein User-Enumeration-Leak, Mock NICHT aufgerufen)

POST /api/auth/reset-password
  ✓ Happy path → Passwort geändert, Token als used markiert, alle Refresh-Tokens revoked
  ✓ Token bereits used → 400
  ✓ Abgelaufener Token → 400

POST /api/auth/upgrade
  ✓ Guest → Vollkonto, is_guest=false in DB
  ✓ Nicht-Guest versucht upgrade → 400
  ✓ Email bereits vergeben → 409

POST /api/auth/logout
  ✓ Refresh-Token nach Logout in DB revoked

DELETE /api/auth/delete-account
  ✓ User + alle Tokens gelöscht, danach kein Login möglich
```

#### Swipes + Matchmaking (`swipes-matchmaking.integration.test.ts`)

```
POST /api/swipes
  ✓ Left-Swipe → kein Match, Swipe in DB gespeichert
  ✓ Right-Swipe, nur 1 Member im Room → kein Match
  ✓ Beide Member swipen right → Match erstellt, matchId in Response,
      Socket-Mock assertieren: io.to('room:X').emit('match', ...)
  ✓ Idempotenz: POST /swipes für selbes room+movie zweimal → nur 1 Match in DB (INSERT IGNORE)
  ✓ User ist kein Mitglied des Rooms → 403
```

### Priorität 2 — Vor erstem produktivem Einsatz

#### Rooms (`rooms.integration.test.ts`)

```
POST /api/rooms
  ✓ Room erstellt, Creator in room_members, Status=waiting

POST /api/rooms/join
  ✓ 2. User joined → Status=active
  ✓ Room voll (2 Members) → 409
  ✓ Aufgelöster Room → 410
  ✓ Ungültiger Code → 404

DELETE /api/rooms/:id/leave
  ✓ Letzter Member verlässt nach Nutzung → Status=dissolved
  ✓ Creator verlässt ohne je einen Partner → hard-deleted
  ✓ Ein Member verlässt bei 2 Members → Status=waiting, Partner bleibt

DELETE /api/rooms/:id/archive
  ✓ Erster User löscht → deleted_from_archive_at gesetzt
  ✓ Zweiter User löscht → Room hard-deleted

PATCH /api/rooms/:id/filters
  ✓ Filter aktualisiert, room_stack zurückgesetzt,
      Socket-Mock assertieren: emit('filters_updated', ...)
```

#### Movies Feed (`movies.integration.test.ts`)

```
GET /api/movies/feed
  ✓ afterPosition=0 → erste 20 unseen Filme, lastPosition korrekt
  ✓ afterPosition=X → nächste 20, kein Overlap
  ✓ Bereits geswiped Filme erscheinen nicht im Feed
  ✓ Leerer Stack → leere Response, hasMore=false

GET /api/movies/rooms/:roomId/next-movie
  ✓ Gibt nächsten ungeswiped Film zurück
  ✓ Kein ungeswiped Film → 404
```

Hinweis: Alle Feed-Tests erfordern manuell geseedete Stack-Daten via `seedStackMovie`.

#### Matches (`matches.integration.test.ts`)

```
GET /api/matches/:roomId
  ✓ Matches paginiert zurückgegeben, watched-Feld korrekt

PATCH /api/matches/:matchId
  ✓ watched=true → DB-Feld aktualisiert
  ✓ watched=false → DB-Feld aktualisiert (toggle)

POST /api/matches/favorites
  ✓ Film zu Favoriten hinzugefügt
  ✓ Duplicate → kein Fehler (ON DUPLICATE KEY)

DELETE /api/matches/favorites/:movieId
  ✓ Favorit entfernt

GET /api/matches/favorites/list
  ✓ Favoriten paginiert zurückgegeben
```

### Priorität 3 — Nice-to-have

```
PATCH /api/rooms/:id           ✓ Room umbenennen
PATCH /api/users/me            ✓ Username ändern
POST  /api/users/me/device-token ✓ Device-Token registriert
```

---

## Was wir NICHT testen

| Was | Warum |
|-----|-------|
| `token-cleanup.ts` | Scheduled Job — kein deterministischer Testpunkt; wird in App-Factory nicht gestartet |
| `apns.ts`, `mail.ts` | Werden gemockt; eigene Unit Tests bringen keinen Mehrwert |
| `generateRoomStack` / `appendRoomStack` | TMDB-abhängig; werden per `vi.mock` als No-Op abgedeckt |
| iOS (SwiftUI) | Komplex, kein MVP-ROI |
| E2E / System Tests | Erfordern vollständigen Stack inkl. iOS-Simulator |
| Echte Concurrency (Race Conditions) | Matchmaking-Idempotenz-Test ist sequentiell — testet INSERT IGNORE, nicht echte Parallelität. Ausreichend für MVP. |

---

## Test-DB Setup (einmalig)

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS watchd_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p watchd_test < src/db/schema.sql
```

Alternativ: `global-setup.ts` erledigt das automatisch beim ersten Testlauf.

---

## CI (GitHub Actions)

```yaml
services:
  mysql:
    image: mysql:8.0
    env:
      MYSQL_ROOT_PASSWORD: testpass
      MYSQL_DATABASE: watchd_test
    ports:
      - 3306:3306
    options: >-
      --health-cmd="mysqladmin ping"
      --health-interval=10s
      --health-timeout=5s
      --health-retries=3
```

Tests laufen ausschließlich in GitHub Actions. Railway bleibt reines Deployment-Target — keine Test-DB auf Railway.

---

## npm Scripts

```bash
npm run test           # alle Tests einmalig
npm run test:watch     # watch mode (Port 0 verhindert Konflikte bei Re-Runs)
npm run test:coverage  # Coverage-Report
```

---

## Watch-Mode — Besonderheiten

- **Port 0**: Server startet auf OS-zugewiesenem Port — keine Port-Konflikte bei Datei-Re-Runs
- **Pool.end() in afterAll**: Verhindert Connection-Leak bei wiederholten Runs
- **Schema-Änderungen**: Erfordern manuellen Restart — `globalSetup` läuft im Watch-Mode nicht erneut
- **TRUNCATE-Performance**: Alle 8 Tabellen in einem einzigen `multipleStatements`-Query — nicht 8 separate Queries
