# Roadmap — Watchd Backend

Prioritisierte Follow-up-Liste aus dem Infra-Gap-Report vom 2026-04-19. Fokus: was nach dem stabilen Setup als nächstes sinnvoll angegangen werden kann.

> Laufende Bug-Fixes und Feature-Arbeit gehen durch normale PRs, nicht über diese Datei. Diese Liste ist für Infrastruktur-/Quality-Improvements und Post-MVP-Themen, die Kontext brauchen um entschieden zu werden.

---

## Erledigt (Setup-Session 2026-04-19)

- ✅ Deterministisches Test-Setup (idempotente Mocks, Single-Worker, 66/66 grün, 3 Läufe identisch)
- ✅ CLAUDE.md versioniert — kanonisch im Backend-Repo, Symlink zum Parent, separate iOS-CLAUDE.md
- ✅ Backend-README als Entry-Point
- ✅ CONTRIBUTING.md mit PR-Workflow, Cheat Sheet, Bypass-Regeln
- ✅ GitHub Actions CI — MySQL 8 Service-Container, Typecheck + Tests
- ✅ Branch-Protection auf `main` via Ruleset, Admin-Bypass für Doku
- ✅ Railway-Deployment-Sektion + Rollback-Procedure in CLAUDE.md
- ✅ `.env.example` vollständig (inkl. `BCRYPT_ROUNDS`)
- ✅ `actions/checkout` und `actions/setup-node` auf v5 (Node-24-Runtime)

---

## P1 — Hoch

### Node 22 Upgrade
**Warum:** Lokal (Node 23) und CI (Node 20) driften aktuell auseinander. Node 20 geht April 2026 in Maintenance, 22 ist LTS bis Oktober 2027. Einmal umziehen, dann 1,5 Jahre Ruhe.
**Effort:** ~15 min
**Was konkret:**
- `.nvmrc` mit `22` im Backend-Repo anlegen
- `engines.node: ">=22"` in `package.json`
- `@types/node: ^22` in `package.json`
- `.github/workflows/test.yml`: `node-version: '22'`
- Lokal `nvm install 22 && nvm use 22` (oder fnm/asdf-Äquivalent)

### Test-Coverage: Room-Stack Lazy Refill
**Warum:** `appendRoomStack()`, das `stack_generating`-Lock und der `stack_exhausted`-Zustand sind ungetestet. Das ist die Refill-Logik, die produktiv am ehesten stillschweigend bricht — z.B. Lock bleibt hängen, keine Refills mehr, User sehen keine neuen Filme und niemand merkt's bis zur Support-Mail.
**Effort:** ~60–90 min
**Was konkret:** Integration-Test im `/test-integration`-Pattern. Szenarien:
- Stack bei ≤ 10 ungeswipten Filmen → Refill triggert, Lock wird gesetzt und wieder freigegeben
- `stack_exhausted=true` → Refill-Trigger blockiert
- Lock-Konflikt (zwei parallele Requests) → nur einer refillt, atomares Update

### Operational Troubleshooting
**Warum:** Deploy-Troubleshooting ist in CLAUDE.md dokumentiert, Code-Laufzeit-Fehler nicht („Socket disconnectet ständig", „Match-Push doppelt", „room_stack bleibt leer trotz aktivem User"). Beim ersten Incident fehlt das Playbook.
**Effort:** ~30 min Skelett, Qualität wächst nach realen Incidents
**Was konkret:** Neue Sektion in `CLAUDE.md` oder `docs/troubleshooting.md` mit Format: Symptom → Diagnose-Schritt → häufigste Ursache. Leere Einträge sind OK — Platzhalter, die nach Incidents gefüllt werden.

---

## P2 — Mittel

### ESLint + Prettier
**Warum:** Aktuell nur TypeScript + Gewohnheit. Lint würde unused imports, unhandled promises, `==`-vs-`===`, fehlende returns etc. automatisch fangen. Prettier beendet Style-Diskussionen mit dir selbst.
**Effort:** ~45 min Setup + einmaliger Cleanup-Pass auf bestehendem Code
**Was konkret:** `eslint` + `@typescript-eslint/*` + `prettier`, sinnvolle Config, `npm run lint` Script, CI-Step neben typecheck+test.

### iOS: APNs End-to-End Setup Doc
**Warum:** Bei Cert-Rotation oder neuem Gerät vergisst du die 8-Schritt-Kette. Aktuell verstreut in CLAUDE.md (Xcode-Capability) und `.env.example` (base64).
**Effort:** ~30 min
**Was konkret:** Sektion in `watchd/CLAUDE.md` oder `watchd/docs/push-setup.md`:
- Apple Developer Portal → Key generieren (Capabilities anhaken: APNs)
- Team-ID finden
- `.p8` runterladen + base64-encode
- In Railway als `APNS_PRIVATE_KEY` setzen
- Xcode: Push Notifications Capability aktivieren → `aps-environment` Entitlement prüfen
- Sandbox vs Production: Key-Typ und `APNS_PRODUCTION` Env müssen matchen

### `download-icons` Script Context
**Warum:** Trivial, aber unklar wann das Script laufen muss. Beim Setup? Bei neuen Streaming-Services? Nie wieder?
**Effort:** ~5 min
**Was konkret:** Ein-Absatz-Hinweis in README oder CLAUDE.md: „Einmalig beim ersten Setup. Danach nur wenn JustWatch neue Provider-IDs liefert oder fehlende Icons auffallen."

### iOS: Signing / Provisioning Docs
**Warum:** Bei Mac-Wechsel oder Bundle-ID-Änderung fehlt der Kontext. Aktuell nur in deinem Kopf.
**Effort:** ~20 min
**Was konkret:** Sektion in `watchd/CLAUDE.md` oder `watchd/README.md`: Apple Dev Team ID, Bundle ID, aktive Capabilities, `.entitlements`-Datei-Status, wie Provisioning-Profile erneuert werden.

---

## P3 — Niedrig / Post-MVP

Aus bestehender CLAUDE.md-„Offene Punkte"-Liste:
- **Room-Rename-UI** — Route existiert, UI fehlt. Feature-Arbeit, kein Infra-Thema.
- **Pino-Logs in Log-Dienst** — aktuell nur stdout. Sinnvoll erst bei echten Production-User und Incidents.
- **App Store Assets** (Screenshots, Icon-Größen) — wenn Launch konkret wird.

Sonstige Nice-to-Have:
- **Architektur-Diagramm** (Socket/DB/APNs-Flow visuell) — hilfreich beim Onboarding eines Mitentwicklers, aktuell nicht nötig.
- **CHANGELOG.md** (handgepflegt, Conventional-Commits-basiert) — sinnvoll sobald User Updates erwarten.
- **API-Collection** (Insomnia / Postman / `.http`-Files) — beschleunigt manuelles Testen, wenn CI + Tests nicht reichen.
- **Performance-Tests** für Swipe-Feed-Pagination und Matchmaking unter Last — wenn echte Last auftritt.

---

## Konvention für diese Datei

- Neue Items hinzufügen, wenn ein relevantes Gap auftaucht. Klein halten — kein Ticket-Tracker.
- Bei Erledigung: Item in „Erledigt"-Sektion verschieben, mit Datum.
- Priorität umsortieren, wenn sich Kontext ändert (echte User zeigen, dass P2 plötzlich P1 ist).
- Wenn das Projekt Mitentwickler bekommt: auf GitHub Issues / Projects wechseln, ROADMAP.md auf Meta-Themen reduzieren.
