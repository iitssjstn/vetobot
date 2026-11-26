# Handoff vetobot

## Goal

De eigenaar wil een AI-trader die hij kan vertrouwen:
"Ik wil gewoon een AI trader hebben die ik kan vertrouwen dat hij uit eindelijk winst kan maken, ik weet van de kans dat hij ook verlies kan maken maar dat hij dat zodanig het verlies kan limieteren door de juiste trades te maken".

Laatste opdrachten (25–26 november 2026):
- Audit leren/promotie/stops/live-veiligheid (PR #4–#7, gemerged).
- Bulk live zetten van recepten + homepage-waarschuwing als niets live staat (PR #10, gemerged). Bij een gezakte eis blijft de toestemming **ingetrokken** (keuze eigenaar: "Intrekken (zoals nu)").
- "Live Trading Reliability & Failure Alerts Audit": gezondheidsbewaking tegen stille uitval + bugcontrole van de hele repo (PR #11, gemerged).
- AI-trader deed een dag niets: oorzaak gevonden en gefixt (PR #12–#14, gemerged).
- Opschonen (PR #16–#18, gemerged): klassieke strategie + AI-team verwijderd (keuze eigenaar; strategieën/bandit, strategie volgen en verkenner bewust behouden), dashboard in 4 groepen met tabs, CI-build-race opgelost.
- Koopdrempel van de AI-trader zelf bijstellen (PR #20, gemerged).
- Live nooit kopen onder het verkoopbare minimum (PR #22) en meeschuivende winstgrens bij uitschieters (PR #23), gemerged.

De eigenaar handelt live (op eigen risico, met eigen inzet). Eerste echte trade via Bitvavo is gelukt (+€ 0,17).

## Werkafspraken (bindend)

- **Alleen via PR's.** "we zouden met PR's gaan werken niet meer direct naar de main pushen". Werkbranch `claude/fervent-bohr-ezx52v` (of een eigen branch per onderwerp, bijv. `claude/audit-...`), PR naar `main`. **Nooit zelf mergen**; wachten op expliciete goedkeuring van de eigenaar. De skill `/hervat` zegt nog "direct op `main`": deze afspraak gaat voor.
- Splits grote wijzigingen in losse, overzichtelijke PR's. PR-tekst met: probleem, risico's, oplossing, gewijzigde bestanden, tests, testresultaten, resterende risico's.
- Geen live trading activeren, geen echte trades in tests (alleen mocks/nep-exchanges).
- Nergens een sessielink (repo, commits, PR's). Commits eindigen alleen met `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `[skip ci]` als alleen `.md` verandert, en dan bij samenvoegen "Create a merge commit" adviseren (squash neemt `[skip ci]` mee).
- Bij gebruik van meerdere agents: elk een eigen werkgebied (bestanden), eigen worktree/branch; hoofdagent controleert, draait alle tests (ook alle branches samen) en maakt de PR's.

## Staat van de code

- `main` = `e688f07` "Merge pull request #23 from iitssjstn/claude/pump-trailing" (bevat PR #4 t/m #23). Image-build groen.
- CI draait `npm test` en **alle** Python-tests; images worden alleen gebouwd bij een push naar `main`. Sinds PR #18 stopt een nieuwere build een oudere (`concurrency`), anders kon een oude build `latest` overschrijven.
- De eigenaar heeft de thuisserver bijgewerkt tot en met PR #17 (26 november) en ziet de nieuwe indeling; VPS t/m PR #11. Na elke update van de bot zet hij de recepten opnieuw live (Trainer → Live, bulkknop).
- Tests op `main`: `npm test` 314/314 (minder door het weghalen van de klassieke strategie); `cd trainer && python -m unittest discover -p "test*.py"` 144 OK.
- Eigenaar werkt via Termius (mobiel) op de thuisserver (`/opt/media-stack`). Claude Code draait daar niet (CPU zonder AVX: "Illegal instruction").

## Active files

- `src/bot.js`: koop-flow, `#liveChecks` (saldo, stop-ronde, saldocontrole vóór de coins), `buyBlockReasons`/`safetyStatus().buyBlock`, exchange-stop (`#placeExchangeStop`, `#onStopState`, `stopFill`), dagboek-hooks, eigen risico, eigen inzet.
- `src/safety.js`: exchange-stop-prijs, saldovergelijking, statussen.
- `src/exchange.js`: `LiveBroker` (operatorId, fees in costEur, `placeStop`/`cancelStop`/`fetchStop`/`findStop`, minimum € 5), `isOrderRefusal`.
- `src/journal.js`: beslissingsdagboek `learning.db` (labels pas na gesloten candles), `labeledRejections`.
- `src/agents.js`: `onlineCorrection` (verschil per trade begrensd op 10 pp), `sizeStake`, `activeAgent`.
- `trainer/stats.py`: t-kwantiel exact (Newton op onvolledige bèta), Welch, `effective_trades` (overlappende eindtests niet dubbel tellen).
- `trainer/probation.py`, `trainer/registry.py`: proefperiode, modelregister, snapshots.
- `trainer/server.py`: `promotion_gate`/`stat_test`, `_finish_round`, `_rollback_target`, `_restore_version`, `add_agent_trades` (onder `publish_lock`), `/registry`.
- `trainer/agent.py`: `_time_split` (splitsing op kalendertijd, embargo), `learn_entry` (NaN/inf overslaan).
- `public/index.html`: Learning (grafiek praktijk vs verwachting, proefstatus), Posities → Live-veiligheid (incl. buyBlock), Trainer → Live.
- `src/health.js` (nieuw): gezondheid uit tijdstempels (gezond/probleem/kritiek/gepauzeerd/gestopt), meldingen met dedupe/escalatie/"Opgelost". `src/runstate.js`: onverwachte herstart herkennen. `manager.checkHealth` (elke 30 s, herstart planner), `/healthz` 503 bij hangende ronde, dashboardblok Gezondheid.
- `src/bot.js` `agentHourlyLog`: elk uur "AI-trader afgelopen 60 min: …" in activiteitenlog en containerlog. `#agentSignal`: handelt het gekozen recept de coin niet, dan een ander toegestaan recept dat dat wel doet.
- Tests: `test/health.test.js`, `test/review-health.test.js`, `test/live-safety.test.js`, `test/learning-data.test.js`, `test/regression*.test.js`, `trainer/test_learning_data.py`, `trainer/test_regression.py`, nieuwe Audit-klassen in `trainer/test_trainer.py`.

## Veranderingen gemaakt (deze chat, samengevat)

1. Live op eigen risico, extra recepten, eigen inzet door de AI-trader, live recepten vallen niet meer weg, operatorId-fix (alle live orders faalden), fees in live, web-app-manifest.
2. Leersysteem: beslissingsdagboek, modelversies met poortwachter, Learning-pagina, proefperiode met automatisch terugvallen, statistische promotietoets, volatiliteit, stop-loss bij Bitvavo, saldocontrole.
3. Audit (PR #4–#7), 12 bevestigde bugs gerepareerd, elk met een eerst falende test:
   - live: stop deels uitgevoerd, dubbele stop na time-out, controles pas ná aankopen (nu buyBlock: bij twijfel geen nieuwe aankopen; bewaken/verkopen nooit geblokkeerd);
   - leerdata: lek via coins met kortere geschiedenis, NaN/inf liet training crashen, label afhankelijk van rekenmoment, uitschieter in de bijsturing;
   - statistiek: herhaalde rondes telden als nieuwe trades (±26% onterechte promoties → 0,3–7%), t-kwantiel te klein, terugzetten naar een gezakt model, race feedback/terugzetten;
   - CI draaide niet alle Python-tests.

4. Gezondheidsbewaking (PR #11): zes oorzaken van stille uitval opgelost (hangende ronde legde ook de positiebewaking stil, fouten alleen in de console, geen crash-afhandeling, Discord-fouten onzichtbaar, `/healthz` altijd ok). Daarna bugcontrole van de hele repo met 4 agents: 14 bugs gefixt, o.a. deels uitgevoerde stop/verkoop kwijt, hele positie dicht bij half gevulde verkoop, state pas aan het eind opgeslagen, dubbele verkoop na verbindingsfout bij limietorders, vals alarm "niet bewaakt", leerserver-race in koersopslag en NaN in trades.
5. AI-trader kocht een dag niets (PR #14): met de fase onbekend of weinig bewijs koos de Strategy Agent het hoofdrecept; handelde dat de coin niet, dan stopte het ("coin niet gekozen" 52×). Andere live gezette recepten werden alleen geprobeerd als het gekozen recept zelf niet live mocht. Nu: ander toegestaan recept dat de coin handelt. Daarna dekt hij alle 12 coins (~170 candles/uur); dat hij in rustige markt niets koopt is de drempel (+0,50%, hoogste live verwachting ±0,3%), geen fout (kenmerken bot = leerserver, geen micro-features in het AI-trader-model).

6. Opschonen (PR #16–#17):
   - Weg: `src/strategy.js` (`evaluate`), klassiek koopsignaal (EMA/RSI/BTC-filter/maxChase/lopende candle), `#modelProbability`/`mlMinProb`/`mlSkipBadRegime`, EMA-verkoop `#signalExit`, AI-team (`askTeamChain`, `TEAM_ROLES`, `ai.mode`), 15 strategie-instellingen, kant-en-klare-strategieën-paneel, tab "AI-team" in AI-chat. Oude `settings.json` laadt (velden vallen weg).
   - Marktbeeld nu uit `marketIndicators()` (EMA 12/26, RSI 14, ATR/ADX 14). AI-controleur gebruikt vaste grenzen "normaal" (staat bij de eigenaar uit).
   - AI-trader én strategieën uit = niets kopen, rode melding op de homepage.
   - Dashboard: menu Overzicht / Handel / AI-trader & leren / Systeem. Trainer-tabs: AI-trader, Wordt hij beter?, Leerserver, Strategieën. Instellingen-tabs: Handel & risico, AI-trader & AI, Coins, Meldingen, Trainer-koppeling, API-keys & account. Deep links openen de juiste tab; pagina en tab worden onthouden.
7. Koopdrempel (PR #20): de leerserver kiest per recept een drempel (bijv. +0,50%, +1,20%); er was geen instelling. Nu `strategy.agentThrAdjust` (−1…+1 %-punt, standaard 0) bij Instellingen → AI-trader & AI; `bot.agentThreshold(agent)` = max(0, recept + bijstelling), overal gebruikt (koop, sizing, verkenner, whyNot, dagboek, plan); AI-chat toont "(recept +0,50%, door jou −0,20)".
8. Live-instellingen eigenaar: koopdrempel-bijstelling −0,30 (bevestigd: hij koopt), laat het voorlopig zo; Limietorders op "Alleen winst nemen (kopen direct)", omdat limiet-kopen na een dip vaak niet gevuld werden.
9. Verkoopbaar minimum (PR #22): Bitvavo weigert orders onder € 5 (errorCode 212). Een halve inzet (Risk Agent) of de kleinste start gaf posities van ~€ 5 die na een kleine daling niet meer te verkopen waren (en geen stop bij Bitvavo kregen). Nu `sellableStake(noodstop%)` = € 5 × 1,03 / (1 − stop) als ondergrens voor live kopen (€ 5,73 bij 10%); `belowMinimum(err)` geeft bij een geweigerde verkoop een duidelijke fout + één Discord-melding per positie (`pos.belowMinNotified`), positie blijft bewaakt.
10. Uitschieter-winstgrens (PR #23, keuzes eigenaar): vanaf +3% topwinst `pos.pump`; niveau = min(instap × (1 + 0,70 × topwinst), top × 0,99), nooit omlaag; verkoop met market order (ook in `watchPositions`); model (`#agentExit`) verkoopt dan niet; live schuift de Bitvavo-stop mee (`#raisePumpStop`, ≥ 0,3% hoger, hooguit eens per 60 s, via `#releaseExchangeStop` + `#placeExchangeStop`). Instellingen `pumpTriggerPct` 3 (0 = uit), `pumpGivebackPct` 30, `pumpMinGapPct` 1 (Handel & risico). Alleen AI-trader-posities, niet de verkenner. Code in `src/safety.js` (`pumpRawLevel`, `pumpLevel`, `exchangeStopPrice` = max(noodstop, winstgrens)) en `test/pump.test.js`. Rest-risico: heel kort geen stop tijdens het vervangen; een afgegane winst-stop heet nog "Stop-loss bij Bitvavo".

## Failed attempts

- Limietorders "niet gevuld" was eigenlijk ccxt die zonder operatorId elke order weigerde (opgelost).
- Agents die gestopt worden zonder commits verliezen hun worktree; bij hervatten maken ze een nieuwe vanaf origin/main (werkt).
- Rebasen van een branch met merge-commits speelt conflicten opnieuw af: niet rebasen als `main` al in de branch zit.
- Dashboard-screenshots: niet via `file://`; serveer `public/` met een kleine HTTP-server en vang `/api/**` af.
- Force-push (ook na `--amend` op een eigen branch) wordt door de auto-mode geblokkeerd: een commit met per ongeluk `[skip ci]` laten staan en "Create a merge commit" adviseren.
- Twee merges kort na elkaar: de oudere build was later klaar en overschreef `latest` (opgelost met PR #18; zo nodig de nieuwste run opnieuw starten).
- Containerlogs zijn weg na een update (container opnieuw aangemaakt); daarom de uurlijkse AI-trader-regel. Diagnose stille AI-trader: Trainer → "Wordt hij beter?" → "Waarom koopt de AI-trader (niet)?" (alleen in geheugen, begint na herstart opnieuw).

## Specific next steps

1. Bijwerken (alleen na merge, eigenaar doet het zelf):
   - VPS: `docker compose pull vetobot-trainer && docker compose up -d vetobot-trainer` (alleen als `trainer/` veranderde)
   - Thuisserver: `cd /opt/media-stack && docker compose pull vetobot && docker compose up -d vetobot`
2. Live volgen: `docker logs -t --since 2h vetobot 2>&1 | grep "AI-trader afgelopen"`; AI-chat "ik gebruik recept …, dat deze coin wel handelt" = PR #14 werkt. Bij de eerstvolgende aankoop: Posities → Live-veiligheid "actief bij Bitvavo".
3. Niet-gefixte vondsten uit de bugcontrole (alleen op verzoek, elk eigen PR): limiet-verkoop als `createOrder` zelf een time-out geeft (dan market van alles); maker-fee niet ingecalculeerd bij limiet-koop met bijna het hele saldo; `#fillOf` met lege `average`/`price` geeft NaN-fee; `#agentExit` geeft `true` bij BUSY; `posMaxPct` in training neemt instapcandle mee (bot niet); `config.json` lezen-aanpassen-schrijven zonder lock; procesbrede foutmeldingen gaan naar alle gebruikers; `uncleanRestart` blijft voor het hele proces gezet; `manager.stop` wacht niet op een lopende tick.
4. Resterende risico's uit de audit, alleen op verzoek, elk als eigen PR:
   - verkoop met verloren antwoord pas zichtbaar bij de volgende saldocontrole (orders opzoeken);
   - correlatie binnen één eindtest: trade-rendementen met tijd bewaren, dan clusteren per dag of block-bootstrap;
   - proefperiode zakt ook bij een goed model in ±11–19% (overwegen: 0,95 of vergelijken met 0);
   - na de afkoeling een nieuwe eindtestperiode eisen voordat een gezakt recept terug mag;
   - `add_agent_trades`: NaN/inf niet opslaan en dubbele feedback ontdubbelen;
   - `agent_extra`: echte trades ook op recept filteren;
   - `#settleJournal`: slippage twee keer rekenen (labels 0,1 pp te optimistisch);
   - `cleanup_files` onder `publish_lock`; terugzetten atomair over bestanden heen.
5. Bekende, bewuste eigenschappen (geen bug): in live kost een aankoop inzet + fee; de Risk Agent halveert de inzet zonder plan per marktfase (nooit onder € 5); met de kleinste live-start (€ 5) geen stop bij Bitvavo (onder het minimum).
