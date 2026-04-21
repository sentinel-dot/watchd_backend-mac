# Test-Lücken

Aktuelle Coverage ist für Happy-Paths + Matching/Stack solide. Es fehlen vor allem **Services**, **Input-Validierung** und **Autorisierungsgrenzen**. Sortiert nach Nutzen.

---

## Lücken mit hohem Nutzen

### Services ohne Tests (derzeit nur gemockt)

- `services/justwatch.ts` — Parser-Unit-Test: `flatrate + free`-Merge, `iconPath`-Mapping, unbekannter Anbieter, leere Offers, malformed GraphQL (graceful degrade)
- `services/tmdb.ts` — Bearer-Token-Pfad vs. `api_key`-Query, LRU-Cache-Hit (zweiter Call ohne fetch)
- `services/matchmaking.ts` — direkter Unit-Test statt nur via Swipe-Route: 1 von 2 rechts, Mix-Swipes, Match ohne `device_token` (kein Crash)

### Swipes — Validierung + Edge-Cases

- Ungültige `direction` (weder `left` noch `right`) → 400
- Fehlende `movieId` / `roomId` → 400
- Idempotenz Left-Swipe (zweimal dasselbe Movie)
- 401 ohne Auth
- `movieId` nicht im `room_stack` des Rooms

### Autorisierungsgrenzen (aktuell nicht konsistent getestet)

- `PATCH /api/matches/:matchId` für Match aus fremdem Room → 403
- `GET /api/movies/feed` + `/next-movie` für Nicht-Member → 403
- `PATCH /api/rooms/:id/filters` für Nicht-Member → 403
- `DELETE /api/matches/favorites/:movieId` für fremden Favoriten

### Auth-Kanten

- Authorization-Header fehlt/malformed → 401 (nicht 500)
- Case-insensitive Email-Login (`NIKO@…` = `niko@…`)
- Passwort >72 Byte (bcrypt-Grenze)
- Refresh-Rotation über 3+ Generationen hält `family_id` konstant

### Rate-Limiter

Mindestens ein Integration-Test **ohne** `skipRateLimiter` → 11. Auth-Request in 15 min → 429. Sonst ist der Limiter produktiv totes Terrain.

### Room-Filter-Validierung

Invalide Genre-IDs, Jahr-Range umgekehrt (`from > to`), Filter-Objekt mit unbekannten Keys.

---

## Bewusst verzichten (kein ROI)

- `token-cleanup.ts` (scheduled, nicht deterministisch — CLAUDE.md sagt das bereits)
- `apns.ts` / `mail.ts` direkt (externe Seiteneffekte, gemockt reicht)
- E2E / iOS (MVP-Scope)
- `config.ts` Startup-Throw (trivialer Code, Test wäre Tautologie)

---

## Empfohlene Reihenfolge

1. JustWatch-Parser-Unit-Tests
2. Swipe-Validierung
3. Autorisierungs-403er (Matches/Movies/Rooms)
4. Auth-Kanten
5. Rate-Limiter
6. TMDB-Client
7. Matchmaking direkt (zweitrangig — Swipe-Integration deckt Happy Path schon ab)
8. Room-Filter-Validierung

Begründung Reihenfolge 1–3: Das sind die Stellen, an denen ein stiller Bug real in Prod ankommen würde.
