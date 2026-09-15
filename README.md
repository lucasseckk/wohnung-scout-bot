# Wohnung Scout Bot

Ein privater, kontinuierlich laufender Discord-Assistent für Wohnungssuchen. Er verarbeitet offiziell empfangene ImmoScout24-Suchaufträge aus einem E-Mail-Postfach, bewertet neue Wohnungen anhand eines persönlichen Profils und veröffentlicht nur passende Treffer in Discord.

Diese öffentliche Projektvorlage enthält keine Zugangsdaten, Bewerberdaten, Merkliste oder bereits verarbeiteten Inserate. Für die eigene Installation werden die mitgelieferten Platzhalterdateien kopiert und anschließend nur lokal ausgefüllt.

Bei jeder Wohnung stehen drei Buttons bereit:

- **Interessiert** markiert den Treffer nur für die klickende Person und zeigt ihr den eigenen kopierfertigen E-Mail-Entwurf.
- **Merken** setzt die Wohnung auf die persönliche lokale Merkliste.
- **Ignorieren** blendet sie nur für den eigenen Workflow aus.

Mit `/merkliste` öffnet jeder freigeschaltete Nutzer ausschließlich seine eigene private Liste. Dort kann eine Wohnung ausgewählt, ein persönlicher E-Mail-Entwurf erzeugt oder der Eintrag aus der Merkliste entfernt werden. Das Inserat und die Liste anderer Nutzer bleiben beim Entfernen erhalten.

Es wird niemals automatisch eine Nachricht an Anbieter verschickt.

## Warum E-Mail statt direktem Scraping?

Das verlinkte Ausgangsrepo enthält keinen ImmoScout24.de-Scraper, sondern nur zwei österreichische Quellen. Außerdem untersagen die aktuellen [ImmoScout24-Nutzungs-AGB](https://www.immobilienscout24.de/agb/nutzungsagb.html) automatisierte Website-Abfragen durch Bots und Crawler. Die offizielle [Search API](https://api.immobilienscout24.de/api-docs/search/introduction/) ist nur für freigegebene Content-Partner und nicht als allgemeiner Datenfeed gedacht.

Darum nutzt diese Version einen offiziellen ImmoScout-Suchauftrag als Eingang. Das liefert denselben praktischen Discord-Workflow, ohne Captchas, Proxys oder Schutzmechanismen zu umgehen. Eine schriftlich genehmigte API kann später als weiterer `ListingSource`-Adapter ergänzt werden.

Die vollständige Prüfung des Ausgangsprojekts steht in [docs/UPSTREAM_ANALYSIS.md](docs/UPSTREAM_ANALYSIS.md).

## Funktionsumfang

- getrennte Werte für Warmmiete, Kaltmiete, Nebenkosten, Heizkosten, Kaution, Fläche, Preis pro m², Zimmer, Etage und Verfügbarkeit
- konfigurierbare Bereiche je Kriterium: perfekt, okay, mittelmäßig und außerhalb
- Gewichtung je Kriterium sowie harte Preis-, Größen-, Lage- und Stichwort-Ausschlüsse
- nachvollziehbarer Score von 0 bis 100 mit Begründungen im Discord-Post
- optionaler Rollen-Ping bei jedem veröffentlichten Wohnungs-Post
- SQLite-Persistenz statt Discord-Nachrichten als Ersatz-Datenbank
- Deduplizierung über Quelle und Inserats-ID
- Datenminimierung: vollständiger E-Mail-Text wird nicht gespeichert; alte neue/ignorierte Treffer werden bereinigt
- privater Interessenten-Workflow mit persönlichem Anschreiben
- getrennte Merkliste und getrennte Interessiert-/Ignoriert-Statuswerte je Discord-Nutzer
- privater `/merkliste`-Befehl mit Auswahl, E-Mail-Entwurf und Entfernen-Funktion
- privater `/config`-Befehl für benannte, dauerhaft gespeicherte Suchprofile
- separates Bewerberprofil je freigeschalteter Discord-ID
- stiller Erststart, damit alte Suchauftrags-E-Mails den Kanal nicht fluten
- Docker-Betrieb und automatisierte Parser-, Scoring-, Vorlagen- und Datenbanktests

## Schnellstart

Für den empfohlenen Dauerbetrieb werden Docker mit Docker Compose, ein Discord-Bot und ein separates E-Mail-Postfach benötigt. Node.js ab 22.13 und pnpm sind nur erforderlich, wenn der Bot ohne Docker entwickelt oder getestet werden soll.

1. In ImmoScout24 einen passenden Suchauftrag anlegen und die Benachrichtigungen an ein separates E-Mail-Postfach senden lassen.
2. Im Discord Developer Portal einen Bot erstellen und ihn mit den Scopes `bot` und `applications.commands` sowie den Rechten „View Channel“, „Send Messages“, „Embed Links“ und „Attach Files“ in den privaten Server einladen. Für einen Rollen-Ping muss die Rolle erwähnbar sein oder der Bot das Recht zum Erwähnen aller Rollen besitzen. Der Bot benötigt keinen Message-Content-Intent. Um Kanal-, Rollen- und Nutzer-IDs zu kopieren, in Discord unter **Einstellungen → Erweitert** den Entwicklermodus aktivieren. Als Ziel wird ein normaler Textkanal auf einem Server benötigt, keine Direktnachricht, kein Thread und kein Forum.
3. Konfiguration anlegen:

```bash
cp .env.template .env
cp config/profile.example.json config/profile.json
```

4. `.env` mit Discord- und IMAP-Daten füllen. Mehrere Werte bei `DISCORD_ALLOWED_USER_IDS` werden durch Kommas getrennt. Die Reihenfolge ist wichtig: erste ID = Hauptprofil und `/config`-Administrator, zweite ID = `allowedUserPosition: 2` usw. Für Gmail gilt `IMAP_HOST=imap.gmail.com`; als Nutzer wird die vollständige Gmail-Adresse und als Passwort ein Google-App-Passwort verwendet. Dafür muss im Google-Konto die Bestätigung in zwei Schritten aktiv sein. Nicht das normale Google-Passwort eintragen.
5. `config/profile.json` auf Stadt, Stadtteile, Mieten, Fläche, Zimmer, Stichwörter und die persönlichen Bewerberprofile anpassen. JSON erlaubt keine Kommentare und keine überflüssigen Kommas am Ende einer Liste oder eines Objekts.
6. Installieren und prüfen:

```bash
pnpm install --frozen-lockfile
pnpm preview
pnpm check
pnpm build
pnpm start
```

`pnpm preview` liest ausschließlich die synthetische Test-E-Mail und zeigt die Bewertung lokal an. Es verbindet sich weder mit Discord noch mit ImmoScout24.

Beim ersten Start wird der Suchregel-Teil aus `config/profile.json` einmalig als aktives SQLite-Profil importiert. Danach werden Mieten, Fläche, Zimmer, Gebiete und Merkmale mit `/config` verwaltet. Bewerberdaten und E-Mail-Texte bleiben weiterhin ausschließlich in der privaten JSON-Datei.

## Dauerbetrieb mit Docker

Nach der Konfiguration:

```bash
docker compose up -d --build
docker compose logs -f wohnung-bot
```

Die SQLite-Datei liegt unter `data/wohnungen.sqlite`. Der Container selbst ist schreibgeschützt; nur `data/` und ein temporärer Ordner sind beschreibbar.

`restart: unless-stopped` startet den Bot nach Abstürzen und Rechnerneustarts wieder, sobald Docker selbst läuft. Der Befehl `docker compose up -d --build` muss auf einem neuen Rechner einmal ausgeführt werden. Zwei Instanzen mit getrennten Datenbanken sollten nicht gleichzeitig dasselbe Postfach und denselben Discord-Kanal bedienen, da sonst doppelte Posts möglich sind.

Änderungen an `.env` werden mit `docker compose up -d --force-recreate` übernommen. Änderungen an Anschreiben oder Bewerberdaten in `config/profile.json` werden mit `docker compose restart wohnung-bot` geladen. Suchregeln, die über `/config` geändert werden, gelten ohne Neustart. Nach dem ersten Import überschreiben direkte Änderungen der Suchregeln in der JSON-Datei das aktive SQLite-Profil nicht.

Beim allerersten erfolgreichen Abruf werden vorhandene E-Mails standardmäßig nur als bekannt gespeichert. Erst danach eintreffende Inserate werden gepostet. Für einen bewussten Test mit vorhandenen E-Mails kann `NOTIFY_EXISTING_ON_START=true` gesetzt werden.

Nach einer Offline-Zeit werden passende Mails innerhalb von `IMAP_LOOKBACK_HOURS` nachgeholt, standardmäßig 72 Stunden, begrenzt auf `IMAP_MAX_MESSAGES` Mails pro Lauf. Vor dem Neustart nach einer längeren Pause können diese Werte vorübergehend erhöht werden.

Für eine schnelle Kontrolle zeigen `docker compose ps` den Containerstatus und `docker compose logs -f wohnung-bot` die laufenden Suchläufe. Die Logansicht wird mit `Ctrl+C` beendet; der Bot läuft im Hintergrund weiter.

## Suchprofil

Jedes Zahlenkriterium besitzt drei überlappende Bereiche. Der erste passende Bereich gewinnt:

```json
"warmRent": {
  "label": "Warmmiete",
  "weight": 30,
  "rejectOutside": true,
  "rejectWhenMissing": false,
  "perfect": { "max": 1100 },
  "okay": { "max": 1300 },
  "mediocre": { "max": 1500 }
}
```

Damit sind bis 1.100 Euro perfekt, bis 1.300 Euro okay, bis 1.500 Euro mittelmäßig und höhere Warmmieten ausgeschlossen. Für Mindestgrößen wird entsprechend `min` verwendet.

Fehlende Angaben erhalten den Faktor `missingValueFactor`. Das ist wichtig, weil Suchauftrags-E-Mails nicht immer jedes Feld enthalten. Mit `rejectWhenMissing: true` kann eine fehlende Pflichtangabe trotzdem zum Ausschluss führen.

Lagen werden ohne Beachtung von Groß-/Kleinschreibung, Akzenten und Trennzeichen als vollständige Wortfolgen verglichen. Übliche Schreibweisen wie `Beispielstadt-Mitte`, `Beispielstadt Mitte` und `Mitte, Beispielstadt` werden erkannt, ohne beispielsweise `Nord` fälschlich in `Nordost` oder `Nordstraße` zu finden. Stichwörter können positiv, negativ oder als harter Ausschluss definiert werden.

## Suchprofile in Discord

`/config` öffnet eine private Übersicht aller gespeicherten Suchprofile. Der Hauptnutzer – die erste ID in `DISCORD_ALLOWED_USER_IDS` – kann ein Profil als Kopie anlegen, umbenennen, bearbeiten, aktivieren oder ein inaktives Profil löschen. Weitere freigeschaltete Nutzer erhalten eine Nur-Lese-Ansicht.

Bearbeitet werden können:

- perfekte, okay und absolute Grenzen für Warm- und Kaltmiete
- perfekte, okay und minimale Werte für Wohnfläche und Zimmer
- perfekte, okay und noch akzeptable Gebiete
- gewünschte und negative Merkmale sowie harte Ausschlusswörter

Genau ein Profil ist aktiv. Änderungen werden vollständig validiert, in `data/wohnungen.sqlite` gespeichert und ab dem nächsten Suchlauf ohne Container-Neustart verwendet. Bereits bekannte oder ausgeschlossene Wohnungen werden nach einem Profilwechsel nicht nachträglich gepostet. Ein neues Profil entsteht als Kopie eines bestehenden Profils, damit Gewichte und Bewertungsschwellen immer vollständig bleiben.

## Merkliste

`/merkliste` zeigt bis zu 25 gemerkte oder als interessant markierte Wohnungen in einer nur für den aufrufenden Nutzer sichtbaren Auswahl. Nach Auswahl stehen **E-Mail-Entwurf**, **Entfernen** und **Exposé öffnen** zur Verfügung. **Entfernen** löscht lediglich den eigenen Merkliste-/Interessiert-Status, nicht den Discord-Post oder die Daten anderer Nutzer.

## Anschreiben

Im Profil stehen diese Platzhalter zur Verfügung:

`{{title}}`, `{{address}}`, `{{city}}`, `{{district}}`, `{{warmRent}}`, `{{coldRent}}`, `{{livingSpace}}`, `{{rooms}}`, `{{name}}`, `{{age}}`, `{{employment}}`, `{{income}}`, `{{household}}`, `{{phone}}`, `{{email}}`, `{{extras}}`.

Der Exposé-Link wird bewusst nicht in den E-Mail-Text eingefügt. Er bleibt im privaten Discord-Dialog als separate Schaltfläche verfügbar.

Das Hauptprofil unter `application.applicant` gehört zur ersten ID aus `DISCORD_ALLOWED_USER_IDS`. Weitere Personen stehen unter `application.additionalApplicants`; `allowedUserPosition: 2` gehört zur zweiten ID, Position 3 zur dritten usw. Für jeden zusätzlichen freigeschalteten Nutzer muss ein eigenes Profil existieren. Name sowie mindestens E-Mail-Adresse oder Telefonnummer müssen ausgefüllt sein, bevor ein Entwurf erzeugt wird.

Persönliche Angaben gehören nur in `config/profile.json`; diese Datei wird absichtlich nicht von Git erfasst. Der Entwurf erscheint als ephemere Discord-Antwort und nicht öffentlich im Kanal.

## Sicher weitergeben oder veröffentlichen

Veröffentlicht werden dürfen `.env.template` und `config/profile.example.json`. Die daraus erzeugten Dateien `.env` und `config/profile.json` bleiben privat. Auch `data/` darf keine lokale Datenbank oder Sicherung enthalten, weil dort unter anderem Suchprofile, Inserate, Discord-Zuordnungen und Merklisten gespeichert werden.

Die passenden Ausschlüsse sind bereits in `.gitignore` und `.dockerignore` hinterlegt. Eine ausführliche Checkliste steht in [SECURITY.md](SECURITY.md). Diese Regeln gelten auch für ZIP-Dateien und direkte Ordnerkopien, nicht nur für GitHub.

## Konfiguration

| Variable | Zweck | Standard |
|---|---|---|
| `DISCORD_TOKEN` | Bot-Token | erforderlich |
| `DISCORD_CHANNEL_ID` | Zielkanal | erforderlich |
| `DISCORD_PING_ROLE_ID` | optionale Ping-Rolle per ID; hat Vorrang vor dem Namen | leer |
| `DISCORD_PING_ROLE_NAME` | optionaler exakter Rollenname, der bei jedem Post erwähnt wird | leer |
| `DISCORD_ALLOWED_USER_IDS` | erforderliche, geordnete Discord-IDs für private Bedienung und Bewerberzuordnung | erforderlich |
| `PROFILE_PATH` | persönliches Suchprofil | `./config/profile.json` |
| `DATABASE_PATH` | SQLite-Datei | `./data/wohnungen.sqlite` |
| `POLL_INTERVAL_MINUTES` | IMAP-Prüfintervall | `10` |
| `NOTIFY_EXISTING_ON_START` | vorhandene Mails beim Start posten | `false` |
| `RETENTION_DAYS` | alte neue/ignorierte Datensätze löschen | `30` |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE` | Mailserver | Port 993, TLS |
| `IMAP_USER`, `IMAP_PASSWORD` | Mailbox/App-Passwort | erforderlich |
| `IMAP_MAILBOX` | überwachter Ordner | `INBOX` |
| `IMAP_LOOKBACK_HOURS` | betrachtetes E-Mail-Fenster | `72` |
| `IMAP_MAX_MESSAGES` | höchstens geladene passende Mails pro Lauf | `100` |
| `IMAP_SENDER_CONTAINS` | Absenderfilter | `immobilienscout24` |
| `IMAP_SUBJECT_CONTAINS` | Betreff-Filter; `Angebot` schließt reine Suchauftrag-Bestätigungen aus | `Angebot` |

## Grenzen und nächster sinnvoller Schritt

ImmoScout kann das Layout seiner Suchauftrags-E-Mails ändern. Der Parser ist defensiv und fixture-getestet, aber eine echte, personenbezogen geschwärzte Beispiel-E-Mail aus deinem Postfach verbessert die Genauigkeit für Veröffentlichungszeit, Warm-/Kaltmiete und Lage erheblich.

Sinnvolle nächste Ausbaustufen:

- mehrere Suchprofile und getrennte Discord-Kanäle
- Preisänderungs- und „nicht mehr verfügbar“-Erkennung
- Pendelzeit-Scoring über eine offiziell nutzbare Karten-API
- private Webübersicht für Merkliste, Besichtigungen und Bewerbungsstatus
- Erinnerungen für Rückfragen und Besichtigungstermine
- verschlüsselter Dokumenten-Check für SCHUFA, Gehaltsnachweise und Selbstauskunft
- weitere erlaubte Quellen über dieselbe Adapter-Schnittstelle
- genehmigter ImmoScout-API-Adapter mit Lösch- und Aufbewahrungsregeln

## Lizenz

Das Projekt basiert auf dem MIT-lizenzierten Repository `JonasLaux/immo-scraper`. Der ursprüngliche Lizenz- und Copyright-Hinweis bleibt in `LICENSE` erhalten.
