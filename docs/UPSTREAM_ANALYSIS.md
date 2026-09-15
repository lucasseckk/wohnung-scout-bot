# Analyse von JonasLaux/immo-scraper

Geprüfter Upstream-Stand: Commit `b6e31b6` vom 18.03.2025.

## Ergebnis

Das Ausgangsprojekt ist ein kleiner österreichischer Prototyp. Es liest `willhaben.at` und `immosuchmaschine.at`, nutzt fest codierte Wiener Bezirke und sendet einfache Discord-Embeds. ImmoScout24.de kommt weder im aktuellen Code noch in der Git-Historie vor.

Nicht übernommen wurden insbesondere:

- Discord als Ersatz-Datenbank (nur die letzten 100 Nachrichten wurden geprüft),
- untypisierte und fragile Portalparser ohne Fixtures,
- hart codierte Suchparameter,
- kurzlebige Cloud-Function mit neuem Discord-Login pro Lauf,
- fehlende Trennung von Warm-/Kaltmiete und fehlendes Scoring,
- paralleler Nachrichten-Burst und geschluckte Versandfehler.

Übernommen wurden die MIT-Lizenz und die sinnvolle Grundidee aus Provider, Normalisierung und Discord-Benachrichtigung. Der Anwendungskern wurde neu aufgebaut: kontinuierlicher Prozess, SQLite, erklärbares Scoring, private Interaktionen und getestete Parsergrenzen.

## Technische Fehler im Ausgangsprojekt

- Keine Tests; `npm test` schlägt absichtlich immer fehl.
- `engines.node >=14`, obwohl natives `fetch` mindestens Node 18 erfordert.
- Willhaben mutiert seine Basis-URL bei jedem Lauf und hängt Suchparameter mehrfach an.
- Deduplizierung kollidiert zwischen Quellen und verliert ältere Inserate.
- Fehler werden teilweise nur protokolliert; der Job erscheint trotzdem erfolgreich.
- Kein Scheduler, obwohl die Dokumentation einen automatisch laufenden Dienst nahelegt.
- Der Entwicklungsstart verwendet ein nicht deklariertes Paket.

## ImmoScout24-Entscheidung

Ein direkter Website-Scraper wurde bewusst nicht implementiert. Die [Nutzungs-AGB von ImmoScout24](https://www.immobilienscout24.de/agb/nutzungsagb.html) untersagen in Ziffer 8 automatisierte Abfragen durch Skripte, Bots und Crawler. Die offizielle [Search API](https://api.immobilienscout24.de/api-docs/search/introduction/) und [Expose API](https://api.immobilienscout24.de/api-docs/expose/overview/) sind für freigegebene Content-Partner vorgesehen und nicht für Datenlieferungsfälle.

Der aktuelle Datenweg verarbeitet deshalb E-Mails aus einem offiziellen Suchauftrag. Für eine später schriftlich genehmigte API-Nutzung ist `ListingSource` die vorgesehene Adaptergrenze.
