# Een telefoon als leerserver (Samsung Galaxy Z Fold4)

Doel: eerst **meten** hoe snel de telefoon leert, en dat vergelijken met de VPS. Pas daarna kiezen
we of de telefoon de leerserver wordt of de VPS helpt. In dit stappenplan wordt niets aan je bot
of je VPS veranderd.

Reken op ongeveer 30 tot 45 minuten. Het meten zelf duurt een paar minuten per apparaat.

---

## Deel 1: de VPS meten (5 minuten)

Om eerlijk te vergelijken stop je de leerserver even, zodat hij niet tegelijk aan het rekenen is.

```bash
docker compose stop vetobot-trainer
```

```bash
docker compose pull vetobot-trainer
```

```bash
docker run --rm --cpus 2 -e TRAIN_JOBS=2 ghcr.io/iitssjstn/vetobot-trainer:latest python bench.py --rounds 5
```

```bash
docker compose start vetobot-trainer
```

Bewaar de uitkomst (een screenshot is genoeg). Draait de shortcutter op dat moment, dan is de VPS
trager dan normaal; meet dan liever als die stil ligt.

---

## Deel 2: de telefoon klaarmaken

### 2.1 Updates en opslag
- Zet de telefoon aan de lader en installeer alle updates (Instellingen → Software-update).
- Zorg voor minstens 5 GB vrije opslag.

### 2.2 Batterij sparen bij 24/7 aan de lader
- Instellingen → **Batterij** → **Batterijbescherming** (*Battery protection*) → aan, kies
  **Maximaal** (laadt tot 80%). Zo gaat de batterij niet kapot als hij altijd aan de lader ligt.

### 2.3 Ontwikkelaarsopties
1. Instellingen → **Over de telefoon** → **Software-informatie** → tik **7 keer** op
   **Buildnummer**. Je krijgt de melding dat de ontwikkelaarsopties aan staan.
2. Instellingen → **Opties voor ontwikkelaars** (*Developer options*) → zet aan:
   **Beperkingen voor onderliggende processen uitschakelen**
   (*Disable child process restrictions*). Zonder dit stopt Android de leerserver na een tijdje.
   Staat deze optie er niet, laat het me weten; dan doen we het via een computer met een
   kabel (adb).

### 2.4 Termux installeren
Termux is een Linux-omgeving voor Android. **Niet** de versie uit de Play Store nemen (die is
verouderd).
1. Ga in de browser naar **f-droid.org**, download de F-Droid-app en installeer hem (sta
   "installeren uit onbekende bronnen" toe als daarom gevraagd wordt).
2. Zoek in F-Droid naar **Termux** en installeer het.

### 2.5 Termux mag altijd blijven draaien
- Instellingen → **Apps** → **Termux** → **Batterij** → **Onbeperkt** (*Unrestricted*).
- Instellingen → **Batterij** → **Achtergrondgebruik beperken** → **Nooit in slaapstand
  gezette apps** (*Never sleeping apps*) → voeg **Termux** toe.

---

## Deel 3: de leerserver-code op de telefoon zetten

Open **Termux** en typ de regels hieronder één voor één (na elke regel op Enter; wachten tot hij
klaar is). Hoofdletters en spaties precies overnemen.

```bash
pkg update -y && pkg upgrade -y
```

```bash
pkg install -y proot-distro
```

```bash
proot-distro install debian
```

```bash
termux-wake-lock
```

`termux-wake-lock` houdt de telefoon wakker zolang Termux draait (je ziet een melding van Termux).

```bash
proot-distro login debian
```

Je zit nu in Debian (de regel begint met `root@localhost`). Verder:

```bash
apt update && apt install -y python3 python3-venv git
```

```bash
python3 -m venv /root/vt
```

```bash
/root/vt/bin/pip install "numpy==2.*" "scikit-learn==1.*"
```

```bash
git clone --depth 1 https://github.com/iitssjstn/vetobot.git /root/vetobot
```

---

## Deel 4: de telefoon meten

Leg de telefoon **opengevouwen**, **zonder hoesje**, op een koele plek (niet in de zon), aan de
lader. Dan:

```bash
cd /root/vetobot/trainer
```

Eerst met 2 kernen, zelfde instelling als de VPS:

```bash
TRAIN_JOBS=2 /root/vt/bin/python bench.py --rounds 5
```

Daarna met 4 en met 8 kernen, om te zien wat de telefoon maximaal kan:

```bash
TRAIN_JOBS=4 /root/vt/bin/python bench.py --rounds 5
```

```bash
TRAIN_JOBS=8 /root/vt/bin/python bench.py --rounds 5
```

Stuur de uitkomsten door (screenshots). Let vooral op twee regels:
- **Gemiddeld per ronde**: lager is sneller.
- **Laatste t.o.v. eerste ronde**: wordt het meer dan 15% trager, dan wordt de telefoon warm.

Klaar met meten? Typ `exit` (je gaat terug naar Termux) en daarna `termux-wake-unlock`.

---

## Problemen

| Wat je ziet | Wat te doen |
|---|---|
| `pip install` duurt heel lang of geeft een compileerfout | Stuur de laatste regels door; dan was er geen kant-en-klare versie voor de telefoon. |
| Termux sluit of stopt halverwege | Controleer 2.3 en 2.5; open Termux opnieuw en begin bij `termux-wake-lock`. |
| `Killed` midden in een ronde | Geheugen vol: sluit andere apps, of meet met `--candles 20000`. |
| De telefoon wordt erg heet | Stoppen met Ctrl+C (in Termux: Ctrl staat boven het toetsenbord). |
