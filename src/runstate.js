import fs from 'node:fs';
import path from 'node:path';

// Is vetobot de vorige keer netjes gestopt? Bij de start wordt run-state.json gelezen: staat daar
// clean: false, dan stopte het proces onverwacht (crash, stroom weg, geforceerde herstart).
// Daarna schrijft hij een nieuwe stand (clean: false) en houdt hij elke minuut 'lastAlive' bij;
// bij een nette stop (SIGTERM/SIGINT) wordt clean: true.
export function openRunState(dir, { now = () => new Date() } = {}) {
  const file = path.join(dir, 'run-state.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { previous = null; }
  const unclean = previous && previous.clean === false
    ? { previousStartedAt: previous.startedAt ?? null, lastAlive: previous.lastAlive ?? null }
    : null;
  const state = { startedAt: now().toISOString(), lastAlive: now().toISOString(), clean: false, pid: process.pid };
  const write = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* geen schijf: dan alleen geen melding bij een herstart */ }
  };
  write();
  return {
    unclean,
    alive() { state.lastAlive = now().toISOString(); write(); },
    clean() { state.clean = true; write(); },
  };
}
