#!/data/data/com.termux/files/usr/bin/bash
# De telefoon als helper van de leerserver (Termux). Starten in Termux met:
#   curl -fsSLo helper.sh https://raw.githubusercontent.com/iitssjstn/vetobot/main/scripts/telefoon-helper.sh && bash helper.sh
# De eerste keer koppelt hij met een koppelcode van 6 cijfers (dashboard: Trainer → Overzicht → Helpers →
# Helper koppelen). Het dashboard toont ook dit hele commando om te kopiëren, met ADRES= en KOPPELCODE=
# erin: dan hoef je niets te typen. De helper-code wordt alleen op de telefoon bewaard.
# Daarna: alleen 'bash helper.sh'.
# Stoppen: Ctrl+C. Andere instellingen (voor 'bash helper.sh' zetten):
#   KERNEN=1 bash helper.sh          aantal kernen (standaard 2: op de Fold4 het snelst)
#   NAAM=fold4 bash helper.sh        naam op het dashboard
#   OPNIEUW=1 bash helper.sh         opnieuw koppelen (ander adres of nieuwe code)
set -e
KERNEN="${KERNEN:-2}"
NAAM="${NAAM:-telefoon}"
OPNIEUW="${OPNIEUW:-0}"

stap() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

stap "Telefoon wakker houden"
termux-wake-lock 2>/dev/null || true

stap "Debian-omgeving controleren"
pkg install -y proot-distro >/dev/null
if proot-distro login debian -- /bin/true >/dev/null 2>&1; then
  echo "Debian staat er al."
else
  proot-distro install debian || {
    echo "Installeren lukte niet. Zit je nog in Debian in een ander Termux-venster? Typ daar 'exit',"
    echo "of typ hier 'pkill proot', en start daarna opnieuw met: bash helper.sh"
    exit 1
  }
fi

CONF="/root/.vetobot-helper"

# De eerste keer: adres en koppelcode (of uit ADRES= en KOPPELCODE=). De helper wisselt de koppelcode
# zelf in voor de helper-code en bewaart die in Debian (alleen leesbaar voor jezelf).
heeft_conf=$(proot-distro login debian -- /bin/bash -c "[ -s $CONF/url ] && [ -s $CONF/helper-token ] && echo ja || echo nee")
PAIR=""
if [ "$heeft_conf" != "ja" ] || [ "$OPNIEUW" = "1" ]; then
  stap "Eenmalig: koppelen met de leerserver"
  URL="${ADRES:-}"
  CODE="${KOPPELCODE:-}"
  if [ -z "$URL" ]; then
    echo "Het adres van je leerserver, zoals bij de bot (Instellingen → Eigen model), bijv. trainer.jouwdomein.nl"
    read -r -p "Adres: " URL </dev/tty
  fi
  if [ -z "$CODE" ]; then
    echo "Maak in het dashboard een koppelcode: Trainer → Overzicht → Helpers → Helper koppelen (6 cijfers)."
    read -r -p "Koppelcode: " CODE </dev/tty
  fi
  CODE="$(printf '%s' "$CODE" | tr -cd '0-9')"
  [ -n "$URL" ] && [ ${#CODE} -eq 6 ] || { echo "Een adres en een koppelcode van 6 cijfers zijn nodig."; exit 1; }
  printf '%s' "$URL" | proot-distro login debian -- /bin/bash -c "mkdir -p $CONF && chmod 700 $CONF && rm -f $CONF/helper-token && cat > $CONF/url"
  PAIR="$CODE"
fi

BINNEN=$(cat <<'EOF'
set -e
stap() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
export DEBIAN_FRONTEND=noninteractive
if [ ! -x /root/vt/bin/python ] || ! /root/vt/bin/python -c "import sklearn" 2>/dev/null; then
  stap "Python, numpy en scikit-learn installeren (eenmalig, 5 tot 10 minuten)"
  apt-get update -y
  apt-get install -y python3 python3-venv git
  [ -x /root/vt/bin/python ] || python3 -m venv /root/vt
  /root/vt/bin/pip install --upgrade pip >/dev/null
  /root/vt/bin/pip install "numpy==2.*" "scikit-learn==1.*"
fi
stap "Nieuwste versie van de helper ophalen"
if [ -d /root/vetobot/.git ]; then
  git -C /root/vetobot pull --ff-only || echo "Bijwerken lukte niet; ik gebruik de versie die er al is."
else
  git clone --depth 1 https://github.com/iitssjstn/vetobot.git /root/vetobot
fi
cd /root/vetobot/trainer
export TRAINER_URL="$(cat /root/.vetobot-helper/url)" DATA_DIR=/root/.vetobot-helper TRAIN_JOBS HELPER_NAME PAIR_CODE
stap "Helper '$HELPER_NAME' start met $TRAIN_JOBS kernen (stoppen: Ctrl+C)"
# Stopt hij onverwacht (bijv. geen internet), dan na 30 seconden vanzelf opnieuw.
while true; do
  set +e
  /root/vt/bin/python helper.py
  rc=$?
  set -e
  if [ "$rc" = "3" ]; then
    echo "Koppelen lukte niet. Maak een nieuwe koppelcode in het dashboard en start opnieuw met: OPNIEUW=1 bash helper.sh"
    exit 1
  fi
  PAIR_CODE=""  # alleen de eerste keer
  echo "Helper gestopt; over 30 seconden opnieuw (Ctrl+C om te stoppen)."
  sleep 30
done
EOF
)

proot-distro login debian -- /bin/bash -c "TRAIN_JOBS='$KERNEN'; HELPER_NAME='$NAAM'; PAIR_CODE='$PAIR'; $BINNEN"
termux-wake-unlock 2>/dev/null || true
