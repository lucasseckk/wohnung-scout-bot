# Private Daten und Zugangsdaten

Diese Projektvorlage enthält absichtlich keine Zugangsdaten, Bewerberdaten oder Laufzeitdaten.

## Niemals veröffentlichen

- `.env` und andere lokale Umgebungsdateien
- `config/profile.json`
- den Inhalt von `data/`, insbesondere SQLite-Dateien und Sicherungen
- Discord-Bot-Tokens, E-Mail-Passwörter oder App-Passwörter
- private SSH-Schlüssel

Die mitgelieferten Dateien `.env.template` und `config/profile.example.json` enthalten nur Platzhalter und dürfen kopiert werden. Persönliche Werte gehören ausschließlich in die daraus erzeugten, von Git ignorierten Dateien.

Falls ein Token oder Passwort versehentlich veröffentlicht wurde, reicht das Löschen aus der aktuellen Datei nicht aus: Das Geheimnis muss beim jeweiligen Anbieter sofort widerrufen und neu erstellt werden.

## Vor jeder Veröffentlichung

Prüfe, dass nur die Vorlagen vorhanden sind und insbesondere diese Pfade fehlen:

```text
.env
config/profile.json
data/wohnungen.sqlite
```

Die vorhandene `.gitignore` verhindert, dass diese Dateien bei normaler Git-Nutzung aufgenommen werden.
