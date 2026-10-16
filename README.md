# herbi. — Community-Glücksrad

Cleane Gewinnspiel-Seite: Namen eintragen, ein Los sichern und die Ziehung live verfolgen. Der Admin startet das Rad über einen Passwort-Login. Node.js + Express, SQLite und HTML/CSS/JavaScript. Kein Build-Schritt und keine externen Konten erforderlich.

## Lokal starten

Node.js 22.17+ oder 24 LTS installieren. Im Projektordner:

```powershell
npm install
Copy-Item .env.example .env
# In .env ADMIN_PASSWORD setzen und SESSION_SECRET durch einen zufälligen Wert ersetzen.
npm start
```

Öffnen: **http://localhost:3000**. Rechts oben über **Admin** mit dem in `.env` gesetzten Passwort anmelden.

## Auf Render bereitstellen

1. Im [Render Dashboard](https://dashboard.render.com/) **New → Blueprint** wählen und dieses Repository verbinden. `render.yaml` konfiguriert einen Node-Web-Service in Frankfurt mit einem persistenten 1-GB-Datenträger.
2. Als `ADMIN_PASSWORD` dein gewünschtes Passwort setzen. `SESSION_SECRET` erzeugt der Blueprint automatisch. Den Wert bei späteren Deployments beibehalten, damit Sitzungen und Browser-Zuordnungen gültig bleiben.
3. Deployment abwarten. Die Seite kann sofort verwendet werden.

Der Blueprint nutzt einen **kostenpflichtigen Starter-Service mit persistentem Datenträger**. Ohne diesen Datenträger verliert die lokale SQLite-Datenbank Teilnehmer und Ziehungen beim nächsten Neustart oder Deployment. [Render-Dokumentation](https://render.com/docs/disks).

Bei manueller Erstellung eines Web Service:

| Feld | Wert |
| --- | --- |
| Language | Node |
| Branch | main |
| Region | Frankfurt |
| Root Directory | Leer lassen |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Disk Mount Path | `/var/data` |
| Disk Size | 1 GB |

Diese Umgebungsvariablen setzen:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24` |
| `DATA_DIR` | `/var/data` |
| `ADMIN_PASSWORD` | Dein gewünschtes Admin-Passwort |
| `SESSION_SECRET` | Zufälliger geheimer Wert mit mindestens 32 Zeichen |

**Client-IDs, Client-Secrets und OAuth-Redirects werden nicht mehr benötigt.** Bereits eingetragene `DISCORD_*`- und `TWITCH_*`-Variablen können aus Render entfernt werden.

Die öffentliche Basis-URL wird automatisch aus `RENDER_EXTERNAL_URL` gelesen. Bei einer eigenen Domain zusätzlich `APP_URL=https://deine-domain.de` setzen, ohne Pfad und ohne abschließenden Schrägstrich. `PORT` setzt Render selbst.

## Teilnahme und Ziehung

- Ein Name mit 2 bis 32 Zeichen reicht. Nach **Los sichern** erscheint der Teilnehmer auf dem Rad.
- Ein signiertes Browser-Cookie merkt sich die Teilnahme für ein Jahr. Wiederholte Klicks und Neuladen erzeugen pro Runde kein zusätzliches Los. Der Name eines vergebenen Loses bleibt für die Runde unverändert.
- Derselbe Name kann pro Runde nur einmal verwendet werden; Groß-/Kleinschreibung und überflüssige Leerzeichen zählen dabei nicht als Unterschied.
- Die Namen sind frei gewählt und werden nicht auf eine reale Person geprüft. Andere Browser, Inkognito-Fenster oder das Löschen des Cookies ermöglichen zusätzliche Einträge unter anderen Namen. Eine strikte Begrenzung auf eine reale Person ist ohne Identitätsprüfung nicht möglich.
- Nur der Admin kann das Rad starten. `crypto.randomInt` bestimmt auf dem Server einen Gewinner; jedes Los hat dieselbe Chance.
- Beim Start schließt die Teilnahme. Alle geöffneten Seiten erhalten Live-Updates und zeigen denselben Gewinner.
- Danach kann der Admin **Neue Runde** öffnen. Alle Teilnehmer können sich erneut ein Los sichern. Vergangene Runden bleiben gespeichert.

Der Admin-Login läuft nach vier Stunden ab. An- und Abmelden als Admin verändert die eigene Teilnahme nicht. Verschlüsselte Sitzungen, signierte Teilnehmer-Cookies, Origin-Prüfung, Sicherheitsheader und Anmelde-Limits laufen auf dem Backend. Passwörter und Secrets ausschließlich in `.env` oder als Render-Umgebungsvariablen hinterlegen.

## Update einer bestehenden Installation

Die Datenbank wird automatisch angepasst. Vorhandene Teilnehmer und Ergebnisse bleiben erhalten. Lose einer offenen Runde brauchen keine weitere Prüfung. Bei bereits laufenden oder abgeschlossenen Ziehungen bleibt die ursprüngliche Zusammenstellung des Rads erhalten. Bestehende angemeldete Browser werden auf die Teilnahme per Cookie umgestellt, soweit die alte Sitzung noch gültig ist.

## Tests

```powershell
npm test
```

Die Integrationstests prüfen die Teilnahme ohne externe Zugangsdaten, Namensprüfung, doppelte Namen, ein Los pro Browser, signierte Cookies, Admin-Rechte, Origin-Schutz, Ziehung und Rundenwechsel, HTTPS-Cookies, Neustart-Persistenz und die Migration bestehender Datenbanken.

Schriften: selbst gehostete **DM Sans** und **Manrope**, jeweils SIL Open Font License. Die Lizenzen liegen in `public/fonts/`.
