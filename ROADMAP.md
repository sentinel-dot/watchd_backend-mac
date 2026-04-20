# Roadmap - Watchd Backend

Prioritisierte Follow-up-Liste aus dem Infra-Gap-Report vom 2026-04-19. Fokus: was nach dem stabilen Setup als naechstes sinnvoll angegangen werden kann.

> Laufende Bug-Fixes und Feature-Arbeit gehen durch normale PRs, nicht ueber diese Datei. Diese Liste ist fuer Infrastruktur-/Quality-Improvements und Post-MVP-Themen, die Kontext brauchen um entschieden zu werden.

---

## Erledigt (Setup-Session 2026-04-19)

- Deterministisches Test-Setup (idempotente Mocks, Single-Worker, 66/66 gruen, 3 Laeufe identisch)
- CLAUDE.md versioniert - kanonisch im Backend-Repo, Symlink zum Parent, separate iOS-CLAUDE.md
- Backend-README als Entry-Point
- CONTRIBUTING.md mit PR-Workflow, Cheat Sheet, Bypass-Regeln
- GitHub Actions CI - MySQL 8 Service-Container, Typecheck + Tests
- Branch-Protection auf `main` via Ruleset, Admin-Bypass fuer Doku
- Railway-Deployment-Sektion + Rollback-Procedure in CLAUDE.md
- `.env.example` vollstaendig (inkl. `BCRYPT_ROUNDS`)
- `actions/checkout` und `actions/setup-node` auf v5 (Node-24-Runtime)
- Node-22-Upgrade abgeschlossen (2026-04-20) - `.nvmrc`, `engines.node >=22`, `@types/node ^22`, CI auf Node 22

---

## P1 - Hoch

### Test-Coverage: Refill-Trigger in Movie-Routes
**Warum:** `appendRoomStack()` selbst ist inzwischen per Integrationstest abgedeckt (`src/tests/integration/room-stack-append.integration.test.ts`), aber die Route-seitige Trigger-Logik in `src/routes/movies.ts` ist noch nicht gezielt getestet. Genau dort entscheidet sich, ob der Lazy-Refill im laufenden Betrieb ueberhaupt zuverlaessig anspringt oder korrekt blockiert wird.
**Effort:** ~45-75 min
**Was konkret:** Integration-Tests fuer `GET /api/movies/feed` und/oder `GET /api/movies/rooms/:roomId/next-movie`:
- bei <= 10 ungeswipten Filmen wird Refill angestossen
- bei `stack_exhausted = true` wird kein Refill getriggert
- bei Lock-Konflikt / parallelen Requests startet nur ein Request den Refill
- optional: sicherstellen, dass der Request selbst normal antwortet, waehrend Refill im Hintergrund laeuft

### Operational Troubleshooting
**Warum:** Deploy-Troubleshooting ist in CLAUDE.md dokumentiert, Code-Laufzeit-Fehler nicht ("Socket disconnectet staendig", "Match-Push doppelt", "room_stack bleibt leer trotz aktivem User"). Beim ersten Incident fehlt das Playbook.
**Effort:** ~30 min Skelett, Qualitaet waechst nach realen Incidents
**Was konkret:** Neue Sektion in `CLAUDE.md` oder `docs/troubleshooting.md` mit Format: Symptom -> Diagnose-Schritt -> haeufigste Ursache. Leere Eintraege sind OK - Platzhalter, die nach Incidents gefuellt werden.

---

## P2 - Mittel

### ESLint + Prettier
**Warum:** Aktuell nur TypeScript + Gewohnheit. Lint wuerde unused imports, unhandled promises, `==`-vs-`===`, fehlende returns etc. automatisch fangen. Prettier beendet Style-Diskussionen mit dir selbst.
**Effort:** ~45 min Setup + einmaliger Cleanup-Pass auf bestehendem Code
**Was konkret:** `eslint` + `@typescript-eslint/*` + `prettier`, sinnvolle Config, `npm run lint` Script, CI-Step neben typecheck+test.

### iOS: APNs End-to-End Setup Doc
**Warum:** Bei Cert-Rotation oder neuem Geraet vergisst du die 8-Schritt-Kette. Aktuell verstreut in CLAUDE.md (Xcode-Capability) und `.env.example` (base64).
**Effort:** ~30 min
**Was konkret:** Sektion in `watchd/CLAUDE.md` oder `watchd/docs/push-setup.md`:
- Apple Developer Portal -> Key generieren (Capabilities anhaken: APNs)
- Team-ID finden
- `.p8` runterladen + base64-encode
- In Railway als `APNS_PRIVATE_KEY` setzen
- Xcode: Push Notifications Capability aktivieren -> `aps-environment` Entitlement pruefen
- Sandbox vs Production: Key-Typ und `APNS_PRODUCTION` Env muessen matchen

### `download-icons` Script Context
**Warum:** Trivial, aber unklar wann das Script laufen muss. Beim Setup? Bei neuen Streaming-Services? Nie wieder?
**Effort:** ~5 min
**Was konkret:** Ein-Absatz-Hinweis in README oder CLAUDE.md: "Einmalig beim ersten Setup. Danach nur wenn JustWatch neue Provider-IDs liefert oder fehlende Icons auffallen."

### iOS: Signing / Provisioning Docs
**Warum:** Bei Mac-Wechsel oder Bundle-ID-Aenderung fehlt der Kontext. Aktuell nur in deinem Kopf.
**Effort:** ~20 min
**Was konkret:** Sektion in `watchd/CLAUDE.md` oder `watchd/README.md`: Apple Dev Team ID, Bundle ID, aktive Capabilities, `.entitlements`-Datei-Status, wie Provisioning-Profile erneuert werden.

---

## P3 - Niedrig / Post-MVP

Aus bestehender CLAUDE.md-"Offene Punkte"-Liste:
- **Room-Rename-UI** - Route existiert, UI fehlt. Feature-Arbeit, kein Infra-Thema.
- **Pino-Logs in Log-Dienst** - aktuell nur stdout. Sinnvoll erst bei echten Production-User und Incidents.
- **App Store Assets** (Screenshots, Icon-Groessen) - wenn Launch konkret wird.

Sonstige Nice-to-Have:
- **Architektur-Diagramm** (Socket/DB/APNs-Flow visuell) - hilfreich beim Onboarding eines Mitentwicklers, aktuell nicht noetig.
- **CHANGELOG.md** (handgepflegt, Conventional-Commits-basiert) - sinnvoll sobald User Updates erwarten.
- **API-Collection** (Insomnia / Postman / `.http`-Files) - beschleunigt manuelles Testen, wenn CI + Tests nicht reichen.
- **Performance-Tests** fuer Swipe-Feed-Pagination und Matchmaking unter Last - wenn echte Last auftritt.

---

## Konvention fuer diese Datei

- Neue Items hinzufuegen, wenn ein relevantes Gap auftaucht. Klein halten - kein Ticket-Tracker.
- Bei Erledigung: Item in "Erledigt"-Sektion verschieben, mit Datum.
- Prioritaet umsortieren, wenn sich Kontext aendert (echte User zeigen, dass P2 ploetzlich P1 ist).
- Wenn das Projekt Mitentwickler bekommt: auf GitHub Issues / Projects wechseln, ROADMAP.md auf Meta-Themen reduzieren.
