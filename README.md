# Football Board

Praktikum SS 2026, TUM (Betreuer: J. Mangler).

Ein berührungsloser Fußball-Kiosk: links wählt man per QR-Code eine von
vier Ligen, rechts stehen die Navigations-QRs. Zur gewählten Liga zeigt
der Kiosk die Tabelle, den aktuellen Spieltag mit Ergebnissen und
Anstoßzeiten und zu jedem Spiel die Form der beiden Teams aus den
letzten fünf Partien.

## Funktionen

- 4 Ligen (Premier League, La Liga, Bundesliga, Serie A), Auswahl per
  QR-Scan mit dem Handy
- Tabelle: Platz, Spiele, S/U/N, Tore, Differenz, Punkte
- Spieltag: der komplette aktuelle Spieltag, beendete Spiele mit
  Ergebnis, offene mit Anstoßzeit
- Spieldetail: Formkurve beider Teams (W/D/L, Gegner, Ergebnis)
- Navigation nur per QR: Spieltag, Tabelle, Liga wechseln, Zurück, Exit
- Wächter: nach 180 s ohne Scan springt der Kiosk von selbst zur
  Ligawahl zurück und läuft endlos weiter

## Screenshots

| Ligawahl | Tabelle | Spieltag |
|---|---|---|
| ![Menu](img/league_menu.png) | ![Tabelle](img/league_table.png) | ![Spieltag](img/matchday.png) |

| Spieldetail | Handy |
|---|---|
| ![Detail](img/match_detail.png) | ![Handy](img/phone_scan.png) |

## Architektur

Kernregel: der CPEE-Prozess ruft nie eine externe API auf. Alles Externe
macht der eigene Server; der Prozess sagt ihm nur "hol Liga X" und
bekommt die aufbereiteten Daten zurück.

```
                 +-----------------------+
football-data.org|  football_backend.js  |
   <------------ |  (Node, Port 12783)   |
                 +-----------+-----------+
                             | antwortet mit JSON,
                             | schreibt zusätzlich
                             v
        football.json   match.json   table.json     (public_html)
                             |
                     CPEE-Prozess
                   (Base64 in Seiten-URL)
                             |
                             v
         https://cpee.org/out/frames/AfandiyevRustam
                             ^
                             | Scan -> fb_send.html -> cpee_callback
                          Handy
```

- Der Server antwortet dem Prozess direkt mit dem Ergebnis. Die
  JSON-Dateien schreibt er zusätzlich - zum Nachschauen beim Debuggen
  und weil `/fb_match` den gewählten Spieltag aus `football.json` liest.
- Pro Liga wird höchstens alle 5 Minuten neu bei football-data.org
  angefragt (Free Tier: 10 Requests/Minute).
- Daten laufen als Base64 in der Seiten-URL zum Frame. Zurück zum
  Prozess laufen nur Codes und Indizes (`BL1`, `m3`, `table`), nie
  Namen - Umlaute überleben den Callback-Weg nicht.

## Der CPEE-Prozess

![Prozess Teil 1](img/process_1_league.png) ![Prozess Teil 2](img/process_2_matchday.png) ![Prozess Teil 3](img/process_3_detail_watchdog.png)

Datenelemente und Endpunkte des Modells:

| Datenelemente | Endpunkte |
|---|---|
| ![Daten](img/data_elements.png) | ![Endpoints](img/endpoints.png) |

Ablauf einer Runde:

1. Init Frame baut das 10x8-Raster auf (einmalig)
2. Reset Round setzt `finished`, `choice` und `league` zurück
3. Show League Menu zeigt die Ligawahl; vier QR-Frames laufen als
   `parallel wait="1" cancel="last"` gegeneinander - der erste Scan
   gewinnt, die anderen drei werden abgebrochen
4. Fetch League Table lässt den Server die Tabelle holen und übernimmt
   die Antwort direkt in `data.tbl`; Show League Table zeigt sie
5. Scan "Spieltag": Fetch League Matches, Matchday Board zeigt den
   Spieltag; das Board selbst ist ein wartender Frame und läuft
   parallel zu den drei Navigations-QRs
6. Scan eines Spiels (`m3`): Select Match, Fetch Match Detail, Show
   Match Detail, QR Back
7. Scan "Tabelle" führt zur Tabelle zurück, "Liga wechseln" zur
   Ligawahl, "Exit" leert den Schirm - danach beginnt in allen Fällen
   die nächste Runde

Vier ineinander liegende Schleifen tragen den Ablauf: Kiosk (endlos),
Liga (bis Liga wechseln oder Exit), Tabellenseite und Spieltag. Jede
Schleifenbedingung nennt genau die Wörter, die sie verlassen.

Wächter: `finished` wird beim Rundenstart und nach jeder Interaktion
auf 0 gesetzt; ein paralleler Zweig zählt in 3-Sekunden-Schritten
hoch. Erreicht er 180, wird der wartende Frame abgebrochen und die
Runde beginnt neu. Der Prozess läuft dabei endlos, `<stop>` gibt es
nicht.

Board: der Prozess ist als Subprozess aufrufbar - liegt im Hub,
braucht keinen Input, spricht die Anzeige nur über die Endpunkte
`frames_init` und `frames_display` an. URL:
<https://cpee.org/hub/server/Teaching.dir/Prak.dir/TUM-Prak-26-SS.dir/AfandiyevRustam.dir/football.xml/>

## Dateien und Datenfluss

| Datei | schreibt | liest | Takt |
|---|---|---|---|
| table.json | Server (`/fb_table`) | - (Prozess bekommt die Antwort direkt) | pro Ligawahl, Cache 5 min |
| football.json | Server (`/fb_matches`) | Server (`/fb_match` sucht `matches[idx]`) | pro Spieltag-Aufruf, Cache 5 min |
| match.json | Server (`/fb_match`) | - | pro Spielwahl |

## Backend (football_backend.js)

| Tür | Aufgabe |
|---|---|
| /fb_table?league=BL1 | Tabelle holen, `table.json` schreiben, Tabelle zurückgeben |
| /fb_matches?league=BL1 | aktuellen Spieltag holen, `football.json` schreiben, zurückgeben |
| /fb_match?league=BL1&idx=3 | Spiel `idx` aus `football.json`, Form beider Teams (letzte 5), `match.json` schreiben, zurückgeben |
| / | Lebenszeichen, Liste der Ligen |

Liga-Codes: `PL`, `PD`, `BL1`, `SA`. Der API-Schlüssel für
football-data.org kommt aus der Umgebungsvariable `FB_KEY` und steht
nicht im Code. Nicht-ASCII-Zeichen werden als `\uXXXX` geschrieben,
damit Vereinsnamen auf keinem Weg verstümmelt werden.

## Seiten

- fb_menu.html - Startseite mit Anleitung, linke Spalte; die vier
  Liga-QRs daneben sind eigene fb_qr-Frames
- fb_qr.html - generischer QR-Frame: zeigt den Callback der wartenden
  Aufgabe als QR, Parameter `value` und `labelb`
- fb_send.html - wird vom Handy geöffnet, sendet `value` per PUT an
  den Callback
- fb_table.html - Tabelle
- fb_matches.html - Spieltag, jedes Spiel mit eigenem QR (`m0`, `m1`, ...)
- fb_match.html - Spieldetail mit Formkurven

Alle Seiten lesen ihre Daten aus dem `data`-Parameter der URL (Base64).

## Starten

1. Server auf lehre:
   `export FB_KEY=...` dann
   `nohup node football_backend.js > football_backend.log 2>&1 &`
2. HTML-Seiten nach `~/public_html`
3. football.xml in CPEE als neue Instanz laden und starten
4. Anzeige: <https://cpee.org/out/frames/AfandiyevRustam>
