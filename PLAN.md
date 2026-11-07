# Plan: de AI-trader betrouwbaar maken voor live

Doel van de eigenaar: een AI-trader die hij kan vertrouwen voordat hij live gaat. Eerst eerlijker meten (stap 1 t/m 3), dan strenger toelaten (stap 4), en pas daarna lang in paper testen (stap 5).

Volgorde: stap 1, 2 en 3 veranderen hoe resultaten gemeten worden. Oude rondes zijn daarna niet meer vergelijkbaar. Na stap 3 beginnen de receptstatistieken daarom opnieuw (oude rondes bewaren als archief, niet meer meetellen).

Status per stap: ☐ open · ◐ bezig · ☑ klaar.

---

## ☐ 1. Validatie en eindtest volledig van elkaar scheiden

**Nu.** De koersgeschiedenis wordt in de tijd gesplitst: 70% leren, 15% validatie (koopdrempel en coins kiezen), 15% eindtest. Toch lekt de eindtest op vier manieren:
- De recepten-zoeker en de Strategy Agent kiezen recepten op hun **eindtest**-resultaten. Na veel rondes is het beste recept deels geluk op de eindtest (veel proberen, het beste kiezen).
- Echte trades van de bot (`agent_extra`) gaan mee in het leren. Ze komen uit de laatste weken, en dat is precies de eindtest-periode.
- Er zit geen buffer tussen de delen. Een trade aan het eind van de validatie loopt door in de eindtest.
- Elke ronde schuift de periode op, dus eindtests van verschillende rondes overlappen.

**Wat we bouwen.**
- Recepten kiezen, rangschikken en de Strategy Agent alleen op de **validatie**. De eindtest dient alleen om te beoordelen of een recept goed genoeg is (ja/nee), niet om te kiezen.
- Een buffer (embargo) van de maximale duur (H candles) tussen leren, validatie en eindtest.
- Echte bot-trades alleen als leervoorbeeld gebruiken als ze vóór het begin van de validatie liggen.
- In het rapport vastleggen welke periode de eindtest was, zodat overlap zichtbaar is.

**Klaar als.** Een test bewijst dat niets uit de eindtest-periode het leren of de keuze beïnvloedt. De pagina Trainer toont de keuze op validatie apart van de eindtest.

## ☐ 2. Drawdown berekenen op basis van een echte portefeuille

**Nu.** De terugval is het opgetelde % per trade, gesorteerd op candle-nummer per coin. Dat is geen echte tijdsvolgorde tussen coins. Ook houdt het geen rekening met:
- trades die tegelijk openstaan;
- de inzet en het maximum aantal open trades;
- verlies tijdens een trade (alleen de uitkomst telt).

**Wat we bouwen.**
- Een portefeuille-simulatie in de backtest:
  - startkapitaal, inzet per trade en maximaal open trades zoals in de bot;
  - trades op echte tijd (timestamp) door elkaar;
  - geen nieuwe trade als alle plekken bezet zijn;
  - het saldo per candle gewaardeerd tegen de koers van dat moment.
- Daaruit de echte terugval in % van het vermogen, het eindresultaat in % en de langste periode onder de top.
- De 25%-grens ("te riskant") en de rangschikking winst/terugval op deze echte terugval zetten.

**Klaar als.** Unittest met een bekende reeks trades geeft de juiste terugval, ook bij overlappende trades. De pagina Trainer toont de portefeuille-terugval.

## ☐ 3. Werkelijke fees en slippage verwerken in het leerproces

**Nu.** De leerserver rekent met een vaste kostenpost (`costPct`, standaard 0,5% per ronde) voor elke coin. De bot meet sinds de Execution Agent de echte afwijking per order (`execLog`), maar die gaat niet terug naar de leerserver.

**Wat we bouwen.**
- De bot stuurt per gesloten trade de echte kosten mee: fees in EUR, de gemeten afwijking bij kopen en verkopen, limiet of market.
- De leerserver houdt per coin de werkelijke kosten bij: mediaan en een voorzichtige bovenkant over de laatste trades. Zonder genoeg metingen per coin: het gemiddelde van alle coins. Zonder enige meting: `costPct`.
- Het leren en de backtest gebruiken die kosten per coin in plaats van één vast getal.
- Dure coins vallen zo vanzelf af.

**Klaar als.** De pagina Trainer toont per coin "aangenomen kosten tegenover gemeten". Een test bewijst dat hogere gemeten kosten minder trades en een lagere verwachte winst geven.

## ☐ 4. Live-toelating strenger maken

**Nu.** Live mag na 20 echte trades (paper) met gemiddeld ≥ +0,1% per trade (`AGENT_PROVEN_MIN`, `AGENT_PROVEN_AVG`).

**Voorstel** (de getallen bepaalt de eigenaar). Live pas als **alles** klopt:
- het recept is *betrouwbaar* (na stap 1 t/m 3 gemeten);
- minstens **50 paper-trades over minstens 21 dagen**;
- gemiddeld na echte kosten ≥ +0,1% per trade, en ook de **voorzichtige ondergrens** (gemiddelde min één standaardfout) boven 0;
- **beter dan de markt** in paper (zelfde vergelijking als in de backtest);
- terugval van de paper-portefeuille hooguit 10%;
- trades in minstens **2 verschillende marktfases**;
- gemeten kosten niet meer dan 1,5 keer de aangenomen kosten;
- **de eigenaar zet live zelf aan** met een knop in het dashboard. Die knop verschijnt pas als alle eisen gehaald zijn.

**Ook daarna:**
- live start met de kleinste inzet en groeit pas na 20 winstgevende live-trades;
- valt een van de eisen weg (live of paper), dan gaat hij automatisch terug naar paper, met een melding.

**Klaar als.** Het dashboard toont per eis "gehaald / nog niet" met de stand. Tests dekken elke eis en het automatisch terugvallen.

## ☐ 5. Daarna langere paper tests uitvoeren

**Pas starten als stap 1 t/m 4 klaar zijn en de recepten opnieuw zijn begonnen.**

- Looptijd: minstens 6 weken in paper, zonder tussentijds de regels te veranderen. Verandert er toch iets, dan begint de teller opnieuw.
- Wekelijks vastleggen (in `handoff.md` of een logboek):
  - aantal trades, gemiddelde na kosten, voordeel boven de markt;
  - portefeuille-terugval, gemeten kosten, en verdeling over de marktfases;
  - pauzes van de Risk Agent.
- Goed genoeg om live te overwegen: alle eisen van stap 4 gehaald, en in ten minste 4 van de 6 weken beter dan de markt.
- Niet goed genoeg: geen nieuwe functies erbij, eerst uitzoeken waarom (welke fase, welke coins, kosten of voorspelling).

---

Afspraak: er wordt alleen gebouwd als de eigenaar het zegt. Elke stap is een eigen commit met tests, en na elke push meldt Claude de build met de update-commando's.
