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
- Lazy-Refill-Trigger in Movie-Routes getestet (2026-04-20) - `movies.integration.test.ts` deckt `<=10` unseen, `stack_exhausted` und atomaren Lock bei Parallel-Requests ab
- Operational-Troubleshooting-Playbook angelegt (2026-04-20) - `docs/troubleshooting.md` als Incident-Startpunkt fuer Runtime-Probleme
- ESLint + Prettier eingerichtet (2026-04-20) - `eslint.config.mjs`, `.prettierrc.json`, `tsconfig.eslint.json`, `npm run lint|lint:fix|format|format:check`; CI prueft jetzt Linting, Formatting, Typecheck und Tests
- iOS: APNs End-to-End Setup Doc angelegt (2026-04-20) - `watchd/docs/apns-end-to-end-setup.md` dokumentiert Apple-Portal -> Railway -> Xcode -> Device-Test
- iOS: Signing / Provisioning Docs angelegt (2026-04-20) - `watchd/docs/signing-provisioning.md` dokumentiert Team ID, Bundle ID, Automatic Signing und Profile-Refresh

---

## P1 - Hoch

---

## P2 - Mittel

### `download-icons` Script Context

**Warum:** Trivial, aber unklar wann das Script laufen muss. Beim Setup? Bei neuen Streaming-Services? Nie wieder?
**Effort:** ~5 min
**Was konkret:** Ein-Absatz-Hinweis in README oder CLAUDE.md: "Einmalig beim ersten Setup. Danach nur wenn JustWatch neue Provider-IDs liefert oder fehlende Icons auffallen."

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
