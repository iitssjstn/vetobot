# vetobot

Een crypto trading bot voor **Bitvavo**. Een regelgebaseerde strategie geeft de signalen, een AI naar keuze mag koopsignalen **afwijzen** (veto), en harde limieten in code bewaken het risico. Standaard draait hij in **paper trading**: er worden geen echte orders geplaatst.

Puur Node.js, zonder NumPy of native code, dus hij draait ook op oudere CPU's.

## Hoe het werkt

Elke check (standaard elke 15 minuten, instelbaar in het dashboard) loopt de bot alle pairs langs:

1. **Open positie?** Dan eerst stop-loss en take-profit checken, daarna het verkoopsignaal. Verkopen gaat **nooit** langs de AI, zodat een AI-fout een stop-loss niet kan blokkeren.
2. **Koopsignaal** (EMA fast kruist boven EMA slow, RSI onder `RSI_MAX_ENTRY`)? Dan eerst de harde regels: maximaal aantal open trades, dagelijkse verlieslimiet en saldo.
3. Komt het signaal daardoor, dan krijgt de **AI** de indicatoren en de laatste candles, en antwoordt met `approve` of `reject` plus een reden.
4. Alles wordt gelogd en is te zien in het dashboard.

De AI bepaalt nooit bedragen, stop-losses of verkopen. Reageert de AI niet, geeft hij onzin terug of is er geen AI-key, dan wordt de trade afgewezen (`AI_FAIL_MODE=reject`).

De strategie kijkt alleen naar **gesloten** candles, en elke candle wordt maar één keer beoordeeld.

## API-keys en account

API-keys komen **nooit** in env-variabelen of `.env`-bestanden. Je vult ze in via het dashboard:

- Ze worden versleuteld (AES-256-GCM) opgeslagen in `data/secrets.enc`.
- De sleutel daarvoor wordt bij de eerste start willekeurig gemaakt in `data/master.key`.
- Na het opslaan zie je alleen nog of een key is ingesteld en de laatste 4 tekens.

Dit beschermt tegen uitlekken via git, losse backups of het dashboard. Iemand met root op de server kan bij beide bestanden; dat geldt voor elke manier van opslaan op disk. Maak je een backup, neem `master.key` en `secrets.enc` dan samen mee, anders zijn de keys niet meer te ontsleutelen.

### First-run setup

Bij de eerste start bestaat er nog geen account. De bot print dan een eenmalige **setup-code** in de logs:

```bash
docker compose logs vetobot
```

Open het dashboard, vul de setup-code in en kies een gebruikersnaam en wachtwoord (minimaal 10 tekens) voor het admin-account. Daarna verdwijnt de setup en kun je alleen nog inloggen. De code zorgt ervoor dat alleen iemand met toegang tot je server het account kan aanmaken.

Het wachtwoord wordt alleen als scrypt-hash opgeslagen in `data/auth.json`. Na 5 mislukte inlogpogingen wordt dat IP 5 minuten geblokkeerd. Wachtwoord vergeten? Stop de container, verwijder `data/auth.json` en start opnieuw voor een nieuwe setup. Je keys blijven bewaard.

## AI-providers

| `AI_PROVIDER` | Wat | Standaardmodel |
|---|---|---|
| `none` | Geen AI, elk signaal gaat door. Handig als nulmeting. | – |
| `gemini` | Google Gemini, gratis key via [aistudio.google.com](https://aistudio.google.com) | `gemini-3.8-flash` |
| `openai` | Elke OpenAI-compatibele API: Groq (standaard), OpenRouter, Ollama, ... | `llama-3.3-70b-versatile` |

De AI-key vul je in via het dashboard. Met **Ophalen** naast het modelveld zie je welke modellen je key mag gebruiken. Met de knop **AI testen** stuur je een testvraag met actuele data van je eerste coin. Je ziet dan het antwoord, het model en de reactietijd, of de echte foutmelding als het misgaat (bijvoorbeeld een ongeldige key, een onbekend model of een rate limit). Er wordt daarbij geen trade geplaatst. Voor een andere OpenAI-compatibele provider zet je `AI_BASE_URL`, bijvoorbeeld `https://openrouter.ai/api/v1`.

Tip: draai een tijd met `none` en daarna met een AI, en vergelijk de resultaten in het dashboard. Zo zie je of de veto echt helpt.

### AI-volgorde (back-upmodellen)

Bij AI-veto zet je maximaal 5 modellen op volgorde, elk met een eigen provider, model en key. Faalt een model (fout, time-out, quota op of een onleesbaar antwoord), dan probeert vetobot het volgende. Een afwijzing is een geldig antwoord; dan gaat hij niet verder naar de volgende.

- Laat je de key van een model leeg, dan gebruikt het de key van een eerder model met dezelfde provider (en base-URL). Zo kun je bijvoorbeeld twee Gemini-modellen met één key gebruiken.
- Met ↑ en ↓ verander je de volgorde; de keys verhuizen mee.
- **Alle modellen testen** stuurt elk model een testvraag en laat per model zien of het werkt.
- Neemt een back-up het over, dan krijg je een Discord-melding. Falen alle modellen, dan krijg je een melding met tag en de fout van elk model, en volgt het signaal je instelling bij "Als alle modellen falen".
- Dezelfde volgorde wordt ook gebruikt voor het dagoverzicht.

## Installeren in je bestaande Docker Compose

De GitHub Action bouwt bij elke push naar `main` de image `ghcr.io/iitssjstn/vetobot:latest`.

Voeg de service toe aan je `docker-compose.yml`. Hier staan alleen instellingen in, geen keys:

```yaml
  vetobot:
    image: ghcr.io/iitssjstn/vetobot:latest
    container_name: vetobot
    restart: unless-stopped
    pull_policy: always
    networks:
      - media
    dns:
      - 1.1.1.1
      - 1.0.0.1
    environment:
      - TZ=Europe/Amsterdam
    ports:
      - "127.0.0.1:3020:3000"
    volumes:
      - ./vetobot/data:/app/data
```

```bash
mkdir -p vetobot/data && sudo chown 1000:1000 vetobot/data
docker compose up -d vetobot
docker compose logs vetobot     # hier staat de setup-code
```

Het dashboard staat dan op `http://127.0.0.1:3020` (via een SSH-tunnel). Via Nginx Proxy Manager forward je naar `vetobot` op poort `3000`. Doe de first-run setup dan meteen, en zet bij voorkeur HTTPS aan.

De image is publiek, dus inloggen bij ghcr.io is niet nodig. Krijg je bij `docker compose pull` toch `denied`, zet dan op GitHub bij Packages → vetobot → Package settings de visibility op Public.

## Instellingen

Naast elk veld bij Planning, Risico & inzet en Strategie staat een **?** met uitleg: wat het doet, wat hoger of lager betekent en een gebruikelijke waarde. Bij Strategie staat ook een uitleg in gewone taal over candles, EMA, kruisingen en RSI, plus drie voorbeeldinstellingen (rustig, gemiddeld, actief) om mee te beginnen. Die passen alleen planning, stop-loss, take-profit, afkoelperiode en strategie aan, nooit je inzet of limieten.

In het dashboard onder **Instellingen** regel je:

- **Handelsmodus**: paper of live (zie hieronder)
- **Planning**: hoe vaak de bot checkt (1 tot 60 minuten) en de candle-tijd (1 minuut tot 1 dag)
- **Risico & inzet**: inzet per trade, maximaal aantal open trades, stop-loss, take-profit, dagelijkse verlieslimiet (telt ook open verliezen mee), fee, afkoelperiode na een verkoop en slippage in paper. Stop-loss, take-profit en daglimiet kun je met 0 uitzetten
- **Strategie**: EMA fast, EMA slow, RSI-periode en de maximale RSI bij instap
- **Paper-account**: opnieuw beginnen met een zelfgekozen startsaldo
- **Coins**: kies uit alle EUR-markten op Bitvavo, gesorteerd op volume, maximaal 100
- **AI-veto**: provider, model, base-URL en wat er gebeurt als de AI faalt
- **API-keys** en je **wachtwoord**

Deze keuzes worden opgeslagen in `data/settings.json` en blijven bewaard na een herstart.

De environment variables hieronder zijn alleen beginwaarden voor de allereerste start; daarna gaat het dashboard voor. Geen ervan is geheim. In live-modus vraagt het dashboard je wachtwoord bij het wijzigen van risico of strategie.

| Variabele | Standaard | Betekenis |
|---|---|---|
| `LIVE_TRADING` | `false` | Beginwaarde voor de modus; daarna via het dashboard |
| `PAIRS` | `BTC/EUR,ETH/EUR` | Beginwaarde voor de coins; daarna via het dashboard |
| `TIMEFRAME` | `1h` | Beginwaarde voor de candle-tijd; daarna via het dashboard |
| `CHECK_INTERVAL_MINUTES` | `15` | Beginwaarde voor het check-interval; daarna via het dashboard |
| `EMA_FAST` / `EMA_SLOW` | `12` / `26` | EMA-periodes |
| `RSI_PERIOD` / `RSI_MAX_ENTRY` | `14` / `70` | Geen aankoop boven deze RSI |
| `STAKE_EUR` | `25` | Inzet per trade |
| `MAX_OPEN_TRADES` | `2` | Maximaal gelijktijdige posities |
| `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` | `3` / `6` | Exit-percentages |
| `MAX_DAILY_LOSS_EUR` | `20` | Daarna geen nieuwe trades tot morgen |
| `FEE_PCT` | `0.25` | Fee voor paper trading |
| `COOLDOWN_MINUTES` | `30` | Na een verkoop dezelfde coin zoveel minuten niet kopen (0 = uit) |
| `PAPER_SLIPPAGE_PCT` | `0.1` | Paper koopt iets duurder en verkoopt iets goedkoper, zoals live met spread |
| `PAPER_START_BALANCE_EUR` | `500` | Startsaldo paper trading |
| `AI_PROVIDER` | `none` | `none`, `gemini` of `openai` |
| `AI_MODEL` | leeg | Leeg = standaardmodel van de provider |
| `AI_BASE_URL` | Groq | Alleen voor `openai` |
| `AI_FAIL_MODE` | `reject` | Wat te doen bij een AI-fout |
| `AI_TIMEOUT_MS` | `45000` | Hoe lang de bot op de AI wacht (ms) |
| `PORT` | `3000` | Poort in de container |

## Meldingen (Discord) en offline-waarschuwing

Bij Instellingen → Meldingen stel je in:

- **Discord-webhook**: vetobot stuurt meldingen naar een kanaal naar keuze. De webhook wordt versleuteld opgeslagen, net als de API-keys.
- **Jouw Discord user ID**: dan word je getagd en krijg je een push-melding op je mobiel en pc.
- **Per soort melding** of hij gestuurd wordt en of je getagd wordt: herstart, trades, stop-loss, fouten (maximaal één keer per 30 minuten per soort), dagelijkse verlieslimiet, wisselen van modus en AI-afwijzingen.

Met **Testmelding sturen** controleer je of het werkt.

### Dagelijks overzicht

Elke dag op een tijd naar keuze (standaard 08:00) stuurt vetobot een overzicht van de afgelopen 24 uur naar Discord: resultaat, winrate, signalen, saldo en open posities, met een korte analyse door de AI van hoe het ging en wat opvalt. Dat kost één AI-call per dag. Faalt de AI, dan komt het overzicht er zonder analyse. Het laatste overzicht staat ook op het dashboard. Met **Overzicht nu versturen** maak je er direct een.

Ziet de AI daar aanleiding toe, dan doet hij in het overzicht ook een **voorstel** voor andere instellingen. Op het dashboard zie je per instelling de huidige waarde en het voorstel; vink aan wat je wilt en klik op **Geselecteerde overnemen**. Er verandert nooit iets vanzelf. De AI mag alleen de strategie (EMA's en RSI), de stop-loss en take-profit en de planning voorstellen, nooit bedragen zoals de inzet per trade, het aantal open trades of de daglimiet. In live-modus is je wachtwoord nodig om over te nemen.

Start vetobot pas na de ingestelde tijd op, dan komt het overzicht van die dag direct na het opstarten.

### Melding als de server offline gaat

Valt je server uit, dan kan vetobot zelf niets meer sturen. Daarom stuurt hij na elke check een heartbeat naar een externe monitor, bijvoorbeeld [healthchecks.io](https://healthchecks.io) (gratis). Bij een check met fouten gaat de ping naar `<url>/fail`. Komen de heartbeats niet meer binnen, dan stuurt de monitor de melding.

1. Maak op healthchecks.io een check aan. Zet **Period** op je check-interval en **Grace Time** op bijvoorbeeld 10 minuten.
2. Plak de ping-URL bij Heartbeat-URL in vetobot en klik op **Heartbeat testen**.
3. Kies in healthchecks.io bij **Integrations** de **Webhook**-integratie met als URL je Discord-webhook, methode POST, header `Content-Type: application/json` en body `{"content": "<@JOUW_ID> vetobot is offline ($NAME)"}`. Dan word je getagd. Zonder tag kun je ook de Discord-integratie gebruiken.

## Live trading

Doe dit pas na weken paper trading met resultaten waar je tevreden over bent.

1. Maak bij Bitvavo een API-key aan met **alleen handelsrechten, zonder opnamerechten**, en koppel hem aan het IP-adres van je server.
2. Vul de key en het secret in bij Instellingen → API-keys en klik op **Bitvavo-keys testen**.
3. Klik bij Handelsmodus op **Overschakelen naar live**, vul je wachtwoord in en typ `LIVE`.
4. Begin met een kleine `STAKE_EUR` en een lage `MAX_DAILY_LOSS_EUR`.

Beveiligingen bij het wisselen:

- De bot test eerst of je Bitvavo-keys werken en haalt je saldo op. Lukt dat niet, dan blijft hij op paper.
- Wisselen kan alleen als er in de huidige modus geen posities meer open staan. Zo blijft een echte positie nooit onbewaakt achter. Sluit ze eerst, eventueel met de knop **Sluiten** bij Posities.
- Zolang je live staat, kun je de Bitvavo-keys niet verwijderen.
- In live-modus staat er een rode streep bovenaan het dashboard en een rode **LIVE**-badge.

Paper en live hebben elk een eigen state-bestand (`data/state-paper.json` en `data/state-live.json`), dus ze lopen nooit door elkaar.

Let op: stop-loss en take-profit worden per check bekeken, niet direct op de exchange. Bij een interval van 15 minuten kan de koers in die tijd verder doorlopen dan je stop-loss.

## Dashboard

- Saldo (paper), resultaat totaal en vandaag, winrate
- Open posities en afgesloten trades
- Elke AI-beslissing met de reden
- API-keys invullen, vervangen of verwijderen
- Wachtwoord wijzigen
- **Nu checken** voert direct een check uit
- **Pauzeren** stopt nieuwe trades; open posities worden nog wel bewaakt
- **Sluiten** bij een positie verkoopt hem direct tegen de marktprijs

## Ontwikkelen

```bash
npm install
npm start      # open http://localhost:3000, setup-code staat in de terminal
npm test
```

## Disclaimer

Dit is experimentele software. Handelen in crypto kan je je hele inzet kosten. Een strategie die er in paper trading goed uitziet, kan live gewoon verliezen.
