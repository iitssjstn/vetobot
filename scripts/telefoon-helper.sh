#!/data/data/com.termux/files/usr/bin/bash
# De telefoon als helper van de leerserver (Termux). Starten in Termux met:
#   curl -fsSLo helper.sh https://raw.githubusercontent.com/iitssjstn/vetobot/main/scripts/telefoon-helper.sh && bash helper.sh
# De eerste keer vraagt hij het adres van je leerserver en de helper-code (pagina Trainer → Overzicht →
# Helpers → Tonen). Die worden alleen op de telefoon bewaard. Daarna: alleen 'bash helper.sh'.
# Stoppen: Ctrl+C. Andere instellingen (voor 'bash helper.sh' zetten):
#   KERNEN=1 bash helper.sh          aantal kernen (standaard 2: op de Fold4 het snelst)
#   NAAM=fold4 bash helper.sh        naam op het dashboard
#   OPNIEUW=1 bash helper.sh         adres en code opnieuw invullen
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

# Adres en code de eerste keer vragen, in Debian bewaren (alleen leesbaar voor jezelf).
heeft_conf=$(proot-distro login debian -- /bin/bash -c "[ -s $CONF/url ] && [ -s $CONF/helper-token ] && echo ja || echo nee")
if [ "$heeft_conf" != "ja" ] || [ "$OPNIEUW" = "1" ]; then
  stap "Eenmalig: adres en helper-code"
  echo "Het adres van je leerserver, zoals bij de bot (Instellingen → Eigen model), bijv. https://trainer.jouwdomein.nl"
  read -r -p "Adres: " URL </dev/tty
  echo "De helper-code staat op de pagina Trainer → Overzicht → Helpers → Tonen (begint met h-)."
  read -r -s -p "Helper-code: " CODE </dev/tty
  echo
  [ -n "$URL" ] && [ -n "$CODE" ] || { echo "Adres en code zijn allebei nodig."; exit 1; }
  printf '%s' "$URL" | proot-distro login debian -- /bin/bash -c "mkdir -p $CONF && chmod 700 $CONF && cat > $CONF/url"
  printf '%s' "$CODE" | proot-distro login debian -- /bin/bash -c "umask 077 && cat > $CONF/helper-token"
  echo "Bewaard op de telefoon."
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
export TRAINER_URL="$(cat /root/.vetobot-helper/url)" DATA_DIR=/root/.vetobot-helper TRAIN_JOBS HELPER_NAME
stap "Helper '$HELPER_NAME' start met $TRAIN_JOBS kernen (stoppen: Ctrl+C)"
# Stopt hij onverwacht (bijv. geen internet), dan na 30 seconden vanzelf opnieuw.
while true; do
  /root/vt/bin/python helper.py || true
  echo "Helper gestopt; over 30 seconden opnieuw (Ctrl+C om te stoppen)."
  sleep 30
done
EOF
)

proot-distro login debian -- /bin/bash -c "TRAIN_JOBS='$KERNEN'; HELPER_NAME='$NAAM'; $BINNEN"
termux-wake-unlock 2>/dev/null || true
