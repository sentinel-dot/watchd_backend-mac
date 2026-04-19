# Contributing — Watchd Backend

Dieses Dokument beschreibt den Arbeitsablauf für Änderungen an diesem Repo. Ziel: kein kaputter Code landet auf `main`, jede Änderung läuft durch CI, jeder Deploy auf Railway ist grün.

> Für die Codebase-Architektur siehe [CLAUDE.md](./CLAUDE.md). Für erste Installation siehe [README.md](./README.md).

---

## Golden Rule

**Nie direkt auf `main` pushen.** Jede Änderung geht über einen Feature-Branch + Pull Request. GitHub ist so konfiguriert, dass es Direct-Pushes ablehnt. Railway deployt ausschließlich `main` — sobald etwas dort landet, geht es live.

---

## Branch-Namen

Präfix + kurze Beschreibung, Wörter mit Bindestrich getrennt:

| Präfix | Wann | Beispiel |
|--------|------|----------|
| `fix/` | Bugfix | `fix/room-join-status` |
| `feat/` | Neues Feature | `feat/push-silent-disconnect` |
| `docs/` | Nur Dokumentation | `docs/railway-deployment` |
| `refactor/` | Code-Umbau ohne Verhaltensänderung | `refactor/extract-match-notifier` |
| `test/` | Nur Tests hinzufügen/fixen | `test/room-stack-refill` |
| `chore/` | Infrastruktur/Tooling | `chore/upgrade-vitest` |

---

## Commit-Messages

[Conventional Commits](https://www.conventionalcommits.org) Style:

```
<type>: <kurze beschreibung in präsens>

[optional: ausführlichere erklärung, warum diese änderung sinnvoll ist]
```

Typen: `fix`, `feat`, `docs`, `refactor`, `test`, `chore`, `perf`.

**Gute Beispiele:**
```
fix: set room status to active after second member joins
feat: add silent push to disconnect partner socket
docs: document Railway rollback procedure
```

**Schlechte Beispiele:**
```
update                           ← sagt nichts
fix stuff                        ← sagt nichts
WIP                              ← gehört nicht auf main
asdf                             ← ernsthaft
```

---

## Arbeitsablauf — Schritt für Schritt

### 1. Aktuellen `main` holen

```bash
cd watchd_backend-mac
git checkout main
git pull
```

Wichtig: immer mit aktuellem `main` als Basis starten, sonst gibt's Merge-Konflikte.

### 2. Branch erstellen

```bash
git checkout -b fix/room-join-status
```

`-b` = „erstelle neu". Ohne `-b` würde Git auf einen existierenden Branch wechseln. Du bist jetzt auf deinem neuen Branch — `main` wird ab jetzt nicht verändert.

### 3. Coden

Normal arbeiten. `git status` zeigt, welche Dateien geändert sind.

### 4. Lokal prüfen (bevor du committest)

```bash
npm run typecheck     # TypeScript muss grün sein
npm test              # zweimal laufen lassen, beide male identisch
```

Wenn etwas rot ist, fixen bevor du pushst — sonst wird CI auf GitHub die gleiche Fehlermeldung geben und dich nicht mergen lassen.

### 5. Committen

```bash
git add <geänderte dateien>
git commit -m "fix: set room status to active after second member joins"
```

Mehrere Commits pro Branch sind OK — werden beim Merge zu einem zusammengefasst (Squash-Merge, siehe Schritt 8).

### 6. Branch pushen

```bash
git push -u origin fix/room-join-status
```

`-u` (oder `--set-upstream`) verbindet lokalen und Remote-Branch. Einmal setzen, danach reicht `git push` ohne Argumente.

### 7. Pull Request öffnen

Nach dem Push zeigt dir GitHub eine URL wie:
```
https://github.com/<user>/watchd_backend-mac/pull/new/fix/room-join-status
```

Oder auf der Repo-Seite erscheint ein gelber Banner **„Compare & pull request"** — anklicken.

Im PR-Formular:
- **Title**: analog zur Commit-Message (`fix: set room status to active after second member joins`)
- **Description**:
  - _Was_ die Änderung tut
  - _Warum_ (welcher Bug, welche Motivation)
  - Falls UI-sichtbar: Screenshots/Videos
- **„Create pull request"** klicken

### 8. CI abwarten

Unten im PR erscheinen die Checks. Nach ~90 Sekunden sollte „All checks have passed ✓" stehen. Wenn rot:
- Auf „Details" klicken → GitHub Actions Log öffnet sich
- Fehler analysieren, lokal fixen, `git add` + `git commit` + `git push` → CI läuft automatisch neu

### 9. Merge

Wenn alle Checks grün sind: **„Squash and merge"** klicken (Button unten im PR). Das fasst alle Commits des Branches zu einem einzigen Commit auf `main` zusammen — saubere Historie.

Railway erkennt den neuen Commit auf `main` und startet automatisch einen Deploy.

### 10. Aufräumen lokal

```bash
git checkout main
git pull
git branch -d fix/room-join-status    # löscht den lokalen Branch
```

Der Remote-Branch auf GitHub wird beim Merge automatisch gelöscht (falls du „Automatically delete head branches" in den Repo-Settings aktiviert hast — empfohlen).

---

## CI: was läuft, wenn

Die Datei [.github/workflows/test.yml](./.github/workflows/test.yml) definiert den Workflow. Aktuell:

- **Trigger**: jeder Push auf `main` + jeder PR (egal welcher Branch)
- **Environment**: Ubuntu + Node 20 + MySQL 8 als Service-Container
- **Schritte**:
  1. Repo auschecken
  2. Node + npm-Cache einrichten
  3. `npm ci` (Dependencies deterministisch installieren)
  4. `npm run typecheck`
  5. `npm test` (gegen frisch aufgesetzte `watchd_test`-DB)
- **Dauer**: ~60–90 Sekunden
- **Parallelität**: neuer Push auf denselben Branch cancelt den laufenden CI-Run

Wenn CI rot ist, zeigt GitHub dir im PR welcher Step fehlgeschlagen ist + den Log.

---

## Notfall: direkt auf `main` pushen

Wenn Prod brennt und kein Review-Zyklus drin ist, kannst du als Repo-Admin die Branch-Protection umgehen:

1. GitHub → Repo → Settings → Branches → Branch-Protection-Rule für `main`
2. Temporär „Require pull request before merging" deaktivieren, oder
3. `git push origin main --force-with-lease` (erfordert aktuelle Rule-Einstellung, die Admin-Push erlaubt)

**Regel:** Danach direkt wieder einschalten. Direct-Push auf `main` sollte die absolute Ausnahme sein, nicht zum Standard werden — sonst ist der ganze Workflow nutzlos.

---

## FAQ

**Ich hab vergessen einen Branch zu erstellen und direkt auf `main` committet. Jetzt?**

```bash
# main zurücksetzen auf den Stand von GitHub
git branch temp-fix                    # aktueller lokaler main als Branch sichern
git reset --hard origin/main           # lokalen main zurück auf Remote-Stand
git checkout temp-fix                  # auf gesicherten Stand wechseln
git checkout -b fix/meine-änderung     # sauberen Branch draus machen
# jetzt normal push + PR
```

**CI sagt „Cannot connect to test DB as dev_test" — warum?**

Das sollte in CI nicht passieren — MySQL-Service-Container wird vor den Test-Steps hochgefahren. Wenn doch: MySQL-Image oder Health-Check in `.github/workflows/test.yml` ist kaputt. Log im Actions-Run prüfen.

**Lokal laufen Tests grün, auf CI rot. Warum?**

Meistens: unterschiedliche MySQL-Version (lokal MariaDB, CI MySQL 8). Seltener: Environment-Unterschied (Timezone, Locale). Log vergleichen und Symptom-spezifisch debuggen.

**Kann ich einen PR ohne CI-Grün mergen?**

Nein, die Branch-Protection-Rule auf `main` blockt das. Als Admin kannst du es umgehen — siehe „Notfall" oben. Normalerweise: Fehler fixen statt CI umgehen.
