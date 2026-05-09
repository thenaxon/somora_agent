# Install, Run, Update, Release

Vollständige Referenz für den Service-Mode-Workflow von somora.
Geschrieben in mit-Worten-und-konkret, damit du nicht raten musst.

Architektur-Hintergrund: siehe `private/DECISIONS.md` Eintrag #41
(Versionierung) und #42 (Service-Mode).

---

## Mental Model — drei Verzeichnisse, zwei Code-Trees, ein Datenverzeichnis

Wenn somora installiert ist und läuft, gibt's drei wichtige Orte auf
deinem Rechner:

| Verzeichnis | Was liegt da | Wer ändert das |
|---|---|---|
| `~/.npm-global/lib/node_modules/somora/` | **prod-Code** (was systemd ausführt) | nur `npm install`/`somora update` |
| `~/Projects/somora/` | **dev-Code** (was du editierst) | nur du beim Coden |
| `~/.somora/` | **Daten** (Sessions, Memory, Config, Logs) | beide Code-Trees, immer |

Plus zwei Helfer:

| Datei | Was sie macht |
|---|---|
| `~/.config/systemd/user/somora.service` | sagt deinem System „so startest du somora" |
| `~/.somora/locks/server.lock` | sagt „ein somora läuft schon, PID X, Port Y" |

**Wichtige Regel:** zu jedem Zeitpunkt läuft **genau ein** somora-Server.
Entweder der prod-Service (systemd), oder dein dev-Server (`npm run
dev:server`) — niemals beide. Das Lockfile setzt das durch.

---

## Erstinstallation auf dieser Maschine (was wir am 2026-05-08 gemacht haben)

```bash
# im dev-Tree:
cd ~/Projects/somora

# 1. Tarball bauen — packt nur was in package.json:files steht
npm pack
# erzeugt: somora-2026.05.08.1.tgz

# 2. Tarball global installieren — kopiert die Bytes nach ~/.npm-global/...
npm install -g ./somora-2026.05.08.1.tgz

# 3. Systemd-Unit + Lock-Verzeichnis anlegen (idempotent)
somora init

# 4. Service starten
somora server start
```

Danach ist alles bereit:

```
~/.npm-global/bin/somora                            ← der Befehl auf deinem PATH
~/.npm-global/lib/node_modules/somora/              ← die installierten Bytes
~/.config/systemd/user/somora.service               ← die systemd-Unit
~/.somora/locks/server.lock                         ← runtime, erscheint wenn Server läuft
```

### Warum `npm install -g <tarball>` und nicht `npm install -g .`?

`npm install -g .` macht einen **Symlink** vom dev-Tree ins Global-
Verzeichnis. Das heißt: der „prod-Code" wäre nur ein Pfeil auf deinen
dev-Code — jede Änderung im dev-Tree würde auch die prod-Installation
sofort ändern. Das ist genau das was wir nicht wollen, weil dann
prod-Version `2026.05.08.1` und dev-Version unbestimmt-aktuell
zusammenfallen.

`npm pack` + `npm install -g <tarball>` macht eine **echte Kopie**
der Bytes. Dev und prod sind dann wirklich getrennt.

### Warum `npm pack` und nicht alle Files direkt?

`npm pack` respektiert das `files`-Feld in `package.json`. Das heißt:
nur `bin/`, `src/`, `tsconfig.json`, `package.json`, `README.md`,
`LICENSE` landen im Tarball. **Internes Zeug bleibt draußen** —
`private/` (DECISIONS, STATUS, Design-Docs), `docs/`, dev-Skripte.
Wichtig für Public-Repo später.

---

## Tägliche Verwendung

### Server-Befehle

```bash
somora server start          # startet via systemd
somora server stop           # stoppt via systemd, räumt Lockfile
somora server restart        # restart via systemd
somora server status         # zeigt Lockfile-Inhalt + systemd-Status
```

`somora server status` ist dein Erstanlauf wenn du nicht weißt ob
und was läuft. Beispiel-Output:

```
lockfile: ~/.somora/locks/server.lock
  pid:        1003377 (alive)
  port:       18737
  host:       127.0.0.1
  startedAt:  2026-05-08T14:47:13.555Z
  version:    2026.05.08.1

● somora.service - somora — Local-first AI agent gateway
     Active: active (running) since Fri 2026-05-08 16:47:13 CEST
```

`(alive)` heißt der Prozess existiert. Wenn da `STALE — process gone`
steht, ist der Lockfile veraltet — beim nächsten `server start` wird
er automatisch überschrieben.

### TUI öffnen

```bash
somora tui
```

Verbindet sich gegen den laufenden Server (Default `127.0.0.1:18737`).
Wenn der Server nicht läuft, siehst du `disconnected` im TUI-Header.

### Direkt-Modus zum Debuggen

```bash
somora server start --foreground
```

Startet den Server **ohne systemd** im aktuellen Terminal. Logs
landen im stdout. Beenden mit Ctrl+C.

Nützlich wenn:
- du die System-Output beim Server-Start sehen willst (Konfig-
  Probleme, Provider-Auth-Fehler etc.)
- systemd nicht verfügbar ist (z.B. in Container, oder bei
  WSL-Setups)

---

## Updates / neue Releases einspielen

### Standard-Workflow

```bash
somora update
```

Macht intern:
1. `npm install -g somora@latest` (ab Public-Repo-Zeit) bzw. später
   `npm install -g <tarball>` lokal — siehe „Lokales Update" unten
2. `systemctl --user restart somora`

### Update auf eine bestimmte Version (z.B. Rollback)

```bash
somora update 2026.05.07.1
```

Zieht genau die angegebene Version, restart.

### Lokales Update (so wie wir es heute machen, ohne Public-Repo)

Solange der Public-Repo nicht da ist, geht der Update so:

```bash
# im dev-Tree, nach deinen Änderungen:
cd ~/Projects/somora

# 1. Version hochziehen in package.json (manuell oder beim Zuruf
#    „Version hochziehen" — Format YYYY.MM.DD.N)

# 2. Tarball bauen
npm pack

# 3. global installieren
npm install -g ./somora-<NEUE-VERSION>.tgz

# 4. Service neu starten
somora server restart

# 5. (optional) git tag + push
git tag <NEUE-VERSION>
git push origin <NEUE-VERSION>
```

`somora update` mit Argument funktioniert noch nicht für lokale
Tarballs — solange wir kein Public-Repo haben, machen wir die
Schritte 2-4 manuell.

---

## Entwickeln am Code (dev-Workflow)

Wenn du Änderungen am Code machen willst, gibst du dem dev-Server
das Steuer:

```bash
# 1. prod-Service stoppen
somora server stop

# 2. dev-Server starten — lebt in deinem dev-Tree, hot-reload
cd ~/Projects/somora
npm run dev:server

# (in anderem Terminal) — TUI gegen den dev-Server
npm run dev:cli
```

Wenn du fertig bist:

```bash
# 1. dev-Server stoppen (Ctrl+C)
# 2. prod-Service zurück:
somora server start
```

**Warum nicht parallel?** Das Lockfile lässt nur einen Server zur
Zeit zu. Wenn du versucht hast den dev-Server zu starten während prod
läuft, würde der dev-Server mit klarer Fehlermeldung verweigern:

```
somora already running (pid=997543, port=18737, started=2026-05-08T...).
Stop it first: `somora server stop` or `systemctl --user stop somora`.
```

Das ist Absicht — verhindert dass zwei Prozesse gleichzeitig in
`~/.somora/` schreiben und sich Daten kaputt machen.

### Was wenn ich Schema-Änderungen mache?

Schema-Änderungen sind **einbahnstraße**: sobald der dev-Server eine
neue Schema-Version in `~/.somora/` schreibt, kann der prod-Server
mit alter Code-Version diese Daten nicht mehr lesen. Heißt:

- Reine Code-Änderungen (Bugfix, neues Feature ohne Schema-Touch)
  → kein Drama, prod bleibt auf alter Version weiterhin lauffähig
- Schema-Änderung (DB-Migration, JSONL-Event-Format-Bump, neues
  Pflichtfeld in config) → **prod muss auf die neue Version gebracht
  werden BEVOR du prod wieder startest**

Notfall-Workaround wenn du dev-Schema-Arbeit machen willst aber
prod-Daten schützen:

```bash
SOMORA_HOME=~/.somora-dev/ npm run dev:server
```

Das benutzt ein separates Datenverzeichnis nur für diese dev-Session.

---

## Was passiert wenn der Rechner neu startet?

systemd merkt sich, ob du den Service „enabled" hast oder nicht.

**Aktueller Stand:** der Service ist **NICHT** auf Auto-Start
konfiguriert. Du startest somora nach jedem Reboot manuell mit
`somora server start`.

Falls du das ändern willst (Service startet automatisch beim
Login):

```bash
systemctl --user enable somora
```

Falls der Service auch ohne dass du eingeloggt bist laufen soll
(z.B. Server-Setup):

```bash
loginctl enable-linger
systemctl --user enable somora
```

**Mein Tipp:** lass es manuell für jetzt. Bei somora-Bugs oder
während Schema-Updates willst du Kontrolle wann der Service
hochfährt.

---

## Logs ansehen, wenn was schief geht

### Server-eigene Logs (Pino)

somora schreibt detaillierte Logs nach:

```
~/.somora/logs/server-YYYY-MM-DD.log
```

Heutige ansehen:

```bash
tail -f ~/.somora/logs/server-2026-05-08.log
```

Mit hübscherer Formatierung wenn `pino-pretty` da ist:

```bash
tail -f ~/.somora/logs/server-2026-05-08.log | npx pino-pretty
```

### systemd-Logs

systemd selbst loggt was Service-Lifecycle-Events angeht (Start,
Stop, Crash, Restart):

```bash
journalctl --user -u somora -f          # live tail
journalctl --user -u somora --since today
journalctl --user -u somora -n 100      # letzte 100 Zeilen
```

### Lockfile manuell prüfen

```bash
cat ~/.somora/locks/server.lock
```

Wenn das Lockfile da ist aber `somora server status` sagt
„STALE — process gone", löscht der nächste `somora server start`
den stale lock automatisch. Manuell aufräumen falls nötig:

```bash
rm ~/.somora/locks/server.lock
```

(Nur wenn 100% sicher dass kein Server mehr läuft — `ps aux | grep
somora` doppel-checken.)

---

## Wenn der Server nicht startet

Reihenfolge zum Diagnostizieren:

1. **Status checken:** `somora server status`
2. **systemd-Logs:** `journalctl --user -u somora -n 50`
3. **Server-Logs:** `tail ~/.somora/logs/server-$(date +%Y-%m-%d).log`
4. **Foreground starten** zum Live-Output sehen:
   ```bash
   somora server stop
   somora server start --foreground
   ```
5. **Lockfile prüfen** (siehe oben)
6. **Port-Konflikt?**
   ```bash
   lsof -i :18737       # zeigt was auf Port 18737 lauscht
   ```

---

## Rollback auf eine ältere Version

Wenn du einen schlechten Update gemacht hast und zurück willst:

```bash
# Variante A: über git zu einem getaggten Stand
cd ~/Projects/somora
git checkout 2026.05.07.1               # oder welche Version auch immer
npm pack
npm install -g ./somora-2026.05.07.1.tgz
somora server restart

# Variante B (zukünftig, sobald Public-Repo + npm-publish):
somora update 2026.05.07.1
```

**Warnung:** Rollback funktioniert nur ohne Schema-Bumps. Wenn die
neuere Version Schema migriert hat, ist `~/.somora/` jetzt im neuen
Format und die alte Code-Version kann nicht damit umgehen. In dem
Fall vor Rollback ein `~/.somora/`-Backup machen und das alte
zurückspielen.

---

## Was bei Updates noch fehlt (FUTURE)

- **Schema-Migrations**: heute noch nicht implementiert (DECISIONS
  #41 — wird beim ersten echten Schema-Bump dazugebaut). Aktuell
  vertraut der Server darauf dass die Daten zum Code passen.
- **`somora update <local-tarball>`**: heute noch nicht — `somora
  update` erwartet eine npm-publishte Version. Lokale Tarballs
  müssen manuell installiert werden (siehe oben).
- **Auto-Backup vor Update**: nicht da. Bei kritischen Daten manuell
  vorher `cp -r ~/.somora ~/.somora.bak.$(date +%Y%m%d)`.

---

## Cheat-Sheet zum Ausdrucken

```
# Status
somora server status                      Was läuft? Lockfile + systemd
journalctl --user -u somora -f            systemd-Logs live
tail -f ~/.somora/logs/server-$(date +%Y-%m-%d).log    Server-Logs

# Lifecycle
somora server start                       starten
somora server stop                        stoppen
somora server restart                     neu
somora server start --foreground          starten OHNE systemd (Debug)

# UI
somora tui                                TUI öffnen

# Updates
somora update                             auf latest
somora update 2026.05.07.1                auf bestimmte Version

# Setup (idempotent, kann jederzeit nochmal laufen)
somora init                               Datadir + systemd-Unit anlegen

# Notfall
rm ~/.somora/locks/server.lock            stale lock entfernen
systemctl --user stop somora              systemd-Service hart stoppen
ps aux | grep somora                      laufende Prozesse finden
```
