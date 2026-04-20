# Troubleshooting - Watchd Backend

Incident-Playbook fuer Laufzeitprobleme, die nicht schon durch das Deploy-Troubleshooting in `CLAUDE.md` abgedeckt sind.

Ziel: beim ersten echten Incident nicht bei null anfangen. Diese Datei darf ruhig unvollstaendig starten und nach realen Vorfaellen konkreter werden.

---

## Verwendung

Pro Symptom:

1. Symptom moeglichst konkret benennen
2. Erst schnelle Checks machen (Logs, `/health`, DB-Status, letzte Aenderung)
3. Wahrscheinlichste Ursache notieren
4. Wenn der Fall neu war: Eintrag hier direkt schaerfen

---

## Baseline Checks

Vor tieferem Debugging immer zuerst:

- Railway-Logs des aktuellen Deploys pruefen
- `GET /health` aufrufen und auf `db` / `tmdb` achten
- pruefen, ob das Problem nach einem frischen Deploy, Env-Var-Change oder externen Provider-Problem angefangen hat
- betroffenen `room_id`, `user_id`, `movie_id` aus Logs oder DB sichern, bevor Daten weiter mutieren

---

## Incident-Katalog

### Socket disconnectet staendig

**Diagnose-Schritte**

- Railway-Logs auf wiederkehrende Server-Errors, Restarts oder ungefangene Promise-Rejections pruefen
- verifizieren, dass Client und Backend dieselbe Base-URL / dasselbe Environment nutzen
- pruefen, ob `JOIN_ROOM` fehlschlaegt, weil Room-Mitgliedschaft in `room_members` fehlt oder `is_active = 0` ist
- gegenchecken, ob CORS / Origin-Konfiguration kuerzlich geaendert wurde

**Haeufigste Ursachen**

- Client zeigt auf falsches Backend oder falsches Environment
- User ist kein aktives Room-Mitglied mehr
- Server wurde redeployed / restarted und die Verbindung baut in Schleife neu auf
- Socket-Handshake scheitert wegen Auth- oder Origin-Problem

### Match-Push doppelt

**Diagnose-Schritte**

- Logs fuer denselben `room_id` + `movie_id` korrelieren: wurde ein Match einmal oder mehrfach erzeugt
- in `matches` pruefen, ob es nur einen Datensatz fuer die Kombination gibt
- kontrollieren, ob mehrere Device-Tokens fuer denselben User registriert sind
- pruefen, ob der Client dieselbe Push-Nachricht lokal doppelt verarbeitet oder parallel noch ein Socket-Event rendert

**Haeufigste Ursachen**

- nicht zwei Matches, sondern ein Match plus doppelte Darstellung im Client
- alte / doppelte Device-Tokens beim selben User
- Retry-Verhalten ausserhalb der DB-Match-Erzeugung fuehrt zu doppeltem Push-Versand

### `room_stack` bleibt leer trotz aktivem User

**Diagnose-Schritte**

- `rooms`-Zeile pruefen: `stack_generating`, `stack_exhausted`, `stack_next_page`, `filters`
- Logs rund um `generateRoomStack` / `appendRoomStack` pruefen
- verifizieren, ob TMDB fuer die gesetzten Filter ueberhaupt Ergebnisse liefert
- pruefen, ob der Trigger in `/api/movies/feed` oder `/api/movies/rooms/:roomId/next-movie` erreicht wird
- in `room_stack` und `swipes` gegenchecken, ob der Stack wirklich leer ist oder nur fuer den User nichts Unseen mehr uebrig ist

**Haeufigste Ursachen**

- Filter sind zu eng, TMDB liefert keine weiteren Titel
- `stack_exhausted = 1` blockiert weitere Refills
- frueherer Fehler hat Refill verhindert; Logs zeigen den ersten Ausloeser
- fuer den konkreten User sind alle vorhandenen Stack-Filme bereits geswiped

---

## SQL-Snippets

```sql
SELECT id, stack_generating, stack_exhausted, stack_next_page, filters
FROM rooms
WHERE id = ?;

SELECT movie_id, position
FROM room_stack
WHERE room_id = ?
ORDER BY position ASC
LIMIT 50;

SELECT user_id, is_active
FROM room_members
WHERE room_id = ?;

SELECT user_id, movie_id, direction, created_at
FROM swipes
WHERE room_id = ?
ORDER BY created_at DESC
LIMIT 50;

SELECT id, room_id, movie_id, created_at
FROM matches
WHERE room_id = ?
ORDER BY created_at DESC
LIMIT 20;
```
