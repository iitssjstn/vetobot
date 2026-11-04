// Harde risicoregels voor nieuwe posities. Geeft een reden terug als het niet mag, anders null.

export function checkEntry(store, config, mode, exchange) {
  const { risk } = config;
  const s = store.state;

  if (s.halted) return `Handel gepauzeerd: ${s.halted.reason}`;
  if (mode === 'live' && !(exchange?.apiKey && exchange?.secret)) {
    return 'Bitvavo-keys ontbreken, vul ze in via het dashboard';
  }

  const open = Object.keys(s.positions).length;
  if (open >= risk.maxOpenTrades) return `Maximum van ${risk.maxOpenTrades} open trades bereikt`;

  const today = store.realizedTodayEur();
  if (today <= -risk.maxDailyLossEur) return `Dagverlies ${today.toFixed(2)} EUR bereikt limiet`;

  if (mode === 'paper' && s.balanceEur < risk.stakeEur) {
    return `Paper-saldo ${s.balanceEur.toFixed(2)} EUR is lager dan de inzet`;
  }
  return null;
}
