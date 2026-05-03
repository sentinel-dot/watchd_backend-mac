# Apple Sign In — Setup-Anleitung

Vollständige Anleitung: Apple Developer Portal → Env Vars → lokales Testen.

---

## Voraussetzungen

- Apple Developer Account (Paid, $99/Jahr)
- Team ID: **Account → Membership Details** (10-Zeichen, z. B. `RNK5A8AP8B`)
- Bundle ID der iOS App: `com.milinkovic.watchd`

---

## Schritt 1 — Capability auf der App ID aktivieren

1. **Certificates, Identifiers & Profiles → Identifiers**
2. Klick auf `com.milinkovic.watchd`
3. Scrolle zu **Sign In with Apple** → Checkbox aktivieren
4. Save → Confirm

---

## Schritt 2 — Private Key erstellen

1. **Keys → (+)**
2. Key Name: `Watchd Sign In with Apple`
3. **Sign In with Apple** aktivieren → Configure → Primary App ID: `com.milinkovic.watchd` → Save
4. Continue → Register
5. **Download** (nur einmal möglich!) — `.p8`-Datei sicher aufbewahren
6. **Key ID** (10-Zeichen) notieren → wird `APPLE_KEY_ID`

> Kein Services ID nötig. Services IDs sind nur für web-basierte Sign-In-Flows (JavaScript API).
> Für native iOS Apps ist der Client immer die Bundle ID.

---

## Schritt 3 — Private Key base64-kodieren

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'
```

Ausgabe (einzeilige Zeichenkette ohne Zeilenumbrüche) → wird `APPLE_PRIVATE_KEY`.

---

## Schritt 4 — Env Vars setzen

### Lokal (`.env`)

```
APPLE_SERVICES_ID=com.milinkovic.watchd   # Bundle ID — NICHT Services ID
APPLE_TEAM_ID=RNK5A8AP8B                  # 10-char Team ID
APPLE_KEY_ID=XXXXXXXXXX                   # Key ID aus Schritt 2
APPLE_PRIVATE_KEY=<base64-string>         # Ausgabe aus Schritt 3
```

### Railway (Production)

Railway Dashboard → Projekt → Variables → gleiche vier Werte eintragen → Redeploy startet automatisch.

---

## Schritt 5 — Xcode Capability bestätigen

1. Target → **Signing & Capabilities**
2. Prüfen ob **Sign In with Apple** bereits eingetragen ist
3. Falls nicht: `+ Capability → Sign In with Apple`

---

## Wichtige Hinweise

**`APPLE_SERVICES_ID` ist die Bundle ID, nicht eine Services ID**

Apple setzt den `aud`-Claim im Identity Token für native iOS Apps auf die Bundle ID.
Wird stattdessen eine Services ID (`com.milinkovic.watchd.signin`) eingetragen,
schlägt die Verifizierung mit `jwt audience invalid` fehl.

**Name kommt nur beim ersten Sign-In**

Apple überträgt `givenName` / `familyName` nur beim allerersten Sign-In mit dieser App.
Bei späteren Logins ist `name` leer → Backend-Fallback: `Watchd-User`.

Um den Namen-Flow erneut zu triggern (z. B. nach DB-Wipe im Dev):

> **Einstellungen → [Apple-ID-Name] → Passwort & Sicherheit → Apps, die Apple-ID verwenden → Watchd → Verbindung trennen**

Beim nächsten Sign-In wird der Name wieder gesendet.

**Authorization Code ist einmalig**

Der `authorizationCode` aus dem iOS Credential kann nur einmal gegen ein Refresh Token
eingetauscht werden. Falls der Exchange scheitert (Netzwerk, Race), wird der Login
trotzdem durchgeführt — nur ohne gespeichertes `apple_refresh_token`.
Das ist für Dev unkritisch; die Revocation bei `DELETE /auth/delete-account` ist dann ein No-op.

**Sandbox vs. Production**

Apple Sign-In hat keine getrennte Sandbox — dieselben Credentials funktionieren in Dev
und Prod. Kein equivalent zu `APNS_PRODUCTION`.

---

## Troubleshooting

| Fehler                                                         | Ursache                                     | Fix                                                       |
| -------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `jwt audience invalid. expected: com.milinkovic.watchd.signin` | `APPLE_SERVICES_ID` auf Services ID gesetzt | Wert auf Bundle ID `com.milinkovic.watchd` ändern         |
| `jwt audience invalid. expected: com.milinkovic.watchd`        | `APPLE_SERVICES_ID` leer oder falsch        | Wert prüfen                                               |
| `invalid_client` beim Auth-Code-Exchange                       | Falscher Key, Team ID oder Bundle ID        | Alle vier Vars gegen Portal-Werte abgleichen              |
| Name erscheint als `Watchd-User`                               | Apple sendet Name nur beim Erst-Login       | App unter Apple-ID-Einstellungen entfernen, neu einloggen |
| 503 `Apple Sign-In not configured`                             | Mind. eine der vier Vars fehlt              | Alle vier Vars in `.env` / Railway setzen                 |
