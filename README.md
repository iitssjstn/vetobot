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
| `gemini` | Google Gemini, gratis key via [aistudio.google.com](https://aistudio.google.com) | `gemini-2.5-flash` |
| `openai` | Elke OpenAI-compatibele API: Groq (standaard), OpenRouter, Ollama, ... | `llama-3.3-70b-versatile` |

De AI-key vul je in via het dashboard. Met de knop **AI testen** stuur je een testvraag met actuele data van je eerste coin. Je ziet dan het antwoord, het model en de reactietijd, of de echte foutmelding als het misgaat (bijvoorbeeld een ongeldige key, een onbekend model of een rate limit). Er wordt daarbij geen trade geplaatst. Voor een andere OpenAI-compatibele provider zet je `AI_BASE_URL`, bijvoorbeeld `https://openrouter.ai/api/v1`.

Tip: draai een tijd met `none` en daarna met een AI, en vergelijk de resultaten in het dashboard. Zo zie je of de veto echt helpt.

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

In het dashboard onder **Instellingen** regel je:

- **Handelsmodus**: paper of live (zie hieronder)
- **Planning**: hoe vaak de bot checkt (1 tot 60 minuten) en de candle-tijd (1 minuut tot 1 dag)
- **Risico & inzet**: inzet per trade, maximaal aantal open trades, stop-loss, take-profit, dagelijkse verlieslimiet en fee. Stop-loss, take-profit en daglimiet kun je met 0 uitzetten
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
| `PAPER_START_BALANCE_EUR` | `500` | Startsaldo paper trading |
| `AI_PROVIDER` | `none` | `none`, `gemini` of `openai` |
| `AI_MODEL` | leeg | Leeg = standaardmodel van de provider |
| `AI_BASE_URL` | Groq | Alleen voor `openai` |
| `AI_FAIL_MODE` | `reject` | Wat te doen bij een AI-fout |
| `PORT` | `3000` | Poort in de container |

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
