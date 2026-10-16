# herbi. — Discord-Glücksrad

Cleane, responsive Gewinnspiel-Seite mit Discord-Anmeldung, Twitch-Follow-Verifizierung für **[joedom](https://www.twitch.tv/joedom)**, einem Los pro Discord-/Twitch-Konto und Runde, einem Passwort-Login für den Admin und einer gemeinsamen Live-Ziehung. Node.js + Express, SQLite und HTML/CSS/JavaScript. Kein Build-Schritt nötig.

## Lokal starten

Node.js 22.17+ oder 24 LTS installieren. Im Projektordner:

```powershell
npm install
Copy-Item .env.example .env
# In .env ADMIN_PASSWORD setzen und SESSION_SECRET durch einen zufälligen Wert ersetzen.
npm start
```

Öffnen: **http://localhost:3000**. Rechts oben über **Admin** mit dem in `.env` gesetzten Passwort anmelden. Ohne Discord-/Twitch-Konfiguration kannst du das Design und den Admin-Login bereits nutzen; echte Teilnahmen brauchen die folgenden Zugangsdaten. Echte Passwörter und Secrets ausschließlich in `.env` oder als Render-Umgebungsvariablen hinterlegen.

## Discord einrichten

1. Im [Discord Developer Portal](https://discord.com/developers/applications) eine Anwendung anlegen, zum Beispiel „Herbi Glücksrad“.
2. Unter **OAuth2** die **Client ID** und das **Client Secret** holen. Als Render-Umgebungsvariablen `DISCORD_CLIENT_ID` und `DISCORD_CLIENT_SECRET` eintragen; lokal in `.env`. Das Secret gehört ausschließlich auf den Server.
3. Unter **OAuth2 → Redirects** exakt diese URL hinzufügen:

   ```text
   https://DEIN-SERVICE.onrender.com/auth/discord/callback
   ```

   Für lokale Anmeldung zusätzlich `http://localhost:3000/auth/discord/callback` eintragen.

Die App verwendet den OAuth2 Authorization Code Flow mit `identify` und `guilds`. Ein Bot und ein Bot-Token sind nicht erforderlich. Die Mitgliedschaft in **beiden** folgenden Servern wird beim Anmelden und erneut beim Sichern eines Loses über die Discord-API geprüft:

- `744595661889994852`
- `1384141435988738048`

Die angezeigten Servernamen sind Platzhalter. Optional echte Namen und Einladungslinks über `DISCORD_GUILD_1_NAME`, `DISCORD_GUILD_2_NAME`, `DISCORD_GUILD_1_INVITE` und `DISCORD_GUILD_2_INVITE` setzen. Ohne Einladungslink öffnet die Seite den jeweiligen Server über seine Discord-ID; für Außenstehende ist das kein Beitrittslink.

## Twitch einrichten

1. In der [Twitch Developer Console](https://dev.twitch.tv/console/apps) unter **Applications → Register Your Application** eine Anwendung anlegen, zum Beispiel „Herbi Glücksrad“. Twitch verlangt dafür ein verifiziertes Konto mit Zwei-Faktor-Authentifizierung.
2. Als **OAuth Redirect URL** exakt diese URL hinzufügen:

   ```text
   https://DEIN-SERVICE.onrender.com/auth/twitch/callback
   ```

   Für lokale Tests zusätzlich `http://localhost:3000/auth/twitch/callback` hinzufügen.
3. Eine passende Kategorie auswählen, etwa **Website Integration**. Falls ein Client-Typ abgefragt wird, **Confidential** wählen, da das Secret ausschließlich auf dem Backend liegt.
4. Unter **Manage** die **Client ID** kopieren und ein **Client Secret** erstellen. In Render als `TWITCH_CLIENT_ID` und `TWITCH_CLIENT_SECRET` setzen, lokal in `.env`.

Die Anmeldung fordert ausschließlich `user:read:follows` an. Das Backend validiert das Token, löst den Kanalnamen **joedom** in dessen Twitch-ID auf und prüft über **Get Followed Channels**, ob der angemeldete Nutzer genau diesem Kanal folgt. Es wird kein kostenpflichtiges Abo verlangt. Der Nutzer folgt dem Kanal selbst auf Twitch und kann danach **Follow prüfen & Los sichern** wählen. Ein Kanalbesitzer- oder Moderator-Token ist dafür nicht erforderlich.

Twitch-Tokens bleiben verschlüsselt auf dem Server. Abgelaufene Tokens werden erneuert; gespeicherte Twitch-Sitzungen werden beim Serverstart und stündlich erneut validiert. Widerrufene Verbindungen müssen neu autorisiert werden. [Twitch-API](https://dev.twitch.tv/docs/api/reference/#get-followed-channels), [Token-Validierung](https://dev.twitch.tv/docs/authentication/validate-tokens/).

## Auf Render bereitstellen

1. Diesen Ordner als GitHub- oder GitLab-Repository hochladen. `.env`, `data/` und `node_modules/` werden nicht mit hochgeladen.
2. Im [Render Dashboard](https://dashboard.render.com/) **New → Blueprint** wählen und das Repository verbinden. Die enthaltene `render.yaml` konfiguriert einen Node-Web-Service in Frankfurt mit einem persistenten 1-GB-Datenträger.
3. Die abgefragten Umgebungsvariablen setzen:

   | Variable | Wert |
   | --- | --- |
   | `DISCORD_CLIENT_ID` | Discord Client ID |
   | `DISCORD_CLIENT_SECRET` | Discord Client Secret |
   | `TWITCH_CLIENT_ID` | Twitch Client ID |
   | `TWITCH_CLIENT_SECRET` | Twitch Client Secret |
   | `ADMIN_PASSWORD` | Dein gewünschtes Admin-Passwort |

   `SESSION_SECRET` wird vom Blueprint zufällig erzeugt. Diesen Wert bei weiteren Deployments beibehalten, damit bestehende Sitzungen lesbar bleiben.
4. Deployment abwarten und die Render-URL in Discord und Twitch als passenden Redirect eintragen, siehe oben.
5. Seite öffnen, Discord verbinden, Twitch verifizieren und über **Admin → Glücksrad starten** ziehen.

**Der Blueprint nutzt einen kostenpflichtigen Render-Starter-Service mit persistentem Datenträger.** Die lokale SQLite-Datei braucht diesen Datenträger, damit Teilnehmer, Sitzungen und Ziehungen Deployments überstehen. Ein kostenloser Service ohne persistenten Speicher verliert diese Daten. [Render-Dokumentation zu Datenträgern](https://render.com/docs/disks).

Bei manueller Einrichtung: Build-Befehl `npm ci --omit=dev`, Start-Befehl `npm start`, Node.js `24`, Health Check `/health`, Disk-Mount `/var/data`, `DATA_DIR=/var/data`, `NODE_ENV=production`. Zusätzlich die fünf Variablen aus der Tabelle und einen zufälligen `SESSION_SECRET` mit mindestens 32 Zeichen setzen.

Die öffentliche Basis-URL wird auf Render automatisch aus `RENDER_EXTERNAL_URL` gelesen. Bei einer eigenen Domain `APP_URL=https://deine-domain.de` setzen und die dazu passenden Discord- und Twitch-Redirects registrieren. `APP_URL` darf keinen Pfad enthalten.

## Ablauf

- Mit Discord anmelden, dann Twitch verbinden. Nur mit Mitgliedschaft in beiden Discord-Servern **und** einem bestätigten Twitch-Follow für **joedom** gibt es ein Los in der offenen Runde.
- Fehlt eine Mitgliedschaft, bleibt der Nutzer angemeldet und kann nach dem Beitritt **Mitgliedschaft prüfen** wählen.
- Fehlt der Follow, auf [twitch.tv/joedom](https://www.twitch.tv/joedom) folgen und **Follow prüfen & Los sichern** wählen.
- Doppelte Anmeldungen, andere Browser und wiederholte Klicks erzeugen keine zusätzlichen Lose. Ein Twitch-Konto kann pro Runde nur einem Discord-Konto ein Los ermöglichen. Die Zuordnung eines vergebenen Loses bleibt für diese Runde fest.
- Nur der angemeldete Admin kann das Rad starten. Der Gewinner wird auf dem Server mit `crypto.randomInt` ausgewählt; alle Segmente sind gleich groß.
- Sobald die Ziehung startet, ist die Teilnahme geschlossen. Alle geöffneten Seiten erhalten Live-Updates. Auch ein später geöffneter Tab zeigt dieselbe Ziehung und denselben Gewinner.
- Nach der Ziehung kann der Admin eine neue Runde öffnen. Dafür sichern sich die Nutzer wieder ein Los. Vergangene Runden bleiben in der Datenbank.
- Die Mitgliedschaften und der Follow werden bei der Teilnahme erneut geprüft. Ein späterer Serveraustritt oder Unfollow entfernt ein bereits vergebenes Los nicht automatisch; für die nächste Runde werden beide Voraussetzungen neu geprüft.

**Update einer bestehenden Installation:** Die Datenbank wird automatisch erweitert. Lose einer noch offenen Runde werden erst nach Twitch-Verifizierung wieder im Rad angezeigt. Bereits laufende oder abgeschlossene Ziehungen behalten ihre ursprünglichen Teilnehmer und Ergebnisse.

Sitzungen sowie Discord- und Twitch-Tokens werden verschlüsselt in SQLite gespeichert. Passwortprüfung, Session-Cookies, OAuth-State, Origin-Prüfung, Sicherheitsheader und Anmelde-Limits laufen im Backend. Der Admin-Zugang läuft nach vier Stunden ab. Das gewünschte Passwort ist über `ADMIN_PASSWORD` änderbar.

## Tests

```powershell
npm test
```

Die Integrationstests prüfen unter anderem beide Mitgliedschaften, Twitch-Follows, doppelte Discord-/Twitch-Konten, OAuth-State, Session-Verschlüsselung, Token-Erneuerung, widerrufene Berechtigungen, Datenbankmigration, Admin-Rechte, Origin-Schutz, die Ziehung, das Schließen der Teilnahme und Neustart-Persistenz. Discord und Twitch werden dabei simuliert; für den echten OAuth-Durchlauf werden deine Anwendungsdaten benötigt.

Schriften: selbst gehostete **DM Sans** und **Manrope**, jeweils SIL Open Font License. Lizenzen liegen in `public/fonts/`.
