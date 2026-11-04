// AI-veto: de AI mag een koopsignaal alleen goedkeuren of afwijzen.
// Positiegrootte, stop-loss en verkopen worden nooit door de AI bepaald.

const SYSTEM_PROMPT = `Je bent een risicofilter voor een crypto trading bot.
Een regelgebaseerde strategie wil een positie openen. Jij beoordeelt alleen of dit
moment verstandig lijkt, op basis van de meegegeven data. Je bepaalt geen bedragen.
Wees kritisch: bij twijfel wijs je af.
Antwoord uitsluitend met JSON in deze vorm:
{"decision": "approve" | "reject", "reason": "korte uitleg in het Nederlands"}`;

export function buildPrompt({ pair, timeframe, indicators, recentCandles }) {
  const candles = recentCandles
    .map((c) => `${new Date(c[0]).toISOString()} O:${c[1]} H:${c[2]} L:${c[3]} C:${c[4]} V:${c[5]}`)
    .join('\n');
  return `Pair: ${pair}
Timeframe: ${timeframe}
Signaal: KOPEN (EMA-crossover omhoog)
Slotkoers: ${indicators.close}
EMA fast: ${indicators.emaFast.toFixed(4)}
EMA slow: ${indicators.emaSlow.toFixed(4)}
RSI: ${indicators.rsi.toFixed(1)}
Verandering laatste 24 candles: ${indicators.change24 == null ? 'onbekend' : indicators.change24.toFixed(2) + '%'}

Laatste candles:
${candles}`;
}

export function parseDecision(text) {
  if (!text) throw new Error('Leeg antwoord van AI');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Geen JSON in AI-antwoord');
  const obj = JSON.parse(match[0]);
  const decision = String(obj.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Ongeldige decision "${obj.decision}"`);
  return { decision, reason: String(obj.reason || '').slice(0, 500) };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function askGemini(cfg, prompt) {
  const model = cfg.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    },
    cfg.timeoutMs,
  );
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

async function askOpenAICompatible(cfg, prompt) {
  const model = cfg.model || 'llama-3.3-70b-versatile';
  const data = await fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    },
    cfg.timeoutMs,
  );
  return data?.choices?.[0]?.message?.content ?? '';
}

// Voor de testknop in het dashboard: dezelfde aanroep als een echte veto, maar
// fouten worden doorgegeven in plaats van opgevangen door de fail-mode.
export async function testConnection(cfg, context) {
  if (cfg.provider === 'none') throw new Error('Er is geen AI-provider gekozen');
  if (!cfg.apiKey) throw new Error('Er is geen AI-key ingesteld');
  const started = Date.now();
  const text = cfg.provider === 'gemini' ? await askGemini(cfg, buildPrompt(context)) : await askOpenAICompatible(cfg, buildPrompt(context));
  const ms = Date.now() - started;
  let parsed;
  try {
    parsed = parseDecision(text);
  } catch (err) {
    throw new Error(`De AI antwoordt, maar niet in het verwachte formaat (${err.message}). Antwoord: ${String(text).slice(0, 200)}`);
  }
  return { ...parsed, provider: cfg.provider, model: cfg.model || defaultModel(cfg.provider), ms };
}

export const defaultModel = (provider) => (provider === 'gemini' ? 'gemini-2.5-flash' : 'llama-3.3-70b-versatile');

// Geeft altijd { decision, reason, provider, error? } terug en gooit nooit.
export async function askVeto(cfg, context) {
  if (cfg.provider === 'none') {
    return { decision: 'approve', reason: 'Geen AI ingesteld, signaal automatisch goedgekeurd', provider: 'none' };
  }
  if (!cfg.apiKey) {
    const decision = cfg.failMode === 'approve' ? 'approve' : 'reject';
    return { decision, reason: `Geen AI-key ingesteld in het dashboard, fail-mode "${decision}"`, provider: cfg.provider, error: true };
  }
  const prompt = buildPrompt(context);
  try {
    const text = cfg.provider === 'gemini' ? await askGemini(cfg, prompt) : await askOpenAICompatible(cfg, prompt);
    return { ...parseDecision(text), provider: cfg.provider };
  } catch (err) {
    const decision = cfg.failMode === 'approve' ? 'approve' : 'reject';
    return {
      decision,
      reason: `AI-fout, fail-mode "${decision}": ${err.message}`,
      provider: cfg.provider,
      error: true,
    };
  }
}
