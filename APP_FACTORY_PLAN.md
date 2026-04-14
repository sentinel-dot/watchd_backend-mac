# Plan: app.ts Factory Extraktion

## Kontext

`index.ts` vermischt aktuell vier logisch getrennte Verantwortlichkeiten:

1. **App-Konfiguration** — Middleware, Routes, Endpoints
2. **Server-Lifecycle** — `listen()`, `shutdown()`, Signal-Handler
3. **Start-Seiteneffekte** — `scheduleTokenCleanup()`, `applyDevSchemaIfEnabled()`
4. **Socket.io-Init** — `initSocket(httpServer, parsedOrigins)`

Tests brauchen ausschließlich (1). Alles andere ist Produktion-only und darf in Tests nicht laufen:
- Rate-Limiter → Auth-Tests schlagen ab dem 11. Request mit 429 fehl (silent killer)
- `scheduleTokenCleanup` → Job feuert 30s nach Start gegen die Test-DB
- `initSocket` → Socket.io-Server kollidiert mit dem gemockten `getIo()`
- `import 'dotenv/config'` → würde `.env` statt `.env.test` laden

---

## Produktionscode-Änderungen

### 1. `src/app.ts` — neu erstellen

Exportiert eine einzige Factory-Funktion:

```typescript
createApp(options?: { skipRateLimiter?: boolean })
  → { app: Express, httpServer: http.Server, parsedOrigins: string | string[] }
```

Inhalt in dieser Reihenfolge:

| # | Was | Bedingung |
|---|-----|-----------|
| 1 | `express()` + `app.set('trust proxy', 1)` | immer |
| 2 | Helmet-Middleware | immer |
| 3 | `parsedOrigins` aus `config.corsOrigins` berechnen + CORS-Middleware | immer |
| 4 | `express.json({ limit: '1mb' })` | immer |
| 5 | Static `/icons` | immer |
| 6 | `authLimiter` (10/15min) + `swipeLimiter` (120/min) registrieren | nur wenn `!options?.skipRateLimiter` |
| 7 | Alle Route-Prefixe (`/api/auth`, `/api/users`, `/api/rooms`, `/api/movies`, `/api/swipes`, `/api/matches`) | immer |
| 8 | `/health` Endpoint | immer |
| 9 | `/.well-known/apple-app-site-association` | immer |
| 10 | `/reset-password` Fallback | immer |
| 11 | 404-Catch-all | immer |
| 12 | Error-Middleware | immer |
| 13 | `http.createServer(app)` → `httpServer` | immer |
| 14 | `return { app, httpServer, parsedOrigins }` | immer |

**Wichtig:** `import 'dotenv/config'` kommt **nicht** in `app.ts`. Tests laden Env-Vars selbst via vitests `envFile`-Config. Steht es in `app.ts`, würde der Import `.env` statt `.env.test` laden — alle Secrets wären falsch.

### 2. `src/index.ts` — wird zum dünnen Wrapper

Nach dem Refactor enthält `index.ts` nur noch:

```
import 'dotenv/config'                          ← bleibt hier, nirgendwo sonst
createApp()  →  { httpServer, parsedOrigins }
initSocket(httpServer, parsedOrigins)
unhandledRejection Handler
uncaughtException Handler
SIGTERM / SIGINT → shutdown()
start(): applyDevSchemaIfEnabled()
          + scheduleTokenCleanup()
          + httpServer.listen(config.port)
void start()
```

`export { app }` (aktuell Zeile 237) fällt weg — war ein Überbleibsel, wird nirgends importiert.

### 3. `src/config.ts` — `BCRYPT_ROUNDS` ergänzen

```typescript
bcryptRounds: parseInt(process.env['BCRYPT_ROUNDS'] ?? '12', 10),
```

Optional, kein `requireEnv`. Default 12 für Produktion.

### 4. `src/routes/auth.ts` — Runden aus Config lesen

Alle `bcrypt.hash(password, 12)` und `bcrypt.compare`-Aufrufe ersetzen durch `config.bcryptRounds`.
Betrifft: `register`, `upgrade`, `reset-password` (Hash-Erstellung).

---

## Warum `parsedOrigins` zurückgegeben wird

`initSocket` braucht `parsedOrigins` für seine eigene CORS-Konfiguration. Die Berechnung liegt in `createApp`, weil sie dort für die CORS-Middleware gebraucht wird. Zwei Alternativen wurden verworfen:

- **`index.ts` berechnet es ein zweites Mal** → Duplikation, könnte auseinanderlaufen
- **`socket/index.ts` liest direkt aus `config`** → ungewollte Kopplung, ist eine Änderung an Socket-Code außerhalb des Scope

Lösung: `createApp` gibt `parsedOrigins` zurück, `index.ts` reicht es an `initSocket` weiter.

---

## Nutzung in Tests (`setup.ts`)

```typescript
import { createApp } from '../app'
import { AddressInfo } from 'net'

const { app, httpServer } = createApp({ skipRateLimiter: true })

// Port 0 → OS wählt freien Port — verhindert Konflikte im Watch-Mode
httpServer.listen(0)
const port = (httpServer.address() as AddressInfo).port
export const agent = supertest(`http://localhost:${port}`)

afterAll(async () => {
  httpServer.close()
  await pool.end()   // verhindert Connection-Leak bei Watch-Mode Re-Runs
})
```

---

## Was sich NICHT ändert

- `socket/index.ts` — unverändert
- Alle Route-Dateien — unverändert
- Alle Services — unverändert
- Alle Middleware — unverändert
- Verhalten im Produktionsmodus — identisch: `index.ts` ruft `createApp()` ohne Options auf

---

## Risiken

Keines — reines Refactoring ohne Verhaltensänderung. Der einzige echte Fallstrick ist `import 'dotenv/config'` in `app.ts` (darf nicht passieren, siehe oben).

---

## Reihenfolge der Implementierung

1. `src/config.ts` — `bcryptRounds` ergänzen
2. `src/app.ts` — Factory erstellen (alles aus `index.ts` kopieren, `skipRateLimiter`-Guard einbauen)
3. `src/index.ts` — auf dünnen Wrapper reduzieren
4. `src/routes/auth.ts` — hardcodierte Runden durch `config.bcryptRounds` ersetzen
5. `npm run typecheck` — muss grün sein
