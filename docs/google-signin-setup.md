# Google Sign-In — Setup-Anleitung

Vollständige Anleitung: Google Cloud Console → iOS Xcode → Env Vars → lokales Testen → App Store Freigabe.

---

## Voraussetzungen

- Google-Account mit Zugang zur Google Cloud Console
- Bundle ID der iOS App: `com.milinkovic.watchd`
- Watchd iOS Client ID (bereits erstellt): `600845465744-4cjhu5pv0fnslqfbmtjf8r4tcm54buki.apps.googleusercontent.com`

---

## Schritt 1 — Google Cloud Projekt & OAuth-Client

Diese Schritte sind bereits erledigt. Zur Dokumentation:

1. **console.cloud.google.com** → Projekt auswählen (oder neu anlegen)
2. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
3. Application type: **iOS**
4. Bundle ID: `com.milinkovic.watchd`
5. → Create

Ergebnis: `600845465744-4cjhu5pv0fnslqfbmtjf8r4tcm54buki.apps.googleusercontent.com`

> Kein Client Secret nötig. Für native iOS Apps verifiziert das Backend den ID Token gegen Googles öffentliche JWKS-Endpunkte — kein geteiltes Geheimnis.

---

## Schritt 2 — OAuth-Zustimmungsbildschirm konfigurieren

1. **APIs & Services → OAuth consent screen**
2. User type: **External** (für App Store — alle Google-Accounts)
3. App-Name: `Watchd`, Support-E-Mail: `niko156m@gmail.com`
4. Scopes: nur Basis-Scopes nötig (`openid`, `email`, `profile`) — keine sensiblen Scopes
5. Save and Continue durch alle Schritte

---

## Schritt 3 — Publishing Status

### Während der Entwicklung (Testing)

Wenn die App auf **Testing** steht, dürfen sich **nur explizit eingetragene Test-Accounts** einloggen. Jeder andere Account sieht die Fehlermeldung „OAuth-Zugriff ist auf Testnutzer beschränkt".

**Test-User hinzufügen:**

1. **APIs & Services → OAuth consent screen → Test users**
2. **+ Add Users** → Google-E-Mail-Adresse eintragen (z. B. `niko156m@gmail.com`)
3. Save

Mehrere Tester können hinzugefügt werden. Maximal 100 Test-User erlaubt.

### Für den App Store (Production)

Vor dem App Store Release muss die App in den **Production**-Status wechseln — damit können sich alle Google-Accounts einloggen, nicht nur Test-User.

**Publishing Status wechseln:**

1. **APIs & Services → OAuth consent screen**
2. Unter **Publishing status** → **Publish App**
3. Bestätigung: Ja, zur Produktion wechseln

> Für die von Watchd genutzten Basis-Scopes (`email`, `profile`, `openid`) ist **keine Google-Verifizierung** erforderlich. Der Wechsel zu Production erfolgt sofort und ohne Review-Prozess.

Würden sensible Scopes (z. B. Gmail-Lesezugriff) genutzt, wäre eine Verifizierung nötig — das ist bei Watchd nicht der Fall.

---

## Schritt 4 — Env Var setzen

Nur eine Variable nötig (kein Private Key — Verifizierung passiert über Googles öffentliche JWKs):

### Lokal (`.env`)

```
GOOGLE_CLIENT_ID_IOS=600845465744-4cjhu5pv0fnslqfbmtjf8r4tcm54buki.apps.googleusercontent.com
GOOGLE_CLIENT_ID_WEB=   # optional, für zukünftigen Web/Android-Support
```

### Railway (Production)

Railway Dashboard → Projekt → Variables → `GOOGLE_CLIENT_ID_IOS` eintragen → Redeploy startet automatisch.

---

## Schritt 5 — Xcode Setup

### 5a — GoogleSignIn SPM Package

1. Xcode → **File → Add Package Dependencies**
2. URL: `https://github.com/google/GoogleSignIn-iOS`
3. Dependency rule: Up to Next Major Version (aktuell v8.x)
4. Product: **GoogleSignIn** auswählen (nicht GoogleSignInSwift)
5. Add to Target: `watchd`

### 5b — Reversed Client ID URL Scheme

Google Sign-In benötigt ein URL Scheme für den OAuth-Callback (Redirect nach Browser-Auth).

1. Xcode → Target `watchd` → **Info → URL Types**
2. Klick auf **+**
3. URL Schemes: `com.googleusercontent.apps.600845465744-4cjhu5pv0fnslqfbmtjf8r4tcm54buki`

Das ist der Client ID umgekehrt nach Domain-Teilen:
- Original: `600845465744-4cjhu5pv0fnslqfbmtjf8r4tcm54buki.apps.googleusercontent.com`
- Reversed: `com.googleusercontent.apps.600845465744-4cjhu5pv0fnslqfbmtjf8r4tcm54buki`

> Das Feld „Identifier" kann leer bleiben. „Role" bleibt Editor.

### 5c — GIDConfiguration (bereits im Code)

`watchd/watchd/watchdApp.swift` initialisiert das SDK beim App-Start:

```swift
GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: APIConfig.googleClientId)
```

`APIConfig.googleClientId` ist auf die echte Client ID gesetzt. Kein Info.plist-Eintrag nötig (da `GENERATE_INFOPLIST_FILE = YES` aktiv ist).

### 5d — URL-Handling (bereits im Code)

`AppDelegate.swift` leitet OAuth-Callbacks an das SDK weiter:

```swift
func application(_ app: UIApplication, open url: URL, options: [...]) -> Bool {
    return GIDSignIn.sharedInstance.handle(url)
}
```

`watchdApp.swift` leitet Deep Links ebenfalls weiter — Google-URLs werden bevorzugt behandelt:

```swift
.onOpenURL { url in
    if GIDSignIn.sharedInstance.handle(url) { return }
    handleDeepLink(url)
}
```

---

## Architektur-Überblick

```
AuthView (Google-Button)
  └── authVM.signInWithGoogle()
        └── GoogleSignInHelper.signIn()           # GIDSignIn.sharedInstance.signIn(...)
              ├── iOS zeigt Google-OAuth-Sheet
              ├── User wählt Account + bestätigt
              ├── result.user.idToken?.tokenString  → idToken
              ├── GIDSignIn.sharedInstance.signOut() # sofort — Watchd nutzt JWT-Sitzung
              └── return (idToken, googleUserId)
        └── APIService.shared.googleSignIn(idToken:)
              └── POST /api/auth/google { idToken }
                    └── Backend: OAuth2Client.verifyIdToken(idToken, audience: clientId)
                          ├── payload.sub → google_id lookup in users
                          ├── payload.email → email linking (falls google_id noch unbekannt)
                          └── neu anlegen (falls weder google_id noch email bekannt)
                    └── → { token, refreshToken, user }
        └── authVM.persistSession(response)
              └── isAuthenticated = true
```

**Warum sofort `signOut()`?**
Das GoogleSignIn SDK hält nach einem Login die Google-Session im Keychain (für Token-Refresh). Watchd nutzt eigene JWT-Sessions und braucht die Google-Session danach nicht. Der sofortige `signOut()` verhindert, dass ein abgelaufenes Google-Token beim nächsten App-Start Probleme macht, und reduziert den Keychain-Footprint.

---

## Sign-In Flow im Detail

Das Backend führt einen 3-stufigen Find-or-Create-Flow aus:

1. **`google_id`-Lookup**: Kennt die DB diesen Google-Account bereits → bestehenden User zurückgeben (200)
2. **Email-Linking**: Unbekannte `google_id`, aber die E-Mail-Adresse existiert bereits → `google_id` auf den bestehenden Account schreiben, einloggen (200)
3. **Neu anlegen**: Weder `google_id` noch E-Mail bekannt → neuen User erstellen (201)

Name-Fallback: Falls Google keinen Namen liefert (selten, aber möglich) → `Watchd-User`.
E-Mail-Fallback: Falls Google keine E-Mail liefert → `email = null`, `isPasswordResettable = false`.

---

## Unterschiede zu Apple Sign-In

| Merkmal | Apple | Google |
|---------|-------|--------|
| Private Key nötig? | Ja (`.p8`) | Nein |
| Env Vars | 4 (`SERVICES_ID`, `TEAM_ID`, `KEY_ID`, `PRIVATE_KEY`) | 1 (`CLIENT_ID_IOS`) |
| Auth Code Exchange | Ja (für apple_refresh_token) | Nein |
| Revocation bei Account-Löschen | Ja (fire-and-forget) | Nein |
| Name nur beim Erst-Login | Ja | Nein (kommt immer) |
| Sandbox vs. Production | Keine Trennung | Testing vs. Production Status |
| Nonce erforderlich | Ja | Nein |

---

## Troubleshooting

| Fehler | Ursache | Fix |
|--------|---------|-----|
| „OAuth-Zugriff ist auf Testnutzer beschränkt" | App ist im Testing-Status, Account nicht als Test-User eingetragen | Test-User in OAuth consent screen hinzufügen **oder** App auf Production publishen |
| `idToken is not valid` / 401 | Falsche `GOOGLE_CLIENT_ID_IOS` | Client ID in `.env` und Railway gegen Google Cloud Console abgleichen |
| Google-Sheet öffnet sich nicht / crash | SPM Package fehlt oder URL Scheme nicht gesetzt | Schritte 5a + 5b prüfen |
| `No such module 'GoogleSignIn'` in Xcode | SPM Package noch nicht hinzugefügt | Schritt 5a durchführen |
| OAuth-Callback kommt nicht an (App friert ein) | URL Scheme falsch oder fehlt | Reversed Client ID in URL Types prüfen (Schritt 5b) |
| 503 `Google Sign-In ist nicht konfiguriert` | `GOOGLE_CLIENT_ID_IOS` fehlt in `.env` / Railway | Variable setzen, Server neu starten |
| `GIDSignIn.sharedInstance.configuration` crash | SDK wird vor `init()` aufgerufen | `GIDConfiguration` muss in `watchdApp.init()` gesetzt werden — bereits korrekt implementiert |
