# Handoff vetobot

## Goal

De eigenaar wil een AI-trader die hij kan vertrouwen:
"Ik wil gewoon een AI trader hebben die ik kan vertrouwen dat hij uit eindelijk winst kan maken, ik weet van de kans dat hij ook verlies kan maken maar dat hij dat zodanig het verlies kan limieteren door de juiste trades te maken".

Laatste grote opdracht (24 november 2026): Vetobot uitbreiden tot een zelflerend systeem met beslissingsdagboek, eerlijke modelvergelijking, modelversiebeheer met terugzetten, en een Learning-pagina. "De belangrijkste maatstaf is of Vetobot na langdurige paper trading aantoonbaar betere, consistentere en risicobewustere handelsbeslissingen neemt dan zijn oorspronkelijke versie." Gebouwd (zie hieronder).

Besluiten van de eigenaar in deze chat:
- Live op eigen risico met eigen inzet en een verliesgrens die hij zelf kiest: "Verliesgrens moet ingesteld kunnen worden zodat ik dat zelf kan bepalen". Gebouwd.
- De AI-trader kiest zelf de inzet tussen inzet en max. inzet, ook live: "Bouw het maar, en ik wil direct in de live testen. Ja ik weet hier de risico van". Gebouwd.
- De oude training van het voorspelmodel mag uit: "als ik hem nu al niet gebruikt hoef hij ook niet te trainer". Schema "Uit" gebouwd; de eigenaar zet het zelf uit.

## Werkafspraak: PR's, niet meer direct naar `main`

**Nieuw en bindend:** "we zouden met PR's gaan werken niet meer direct naar de main pushen".
- Werk op de branch `claude/fervent-bohr-ezx52v` (of een nieuwe branch), push daarheen en open een PR naar `main`. Niet zelf samenvoegen; de eigenaar voegt samen.
- CI bouwt de images pas bij een push naar `main` (dus na het samenvoegen). Geef na het samenvoegen de update-commando's.
- De skill `/hervat` zegt nog "direct op `main`": deze afspraak gaat voor.
- De laatste push direct naar `main` (`ec698c5`) mocht blijven staan: "Laat maar staan".

## Staat van de code

- Branch: `main`; werkbranch `claude/fervent-bohr-ezx52v` staat gelijk aan `main`.
- Laatste codecommit: `ec698c5` "Integratie leersysteem: extra recepten ververst bij 'niet beter', Learning-pagina op de echte registervorm, README".
- CI van `ec698c5`: zie de laatste run van `docker.yml` (liep nog bij het schrijven).
- Beide servers moeten na deze build bijgewerkt worden (bot én leerserver). Niet bevestigd dat dat gebeurd is.
- Belangrijke eerdere fix: `c006295` operatorId bij Bitvavo-orders (zonder die waarde weigerde ccxt elke live order, ook verkopen). Zorg dat de thuisserver minstens die versie draait.

## Active files

- `src/journal.js`: beslissingsdagboek (SQLite `learning.db` per gebruiker), labels na 1/4/24 uur zonder lekken, trades met kosten en MFE/MAE, `stats()` voor Learning.
- `src/bot.js`: hooks naar het dagboek (`#journalDecision`, `#journalAgent`, `#journalTrade`), guard tegen dubbele orders (`this.ordering`), live niet kopen zonder orderboek, eigen risico (`agentRiskyActive`, `agentRiskyLoss`), eigen inzet (`sizeStake`), `sizingSummary`, `learningStats`.
- `src/agents.js`: `sizeStake`, `activeAgent`/`allAgentParts` (extra recepten alleen actief als live gezet).
- `src/exchange.js`: `OPERATOR_ID` (BITVAVO_OPERATOR_ID), fees in live costEur, echte fouten bij limiet-koop niet verstoppen; candle-cachesleutel met `since`.
- `src/manager.js`: `refreshAgent` vraagt live gezette recepten mee (`?keep=`), `learningRegistry()`, sluit het dagboek bij stoppen.
- `src/server.js`: `/api/agent/live` (ook eigen risico), `/api/learning`, `/api/admin/learning/rollback|unpin`.
- `trainer/registry.py`: modelregister `registry.db`, snapshots `agents/versions/v<n>.json`, migraties, corrupt-herstel.
- `trainer/server.py`: poortwachter `promotion_gate`, `publish_agent`, `_finish_round`, `extra_recipes`, `add_kept`, `/registry`, rollback/unpin, schema "Uit" voor het oude model.
- `trainer/agent.py`: metrics (netReturnPct, profitFactor, sharpe, avgWin/LossPct, byVolatility).
- `trainer/agent_search.py`: opnieuw trainen alleen bij nieuwe data (`retestHours`, `retestTrades`).
- `public/index.html`: pagina Learning; Trainer → Live (Nu live, eigen risico, extra recepten); instellingen eigen inzet en kleinste live-start.
- `README.md`: sectie "Learning: hoe vetobot leert en zich verbetert" (architectuur, database/herstel, instellingen).

## Veranderingen gemaakt

1. Live op eigen risico: per recept, eigen inzet, verliesgrens in €; stopt vanzelf met melding. Kleinste live-start is een instelling.
2. Live-bugs opgelost: fees telden live niet mee; vrij saldo binnen een ronde; operatorId voor Bitvavo (alle live orders faalden); ander recept gebruiken als het fase-recept niet live mag; live gezette recepten vallen niet meer weg.
3. Extra recepten (top 6, getest/betrouwbaar) om live te zetten; "Nu live"-overzicht, ook op mobiel.
4. AI-trader kiest zelf de inzet (tussen inzet en max. inzet) naar vertrouwen; harde grens op max. inzet.
5. Dagoverzicht: "gekocht N" naast goedgekeurd, redenen als kopen mislukt; geen "testfase"-verwarring meer.
6. Web-app-manifest en icoon (dashboard als app op de telefoon).
7. Leersysteem (met twee agents parallel gebouwd en daarna samengevoegd): beslissingsdagboek, volatiliteit als marktomstandigheid, profit factor/Sharpe/gem. winst en verlies, modelversiebeheer met poortwachter, terugzetten en vastzetten, trainen alleen bij nieuwe data, Learning-pagina, live-beveiligingen (orderboek verplicht, geen dubbele orders, harde limieten vlak voor elke order).

Tests bij `ec698c5`: `npm test` 199 van 199 geslaagd; `cd trainer && python -m unittest test_trainer` 96 tests OK. Rooktest: bot start met lege datamap, `/healthz` ok.

## Failed attempts

- Limietorders "niet gevuld": was geen vulprobleem maar ccxt die zonder operatorId elke order weigerde; de bot verstopte die fout. Opgelost, en echte fouten worden nu gemeld.
- Schermafbeeldingen van het dashboard via `file://` werken niet (de pagina wil de API bereiken en vervangt de inhoud): serveer `public/` met een kleine HTTP-server en vang `/api/**` af in Playwright.
- Telefoon als volledige leerserver: te traag; als helper naast de VPS werkt het (Fold4 ±351 s per ronde met 2 kernen).

## Specific next steps

1. Na een geslaagde build: eigenaar laten bijwerken.
   - VPS: `docker compose pull vetobot-trainer && docker compose up -d vetobot-trainer`
   - Thuisserver: `docker compose pull vetobot && docker compose up -d vetobot`
2. Eigenaar laten controleren:
   - pagina **Learning** laadt; na de eerste leerronde verschijnen versies (v1 = "eerste model van de AI-trader");
   - na een paar uur zijn er beslissingen met uitkomsten na 1/4/24 uur;
   - Trainer → Wanneer trainen → Schema **Uit** (oude voorspelmodel), als hij dat wil.
3. Live: controleren dat aankopen nu "Gekocht: € …" geven (operatorId-fix) en dat het eigen-risico-recept bij "Nu live" staat.
4. Aandachtspunten:
   - het plan per marktfase (`regimes` in `agent.json`) verandert alleen bij een promotie; de extra recepten worden wel elke ronde bijgewerkt;
   - oude recepten zonder `grossWin/LossPct` hebben een onbekende eindtest-profit factor; de PF-eis laat dan door;
   - de Strategy-pauze-hook in het dagboek is vrijwel onbereikbaar (chooseForRegime geeft altijd een recept).
5. Mogelijke vervolgstappen, alleen op verzoek: gelabelde afgewezen beslissingen ook naar de leerserver sturen voor kalibratie; volatiliteit ook gebruiken in de Strategy Agent (recept per trend én volatiliteit); de Risk Agent instelbaar maken.
6. Werk via PR's (zie boven).
