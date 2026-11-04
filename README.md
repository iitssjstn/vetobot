# vetobot

Een crypto trading bot voor **Bitvavo**. Een regelgebaseerde strategie geeft de signalen, een AI naar keuze mag koopsignalen **afwijzen** (veto), en harde limieten in code bewaken het risico. Standaard draait hij in **paper trading**: er worden geen echte orders geplaatst.

Puur Node.js, zonder NumPy of native code, dus hij draait ook op oudere CPU's.

## Hoe het werkt

Elke `CHECK_INTERVAL_MINUTES` loopt de bot alle pairs langs:

1. **Open positie?** Dan eerst stop-loss en take-profit checken, daarna het verkoopsignaal. Verkopen gaat **nooit** langs de AI, zodat een AI-fout een stop-loss niet kan blokkeren.
2. **Koopsignaal** (EMA fast kruist boven EMA slow, RSI onder `RSI_MAX_ENTRY`)? Dan eerst de harde regels: maximaal aantal open trades, dagelijkse verlieslimiet en saldo.
3. Komt het signaal daardoor, dan krijgt de **AI** de indicatoren en de laatste candles, en antwoordt met `approve` of `reject` plus een reden.
4. Alles wordt gelogd en is te zien in het dashboard.

De AI bepaalt nooit bedragen, stop-losses of verkopen. Reageert de AI niet of geeft hij onzin terug, dan wordt de trade afgewezen (`AI_FAIL_MODE=reject`).

De strategie kijkt alleen naar **gesloten** candles, en elke candle wordt maar één keer beoordeeld.

## AI-providers

| `AI_PROVIDER` | Wat | Standaardmodel |
|---|---|---|
| `none` | Geen AI, elk signaal gaat door. Handig als nulmeting. | – |
| `gemini` | Google Gemini, gratis key via [aistudio.google.com](https://aistudio.google.com) | `gemini-2.5-flash` |
| `openai` | Elke OpenAI-compatibele API: Groq (standaard), OpenRouter, Ollama, ... | `llama-3.3-70b-versatile` |

Voor een andere OpenAI-compatibele provider zet je `AI_BASE_URL`, bijvoorbeeld `https://openrouter.ai/api/v1`.

Tip: draai een tijd met `none` en daarna met een AI, en vergelijk de resultaten in het dashboard. Zo zie je of de veto echt helpt.

## Installeren in je bestaande Docker Compose

De GitHub Action bouwt bij elke push naar `main` de image `ghcr.io/iitssjstn/vetobot:latest`.

Maak een map met een eigen `.env`:

```bash
mkdir -p /opt/media-stack/vetobot
cp .env.example /opt/media-stack/vetobot/.env   # of kopieer de inhoud handmatig
nano /opt/media-stack/vetobot/.env
```

Voeg de service toe aan je `docker-compose.yml`:

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
    env_file:
      - ./vetobot/.env
    ports:
      - "127.0.0.1:3020:3000"
    volumes:
      - ./vetobot/data:/app/data
```

```bash
docker compose up -d vetobot
docker compose logs -f vetobot
```

Het dashboard staat dan op `http://127.0.0.1:3020` (via een SSH-tunnel). Via Nginx Proxy Manager forward je naar `vetobot` op poort `3000`. Zet in dat geval altijd `DASHBOARD_PASSWORD`.

Omdat de repo privé is, moet je server eenmalig inloggen bij ghcr.io:

```bash
echo <github-token-met-read:packages> | docker login ghcr.io -u iitssjstn --password-stdin
```

## Live trading

Doe dit pas na weken paper trading met resultaten waar je tevreden over bent.

1. Maak bij Bitvavo een API-key aan met **alleen handelsrechten, zonder opnamerechten**, en koppel hem aan het IP-adres van je server.
2. Zet `BITVAVO_API_KEY`, `BITVAVO_API_SECRET` en `LIVE_TRADING=true` in je `.env`.
3. Begin met een kleine `STAKE_EUR` en een lage `MAX_DAILY_LOSS_EUR`.

Paper en live hebben elk een eigen state-bestand (`data/state-paper.json` en `data/state-live.json`), dus ze lopen nooit door elkaar.

Let op: stop-loss en take-profit worden per check bekeken, niet direct op de exchange. Bij een interval van 15 minuten kan de koers in die tijd verder doorlopen dan je stop-loss.

## Dashboard

- Saldo (paper), resultaat totaal en vandaag, winrate
- Open posities en afgesloten trades
- Elke AI-beslissing met de reden
- **Nu checken** voert direct een check uit
- **Pauzeren** stopt nieuwe trades; open posities worden nog wel bewaakt

## Ontwikkelen

```bash
npm install
cp .env.example .env
npm start
npm test
```

## Disclaimer

Dit is experimentele software. Handelen in crypto kan je je hele inzet kosten. Een strategie die er in paper trading goed uitziet, kan live gewoon verliezen.
