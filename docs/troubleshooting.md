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
- betroffenen `partnership_id`, `user_id`, `movie_id` aus Logs oder DB sichern, bevor Daten weiter mutieren

---

## Incident-Katalog

### Socket disconnectet staendig

**Diagnose-Schritte**

- Railway-Logs auf wiederkehrende Server-Errors, Restarts oder ungefangene Promise-Rejections pruefen
- verifizieren, dass Client und Backend dieselbe Base-URL / dasselbe Environment nutzen
- pruefen, ob `JOIN`-Payload `{ token, partnershipId }` fehlschlaegt, weil Partnership-Mitgliedschaft in `partnership_members` fehlt
- gegenchecken, ob CORS / Origin-Konfiguration kuerzlich geaendert wurde

**Haeufigste Ursachen**

- Client zeigt auf falsches Backend oder falsches Environment
- User ist kein Member der angegebenen Partnership (fehlt in `partnership_members`)
- Server wurde redeployed / restarted und die Verbindung baut in Schleife neu auf
- Socket-Handshake scheitert wegen Auth- oder Origin-Problem

---

### Match-Push doppelt

**Diagnose-Schritte**

- Logs fuer dieselbe `partnership_id` + `movie_id` korrelieren: wurde ein Match einmal oder mehrfach erzeugt
- in `matches` pruefen, ob es nur einen Datensatz fuer die Kombination gibt
- kontrollieren, ob mehrere Device-Tokens fuer denselben User registriert sind
- pruefen, ob der Client dieselbe Push-Nachricht lokal doppelt verarbeitet oder parallel noch ein Socket-Event rendert

**Haeufigste Ursachen**

- nicht zwei Matches, sondern ein Match plus doppelte Darstellung im Client
- alte / doppelte Device-Tokens beim selben User
- Retry-Verhalten ausserhalb der DB-Match-Erzeugung fuehrt zu doppeltem Push-Versand

---

### `partnership_stack` bleibt leer trotz aktiver Partnership

**Diagnose-Schritte**

- `partnerships`-Zeile pruefen: `stack_generating`, `stack_exhausted`, `stack_next_page`, `filters`
- Logs rund um `generatePartnershipStack` / `appendPartnershipStack` pruefen
- verifizieren, ob TMDB fuer die gesetzten Filter ueberhaupt Ergebnisse liefert
- pruefen, ob der Trigger in `/api/movies/feed` oder `/api/movies/partnerships/:partnershipId/next-movie` erreicht wird
- in `partnership_stack` und `swipes` gegenchecken, ob der Stack wirklich leer ist oder nur fuer den User nichts Unseen mehr uebrig ist

**Haeufigste Ursachen**

- Filter sind zu eng, TMDB liefert keine weiteren Titel
- `stack_exhausted = 1` blockiert weitere Refills
- frueherer Fehler hat Refill verhindert; Logs zeigen den ersten Ausloeser
- fuer den konkreten User sind alle vorhandenen Stack-Filme bereits geswiped

---

### Server-Start schlägt fehl: `Cannot add foreign key constraint` (WATCHD_APPLY_SCHEMA)

**Symptom**

Railway-Log zeigt beim Start:

```
FATAL: Server start failed
Error: Cannot add foreign key constraint
sqlState: HY000
```

Lokal funktioniert der Start trotz `WATCHD_APPLY_SCHEMA=1` ohne Fehler.

**Ursache**

MySQL 8 verbietet FK-Constraints auf Spalten, die gleichzeitig als Basis-Spalte einer `STORED GENERATED` Column in derselben Tabelle benutzt werden. MariaDB erlaubt diese Kombination — daher kein lokaler Fehler.

**Fix**

Generierte Spalten durch reguläre `INT NOT NULL`-Spalten ersetzen und die Werte beim INSERT per `Math.min`/`Math.max` setzen. UNIQUE KEY bleibt erhalten und erzwingt die Pair-Uniqueness weiterhin auf DB-Ebene.

**Prüfung**

`WATCHD_APPLY_SCHEMA` ist eine Dev-/Test-Funktion — in `apply-schema.ts` wird sie bei `NODE_ENV=production` explizit geblockt. Railway sollte diese Variable im Prod-Environment **nicht** gesetzt haben.

---

### Apple Sign-In schlägt fehl: 401 / Token-Verify-Fehler

**Symptom**

`POST /api/auth/apple` gibt 401 zurück, obwohl das iOS-Gerät einen gültigen `identityToken` liefert.

**Diagnose-Schritte**

- Railway-Logs: steht dort `jwt audience invalid` oder `invalid issuer`? → `APPLE_SERVICES_ID` falsch
- steht dort `nonce validation failed`? → iOS-seitiger Nonce-SHA256-Hash stimmt nicht mit Backend überein
- steht dort `503 Apple Sign-In not configured`? → `APPLE_SERVICES_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` fehlen in Railway-Vars
- pruefen ob `APPLE_SERVICES_ID` der **Bundle ID** entspricht (`com.milinkovic.watchd`), nicht einer Services ID — native iOS-Apps setzen `aud` auf die Bundle ID, nicht auf eine Web-Services-ID

**Haeufigste Ursachen**

| Fehler                                     | Ursache                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `jwt audience invalid`                     | `APPLE_SERVICES_ID` ist eine Web-Services-ID statt der iOS Bundle ID                                                                  |
| `nonce validation failed`                  | iOS schickt SHA256(rawNonce) an Apple, aber rawNonce ans Backend — pruefen ob `AppleAuthHelper.sha256` korrekt                        |
| `503`                                      | Mind. eine der vier Apple-Env-Vars fehlt in Railway                                                                                   |
| User-Email ist `@privaterelay.appleid.com` | Normal — Apple Relay-Email. Kein Fehler, aber `Passwort vergessen`-Flow funktioniert nicht fuer diese Accounts (kein SMTP-Zustellweg) |

**Relay-Email-Besonderheit**

Apple liefert die echte Email nur beim allerersten Sign-In. Folge-Logins haben ggf. nur `sub` ohne Email. Backend-Flow behandelt das korrekt (lookup via `apple_id` zuerst) — kein Action-Item, aber gut zu wissen fuer Support-Anfragen.

---

### Partnership-Request-Push kommt nicht an

**Symptom**

User B gibt A's Share-Code ein, A bekommt keinen Push. Backend-Log zeigt keine APNs-Fehler.

**Diagnose-Schritte**

- pruefen ob User A einen `device_token` in `users` hat: `SELECT device_token FROM users WHERE id = ?`
- pruefen ob `APNS_PRODUCTION` zur App-Variante passt (Xcode-Build = `false`, TestFlight = `true`)
- Railway-Logs auf APNs-Errors oder `sendPartnershipRequestPush`-Aufruf pruefen
- Socket-Event `partnership_request` an `user:<A.id>` wird zusaetzlich gesendet — wenn A gerade in der App ist, sollte die In-App-Benachrichtigung trotzdem ankommen

**Haeufigste Ursachen**

- User A hat Push-Permission nicht erteilt → kein Device-Token → kein Push
- `APNS_PRODUCTION=true` mit Sandbox-Key kombiniert (oder umgekehrt) → schlaegt lautlos fehl
- Device-Token veraltet → iOS erneuert Token regelmaeßig; App postet neuen Token bei jedem Login
- Push-Capability fehlt in Xcode-Target → `registerForRemoteNotifications()` schlaegt lautlos fehl

---

### Share-Code-Kollision: `share-code collision ceiling`

**Symptom**

`POST /api/auth/register` oder `POST /api/users/me/share-code/regenerate` gibt 500 zurück mit `share-code collision ceiling`.

**Ursache**

`generateUniqueShareCode()` hat 5× hintereinander einen Code erzeugt, der bereits in `users.share_code` existiert. Bei ~1 Mio Usern liegt die statistische Kollisionswahrscheinlichkeit bei ca. 1 in 10⁶ pro Versuch — 5 aufeinanderfolgende Kollisionen sind in der Praxis extrem unwahrscheinlich.

**Wahrscheinlichere Ursache in der Praxis**

DB-Constraint-Problem oder Bug in `generateShareCode()` (Alphabet-Fehler), nicht echte Kollision. Logs pruefen: wirft `generateShareCode()` den Fehler wirklich fuenf Mal, oder faengt ein anderer Fehler im `try`-Block den Fehler falsch ab?

**Mitigation**

- Normalfall: User erneut versuchen lassen (Reload/Re-Register) — naechster Versuch erzeugt anderen Code
- Wenn systematisch: `share-code.ts` `generateShareCode()` debuggen, Alphabet-Konstante pruefen

---

## SQL-Snippets

```sql
-- Partnership-Status pruefen
SELECT id, status, stack_generating, stack_exhausted, stack_next_page, filters
FROM partnerships
WHERE id = ?;

-- Stack-Eintraege einer Partnership
SELECT movie_id, position
FROM partnership_stack
WHERE partnership_id = ?
ORDER BY position ASC
LIMIT 50;

-- Members einer Partnership
SELECT user_id, joined_at
FROM partnership_members
WHERE partnership_id = ?;

-- Swipes eines Users in einer Partnership
SELECT user_id, movie_id, direction, swiped_at
FROM swipes
WHERE partnership_id = ?
ORDER BY swiped_at DESC
LIMIT 50;

-- Matches einer Partnership
SELECT id, partnership_id, movie_id, watched, matched_at
FROM matches
WHERE partnership_id = ?
ORDER BY matched_at DESC
LIMIT 20;

-- Share-Code eines Users
SELECT id, name, share_code, device_token
FROM users
WHERE id = ?;
```
