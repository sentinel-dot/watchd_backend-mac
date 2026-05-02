# launchd – Backend als macOS-Dienst

Der Backend-Prozess läuft über `launchd` (macOS-Äquivalent zu systemd) als `LaunchAgent` – startet automatisch beim Login und wird bei Abstürzen neu gestartet.

Env-Vars kommen aus `.env` im Backend-Verzeichnis via `dotenv` – keine separaten Einträge in der Plist nötig.

## Einmalig einrichten

```bash
# 1. Build aktualisieren
cd /Users/x/watchd-coding/watchd_backend-mac && npm run build

# 2. Logs-Ordner anlegen
mkdir -p /Users/x/watchd-coding/watchd_backend-mac/logs

# 3. Plist kopieren
cp /Users/x/watchd-coding/watchd_backend-mac/launchd/com.watchd.backend.plist \
   ~/Library/LaunchAgents/com.watchd.backend.plist

# 4. Service laden und starten
launchctl load ~/Library/LaunchAgents/com.watchd.backend.plist
```

## Tägliche Nutzung

```bash
# Status prüfen (PID > 0 = läuft)
launchctl list | grep watchd

# Logs live
tail -f /Users/x/watchd-coding/watchd_backend-mac/logs/stderr.log

# Neu starten (z.B. nach neuem Build)
launchctl stop com.watchd.backend && launchctl start com.watchd.backend
```

## Nach Code-Änderungen

```bash
cd /Users/x/watchd-coding/watchd_backend-mac
npm run build
launchctl stop com.watchd.backend && launchctl start com.watchd.backend
```

## Service dauerhaft entfernen

```bash
launchctl unload ~/Library/LaunchAgents/com.watchd.backend.plist
rm ~/Library/LaunchAgents/com.watchd.backend.plist
```
