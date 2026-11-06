// Meldingen naar Discord en een heartbeat naar een externe monitor.
//
// - Discord: via een webhook die je in het dashboard instelt (versleuteld opgeslagen).
//   Optioneel met een tag (<@jouw-user-id>), zodat je een push-melding krijgt.
// - Heartbeat: na elke check een GET naar een URL van bijvoorbeeld healthchecks.io.
//   Komt die niet meer binnen (server offline), dan stuurt díe dienst de melding.
//   Bij een check met fouten gaat de ping naar <url>/fail.
//
// Fouten bij het versturen worden gelogd maar laten de bot nooit vastlopen.

export const NOTIFY_EVENTS = {
  startup: 'Gestart of weer online na een herstart',
  trades: 'Trade geopend of gesloten',
  stoploss: 'Stop-loss geraakt',
  errors: 'Fouten bij een check (max. 1 per 30 min per soort)',
  dailyLimit: 'Dagelijkse verlieslimiet bereikt',
  mode: 'Gewisseld tussen paper en live',
  aiVeto: 'Koopsignaal afgewezen door de AI',
  aiFallback: 'Back-upmodel nam het over van de AI',
  aiFailed: 'Alle AI-modellen faalden',
  dailySummary: 'Dagelijks overzicht',
  strategy: 'Automatisch overgestapt op een nieuwe strategie (trainer)',
};

const COLORS = { info: 0x5aa9f0, ok: 0x3ccf8e, warn: 0xf0b24a, error: 0xf26d6d, live: 0xf26d6d };
const ERROR_THROTTLE_MS = 30 * 60 * 1000;

export const isDiscordWebhook = (url) =>
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(String(url ?? ''));

export class Notifier {
  constructor({ secrets, settings, log = console, fetchImpl = fetch }) {
    this.secrets = secrets;
    this.settings = settings;
    this.log = log;
    this.fetch = fetchImpl;
    this.lastErrorSent = new Map();
    this.lastHeartbeat = null;
  }

  get cfg() {
    return this.settings.notify;
  }

  // event: een sleutel uit NOTIFY_EVENTS. Geeft true terug als er iets is verstuurd.
  // cfg kan worden meegegeven om de instellingen te overschrijven (gebruikt door test()).
  async send(event, { title, message, level = 'info', fields }, cfg = this.cfg) {
    const url = this.secrets.get('discordWebhook');
    if (!url || !cfg.events[event]) return false;

    if (['errors', 'aiFallback', 'aiFailed'].includes(event)) {
      const key = `${event}:${String(message).slice(0, 80)}`;
      const last = this.lastErrorSent.get(key);
      if (last && Date.now() - last < ERROR_THROTTLE_MS) return false;
      this.lastErrorSent.set(key, Date.now());
    }

    const userId = cfg.discordUserId;
    const mention = userId && cfg.mentions[event];
    const mode = this.settings.mode;
    const body = {
      username: 'vetobot',
      content: mention ? `<@${userId}>` : '',
      allowed_mentions: { users: mention ? [userId] : [] },
      embeds: [{
        title: String(title).slice(0, 250),
        description: String(message ?? '').slice(0, 3500),
        color: COLORS[level] ?? COLORS.info,
        fields: (fields ?? []).slice(0, 10).map((f) => ({ name: String(f.name), value: String(f.value), inline: f.inline ?? true })),
        footer: { text: `vetobot · ${mode === 'live' ? 'LIVE' : 'paper'}` },
        timestamp: new Date().toISOString(),
      }],
    };
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Discord gaf HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return true;
    } catch (err) {
      this.log.error(`Discord-melding mislukt: ${err.message}`);
      if (event === 'test') throw err;
      return false;
    }
  }

  async test() {
    if (!this.secrets.get('discordWebhook')) throw new Error('Er is nog geen Discord-webhook ingesteld');
    const cfg = { ...this.cfg, events: { test: true }, mentions: { test: true } };
    await this.send('test', {
      title: 'Testmelding van vetobot',
      message: cfg.discordUserId
        ? 'Als je dit ziet en een melding kreeg, werken de Discord-meldingen met tag.'
        : 'Als je dit ziet, werken de Discord-meldingen. Vul je Discord user ID in om ook getagd te worden.',
      level: 'ok',
    }, cfg);
  }

  // ok=false stuurt naar <url>/fail, zodat de monitor ook bij fouten kan waarschuwen.
  async heartbeat(ok = true, { force = false } = {}) {
    const url = this.secrets.get('heartbeatUrl');
    if (!url) return null;
    // Bij snelle checks niet vaker dan eens per minuut pingen; een fout gaat altijd direct.
    if (ok && !force && this.lastHeartbeat?.ok && !this.lastHeartbeat.error &&
        Date.now() - new Date(this.lastHeartbeat.at).getTime() < 55000) return this.lastHeartbeat;
    const target = ok ? url : `${url.replace(/\/$/, '')}/fail`;
    try {
      const res = await this.fetch(target, { method: 'GET', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastHeartbeat = { at: new Date().toISOString(), ok, error: null };
    } catch (err) {
      this.lastHeartbeat = { at: new Date().toISOString(), ok, error: err.message };
      this.log.error(`Heartbeat mislukt: ${err.message}`);
    }
    return this.lastHeartbeat;
  }
}
