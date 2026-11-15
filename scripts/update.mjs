// Radar de Investimentos: busca cotações, calcula análises, verifica o alerta do Bitcoin
// e (se configurado) envia WhatsApp pelo CallMeBot. Roda no GitHub Actions a cada 30 min.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'data.json');
const STATE = join(ROOT, 'data', 'state.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (radar-investimentos)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readJson = async (p, def) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return def; } };
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.json();
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      throw new Error(`HTTP ${r.status} em ${url}`);
    } catch (e) { if (i === tries - 1) throw e; await sleep(2000); }
  }
}

/* ---------- fontes ---------- */
async function yahoo(sym) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`);
  const r = j.chart.result[0], q = r.indicators.quote[0], m = r.meta;
  const pts = r.timestamp.map((t, i) => ({ t: t * 1000, c: q.close[i], l: q.low[i], h: q.high[i] })).filter(p => p.c != null);
  // fechamento do pregão anterior (o "chartPreviousClose" do Yahoo é o de 1 ano atrás quando range=1y)
  const ultimo = pts[pts.length - 1], horaPreco = (m.regularMarketTime || 0) * 1000;
  const mesmoDia = ultimo && new Date(ultimo.t).toISOString().slice(0, 10) === new Date(horaPreco).toISOString().slice(0, 10);
  const anterior = mesmoDia ? pts[pts.length - 2]?.c : ultimo?.c;
  return { pts, preco: m.regularMarketPrice, anterior, horaPreco, anosDias: 252 };
}
async function coingecko(id) {
  const hist = await getJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=brl&days=365&interval=daily`);
  await sleep(1500);
  const ohlc = await getJson(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=brl&days=30`);
  await sleep(1500);
  const now = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=brl,usd&include_24hr_change=true&include_last_updated_at=true`);
  const pts = hist.prices.map(([t, c]) => ({ t, c, l: c, h: c }));
  const n = now[id];
  return { pts, preco: n.brl, precoUSD: n.usd, var24h: n.brl_24h_change, horaPreco: n.last_updated_at * 1000,
    velas: ohlc.map(([t, o, h, l, c]) => ({ t, h, l, c })), anosDias: 365 };
}

/* ---------- análises ---------- */
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sma = (a, n) => a.length >= n ? mean(a.slice(-n)) : null;
function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function vol(closes, anosDias, n = 30) {
  const c = closes.slice(-(n + 1)); if (c.length < 10) return null;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i])); const m = mean(r);
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(anosDias);
}
const pct = (a, b) => (a != null && b) ? (a / b - 1) * 100 : null;
const DIA = 864e5;

function analisar(d, preco) {
  const pts = d.pts, closes = pts.map(p => p.c).concat([]);
  const agora = Date.now();
  const desde = dias => pts.filter(p => p.t >= agora - dias * DIA);
  const closeEm = dias => { const alvo = agora - dias * DIA; let best = null; for (const p of pts) if (p.t <= alvo) best = p; if (!best && pts.length && pts[0].t - alvo < 5 * DIA) best = pts[0]; return best ? best.c : null; };
  const faixa = dias => { const s = desde(dias); const lows = s.map(p => p.l ?? p.c), highs = s.map(p => p.h ?? p.c); lows.push(preco); highs.push(preco); return { min: Math.min(...lows), max: Math.max(...highs) }; };
  const f7 = faixa(7), f30 = faixa(30), f365 = faixa(366);
  if (d.velas && d.velas.length) { const vl = d.velas.map(v => v.l).concat([preco]); f30.min = Math.min(f30.min, ...vl); f30.max = Math.max(f30.max, ...d.velas.map(v => v.h)); }
  const cl = closes.slice(); cl[cl.length - 1] = preco;
  const mm20 = sma(cl, 20), mm50 = sma(cl, 50), mm200 = sma(cl, 200), r14 = rsi(cl), v = vol(cl, d.anosDias);
  const sig30 = v != null ? v * Math.sqrt(30 / 365) : null;
  const m = {
    var1d: d.var24h ?? pct(preco, d.anterior), var7d: pct(preco, closeEm(7)), var30d: pct(preco, closeEm(30)), var1a: pct(preco, closeEm(365)),
    min7: f7.min, max7: f7.max, min30: f30.min, max30: f30.max, min52: f365.min, max52: f365.max,
    posFaixa30: f30.max > f30.min ? (preco - f30.min) / (f30.max - f30.min) * 100 : null,
    mm20, mm50, mm200, rsi14: r14, vol30: v != null ? v * 100 : null, quedaTopo: pct(preco, f365.max),
    cenario30: sig30 != null ? { baixo: preco * Math.exp(-sig30), alto: preco * Math.exp(sig30), baixo95: preco * Math.exp(-2 * sig30), alto95: preco * Math.exp(2 * sig30) } : null
  };
  // sinais por regra (leitura técnica simples, não é recomendação)
  const s = [];
  if (m.posFaixa30 != null && m.posFaixa30 <= 10) s.push({ tipo: 'compra', txt: 'Perto da mínima dos últimos 30 dias' });
  if (m.posFaixa30 != null && m.posFaixa30 >= 90) s.push({ tipo: 'alerta', txt: 'Perto da máxima dos últimos 30 dias' });
  if (r14 != null && r14 < 30) s.push({ tipo: 'compra', txt: `IFR(14) em ${r14.toFixed(0)}: sobrevendido` });
  if (r14 != null && r14 > 70) s.push({ tipo: 'alerta', txt: `IFR(14) em ${r14.toFixed(0)}: sobrecomprado` });
  if (mm200) s.push(preco >= mm200 ? { tipo: 'info', txt: 'Acima da média de 200 dias: tendência longa de alta' } : { tipo: 'info', txt: 'Abaixo da média de 200 dias: tendência longa de baixa' });
  if (mm50 && mm200) s.push(mm50 >= mm200 ? { tipo: 'info', txt: 'Média de 50 dias acima da de 200' } : { tipo: 'info', txt: 'Média de 50 dias abaixo da de 200' });
  if (m.quedaTopo != null && m.quedaTopo <= -20) s.push({ tipo: 'compra', txt: `${Math.abs(m.quedaTopo).toFixed(0)}% abaixo da máxima de 12 meses` });
  const nc = s.filter(x => x.tipo === 'compra').length, na = s.filter(x => x.tipo === 'alerta').length;
  const leitura = nc >= 2 ? 'Zona de compra pela regra' : nc === 1 ? 'Atenção: um sinal de compra' : na ? 'Esticado: cuidado ao comprar' : 'Neutro';
  return { m, sinais: s, leitura };
}

/* ---------- WhatsApp (CallMeBot) ---------- */
async function whatsapp(texto) {
  const phone = process.env.CALLMEBOT_PHONE, key = process.env.CALLMEBOT_APIKEY;
  if (!phone || !key) return 'desligado';
  try {
    const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(key)}`);
    return r.ok ? 'enviado' : `falhou (HTTP ${r.status})`;
  } catch (e) { return 'falhou (' + e.message + ')'; }
}
const brl = v => 'R$ ' + v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

/* ---------- principal ---------- */
const cfg = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));
const prev = await readJson(OUT, { ativos: [] });
const state = await readJson(STATE, { ultimoAlerta: null, historico: [] });
const prevById = Object.fromEntries((prev.ativos || []).map(a => [a.id, a]));

let usdbrl = prev.usdbrl || null;
try { usdbrl = (await yahoo('USDBRL=X')).preco; } catch (e) { console.warn('dólar:', e.message); }

const ativos = [];
let btcBruto = null;
for (const a of cfg.ativos) {
  try {
    const d = a.fonte === 'coingecko' ? await coingecko(a.simbolo) : await yahoo(a.simbolo);
    if (a.fonte === 'coingecko') btcBruto = d;
    const an = analisar(d, d.preco);
    const serie = d.pts.map(p => [Math.round(p.t / 1000), +p.c.toFixed(a.moeda === 'USD' ? 2 : 2)]);
    ativos.push({ ...a, preco: d.preco, precoUSD: d.precoUSD ?? null, precoBRL: a.moeda === 'USD' && usdbrl ? d.preco * usdbrl : d.preco,
      horaPreco: d.horaPreco, serie, ...an, ok: true });
    console.log(`${a.id}: ${d.preco} (${an.leitura})`);
  } catch (e) {
    console.warn(`${a.id} falhou:`, e.message);
    if (prevById[a.id]) ativos.push({ ...prevById[a.id], ok: false, erro: 'Cotação não atualizada nesta rodada' });
  }
  await sleep(400);
}

/* ---------- alerta do Bitcoin: mínima de N dias ---------- */
const ab = cfg.alertaBitcoin; let alerta = null;
if (btcBruto) {
  const agora = Date.now(), corte = agora - 6 * 3600e3; // ignora as últimas 6h para comparar com a mínima anterior
  const velas = btcBruto.velas.filter(v => v.t >= agora - ab.diasMinima * DIA && v.t < corte);
  const diarios = btcBruto.pts.filter(p => p.t >= agora - ab.diasMinima * DIA && p.t < corte).map(p => p.c);
  const minAnterior = Math.min(...velas.map(v => v.l), ...diarios);
  const preco = btcBruto.preco;
  const u = state.ultimoAlerta;
  const rompeu = preco <= minAnterior;
  const horas = u ? (agora - u.em) / 3600e3 : Infinity;
  const deveAvisar = rompeu && (!u || preco <= u.preco * (1 - ab.novoAlertaSeCairMaisPct / 100) || horas >= ab.repetirAposHoras);
  alerta = { regra: `Bitcoin abaixo da mínima dos últimos ${ab.diasMinima} dias`, minAnterior, preco, rompeu, verificadoEm: agora };
  if (deveAvisar) {
    const texto = `🔔 *Bitcoin na mínima do mês*\nPreço agora: ${brl(preco)}\nMínima anterior (${ab.diasMinima} dias): ${brl(minAnterior)}\n\nPela sua regra (mínima de ${ab.diasMinima} dias), é um ponto de compra.\nNão é recomendação de investimento. Decida com cuidado.`;
    const envio = await whatsapp(texto);
    state.ultimoAlerta = { em: agora, preco };
    state.historico.unshift({ em: agora, preco, minAnterior, whatsapp: envio });
    state.historico = state.historico.slice(0, 60);
    console.log('ALERTA disparado; WhatsApp:', envio);
  }
}

const out = {
  atualizado: Date.now(), usdbrl,
  whatsapp: { ativo: !!(process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY) },
  regraAlerta: ab, alerta, alertas: state.historico, ativos
};
await mkdir(dirname(OUT), { recursive: true }); await mkdir(dirname(STATE), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
await writeFile(STATE, JSON.stringify(state, null, 1));
console.log(`ok: ${ativos.filter(a => a.ok).length}/${cfg.ativos.length} ativos atualizados`);
