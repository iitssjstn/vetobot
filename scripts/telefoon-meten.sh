#!/data/data/com.termux/files/usr/bin/bash
# Alles in één keer op een Android-telefoon (Termux): installeren, de leerserver-code ophalen en
# meten met 2, 4 en 8 kernen. Starten in Termux met:
#   pkg install -y curl && curl -fsSLo meten.sh https://raw.githubusercontent.com/iitssjstn/vetobot/main/scripts/telefoon-meten.sh && bash meten.sh
# Opnieuw draaien mag: wat al geïnstalleerd is, wordt overgeslagen.
set -e
RONDES="${RONDES:-5}"
KERNEN="${KERNEN:-2 4 8}"

stap() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

stap "Telefoon wakker houden tijdens het meten"
termux-wake-lock 2>/dev/null || true

stap "Termux bijwerken (kan een paar minuten duren)"
apt-get update -y
apt-get -y -o Dpkg::Options::=--force-confnew -o Dpkg::Options::=--force-confdef upgrade

stap "Debian-omgeving installeren"
pkg install -y proot-distro
# Staat Debian er al (en kunnen we inloggen), dan niet opnieuw installeren. Niet afgaan op een vaste
# map: die verschilt tussen versies van proot-distro.
if proot-distro login debian -- /bin/true >/dev/null 2>&1; then
  echo "Debian staat er al."
else
  proot-distro install debian || {
    echo "Installeren lukte niet. Zit je nog in Debian in een ander Termux-venster? Typ daar 'exit',"
    echo "of typ hier 'pkill proot', en start daarna opnieuw met: bash meten.sh"
    exit 1
  }
fi

# Alles hieronder draait in Debian.
BINNEN=$(cat <<'EOF'
set -e
stap() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
export DEBIAN_FRONTEND=noninteractive
stap "Python en git installeren"
apt-get update -y
apt-get install -y python3 python3-venv git
if [ ! -x /root/vt/bin/python ]; then
  python3 -m venv /root/vt
fi
stap "numpy en scikit-learn installeren (kan 5 tot 10 minuten duren)"
/root/vt/bin/pip install --upgrade pip >/dev/null
/root/vt/bin/pip install "numpy==2.*" "scikit-learn==1.*"
stap "Leerserver-code ophalen"
if [ -d /root/vetobot/.git ]; then
  git -C /root/vetobot pull --ff-only
else
  git clone --depth 1 https://github.com/iitssjstn/vetobot.git /root/vetobot
fi
cd /root/vetobot/trainer
for k in $KERNEN; do
  stap "Meten met $k kernen ($RONDES rondes)"
  TRAIN_JOBS=$k /root/vt/bin/python bench.py --rounds "$RONDES" | tee "/root/meting-$k-kernen.txt"
done
stap "Samenvatting"
for k in $KERNEN; do
  f="/root/meting-$k-kernen.txt"
  echo "--- $k kernen ---"
  grep -E "Apparaat|Gemiddeld per ronde|Geheugen|Laatste t.o.v." "$f" || echo "(geen uitkomst; zie hierboven)"
done
echo
echo "Klaar. Maak een screenshot van deze samenvatting en stuur hem door."
EOF
)

proot-distro login debian -- /bin/bash -c "KERNEN='$KERNEN'; RONDES='$RONDES'; $BINNEN"

termux-wake-unlock 2>/dev/null || true
