# Watchd Backend - Optimierungen & Deployment

## Installation der neuen Dependencies

```bash
cd watchd_backend-mac
npm install
```

Neue Packages:
- `express-rate-limit` - Rate Limiting für Auth-Endpoints
- `express-validator` - Input-Validierung
- `pino` - Strukturiertes Logging

## Datenbank-Migration

Führe die SQL-Migration aus um das Schema zu aktualisieren:

```bash
mysql -u root -p watchd < migrations/001_optimizations.sql
```

Oder manuell via MySQL-Client:

```sql
source /path/to/watchd_backend-mac/migrations/001_optimizations.sql;
```

### Neue DB-Tabellen:
- `password_reset_tokens` - Für Password-Reset-Flow
- `room_stack` - Für synchronisierte Movie-Feeds
- `favorites` - Persönliche Favoriten-Liste

### Geänderte Spalten:
- `users`: `email` und `password_hash` sind jetzt NULL-able, neues Feld `is_guest`
- `rooms`: Neue Felder `status`, `name`, `filters`, `last_activity_at`
- `room_members`: Neues Feld `is_active`
- `matches`: Neues Feld `watched`

## Neue API-Endpoints

### Auth
- `POST /api/auth/guest` - Gast-Login ohne E-Mail/Passwort
- `POST /api/auth/upgrade` - Gast-Account zu vollwertigem Konto upgraden
- `POST /api/auth/forgot-password` - Password-Reset anfordern
- `POST /api/auth/reset-password` - Passwort zurücksetzen

### Users
- `PATCH /api/users/me` - Nutzernamen ändern

### Rooms
- `GET /api/rooms` - Alle Rooms des Users abrufen
- `PATCH /api/rooms/:id` - Room-Name ändern
- `PATCH /api/rooms/:id/filters` - Filter aktualisieren
- `DELETE /api/rooms/:id/leave` - Room verlassen

### Movies
- `GET /api/movies/rooms/:roomId/next-movie` - Nächsten Film aus Room-Stack holen

### Matches
- `PATCH /api/matches/:matchId` - Match als "geschaut" markieren

### Favorites
- `POST /api/matches/favorites` - Zu Favoriten hinzufügen
- `DELETE /api/matches/favorites/:movieId` - Aus Favoriten entfernen
- `GET /api/matches/favorites/list` - Alle Favoriten abrufen

## Environment Variables

Keine neuen Env-Variablen nötig. Bestehende `.env` ist ausreichend:

```env
PORT=3000
JWT_SECRET=...
TMDB_API_KEY=...
DB_HOST=...
DB_PORT=3306
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
LOG_LEVEL=info # Optional, default: info
NODE_ENV=production # Optional für Production
```

## Neues Logging

Das Backend verwendet jetzt strukturiertes JSON-Logging mit Pino:

```typescript
import { logger } from './logger';

logger.info({ userId, roomId }, 'User joined room');
logger.error({ err, userId }, 'Login failed');
```

In Development wird Pretty-Printing aktiviert (bunte Console-Logs).
In Production werden JSON-Logs ausgegeben (für Log-Aggregation).

## Graceful Shutdown

Der Server reagiert jetzt auf `SIGTERM` und `SIGINT`:
- Schließt HTTP-Server (keine neuen Connections)
- Schließt Socket.io-Verbindungen
- Beendet DB-Pool sauber

## Health-Check

Der `/health`-Endpoint ist jetzt erweitert:

```json
{
  "status": "ok",
  "db": "ok",
  "uptime": 123.45
}
```

Status ist "degraded" wenn DB nicht erreichbar, aber HTTP 200 wird trotzdem zurückgegeben.

## Rate Limiting

Auth-Endpoints sind jetzt geschützt:
- `/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`
- Limit: 10 Requests pro 15 Minuten pro IP
- Response bei Überschreitung: HTTP 429 mit deutscher Fehlermeldung

## Room-Stack-System

Rooms haben jetzt einen serverseitig generierten Movie-Stack:
- Bei Room-Erstellung werden 5 Seiten TMDB-Filme (~100 Filme) gefetcht
- Filter werden angewendet (Genres, Streaming-Services, Rating, etc.)
- Beide Partner sehen denselben Stack in derselben Reihenfolge
- Keine Duplikate mehr möglich
- Drastisch weniger TMDB API-Calls

## Deployment-Checklist

- [ ] Datenbank-Migration ausführen
- [ ] `npm install` für neue Dependencies
- [ ] `.env` prüfen (keine Änderungen nötig)
- [ ] Server neu starten
- [ ] Health-Check testen: `curl http://localhost:3000/health`
- [ ] Logs prüfen (sollten jetzt strukturiert sein)

## iOS-Integration

Die iOS-App unterstützt jetzt:
- Gast-Modus (ohne E-Mail/Passwort)
- Deep Links (`watchd://join/<CODE>`, `watchd://reset-password?token=...`)
- Offline-Handling mit Banner
- Automatisches Logout bei 401
- Alle neuen API-Features

Wichtig: In Xcode unter `Info.plist` muss das URL-Scheme `watchd` registriert sein.
