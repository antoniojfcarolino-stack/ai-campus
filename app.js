/* AI Campus — interface, Gemini ou Claude direto do telemóvel, biblioteca, estudo, plano, progresso e sincronização com o Google Drive. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const { UCS, byKey, ucLabel } = Core;
  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const MAX_INLINE = 18 * 1024 * 1024;
  const MAX_DRIVE_FILE = 40 * 1024 * 1024;
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';
  const STATE_NAME = 'ai-campus-state.json';
  const MAC_NAME = 'do-mac.json';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deps = () => ({ marked: window.marked, katex: window.katex, purify: window.DOMPurify });
  const ls = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ } };
  const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const jset = (k, v) => lset(k, JSON.stringify(v));
  Core.setSemestres(jget('semestres', null)); // 🎓 as UCs do semestre ativo (por omissão, as 6 de origem)
  const semId = () => Core.semAtual();
  const activeKeys = () => new Set(UCS.map(u => u.key));
  // 🙂 Memória do aluno (o que diz de si, o que a app aprende, dificuldades e 👍/👎): fica no telemóvel e vai com o Drive e o backup.
  const alunoGet = () => Core.normAluno(jget('aluno', null));
  function alunoSet(a) { a = Core.normAluno(a); jset('aluno', a); markDirty(); return a; }
  function alunoAdd(lista, item) { const a = alunoGet(); a[lista] = [{ id: uuid(), t: Date.now(), ...item }, ...a[lista]]; return alunoSet(a); }
  function alunoDif(uc, txt) { // uma pergunta de quiz falhada ou uma carta errada (sem repetir a mesma)
    const t = String(txt || '').replace(/[$*_`#>]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!uc || t.length < 4 || alunoGet().dif.some(d => d.uc === uc && Core.normQ(d.txt) === Core.normQ(t))) return;
    alunoAdd('dif', { uc, txt: t });
  }

  const ENGINES = ['auto', 'gemini', 'claude'];
  const S = {
    key: ls('gkey', ''), model: ls('gmodel', 'gemini-flash-latest'), hist: +ls('ghist', 8),
    // Motor: 🔁 Automático (grátis, troca de motor quando um chega ao limite), ✨ Gemini ou 🟠 Claude (API da Anthropic, paga).
    // As chaves nunca entram em backups nem no Drive.
    engine: ENGINES.includes(ls('gengine', 'auto')) ? ls('gengine', 'auto') : 'auto', ckey: ls('ckey', ''), cmodel: ls('cmodel', Core.CLAUDE_MODEL),
    okey: ls('okey', ''), tkey: ls('tkey', ''), akey: ls('akey', ''), skey: ls('skey', ''),   // OpenRouter, Tavily, OpenAlex, Stack Exchange
    chain: Core.normChain(jget('chain', null)), chainDraft: [], cstate: Core.chainPrune(jget('cstate', null), Date.now()),
    effort: ['low', 'medium', 'high'].includes(ls('geffort', 'medium')) ? ls('geffort', 'medium') : 'medium', cdrop: { opt: false, search: false, code: false, tools: false },
    proxy: ls('gproxy', ''), token: ls('gtoken', ''), ocrAuto: ls('gocr', '1') === '1',
    // 💾 cache local, ✔︎ verificação das contas por um segundo motor grátis, 🧠 ordem dos motores grátis ajustada pelos números
    cacheOn: ls('gcache', '1') === '1', verifyOn: ls('gverify', '1') === '1', adaptOn: ls('gadapt', '1') === '1',
    stats: Core.statPrune(jget('stats', {}), Date.now()), diag: false,
    embModel: null, embShape: undefined,
    chat: null, chats: [], pinned: new Map(), images: [], busy: false, abort: null, idx: new Map(),
    drive: { clientId: ls('gclient', ''), on: ls('gdrive', '0') === '1', token: '', exp: 0, folder: ls('gfolder', ''), paths: {}, busy: false, timer: 0, last: +ls('glast', 0), pending: false },
  };
  const D = S.drive;

  // ------------------------------------------------------------ utilidades
  let toastT;
  function toast(msg, ms = 3500, multi = false) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false; t.classList.toggle('multi', multi);
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
  }
  const fmtSize = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'conversa';
  const nearBottom = () => { const m = $('#msgs'); return m.scrollHeight - m.scrollTop - m.clientHeight < 140; };
  const toBottom = () => { const m = $('#msgs'); m.scrollTop = m.scrollHeight; };
  const isClaude = () => S.engine === 'claude';
  const isAuto = () => S.engine === 'auto';
  const engineName = () => (isClaude() ? 'Claude' : isAuto() ? 'motor 🔁 Automático (grátis)' : 'Gemini');
  const provKey = p => ({ gemini: S.key, openrouter: S.okey }[p] || '');
  // O que falta para a app poder usar um fornecedor da cadeia ('' = nada). Mistral, Groq e Cloudflare só pelo proxy (sem CORS).
  function availWhy(p) {
    if (p === 'gemini') return S.key || S.proxy ? '' : 'sem chave Gemini';
    const P = Core.PROVIDERS[p];
    if ((P.cors && provKey(p)) || S.proxy) return '';
    return P.cors ? 'sem chave (ou proxy)' : 'precisa do proxy (ver proxy/README.md)';
  }
  // dá para gerar respostas com o motor ativo
  const haveGen = () => (isClaude() ? !!(S.proxy || S.ckey) : isAuto() ? S.chain.some(l => !l.off && !availWhy(l.p)) : !!(S.proxy || S.key));
  const haveEmb = () => !!(S.key || (S.proxy && !isClaude()));           // a pesquisa por significado só existe no Gemini
  const saveCState = () => jset('cstate', S.cstate);
  // há pelo menos um motor grátis utilizável (a verificação das contas usa sempre um motor grátis, mesmo com o Claude)
  const haveFree = () => S.chain.some(l => !l.off && !availWhy(l.p));
  // ordem dos motores grátis para os pedidos: a escolhida nas Definições, ajustada pelos números se o 🧠 estiver ligado
  const effChain = () => (S.adaptOn ? Core.adaptiveOrder(S.chain, S.stats).order : S.chain);

  // ---- estatísticas dos motores (ficam só neste telemóvel; o diagnóstico não conta)
  function statRec(key, ok, ms = 0, err = '') {
    if (S.diag) return;
    S.stats = Core.statAdd(S.stats, { key, ok, ms, err }); jset('stats', S.stats);
  }
  // ---- cache local (IndexedDB): respostas, fontes externas, escolha da UC e vetor da pergunta
  async function cacheGet(k) {
    if (!S.cacheOn) return undefined;
    try { const e = await DB.get('cache', k); return Core.cacheFresh(e) ? e.v : undefined; } catch (e) { return undefined; }
  }
  function cachePut(k, kind, v) { if (S.cacheOn) DB.put('cache', { k, kind, t: Date.now(), v }).catch(() => { /* cache cheia ou indisponível: segue sem ela */ }); }
  async function cachePruneAll() {
    try { const del = Core.cachePrune(await DB.all('cache')); if (del.length) await DB.delMany('cache', del); } catch (e) { /* ignora */ }
  }
  const libBump = () => lset('libv', String(+ls('libv', '0') + 1)); // a biblioteca mudou: as respostas guardadas deixam de servir
  const engineKey = () => (isAuto() ? 'auto' : isClaude() ? `claude:${S.cmodel}` : `gemini:${S.model}`);
  function statLabel(key) {
    const i = key.indexOf(':'), p = key.slice(0, i), m = key.slice(i + 1);
    if (Core.PROVIDERS[p]) return Core.linkLabel({ p, m });
    return p === 'claude' ? `🟠 Claude · ${m}` : key;
  }
  const NEED_FREE = 'Para o motor 🔁 Automático (grátis) basta a chave Gemini (grátis). Em 🔁 Motores grátis podes juntar o OpenRouter e, com o proxy, o Mistral, o Groq e o Cloudflare.';
  const needKeyText = () => (isClaude() ? 'Falta a chave da API Anthropic (sk-ant-…). Cola-a aqui para usar o Claude, ou muda o motor na barra lateral.' : isAuto() ? NEED_FREE : 'Falta a chave Gemini (grátis). Cola-a aqui para começar.');
  const webKey = () => (isClaude() ? 'cweb' : 'web'); // no Claude a pesquisa web é paga: tem o seu próprio interruptor (desligado por omissão)
  const rich = t => Core.renderRich(String(t ?? ''), deps());
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const blobToB64 = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1]); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
  const tombAdd = (kind, id) => { const t = jget('tomb', {}); t[`${kind}:${id}`] = Date.now(); jset('tomb', t); };
  const getPlan = () => Core.normPlan(jget('plan', null));
  const fmtDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
  const setPlan = p => { jset('plan', p); markDirty(); };
  function logAct(kind, uc, ok = 0, total = 0) {
    const l = jget('actlog', []); l.push({ id: uuid(), t: Date.now(), uc, kind, ok, total });
    jset('actlog', l.slice(-1000)); markDirty();
  }
  function download(name, type, data) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function refreshDue() {
    const keys = activeKeys(), due = (await DB.all('cards')).filter(c => c.due <= Date.now() && keys.has(c.uc)).length;
    $('#studyBtn').textContent = `🃏 Estudar${due ? ` (${due})` : ''}`;
    return due;
  }

  // ------------------------------------------------------------ Gemini
  function errText(status, m, model) {
    if (S.proxy && status === 401) return 'Token do proxy errado. Verifica em ⚙️ Definições.';
    if (S.proxy && status === 403) return 'O proxy recusou o pedido (origem não permitida ou rota bloqueada).';
    if (status === 400 && /API key/i.test(m)) return 'Chave Gemini inválida. Verifica em ⚙️ Definições.';
    if (status === 403) return 'Acesso negado (chave sem permissão, restrita a outro endereço, ou região sem acesso).';
    if (status === 404) return `Modelo "${model}" não encontrado. Troca o modelo em ⚙️ Definições (ex.: gemini-flash-latest).`;
    if (status === 429) return 'Limite do plano gratuito atingido. Espera um minuto, usa um modelo mais leve (ex.: gemini-3.1-flash-lite) ou o motor 🔁 Automático (grátis), que troca de motor sozinho.';
    if (/em falta no worker/.test(m)) return m;
    return `Erro ${status}: ${m || 'falha na ligação ao Gemini'}`;
  }
  // Cabeçalhos de limite que interessam à cadeia (o x-ratelimit-reset do OpenRouter é uma data em milissegundos).
  const limitHeaders = r => ({ retryAfter: r.headers.get('retry-after'), reset: (v => (/^\d{12,}$/.test(v || '') ? +v : 0))(r.headers.get('x-ratelimit-reset')) });
  // Erro HTTP com tudo o que a cadeia precisa para decidir (estado, corpo, cabeçalhos de limite, direto ou pelo proxy).
  async function httpError(r, text, via) {
    const raw = await r.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* sem corpo JSON */ }
    const m = Core.errMessageOf(j) || raw.slice(0, 300);
    return Object.assign(new Error(text(r.status, m)), { status: r.status, body: j, raw: m, headers: limitHeaders(r), via });
  }
  const errInfo = e => ({ status: e.status ?? 0, message: e.raw || e.message, body: e.body, headers: e.headers, via: e.via });

  const authHeaders = () => (S.proxy ? { 'x-app-token': S.token } : { 'x-goog-api-key': S.key });

  async function fetchGemini(method, body, signal, model = S.model, key = S.key, retries = 1) {
    const via = S.proxy ? 'proxy' : 'direct';
    for (let t = 0; ; t++) {
      let r;
      try {
        r = await fetch(`${S.proxy || API}/models/${model}:${method}`, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', ...(S.proxy ? { 'x-app-token': S.token } : { 'x-goog-api-key': key }) },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw Object.assign(new Error(`Sem ligação ao Gemini${S.proxy ? ' (ou ao proxy)' : ''}. Verifica a internet.`), { status: 0, via });
      }
      if (r.ok) return r;
      if ((r.status === 429 || r.status === 503) && t < retries) { await sleep(3000 * (t + 1)); continue; }
      throw await httpError(r, (s, m) => errText(s, m, model), via);
    }
  }

  async function genText(body, signal) {
    const j = await (await fetchGemini('generateContent', body, signal)).json();
    if (j.promptFeedback?.blockReason) throw new Error('Pedido bloqueado pelo Gemini: ' + j.promptFeedback.blockReason);
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  }

  function* sseEvents(block) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const j = line.slice(5).trim();
      if (j && j !== '[DONE]') { try { yield JSON.parse(j); } catch (e) { /* bloco incompleto */ } }
    }
  }

  // Um motor que fica calado demasiado tempo (sem enviar nada) não prende a app: ao fim de 2 minutos desiste com um erro
  // (no 🔁 Automático passa ao motor seguinte).
  const SSE_IDLE_MS = 120000, POS_CODIGO_MS = 20000;
  async function* sse(r, espera = () => SSE_IDLE_MS) {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      let timer;
      const ms = espera();
      const parado = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`O motor deixou de responder (${Math.round(ms / 1000)} s sem enviar nada). Tenta outra vez.`), { status: 504, idle: true })), ms); });
      let res;
      try { res = await Promise.race([reader.read(), parado]); } catch (e) { reader.cancel().catch(() => {}); throw e; } finally { clearTimeout(timer); }
      const { done, value } = res;
      buf = (buf + dec.decode(value || new Uint8Array(), { stream: !done })).replace(/\r\n/g, '\n'); // \r\n pode vir partido entre dois pedaços
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); yield* sseEvents(block); }
      if (done) break;
    }
    if (buf.trim()) yield* sseEvents(buf); // último evento sem linha em branco no fim
  }

  async function callGemini(body, onUpdate, signal, { model = S.model, retries = 1 } = {}) {
    const out = { text: '', calcs: [], sources: [], searchHtml: '' };
    let finish = '', block = '';
    const r = await fetchGemini('streamGenerateContent?alt=sse', body, signal, model, S.key, retries);
    // Depois de correr o código, o Gemini às vezes fica calado (ou acaba sem escrever nada): se em 20 s não vier texto,
    // a app desiste deste pedido e fica com os cálculos; quem chamou pede a explicação à parte (askUC).
    let espera = SSE_IDLE_MS;
    try {
      for await (const ch of sse(r, () => espera)) {
        if (ch.promptFeedback?.blockReason) block = ch.promptFeedback.blockReason;
        const cand = ch.candidates?.[0];
        if (!cand) continue;
        for (const p of cand.content?.parts || []) {
          const ec = p.executableCode || p.executable_code, cr = p.codeExecutionResult || p.code_execution_result;
          if (ec) { out.calcs.push({ code: ec.code }); espera = SSE_IDLE_MS; }
          else if (cr) { const last = out.calcs[out.calcs.length - 1]; if (last) last.output = cr.output; else out.calcs.push({ output: cr.output }); espera = POS_CODIGO_MS; }
          else if (typeof p.text === 'string' && !p.thought) { out.text += p.text; if (p.text.trim()) espera = SSE_IDLE_MS; }
        }
        const gm = cand.groundingMetadata;
        if (gm) {
          (gm.groundingChunks || []).forEach(c => { if (c.web && /^https?:/.test(c.web.uri) && !out.sources.some(s => s.uri === c.web.uri)) out.sources.push(c.web); });
          if (gm.searchEntryPoint?.renderedContent) out.searchHtml = gm.searchEntryPoint.renderedContent;
        }
        if (cand.finishReason) finish = cand.finishReason;
        onUpdate && onUpdate(out);
      }
    } catch (e) {
      if (!(e.idle && out.calcs.length && !out.text.trim())) throw e;
      out.text = ''; // (calou-se depois do cálculo: segue só com os cálculos)
    }
    if (!out.text && !out.calcs.length) throw new Error(block ? 'Pedido bloqueado pelo Gemini: ' + block : `Resposta vazia (${finish || 'sem motivo'}). Tenta reformular.`);
    if (finish === 'MAX_TOKENS') out.text += '\n\n*(resposta cortada por limite de tamanho — pede "continua")*';
    return out;
  }

  // ------------------------------------------------------------ Claude (API da Anthropic)
  // Mesmo contrato do Gemini: devolve { text, calcs, sources, searchHtml }. O corpo e o streaming vivem em Core.claude* (testados em Node).
  const CLAUDE_EXTRAS = {
    opt: 'o Claude não aceitou o ajuste de raciocínio/esforço: continuo sem ele',
    search: 'a pesquisa web não está disponível na tua conta Anthropic (um administrador pode tê-la desligado): continuo sem ela',
    code: 'a execução de código não está disponível na tua conta Anthropic: continuo sem ela (os cálculos ficam por conta do modelo)',
    tools: 'o Claude não aceitou as ferramentas de cálculo/pesquisa: continuo sem elas',
  };
  const noCdrop = () => ({ opt: false, search: false, code: false, tools: false });
  // O que a conta recusou uma vez fica de fora dos pedidos seguintes (até guardares as Definições outra vez).
  const dropClaudeExtras = body => Core.claudeDrop(body, S.cdrop);

  async function fetchClaude(body, signal, { key = S.ckey, noFallback = false, retries = 1 } = {}) {
    const url = Core.claudeUrl(S.proxy);
    const headers = S.proxy ? { 'Content-Type': 'application/json', 'x-app-token': S.token }
      : { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': Core.CLAUDE_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
    let cur = noFallback ? body : dropClaudeExtras(body), stripped = false, retry = 0;
    for (;;) {
      let r;
      try { r = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(cur) }); } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error('Sem ligação ao Claude (internet, bloqueio do browser ou do proxy). Em ⚙️ Definições → 🩺 Diagnóstico vês o motivo.');
      }
      if (r.ok) return r;
      let j = null;
      try { j = await r.json(); } catch (e) { /* sem corpo JSON */ }
      if (r.status === 400 && !stripped && !noFallback) { // opção extra recusada (raciocínio, esforço, ferramentas): tenta uma vez sem ela
        const alt = Core.claudeStrip(cur, j && j.error && j.error.message);
        if (alt) { stripped = true; cur = alt.body; alt.what.forEach(w => { S.cdrop[w] = true; toast(CLAUDE_EXTRAS[w], 7000); }); continue; }
      }
      if (Core.claudeRetryable(r.status) && retry < retries) { retry++; await sleep(Math.min(20, +r.headers.get('retry-after') || 3 * retry) * 1000); continue; }
      const e = new Error(Core.claudeErrorText(r.status, j, { proxy: !!S.proxy, model: cur.model })); e.status = r.status; throw e;
    }
  }

  async function callClaude(req, onUpdate, signal, opts = {}) {
    let body = Core.claudeBody({ ...req, model: S.cmodel, effort: S.effort });
    let st = Core.claudeNewStream();
    for (let round = 0; ; round++) {
      const r = await fetchClaude(body, signal, opts);
      for await (const ev of sse(r)) { Core.claudeFeed(st, ev); onUpdate && onUpdate(st.out); }
      if (st.stop !== 'pause_turn' || round >= 3) break; // pause_turn: a pesquisa/cálculo continua num novo pedido, com o turno do assistente devolvido inalterado
      body = Core.claudeContinue(body, Core.claudeAssistantBlocks(st));
      st = Core.claudeNewStream(st);
    }
    const out = Core.claudeFinish(st);
    if (!out.text.trim() && !out.calcs.length) throw new Error(`Resposta vazia (${st.stop || 'sem motivo'}). Tenta reformular.`);
    return out;
  }

  // ------------------------------------------------------------ motores grátis no formato OpenAI (Mistral, Groq, OpenRouter, Cloudflare)
  // Corpo, streaming e erros vivem em Core.oa* e Core.classifyError (testados em Node). O Python corre no telemóvel (py-worker.js).
  async function fetchOA(l, body, signal) {
    const P = Core.PROVIDERS[l.p], routes = [];
    if (P.cors && provKey(l.p)) routes.push('direct');
    if (S.proxy) routes.push('proxy');
    if (!routes.length) throw Object.assign(new Error(availWhy(l.p) || 'precisa do proxy'), { status: -1 });
    for (const via of routes) {
      const headers = via === 'proxy' ? { 'Content-Type': 'application/json', 'x-app-token': S.token }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${provKey(l.p)}`, ...(l.p === 'openrouter' ? { 'HTTP-Referer': location.origin, 'X-Title': 'AI Campus' } : {}) };
      let r;
      try { r = await fetch(Core.oaUrl(l.p, via === 'proxy' ? S.proxy : ''), { method: 'POST', headers, signal, body: JSON.stringify(body) }); } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (via === 'direct' && routes.includes('proxy')) continue; // bloqueado diretamente (CORS?): tenta pelo proxy
        throw Object.assign(new Error(`Sem ligação ao ${P.nome}${via === 'proxy' ? ' através do proxy' : ''}.`), { status: 0, via });
      }
      if (r.ok) return r;
      throw await httpError(r, (s, m) => `${P.nome}: erro ${s}${m ? ' — ' + m : ''}`, via);
    }
  }

  async function callOA(l, req, onUpdate, signal) {
    let body = Core.oaBody(req, l, { fast: !!req.fast }), st = Core.oaNewStream(), stripped = false;
    for (let round = 0; ; round++) {
      let r;
      try { r = await fetchOA(l, body, signal); } catch (e) {
        if (e.name === 'AbortError' || stripped) throw e;
        const c = Core.classifyError(l.p, errInfo(e), Date.now()); // recusou ferramentas/parâmetros: tenta uma vez sem eles
        if (c.kind !== 'feature' || c.what.includes('images')) throw e;
        stripped = true; body = Core.oaStrip(body, c.what); round--; continue;
      }
      if (/json/.test(r.headers.get('content-type') || '')) { Core.oaFeed(st, await r.json()); onUpdate && onUpdate(st.out); }
      else for await (const ev of sse(r)) { Core.oaFeed(st, ev); onUpdate && onUpdate(st.out); }
      const calls = Core.oaCalls(st, l);
      if (!calls.length || round >= 5) break;
      body = { ...body, messages: [...body.messages, Core.oaAssistantTurn(calls)] };
      for (const c of calls) {
        const calc = { code: c.code || c.args };
        st.out.calcs.push(calc); st.out.status = '🐍 A calcular no telemóvel…'; onUpdate && onUpdate(st.out);
        calc.output = c.name === 'python' && c.code.trim()
          ? await pyRun(c.code, signal, s => { st.out.status = s; onUpdate && onUpdate(st.out); })
          : `ERRO: a ferramenta "${c.name}" não existe (só há "python").`;
        body.messages.push(Core.oaToolResult(l, c, calc.output));
      }
      st = Core.oaNewStream(st);
    }
    return Core.oaFinish(st);
  }

  // Um elo da cadeia. O Gemini faz o cálculo no servidor dele; os outros chamam a ferramenta python (no telemóvel).
  async function runLink(l, req, onUpdate, signal) {
    if (l.p !== 'gemini') return callOA(l, req, onUpdate, signal);
    const body = Core.buildBody({ ...req, tool: Core.geminiTool(req.tool) });
    try { return await callGemini(body, onUpdate, signal, { model: l.m, retries: 0 }); } catch (e) {
      if (e.name === 'AbortError' || !body.tools) throw e;
      const c = Core.classifyError('gemini', errInfo(e), Date.now());
      if (c.kind !== 'feature' || !c.what.includes('tools')) throw e;
      delete body.tools; // este modelo não executa código: responde sem a ferramenta
      return callGemini(body, onUpdate, signal, { model: l.m, retries: 0 });
    }
  }

  // 🔁 Automático: tenta os motores por ordem; um limite atingido ou um motor em baixo passa ao seguinte sem perder a pergunta,
  // e fica registado (até repor) para os próximos pedidos não perderem tempo com ele.
  // `avoid`: o motor que deu a resposta que se está a verificar (fica de fora).
  async function callAuto(req, onUpdate, signal, { avoid = null } = {}) {
    const chain = effChain();
    const plan = parts => Core.planChain(chain, { needs: Core.partNeeds(parts), fast: !!req.fast, avail: availWhy, state: S.cstate, now: Date.now(), avoid });
    S.cstate = Core.chainPrune(S.cstate, Date.now());
    let parts = req.parts;
    const notes = [], tried = [];
    for (let pass = 0; pass < 2; pass++) {
      const p = plan(parts);
      for (const l of p.run) {
        const blocked = Core.linkBlocked(S.cstate, l, Date.now()); // ex.: o outro modelo do mesmo fornecedor acabou de recusar a chave
        if (blocked) { tried.push({ l, why: blocked }); continue; }
        const t0 = Date.now();
        try {
          const out = await runLink(l, { ...req, parts }, onUpdate, signal);
          statRec(Core.linkKey(l), true, Date.now() - t0);
          if (notes.length) out.text += `\n\n*(${notes.join('; ')})*`;
          return Object.assign(out, { by: l, tried });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          const c = Core.classifyError(l.p, errInfo(e), Date.now());
          statRec(Core.linkKey(l), false, 0, c.kind);
          Core.chainMark(S.cstate, l, c); saveCState();
          tried.push({ l, why: c.kind === 'limit' ? `esgotado ${Core.untilText(c.until, Date.now())}` : c.why });
          onUpdate && onUpdate({ text: '', calcs: [], sources: [], searchHtml: '', status: `↪️ ${Core.linkLabel(l)}: ${tried[tried.length - 1].why}. A tentar o seguinte…` });
        }
      }
      // Ninguém que vê o vídeo (ou lê o PDF sem texto) respondeu ou está disponível: os outros respondem sem esse ficheiro, com aviso.
      if (pass === 0 && p.skipped.some(s => s.soft)) {
        const n = Core.partNeeds(parts);
        parts = parts.filter(x => !(x.file_data || x.fileData || /^video\//.test((x.inline_data || {}).mime_type || '') || ((x.inline_data || {}).mime_type === 'application/pdf' && !x.alt)));
        if (n.video) notes.push('o vídeo ficou de fora: só o Gemini vê vídeos e não está disponível agora');
        if (n.pdf) notes.push('o PDF fixado ficou de fora: só o Gemini o lê (não tem texto extraído) e não está disponível agora');
        continue;
      }
      const why = new Map(p.skipped.filter(s => !s.soft).map(s => [Core.linkKey(s.l), s]));
      tried.forEach(t => why.set(Core.linkKey(t.l), t)); // cada motor uma vez, com o motivo mais recente, pela ordem da cadeia
      const pos = l => chain.findIndex(x => Core.linkKey(x) === Core.linkKey(l));
      throw new Error(Core.chainEmptyText([...why.values()].sort((a, b) => pos(a.l) - pos(b.l))));
    }
  }

  // Pedido neutro { system, history, parts, tool, temperature, json, maxHistory, fast } para o motor ativo (o Claude ignora temperature).
  // No Gemini, a pesquisa web vem das fontes externas da app (a do Google não existe no plano grátis).
  const geminiBody = req => Core.buildBody({ ...req, tool: Core.geminiTool(req.tool) });
  // Gemini ou Claude escolhidos à mão: cada pedido também conta para as estatísticas (o Automático conta motor a motor).
  async function timed(fn) {
    const key = isClaude() ? `claude:${S.cmodel}` : `gemini:${S.model}`, t0 = Date.now();
    try { const r = await fn(); statRec(key, true, Date.now() - t0); return r; } catch (e) {
      if (e.name !== 'AbortError') statRec(key, false, 0, Core.classifyError(isClaude() ? 'claude' : 'gemini', errInfo(e), Date.now()).kind);
      throw e;
    }
  }
  const aiStream = (req, onUpdate, signal, opts) => (isAuto() ? callAuto(req, onUpdate, signal)
    : timed(() => (isClaude() ? callClaude(req, onUpdate, signal, opts) : callGemini(geminiBody(req), onUpdate, signal))));
  const aiText = async (req, signal, opts) => (isAuto() ? (await callAuto(req, null, signal)).text
    : timed(async () => (isClaude() ? (await callClaude(req, null, signal, opts)).text : genText(geminiBody(req), signal))));

  // ------------------------------------------------------------ Python no telemóvel (Pyodide num worker à parte)
  // Carrega da primeira vez (~20 MB, depois fica guardado); cada execução tem um limite de tempo e o worker é parado se passar.
  const PY_BOOT_MS = 180000, PY_RUN_MS = +ls('pyms', 30000);
  let pyW = null, pySeq = 0, pyReady = false;
  const pyWait = new Map();
  // Pára o worker; os cálculos que estavam à espera recebem o motivo (nunca ficam pendurados).
  function pyKill(why = 'o Python foi reiniciado (outro cálculo passou do tempo); tenta outra vez') {
    if (pyW) pyW.terminate();
    pyW = null; pyReady = false;
    const ws = [...pyWait.values()]; pyWait.clear();
    ws.forEach(w => w({ ok: false, out: why }));
  }
  function pyWorker() {
    if (pyW) return pyW;
    pyW = new Worker('py-worker.js', { type: 'module' });
    pyW.onmessage = ({ data }) => { const w = pyWait.get(data.id); if (w) w(data); };
    pyW.onerror = e => pyKill(`o Python não arrancou (${e.message || 'erro no worker'})`);
    return pyW;
  }
  function pyRun(code, signal, onStatus) {
    return new Promise(resolve => {
      const id = ++pySeq;
      let timer = 0;
      const end = txt => { clearTimeout(timer); pyWait.delete(id); signal && signal.removeEventListener('abort', onAbort); resolve(txt); };
      const arm = (ms, txt) => { clearTimeout(timer); timer = setTimeout(() => { pyWait.delete(id); pyKill(); end(txt); }, ms); };
      const onAbort = () => { pyWait.delete(id); pyKill(); end('(interrompido)'); };
      pyWait.set(id, d => {
        if (d.phase === 'run') { pyReady = true; onStatus && onStatus('🐍 A calcular no telemóvel…'); arm(PY_RUN_MS, `ERRO: o código demorou mais de ${Math.round(PY_RUN_MS / 1000)} s e foi parado.`); return; }
        end(d.ok ? d.out : `ERRO:\n${d.out}`);
      });
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      if (!pyReady && onStatus) onStatus('🐍 A preparar o Python no telemóvel (só da primeira vez, ~20 MB)…');
      arm(PY_BOOT_MS, 'ERRO: o Python não carregou a tempo (na primeira vez precisa de internet).');
      pyWorker().postMessage({ id, code });
    });
  }

  // ------------------------------------------------------------ embeddings (pesquisa por significado)
  // O Gemini primeiro; com o proxy, o Workers AI (bge-m3) é a reserva quando o Gemini não tem modelo de embeddings ou falha.
  // Cada excerto guarda o modelo que o calculou (embM): a pergunta usa sempre o mesmo modelo que os excertos.
  const CF_EMB = '@cf/baai/bge-m3';
  const isCfEmb = m => /^@cf\//.test(m || '');
  async function embModel() {
    if (S.embModel !== null) return S.embModel;
    if (!haveEmb()) return '';
    try {
      const r = await fetch(`${S.proxy || API}/models?pageSize=200`, { headers: authHeaders() });
      if (!r.ok) return S.proxy ? (S.embModel = CF_EMB) : ''; // sem proxy não guarda a falha: tenta outra vez mais tarde
      const ms = ((await r.json()).models || []).filter(x => /embed/i.test((x.supportedGenerationMethods || []).join(' ')) || /embedding/i.test(x.name || ''));
      const m = ms.find(x => /gemini-embedding/i.test(x.name)) || ms[0];
      return (S.embModel = m ? m.name.replace('models/', '') : (S.proxy ? CF_EMB : ''));
    } catch (e) { return S.proxy ? CF_EMB : ''; }
  }

  async function cfEmbed(texts) {
    const r = await fetch(Core.proxyBase(S.proxy) + '/workersai/v1/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-token': S.token },
      body: JSON.stringify({ model: CF_EMB, input: texts.map(t => String(t).slice(0, 6000)) }),
    });
    if (!r.ok) throw Object.assign(new Error('embeddings do Workers AI: erro ' + r.status), { status: r.status });
    const d = ((await r.json()).data || []).sort((a, b) => a.index - b.index);
    if (d.length !== texts.length || !d.every(e => Array.isArray(e.embedding) && e.embedding.length)) throw Object.assign(new Error('embeddings incompletos'), { status: 0 });
    return d.map(e => Float32Array.from(e.embedding));
  }

  async function geminiEmbed(m, part, taskType) {
    const dim = /gemini-embedding/i.test(m) ? 768 : 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const shape = S.embShape ?? 0;
      try {
        let es;
        if (S.embOne) { // o modelo não aceita pedidos em lote: um a um
          es = [];
          for (const t of part) es.push((await (await fetchGemini('embedContent', Core.embedRequest(m, t, taskType, shape, dim), undefined, m, S.key, 0)).json()).embedding || {});
        } else es = (await (await fetchGemini('batchEmbedContents', { requests: part.map(t => Core.embedRequest(m, t, taskType, shape, dim)) }, undefined, m, S.key, 0)).json()).embeddings || [];
        if (es.length !== part.length || !es.every(e => e.values)) throw Object.assign(new Error('embeddings incompletos'), { status: 0 });
        S.embShape = shape;
        return es.map(e => Float32Array.from(e.values));
      } catch (e) {
        if (e.status === 400 && shape < 2) { S.embShape = shape + 1; continue; } // formato seguinte (campos antigos, depois sem opções)
        if (e.status === 404 && !S.embOne) { S.embOne = true; continue; }
        if (e.status === 429 && attempt < 3) { await sleep(20000); continue; }
        throw e;
      }
    }
    throw new Error('embeddings do Gemini indisponíveis');
  }

  // Devolve os vetores que conseguiu calcular (pode ser menos que os textos se o limite de quota apertar); o array traz
  // em .model o modelo que os calculou. `want` força um modelo (o dos excertos, para a pergunta bater com eles).
  async function embedTexts(texts, taskType, onProgress, want) {
    let m = want || await embModel();
    const out = []; out.model = m;
    if (!m) return out;
    for (let i = 0; i < texts.length; i += 50) {
      const part = texts.slice(i, i + 50);
      let got = null;
      try { got = isCfEmb(m) ? await cfEmbed(part) : await geminiEmbed(m, part, taskType); } catch (e) {
        // O Gemini falhou: com o proxy passa ao Workers AI (só se ainda não há vetores deste pedido e o modelo não foi imposto).
        if (!isCfEmb(m) && S.proxy && !want && !out.length) {
          try { got = await cfEmbed(part); m = out.model = S.embModel = CF_EMB; } catch (e2) { /* nenhum disponível */ }
        }
      }
      if (!got) return out;
      out.push(...got);
      onProgress && onProgress(out.length, texts.length);
    }
    return out;
  }

  async function embedChunks(chunks, onProgress) {
    if (!chunks.length || !haveEmb()) return 0;
    const v = await embedTexts(chunks.map(c => c.text), 'RETRIEVAL_DOCUMENT', onProgress).catch(() => []);
    v.forEach((e, i) => { chunks[i].emb = e; chunks[i].embM = v.model; });
    return v.length;
  }

  // Calcula os embeddings que faltam, por blocos: o progresso grava-se e a pesquisa melhora aos poucos.
  // Só corre uma vez de cada vez; se entrarem excertos novos entretanto, dá mais uma volta.
  let embRun = null, embAgain = false;
  function embedMissing(onProgress) {
    if (embRun) { embAgain = true; return embRun; }
    embRun = (async () => {
      let total = 0, done = 0, failed = false;
      do {
        embAgain = false;
        const todo = (await DB.all('chunks')).filter(c => !c.emb);
        total += todo.length;
        for (let i = 0; i < todo.length && !failed; i += 100) {
          const blk = todo.slice(i, i + 100), n = await embedChunks(blk);
          if (n) {
            const live = new Set((await DB.all('files')).map(f => f.id)); // ficheiro apagado entretanto: não ressuscitar os excertos
            await DB.putMany('chunks', blk.slice(0, n).filter(c => live.has(c.fileId)));
            S.idx.clear();
          }
          done += n; onProgress && onProgress(done, total);
          if (n < blk.length) failed = true;
        }
      } while (embAgain && !failed);
      return { todo: total, done };
    })().finally(() => { embRun = null; });
    return embRun;
  }

  // ------------------------------------------------------------ biblioteca / pesquisa híbrida
  async function getIndex(uc) {
    if (!S.idx.has(uc)) S.idx.set(uc, Core.buildIndex(await DB.byIndex('chunks', 'uc', uc)));
    return S.idx.get(uc);
  }

  // BM25 (palavras) + embeddings (significado), fundidos por RRF. Sem embeddings fica só BM25.
  async function hybrid(uc, q, k = 5) {
    const idx = await getIndex(uc);
    if (!idx.N) return [];
    const bm = Core.search(idx, q, 8), chunks = idx.docs.map(d => d.c);
    if (chunks.some(c => c.emb)) {
      // A pergunta usa o modelo da maioria dos excertos (Gemini ou Workers AI; os antigos, sem embM, são do Gemini):
      // vetores de modelos diferentes não se comparam.
      const grupo = c => (isCfEmb(c.embM) ? c.embM : 'gemini'), conta = new Map();
      chunks.forEach(c => { if (c.emb) conta.set(grupo(c), (conta.get(grupo(c)) || 0) + 1); });
      const g = [...conta].sort((a, b) => b[1] - a[1])[0][0];
      const ativo = await embModel();
      const m = g !== 'gemini' ? g : (chunks.find(c => c.emb && c.embM && !isCfEmb(c.embM))?.embM || (isCfEmb(ativo) ? '' : ativo));
      if (m) {
        const ek = 'e:' + Core.hashKey(m, Core.normQ(q)); // o vetor de uma pergunta repetida vem da cache
        let qv = await cacheGet(ek);
        if (!Array.isArray(qv)) {
          const v = await embedTexts([q], 'RETRIEVAL_QUERY', null, m);
          qv = v.length && v.model === m ? Array.from(v[0]) : null;
          if (qv) cachePut(ek, 'emb', qv);
        }
        if (qv) return Core.fuse([bm, Core.semSearch(chunks.filter(c => c.emb && grupo(c) === g), qv, 8)], k);
      }
    }
    return bm.slice(0, k);
  }

  async function retrieve(uc, text) {
    const prev = S.chat.messages.filter(m => m.role === 'user').slice(-2, -1)[0]?.content || ''; // pergunta anterior dá contexto a follow-ups curtos
    return hybrid(uc, text.length < 40 && prev ? `${prev} ${text}` : text, 5);
  }

  async function indexPdf(file, rec) {
    if (!window.pdfjsLib) { rec.noIndex = true; return []; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    rec.pages = pdf.numPages;
    const chunks = [], empty = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      const text = tc.items.map(it => it.str).join(' ');
      if (text.trim().length < 30) empty.push(i);
      rec.chars += text.length;
      Core.chunkText(text).forEach(t => chunks.push({ id: uuid(), fileId: rec.id, uc: rec.uc, name: rec.name, page: i, n: chunks.length, text: t }));
      if (i % 10 === 0) toast(`A ler ${rec.name}… ${i}/${pdf.numPages}`, 1500);
    }
    // O OCR automático (ligado por omissão) é do Gemini, que tem quota grátis; o Claude gasta saldo, por isso pergunta sempre.
    if (empty.length && haveGen() && ((S.ocrAuto && !isClaude()) || confirm(`${empty.length} página(s) sem texto (digitalizadas). Fazer OCR com o ${engineName()}? (gasta ${isClaude() ? 'saldo da API: cada página é uma imagem enviada ao Claude' : 'quota'})`))) {
      await ocrPages(pdf, empty, rec, chunks);
    }
    return chunks;
  }

  async function ocrPages(pdf, pages, rec, chunks) {
    for (let i = 0; i < pages.length; i += 3) {
      const grp = pages.slice(i, i + 3);
      toast(`OCR ${Math.min(i + 3, pages.length)}/${pages.length}…`, 5000);
      const parts = [{ text: `Transcreve fielmente o texto (fórmulas em LaTeX) de cada imagem. Antes de cada uma escreve ===N=== com N, pela ordem: ${grp.join(', ')}.` }];
      for (const n of grp) {
        const pg = await pdf.getPage(n), vp = pg.getViewport({ scale: 1.5 }), cv = document.createElement('canvas');
        cv.width = vp.width; cv.height = vp.height;
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.8).split(',')[1] } });
      }
      try { ocrInto(await aiText({ system: 'És um OCR rigoroso.', parts, temperature: 0, fast: true }), rec, chunks); } catch (e) { toast('OCR interrompido: ' + e.message, 6000); return; }
    }
  }
  // Resposta do OCR («===N===» antes de cada página) -> excertos pesquisáveis, com a página.
  function ocrInto(raw, rec, chunks) {
    raw.split(/===\s*(\d+)\s*===/).forEach((seg, k, arr) => {
      if (k % 2 !== 1) return;
      const t = arr[k + 1] || ''; rec.chars += t.length;
      Core.chunkText(t).forEach(x => chunks.push({ id: uuid(), fileId: rec.id, uc: rec.uc, name: rec.name, page: +seg, n: chunks.length, text: x }));
    });
  }
  // Imagem na biblioteca (quadro, apontamentos à mão, diapositivo, esquema): o texto, ou a descrição de um diagrama, fica pesquisável.
  async function ocrImage(b64, rec) {
    toast(`OCR de ${rec.name}…`, 5000);
    const chunks = [];
    try {
      const raw = await aiText({ system: 'És um OCR rigoroso.', temperature: 0, fast: true, parts: [
        { text: 'Transcreve fielmente o texto (fórmulas em LaTeX) de cada imagem; se for um diagrama, esquema ou quadro, descreve-o em 2 a 4 frases com os nomes e valores que aparecem. Antes de cada uma escreve ===N=== com N, pela ordem: 1.' },
        { inline_data: { mime_type: 'image/jpeg', data: b64 } }] });
      ocrInto(raw, rec, chunks);
    } catch (e) { toast('OCR da imagem interrompido: ' + e.message, 6000); }
    return chunks;
  }

  async function addFiles(files) {
    const uc = $('#libUc').value;
    if (!uc) return toast('Este semestre ainda não tem UCs: acrescenta-as em 🎓 (barra lateral).', 6000);
    const tipo = $('#libTipo').value, tema = Core.cleanTema($('#libTema').value); // (o tema fica escrito: os ficheiros seguintes vão para o mesmo)
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase(), kind = Core.kindOf(f.name, f.type);
      const rec = { id: uuid(), uc, name: f.name, size: f.size, added: Date.now(), upd: Date.now(), kind: kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'doc',
        blob: f, pages: 0, chars: 0, tipo: Core.TIPOS[tipo] ? tipo : Core.tipoAuto(kind), ...(tema ? { tema } : {}) };
      let chunks = [];
      try {
        if (ext === 'pdf') {
          toast(`A ler ${f.name}…`, 8000);
          chunks = await indexPdf(f, rec);
          if (rec.noIndex) toast('Leitor de PDF indisponível (offline?). Guardei o ficheiro; usa 📌 para o enviar inteiro.', 6000);
          else if (!chunks.length) toast(`PDF sem texto legível. Ativa o OCR automático nas definições ou usa 📌 para o enviar inteiro ao ${engineName()}.`, 7000);
        } else if (Core.isOffice(f.name)) { // PowerPoint / Word: o texto de cada diapositivo / página fica pesquisável
          toast(`A ler ${f.name}…`, 8000);
          const pgs = await Core.officePages(await f.arrayBuffer(), f.name);
          rec.pages = pgs.length;
          pgs.forEach((t, i) => { rec.chars += t.length; Core.chunkText(t).forEach(x => chunks.push({ id: uuid(), fileId: rec.id, uc, name: f.name, page: i + 1, n: chunks.length, text: x })); });
          if (!chunks.length) toast(`${f.name}: não encontrei texto (só imagens?). Exporta-o para PDF e usa o OCR, ou 📌 para o enviar.`, 7000);
        } else if (kind === 'video') {
          if (f.size > MAX_INLINE) toast('Vídeo grande: só dá para enviar até ~15 MB. Para aulas longas, cola o link do YouTube na pergunta.', 7000);
        } else if (kind === 'image') { // guardada mais leve (até 2000 px) e lida por OCR, como as páginas digitalizadas
          const im = await compressImage(f, 2000);
          rec.blob = im.blob; rec.size = im.blob.size; rec.pages = 1;
          if (!/\.jpe?g$/i.test(rec.name)) rec.name = rec.name.replace(/\.[^.]*$/, '') + '.jpg'; // (agora é um JPEG: o nome diz a verdade no Drive e no Mac)
          if (haveGen() && ((S.ocrAuto && !isClaude()) || confirm(`Ler o texto de «${f.name}» com o ${engineName()} (OCR), para ficar pesquisável? (gasta ${isClaude() ? 'saldo da API' : 'quota'})`))) chunks = await ocrImage(im.url.split(',')[1], rec);
          if (!chunks.length) toast(`${f.name}: imagem guardada, mas sem texto pesquisável. Usa 📌 para a enviar com a pergunta.`, 7000);
        } else {
          const t = await f.text(); rec.chars = t.length; rec.pages = 1;
          Core.chunkText(t).forEach(x => chunks.push({ id: uuid(), fileId: rec.id, uc, name: f.name, page: 1, n: chunks.length, text: x }));
        }
        await DB.put('files', rec);
        if (chunks.length) await DB.putMany('chunks', chunks);
        S.idx.delete(uc); libBump(); renderFiles();
        toast(`✅ ${f.name} guardado${chunks.length ? ' e pesquisável' : ''}.`);
        markDirty();
        if (chunks.length && haveEmb()) { // o significado indexa-se em segundo plano; a pesquisa por palavras já funciona
          embedMissing((d, t) => toast(`🧠 A indexar por significado… ${d}/${t}`, 2500)).then(r => {
            if (r.todo && r.done < r.todo) toast(`Indexação por significado parcial (${r.done}/${r.todo}). Em ⚙️ Definições, toca em 🧠 para continuar.`, 8000);
          }).catch(() => {});
        }
      } catch (e) { toast(`Erro em ${f.name}: ${e.message}`, 6000); }
    }
    renderFiles();
  }

  // A biblioteca da UC: agrupada por tipo (teoria, exercícios, vídeos, imagens), com o tema (semana, capítulo…) e um filtro.
  async function renderFiles() {
    const uc = $('#libUc').value;
    const all = uc ? await DB.byIndex('files', 'uc', uc) : [];
    const temas = Core.temasOf(all), fsel = $('#libFiltro'), antes = fsel.value || 'all';
    fsel.innerHTML = '<option value="all">Todos os ficheiros</option>' +
      Object.entries(Core.TIPOS).filter(([k]) => all.some(f => Core.fileTipo(f) === k)).map(([k, l]) => `<option value="t:${k}">${l}</option>`).join('') +
      temas.map(t => `<option value="m:${Core.esc(t)}">🏷️ ${Core.esc(t)}</option>`).join('');
    fsel.value = [...fsel.options].some(o => o.value === antes) ? antes : 'all';
    fsel.hidden = all.length < 2;
    $('#temaList').innerHTML = temas.map(t => `<option value="${Core.esc(t)}">`).join('');
    const v = fsel.value;
    const files = Core.sortFiles(all.filter(f => v === 'all' || (v.startsWith('t:') ? Core.fileTipo(f) === v.slice(2) : Core.cleanTema(f.tema) === v.slice(2))));
    const box = $('#fileList'); box.innerHTML = '';
    if (!files.length) { box.innerHTML = `<p class="hint">${uc ? 'Sem material nesta UC.' : 'Este semestre ainda não tem UCs (🎓).'}</p>`; return; }
    let grupo = '', tema = '';
    const titulo = (cls, txt) => { const h = document.createElement('div'); h.className = cls; h.textContent = txt; box.appendChild(h); };
    for (const f of files) { // por tipo e, dentro de cada tipo, por tema (os sem tema primeiro)
      const g = Core.fileTipo(f), t = Core.cleanTema(f.tema);
      if (g !== grupo) { grupo = g; tema = ''; titulo('fgrp', Core.TIPOS[g]); }
      if (t && t !== tema) titulo('ftema', `🏷️ ${t}`);
      tema = t;
      const d = document.createElement('div');
      d.className = 'item' + (S.pinned.has(f.id) ? ' pinned' : '');
      const where = f.from === 'mac' ? ' <small class="mac" title="veio do Mac (pelo Drive)">💻</small>' : f.driveId ? ' <small title="no Drive">☁️</small>' : '';
      d.innerHTML = `<span>${f.kind === 'video' ? '🎬' : f.kind === 'image' ? '🖼️' : '📄'}</span><span class="t"><span class="nm" title="${Core.esc(f.name)}">${Core.esc(f.name)}</span><small class="meta">${fmtSize(f.size)}${where}</small></span>` +
        '<button title="Tipo e tema" aria-label="editar">✏️</button><button title="Enviar ficheiro inteiro" aria-label="fixar">📌</button><button title="Apagar" aria-label="apagar">🗑️</button>';
      const [edit, pin, del] = d.querySelectorAll('button');
      edit.onclick = e => { e.stopPropagation(); if (f.from === 'mac') toast('Este ficheiro veio do Mac: muda-o de pasta lá (materias/<UC>/<tipo>/<tema>/) e o telemóvel acompanha.', 7000); else openFileEdit(f); };
      pin.onclick = async e => {
        e.stopPropagation();
        if (S.pinned.has(f.id)) { S.pinned.delete(f.id); renderFiles(); renderChips(); return; }
        let rec = f;
        if (!rec.blob) { // ficheiro que veio de outro dispositivo: vai buscá-lo ao Drive
          if (!rec.driveId) return toast('Este ficheiro veio de um backup sem o conteúdo original. Volta a carregá-lo.');
          try { toast('A descarregar do Drive…'); rec = { ...f, blob: await driveGet(f.driveId, true) }; await DB.put('files', rec); } catch (err) { return toast(err.message === 'NEEDS_AUTH' ? 'Toca em ☁️ para entrar no Google e depois tenta outra vez.' : err.message, 6000); }
        }
        S.pinned.set(f.id, rec); renderFiles(); renderChips();
      };
      del.onclick = async e => {
        e.stopPropagation();
        if (!confirm(`Apagar "${f.name}"?`)) return;
        await DB.del('files', f.id); await DB.delByIndex('chunks', 'fileId', f.id);
        tombAdd('file', f.id);
        if (D.on && tokenOk()) { if (f.driveId) driveDelete(f.driveId); if (f.idxId) driveDelete(f.idxId); }
        S.pinned.delete(f.id); S.idx.delete(f.uc); libBump(); renderFiles(); renderChips(); markDirty();
      };
      box.appendChild(d);
    }
  }

  function renderChips() {
    const c = $('#chips'); c.innerHTML = '';
    S.pinned.forEach((f, id) => {
      const e = document.createElement('span'); e.className = 'chip';
      e.innerHTML = `📌 ${Core.esc(f.name.slice(0, 28))} <button aria-label="remover">✕</button>`;
      e.querySelector('button').onclick = () => { S.pinned.delete(id); renderFiles(); renderChips(); };
      c.appendChild(e);
    });
    S.images.forEach((im, i) => {
      const e = document.createElement('span'); e.className = 'chip';
      e.innerHTML = `<img src="${im.url}" alt=""> <button aria-label="remover">✕</button>`;
      e.querySelector('button').onclick = () => { S.images.splice(i, 1); renderChips(); };
      c.appendChild(e);
    });
  }

  async function compressImage(file, max = 1600) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error('o Chrome não consegue abrir esta imagem (formato HEIC?): converte-a para JPG ou PNG'); }
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return { url: cv.toDataURL('image/jpeg', 0.85), blob: await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85)) };
  }

  // ✏️ tipo e tema de um ficheiro (no Drive, e depois no Mac, passa para a pasta nova na sincronização seguinte)
  let fileEdit = null;
  function openFileEdit(f) {
    fileEdit = f.id;
    $('#fdNome').textContent = f.name;
    $('#fdTipo').innerHTML = Object.entries(Core.TIPOS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    $('#fdTipo').value = Core.fileTipo(f); $('#fdTema').value = Core.cleanTema(f.tema);
    $('#fileDlg').showModal();
  }
  async function saveFileEdit() {
    const f = fileEdit && await DB.get('files', fileEdit);
    if (!f) { $('#fileDlg').close(); return; }
    const tipo = $('#fdTipo').value, tema = Core.cleanTema($('#fdTema').value);
    if (Core.fileTipo(f) !== tipo || Core.cleanTema(f.tema) !== tema) {
      const novo = { ...f, tipo, upd: Date.now(), ...(f.driveId ? { mover: true } : {}) };
      if (tema) novo.tema = tema; else delete novo.tema;
      await DB.put('files', novo);
      if (S.pinned.has(f.id)) S.pinned.set(f.id, novo);
      markDirty();
    }
    $('#fileDlg').close(); renderFiles();
  }

  // ------------------------------------------------------------ conversas
  async function loadChats() {
    S.chats = (await DB.all('chats')).sort((a, b) => b.updated - a.updated);
    renderChatList();
  }
  function renderChatList() {
    const box = $('#chatList'); box.innerHTML = '';
    const doSemestre = S.chats.filter(c => Core.semOf(c) === semId()); // só as conversas deste semestre
    if (!doSemestre.length) box.innerHTML = '<p class="hint">Ainda sem conversas.</p>';
    doSemestre.forEach(c => {
      const d = document.createElement('div'); d.className = 'item' + (S.chat && S.chat.id === c.id ? ' on' : '');
      d.innerHTML = `<span class="t">${Core.esc(c.title)}</span><button aria-label="apagar">✕</button>`;
      d.onclick = () => { openChat(c); closeSide(); };
      d.querySelector('button').onclick = async e => {
        e.stopPropagation();
        if (!confirm('Apagar esta conversa?')) return;
        await DB.del('chats', c.id); tombAdd('chat', c.id);
        if (S.chat && S.chat.id === c.id) newChat();
        loadChats(); markDirty();
      };
      box.appendChild(d);
    });
  }
  function newChat() { S.chat = { id: uuid(), title: 'Nova conversa', messages: [], updated: Date.now(), sem: semId() }; paintChat(); renderChatList(); }
  function openChat(c) { S.chat = c; paintChat(); renderChatList(); }
  async function saveChat() {
    const c = S.chat; if (!c.messages.length) return;
    if (c.title === 'Nova conversa') {
      const t = (c.messages[0].content || 'Conversa').replace(/\s+/g, ' ').trim();
      c.title = t.length > 42 ? t.slice(0, 42).replace(/\s+\S*$/, '') + '…' : t; // corta numa palavra inteira
    }
    c.updated = Date.now();
    await DB.put('chats', c);
    if (!S.chats.some(x => x.id === c.id)) S.chats.unshift(c);
    S.chats.sort((a, b) => b.updated - a.updated);
    renderChatList(); $('#title').textContent = c.title; markDirty();
  }

  // ------------------------------------------------------------ mensagens
  const SRC_ICON = { wiki: '📖', so: '💬', paper: '🎓', web: '🌐' };
  function paintAssistant(el, m, live) {
    const by = m.by?.length ? ` · <span class="by" role="button" tabindex="0" title="${Core.esc([...m.by, ...(m.tried || []).map(t => '↪️ ' + t)].join('\n'))}">🔁 ${Core.esc(m.by.map(b => b.replace(/^\S+\s/, '').split(' · ')[0]).join(', '))}${m.tried?.length ? ' ↪️' : ''}</span>` : '';
    const cached = m.cached ? ` · <span class="cached" title="Resposta guardada no telemóvel: não gastou nenhum pedido. 🔄 pede uma nova.">💾 guardada ${Core.esc(new Date(m.cached).toLocaleDateString('pt-PT', { day: 'numeric', month: 'numeric' }))}</span>` : '';
    const tags = m.ucs?.length ? `<div class="tags">${m.ucs.map(k => Core.esc(ucLabel(k))).join(' · ')}${m.web ? ' · 🌐 web' : ''}${m.engine === 'claude' ? ' · 🟠 Claude' : ''}${by}${cached}</div>` : '';
    const calcs = (m.calcs || []).map(c => `<details class="calc"><summary>🧮 Cálculo executado</summary>${c.code ? `<pre><code>${Core.esc(c.code)}</code></pre>` : ''}${c.output ? `<pre><code>${Core.esc(c.output)}</code></pre>` : ''}</details>`).join('');
    const safe = (m.sources || []).filter(s => /^https?:\/\//i.test(s.uri || ''));
    const src = safe.length ? `<div class="sources">Fontes: ${safe.map(s => `<a href="${Core.esc(s.uri)}" target="_blank" rel="noopener">${SRC_ICON[s.kind] ? SRC_ICON[s.kind] + ' ' : ''}${Core.esc(s.title || 'link')}</a>`).join(' · ')}</div>` : '';
    const sugg = m.searchHtml ? `<iframe class="sugg" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${Core.esc('<base target="_blank">' + m.searchHtml)}"></iframe>` : '';
    const fb = !String(m.content || '').startsWith('*(interrompido)') ? `<button data-act="up" class="fb${m.fb === 'up' ? ' on' : ''}" title="Gostei: as próximas respostas vão neste tom" aria-label="gostei">👍</button><button data-act="down" class="fb${m.fb === 'down' ? ' on' : ''}" title="Não gostei" aria-label="não gostei">👎</button>` : '';
    const why = m.fb === 'down' && !m.fbWhy ? `<div class="fbwhy">O que falhou? ${['longa', 'curta', 'confusa', 'artificial', 'errada'].map(t => `<button data-why="${t}">${Core.FB_TIPOS[t]}</button>`).join('')}</div>` : '';
    const acts = !live && m.content && !m.error ? `<div class="acts">${fb}<button data-act="copy">📋</button><button data-act="md">⬇️ .md</button><button data-act="pdf">🖨️ PDF</button>${m.cached ? '<button data-act="redo" title="Pedir uma resposta nova (sem a cache)">🔄 Nova resposta</button>' : ''}</div>${why}` : '';
    el.innerHTML = tags + `<div class="md${live ? ' cursor' : ''}">${rich(m.content || m.status || '…')}</div>` + calcs + verifyHtml(m.verify) + src + sugg + acts;
  }
  // O resultado da verificação das contas (feita por um segundo motor grátis).
  function verifyHtml(v) {
    if (!v) return '';
    const by = v.by ? ` (${Core.esc(v.by)})` : '';
    if (v.v === 'run') return '<div class="verify run">🔎 A confirmar as contas noutro motor…</div>';
    if (v.v === 'ok') return `<div class="verify ok">✔︎ Contas confirmadas por outro motor${by}</div>`;
    if (v.v === 'erro') return `<div class="verify bad"><b>⚠️ Outro motor${by} encontrou um possível erro nas contas:</b><div class="md">${rich(v.notes || '')}</div></div>`;
    if (v.v === 'incerto') return `<div class="verify unk">❔ A confirmação das contas${by} não foi conclusiva: revê os resultados.</div>`;
    if (v.v === 'falhou') return `<div class="verify unk">❔ Não consegui confirmar as contas agora (${Core.esc(v.notes || 'nenhum motor grátis disponível')}).</div>`;
    return ''; // 'nada': a resposta não tinha resultados para confirmar
  }

  function addMsgEl(m, live = false) {
    const el = document.createElement('div'); el.className = `msg ${m.role}`; el.dataset.i = S.chat.messages.indexOf(m);
    if (m.role === 'user') {
      (m.imgs || []).forEach(u => { const i = document.createElement('img'); i.src = u; i.className = 'att'; el.appendChild(i); });
      const t = document.createElement('div'); t.style.whiteSpace = 'pre-wrap'; t.textContent = m.content; el.appendChild(t);
    } else paintAssistant(el, m, live);
    $('#msgs').appendChild(el);
    return el;
  }


  async function todaySummary(el) {
    const due = await refreshDue();
    const today = Core.dayKey(Date.now());
    const keys = activeKeys(), ex = jget('exams', []).filter(x => x.data >= today && keys.has(x.uc)).sort((a, b) => a.data.localeCompare(b.data))[0], t = [];
    if (due) t.push(`🔁 ${due} cartas para rever`);
    if (ex) {
      const days = Math.round((new Date(ex.data + 'T00:00:00') - new Date(today + 'T00:00:00')) / 864e5);
      t.push(`📝 ${ex.nome} (${byKey[ex.uc]?.nome || ''}) ${days === 0 ? 'é hoje' : `em ${days} dia${days === 1 ? '' : 's'}`}`);
    }
    const todo = getPlan().items.filter(p => p.data === today && !p.feito && Core.semOf(p) === semId()).length;
    if (todo) t.push(`📅 ${todo} tarefa${todo === 1 ? '' : 's'} do plano hoje`);
    if (t.length && el.isConnected) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = t.join(' · '); el.appendChild(p); }
  }

  function paintChat() {
    const box = $('#msgs'); box.innerHTML = '';
    $('#title').textContent = S.chat.title;
    if (!S.chat.messages.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.innerHTML = `<h2>🎓 Olá! Em que posso ajudar?</h2><p>${UCS.length} agente${UCS.length === 1 ? '' : 's'} especialista${UCS.length === 1 ? '' : 's'}, com os teus apontamentos como fonte. Carrega PDFs em 📚 Biblioteca, tira foto a exercícios (📷) ou cola links de aulas do YouTube.</p>` +
        (UCS.length ? '' : '<p><b>Este semestre ainda não tem UCs:</b> toca em 🎓 (barra lateral) para as acrescentar.</p>') + '<div class="grid"></div>';
      UCS.slice(0, 8).map(u => [u.emoji, u.ex]).forEach(([ic, t]) => {
        const b = document.createElement('button'); b.textContent = `${ic} ${t}`;
        b.onclick = () => { $('#input').value = t; $('#input').focus(); };
        e.querySelector('.grid').appendChild(b);
      });
      box.appendChild(e); todaySummary(e);
    } else S.chat.messages.forEach(m => addMsgEl(m));
    toBottom();
  }

  function exportMsg(act, m) {
    if (act === 'copy') { navigator.clipboard.writeText(m.content).then(() => toast('Copiado.'), () => toast('Não consegui copiar.')); return; }
    if (act === 'md') return download(`${m.fname || 'resposta'}.md`, 'text/markdown', m.content);
    const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0';
    f.srcdoc = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css"><style>body{font:14px/1.5 system-ui;margin:24px}pre{background:#f3f3f7;padding:8px;white-space:pre-wrap}</style>${rich(m.content)}`;
    f.onload = () => setTimeout(() => { try { f.contentWindow.print(); } catch (e) { toast('Não consegui abrir a impressão.'); } setTimeout(() => f.remove(), 60000); }, 600);
    document.body.appendChild(f);
  }

  // 🔄 numa resposta guardada: pede uma nova (a guardada é substituída). Se for a última da conversa, sai e dá lugar à nova.
  function redo(i) {
    if (S.busy) return;
    const u = S.chat.messages[i - 1];
    if (!u || u.role !== 'user') return;
    if (i === S.chat.messages.length - 1) { S.chat.messages.splice(i - 1, 2); paintChat(); }
    $('#input').value = u.content;
    send({ fresh: true });
  }

  function exportChat() {
    if (!S.chat.messages.length) return toast('A conversa está vazia.');
    download(`${slug(S.chat.title)}.md`, 'text/markdown', Core.chatToMarkdown(S.chat));
  }

  // ------------------------------------------------------------ envio
  async function route(text, hist, signal) {
    const quick = Core.routeConfident(text); // pergunta clara: poupa um pedido à IA
    if (quick) return [quick];
    const rk = 'r:' + Core.hashKey(Core.normQ(text), Core.cleanHistory(hist, 2).map(m => Core.normQ(m.content).slice(0, 200)));
    const saved = await cacheGet(rk); // a mesma dúvida já foi encaminhada: não gasta outro pedido
    if (Array.isArray(saved) && saved.length && saved.every(Core.isActive)) return saved;
    try {
      const raw = await aiText({ system: 'És um router de pedidos de estudo.', parts: [{ text: Core.routerPrompt(text, hist) }], temperature: 0, json: true, fast: true }, signal);
      const j = Core.parseJSON(raw), ucs = Core.parseRoute(raw, text);
      if (j && Array.isArray(j.ucs) && j.ucs.some(Core.isActive)) cachePut(rk, 'route', ucs); // só a escolha da IA (não a das palavras-chave)
      return ucs;
    } catch (e) { if (e.name === 'AbortError') throw e; return Core.routeFallback(text); }
  }

  // ------------------------------------------------------------ fontes externas (complemento aos apontamentos)
  // Wikipédia (PT, senão EN), Stack Overflow (PT e EN), OpenAlex (artigos) e a web (Tavily: com chave ou no modo grátis sem conta).
  // Cada fonte tem 7 s; a que falhar fica de fora sem estragar a resposta.
  async function getJSON(url, signal, opts = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000), stop = () => ctl.abort();
    signal && signal.addEventListener('abort', stop);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      return await r.json();
    } finally { clearTimeout(timer); signal && signal.removeEventListener('abort', stop); }
  }
  // A mesma pergunta em várias UCs não repete pedidos (memória); com a 💾 cache ligada, também não os repete durante 7 dias.
  const extCache = new Map();
  function cachedExt(k, f) {
    k = Core.normQ(k); // «RGPD consentimento» e «rgpd Consentimento» são a mesma pesquisa
    if (!extCache.has(k)) {
      const xk = 'x:' + Core.hashKey(k);
      extCache.set(k, (async () => {
        const saved = await cacheGet(xk);
        if (Array.isArray(saved)) return saved;
        const r = await f();
        if (Array.isArray(r) && r.length) cachePut(xk, 'ext', r); // resultados vazios não se guardam (podem ser uma falha passageira)
        return r;
      })().catch(e => { extCache.delete(k); throw e; }));
      if (extCache.size > 60) extCache.delete(extCache.keys().next().value);
    }
    return extCache.get(k);
  }
  async function extWiki(q, signal) {
    for (const lang of ['pt', 'en']) {
      const r = Core.parseWiki(await getJSON(Core.wikiUrl(lang, q), signal, { headers: { 'Api-User-Agent': 'AI-Campus/1.0 (app de estudo)' } }), lang);
      if (r.length) return r.slice(0, 2);
    }
    return [];
  }
  async function extSO(q, signal) {
    for (const site of ['pt.stackoverflow', 'stackoverflow']) {
      const qs = Core.parseSeSearch(await getJSON(Core.seSearchUrl(site, q, S.skey), signal));
      if (qs.length) return Core.parseSeAnswers(await getJSON(Core.seAnswersUrl(site, qs.map(x => x.id), S.skey), signal), qs);
    }
    return [];
  }
  const extPapers = async (q, signal) => Core.parseOpenAlex(await getJSON(Core.openAlexUrl(q, S.akey), signal)).slice(0, 2);
  async function extWeb(q, signal) {
    const body = JSON.stringify(Core.tavilyBody(q));
    const viaProxy = () => getJSON(Core.proxyBase(S.proxy) + '/tavily/search', signal, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-token': S.token }, body });
    const direct = () => getJSON('https://api.tavily.com/search', signal, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', ...(S.tkey ? { Authorization: `Bearer ${S.tkey}` } : { 'X-Tavily-Access-Mode': 'keyless' }) } });
    let j;
    if (S.proxy && !S.tkey) j = await viaProxy(); // a chave (se houver) está no proxy
    else {
      try { j = await direct(); } catch (e) { if ((signal && signal.aborted) || !S.proxy) throw e; j = await viaProxy(); }
    }
    return Core.parseTavily(j).slice(0, 3);
  }
  async function externalFor(ucKey, text, signal) {
    const prev = S.chat.messages.filter(m => m.role === 'user').slice(-2, -1)[0]?.content || '';
    const full = (text.length < 40 && prev ? `${prev} ${text}` : text).replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
    const kw = Core.keywords(full);
    const job = k => (k === 'wiki' ? kw && cachedExt('w:' + kw, () => extWiki(kw, signal))
      : k === 'so' ? kw && cachedExt('s:' + kw, () => extSO(kw, signal))
        : k === 'paper' ? kw && cachedExt('p:' + kw, () => extPapers(kw, signal))
          : full && cachedExt('t:' + full, () => extWeb(full, signal)));
    const res = await Promise.all(Core.extKinds(ucKey, text).map(k => Promise.resolve(job(k)).catch(e => {
      if (signal && signal.aborted) throw e;
      return []; // fonte indisponível: segue sem ela
    })));
    return Core.formatExternal(res.filter(Array.isArray).flat());
  }

  // Texto de um PDF fixado (o que a biblioteca extraiu, com as páginas): é assim que os motores que não leem PDFs o recebem.
  async function pdfAlt(f) {
    const cs = Core.sortChunks(await DB.byIndex('chunks', 'fileId', f.id));
    if (!cs.length) return '';
    let t = `FICHEIRO FIXADO (${f.name}, texto extraído):`, page = 0;
    for (const c of cs) {
      if (c.page !== page) { t += `\n[p. ${c.page}] `; page = c.page; }
      t += c.text + ' ';
      if (t.length > 60000) { t += '…'; break; }
    }
    return t;
  }

  // Partes do pedido no formato "Gemini" ({text} | {inline_data} | {file_data}); Core.claudeContent e Core.oaContent convertem-nas.
  async function officeText(f) { // PowerPoint / Word fixado: o texto, com o número do diapositivo / página
    const pgs = await Core.officePages(await f.blob.arrayBuffer(), f.name), slide = /\.pptx$/i.test(f.name);
    return pgs.map((t, i) => `[${slide ? 'diapositivo' : 'página'} ${i + 1}]\n${t}`).join('\n\n');
  }

  async function userParts(text, hits, primary, ext = '') {
    const main = { text: (hits.length ? `EXCERTOS DOS APONTAMENTOS:\n${Core.formatContext(hits)}\n\n` : '') + (ext ? `${ext}\n\n` : '') + 'PERGUNTA: ' + text };
    if (!primary) return [main];
    const extra = [], files = []; // extra: fotos, links e ficheiros fixados; files: texto dos ficheiros fixados (vai antes da pergunta)
    S.images.forEach(im => extra.push({ inline_data: { mime_type: 'image/jpeg', data: im.url.split(',')[1] } }));
    if (isClaude()) { if (Core.youtubeLinks(text).length) toast('O Claude não vê vídeos do YouTube: o link foi ignorado. Para aulas em vídeo usa o motor Gemini.', 7000); }
    else Core.youtubeLinks(text).forEach(u => extra.push({ file_data: { file_uri: u } }));
    let total = 0;
    for (const f of S.pinned.values()) {
      total += f.blob.size;
      if (total > MAX_INLINE) throw new Error('Os ficheiros fixados (📌) passam o limite de ~18 MB por pedido. Remove algum.');
      const pdf = f.name.toLowerCase().endsWith('.pdf'), img = f.kind === 'image';
      if (Core.isOffice(f.name)) { files.push({ text: `FICHEIRO FIXADO (${f.name}):\n${await officeText(f)}` }); continue; }
      if (isClaude()) {
        if (f.kind === 'video') throw new Error(`O Claude não vê vídeos ("${f.name}" está fixado com 📌). Muda o motor para Gemini ou tira o 📌.`);
        if (pdf) extra.push({ inline_data: { mime_type: 'application/pdf', data: await blobToB64(f.blob) } });
        else if (img) extra.push({ inline_data: { mime_type: f.blob.type || 'image/jpeg', data: await blobToB64(f.blob) } });
        else files.push({ text: `FICHEIRO FIXADO (${f.name}):\n${await f.blob.text()}` });
        continue;
      }
      if (isAuto() && f.kind !== 'video' && !pdf && !img) { files.push({ text: `FICHEIRO FIXADO (${f.name}):\n${await f.blob.text()}` }); continue; }
      const mime = f.kind === 'video' ? (f.blob.type || 'video/mp4') : pdf ? 'application/pdf' : img ? (f.blob.type || 'image/jpeg') : 'text/plain';
      const part = { inline_data: { mime_type: mime, data: await blobToB64(f.blob) } };
      if (isAuto() && pdf) { const alt = await pdfAlt(f); if (alt) part.alt = alt; } // o Gemini lê o PDF; os outros, o texto dele
      extra.push(part);
    }
    return [...files, main, ...extra]; // (no Gemini, files só tem PowerPoint/Word: o resto vai em extra)
  }

  async function askUC(k, text, hist, primary, onUpdate, signal) {
    const uc = byKey[k], web = $('#web').checked;
    const hits = await retrieve(k, text);
    // Fontes externas: no Gemini e no Automático vêm da app (grátis), com o 🌐 ligado ou na Ética; no Claude é a pesquisa dele (paga).
    let ext = { text: '', sources: [] };
    if (!isClaude() && (web || uc.tool === 'search')) {
      onUpdate && onUpdate({ text: '', calcs: [], sources: [], searchHtml: '', status: '🌐 A consultar fontes externas…' });
      ext = await externalFor(k, text, signal);
    }
    const al = alunoGet(); // 🙂 o que se sabe do aluno + o tom de que ele gosta
    const cartas = (await DB.byIndex('cards', 'uc', k).catch(() => [])).filter(c => (c.ease || 2.5) < 2.2).sort((a, b) => a.ease - b.ease).slice(0, 3)
      .map(c => String(c.frente || '').replace(/[$*_`#>]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean);
    const sys = Core.systemPrompt(uc, $('#estilo').value, hits.length > 0 || (primary && S.pinned.size > 0),
      { externas: !!ext.text, aluno: Core.alunoPrompt(al, uc, cartas), exemplos: Core.exemplosTom(al, uc) });
    const parts = await userParts(text, hits, primary, ext.text);
    // Claude: cálculo e pesquisa dele (as duas podem estar ligadas). Gemini e motores grátis: cálculo; a pesquisa são as fontes externas.
    const tool = isClaude() ? (web ? (uc.tool === 'code' ? ['code', 'search'] : ['search']) : [uc.tool]) : (uc.tool === 'code' ? 'code' : undefined);
    const r = await aiStream({ system: sys, history: hist, parts, tool, maxHistory: S.hist }, onUpdate, signal);
    if (!String(r.text || '').trim() && (r.calcs || []).length) {
      // Alguns modelos (ex.: Gemini Flash) às vezes param logo depois de correr o código, sem escrever a explicação.
      // Pede-a de novo, sem ferramentas, com os resultados já calculados (não volta a gastar tempo a calcular).
      const calcs = r.calcs, feitos = calcs.map((c, i) => `Cálculo ${i + 1}:\n${String(c.code || '').slice(0, 2500)}\n→ ${String(c.output || '(sem resultado)').slice(0, 1500)}`).join('\n\n');
      onUpdate && onUpdate({ ...r, status: '✍️ A escrever a explicação…' });
      const r2 = await aiStream({ system: sys, history: hist, maxHistory: S.hist,
        parts: [...parts, { text: `CÁLCULOS JÁ FEITOS COM PYTHON (usa estes resultados e não voltes a calcular):\n${feitos}\n\nEscreve agora a resposta ao aluno, no estilo pedido.` }] },
      x => onUpdate && onUpdate({ ...x, calcs }), signal);
      r.text = r2.text;
      if (r2.sources && r2.sources.length) r.sources = [...(r.sources || []), ...r2.sources];
      if (r2.tried) r.tried = [...(r.tried || []), ...r2.tried];
    }
    if (ext.sources.length) r.sources = [...ext.sources, ...(r.sources || []).filter(s => !ext.sources.some(x => x.uri === s.uri))];
    return r;
  }

  function setBusy(b) {
    S.busy = b; $('#sendBtn').textContent = b ? '■' : '➤'; $('#sendBtn').setAttribute('aria-label', b ? 'Parar' : 'Enviar');
    $('#engine').disabled = b; // o motor não muda a meio de uma resposta
  }

  // Confirma as contas da resposta com um segundo motor grátis (nunca o mesmo que respondeu). Não mexe no texto da resposta:
  // junta um aviso por baixo. Parar (■) durante a confirmação só a cancela; a resposta fica.
  async function verifyInto(am, q, paint, signal) {
    const avoid = am.byLink || (isAuto() ? null : isClaude() ? null : { p: 'gemini', m: S.model });
    am.verify = { v: 'run' }; paint();
    try {
      const r = await callAuto({ system: Core.VERIFY_SYSTEM, parts: [{ text: Core.verifyPrompt(q, am.content, am.calcs) }], tool: 'code', temperature: 0, maxHistory: 0 }, null, signal, { avoid });
      am.verify = { ...Core.parseVerdict(r.text), by: Core.linkLabel(r.by) };
    } catch (e) {
      if (e.name === 'AbortError') { delete am.verify; return; }
      am.verify = { v: 'falhou', notes: String(e.message || '').split('\n')[0].slice(0, 160) };
    }
  }

  // opts.fresh: pedir uma resposta nova mesmo que haja uma guardada (botão 🔄 de uma resposta da cache)
  async function send(opts = {}) {
    if (S.busy) { S.abort && S.abort.abort(); return; }
    const text = $('#input').value.trim();
    if (!text && !S.images.length) return;
    if (!UCS.length) return toast('Este semestre ainda não tem UCs: acrescenta-as em 🎓 (no topo da barra lateral).', 6000);
    if (!haveGen()) return openSettings(needKeyText());
    if (!navigator.onLine) return toast('Sem internet: os agentes precisam de ligação.');

    const q = text || 'Analisa a imagem anexada.';
    const hist = S.chat.messages.filter(m => !m.error);
    // Cache: só perguntas de texto (fotos, ficheiros fixados e vídeos mudam a resposta e não entram na chave).
    const media = S.images.length > 0 || S.pinned.size > 0 || Core.youtubeLinks(q).length > 0;
    const ck = S.cacheOn && !media ? Core.answerKey({ q, mode: $('#mode').value, estilo: $('#estilo').value, web: $('#web').checked, engine: engineKey(), hist, lib: +ls('libv', '0') }) : null;
    const um = { role: 'user', content: q, imgs: S.images.map(i => i.url) };
    const am = { role: 'assistant', content: '', ucs: [], calcs: [], sources: [], web: $('#web').checked };
    if (S.engine !== 'gemini') am.engine = S.engine;
    const who = rs => { // quem respondeu no modo Automático (e quem ficou pelo caminho)
      const by = [...new Set(rs.filter(r => r && r.by).map(r => Core.linkLabel(r.by)))];
      if (by.length) am.by = by;
      const first = rs.find(r => r && r.by);
      if (first) am.byLink = { p: first.by.p, m: first.by.m };
      const tried = rs.flatMap(r => (r && r.tried) || []).map(t => `${Core.linkLabel(t.l)}: ${t.why}`);
      if (tried.length) am.tried = [...new Set(tried)];
    };
    if (S.chat.messages.length === 0) $('#msgs').innerHTML = '';
    S.chat.messages.push(um, am);
    addMsgEl(um); const el = addMsgEl(am, true); toBottom();
    $('#input').value = ''; $('#input').style.height = 'auto';
    setBusy(true); S.abort = new AbortController();
    const signal = S.abort.signal;
    let raf = 0;
    const paint = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; const nb = nearBottom(); paintAssistant(el, am, true); if (nb) toBottom(); }); };
    const merge = r => { am.content = r.text; am.calcs = r.calcs; am.sources = r.sources; am.searchHtml = r.searchHtml; am.status = r.status; };

    try {
      const hit = ck && !opts.fresh ? await cacheGet(ck) : undefined;
      if (hit && typeof hit.content === 'string') { // pergunta repetida: resposta guardada, sem gastar nenhum pedido
        Object.assign(am, { content: hit.content, calcs: hit.calcs || [], sources: hit.sources || [], ucs: hit.ucs || [], cached: hit.at || Date.now() },
          hit.by ? { by: hit.by } : {}, hit.verify ? { verify: hit.verify } : {});
        statRec('cache', true);
        logAct('ask', am.ucs[0]);
        return;
      }
      let ucs = $('#mode').value === 'auto' ? await route(q, hist, signal) : [$('#mode').value];
      const pinnedUc = [...S.pinned.values()][0]?.uc;
      if (pinnedUc && $('#mode').value === 'auto') ucs = [pinnedUc, ...ucs.filter(k => k !== pinnedUc)].slice(0, 3);
      am.ucs = ucs; paint();

      if (ucs.length === 1) {
        const r = await askUC(ucs[0], q, hist, true, x => { merge(x); paint(); }, signal);
        merge(r); who([r]);
      } else {
        am.content = `⏳ A consultar ${ucs.map(ucLabel).join(' e ')}…`; paint();
        const rs = await Promise.all(ucs.map((k, i) => askUC(k, q, hist, i === 0, null, signal)));
        const parts = [{ text: `Pergunta do aluno: ${q}\n\n` + rs.map((r, i) => `### ${byKey[ucs[i]].nome}\n${r.text}`).join('\n\n') }];
        const sys = 'Juntas as respostas de vários especialistas numa só, em português de Portugal, organizada por UC, sem repetições, mantendo fórmulas LaTeX ($...$) e citações [ficheiro, p. N] e [En].\n' + Core.HUMANO_RULES;
        const fin = await aiStream({ system: sys, parts, maxHistory: 0 }, r => { am.content = r.text; am.status = r.status; paint(); }, signal);
        am.content = fin.text; am.calcs = rs.flatMap(r => r.calcs);
        am.sources = rs.flatMap(r => r.sources).filter((s, i, a) => a.findIndex(x => x.uri === s.uri) === i);
        who([...rs, fin]);
      }
      S.images = []; renderChips(); logAct('ask', ucs[0]);
      delete am.status;
      am.content = Core.limparTiques(am.content); // (as frases feitas que ainda escapem ao prompt)
      if (ck) am.ck = ck;
      aprender();
      if (S.verifyOn && haveFree() && Core.wantsVerify(ucs, am)) await verifyInto(am, q, paint, signal);
      if (ck && Core.cacheableAnswer(am)) {
        const v = am.verify && ['ok', 'erro', 'nada'].includes(am.verify.v) ? am.verify : undefined; // «não consegui confirmar» não se guarda
        cachePut(ck, 'ans', { content: am.content, calcs: am.calcs, sources: am.sources, ucs: am.ucs, by: am.by, verify: v, at: Date.now() });
      }
    } catch (e) {
      if (e.name === 'AbortError') { if (!am.content || am.content.startsWith('⏳')) am.content = '*(interrompido)*'; }
      else { am.content = '⚠️ ' + e.message; am.error = true; }
    } finally {
      cancelAnimationFrame(raf); delete am.status; paintAssistant(el, am, false);
      setBusy(false); S.abort = null; saveChat(); toBottom();
    }
  }

  // ------------------------------------------------------------ estudo: quiz, baralho (SM-2), revisão e resumos
  function openStudy(tipo) {
    closeSide(); $('#stUc').value = $('#libUc').value; $('#stOut').innerHTML = '';
    if (tipo) $('#stTipo').value = tipo;
    $('#study').showModal();
    if (tipo === 'rever') generateStudy();
  }

  async function generateStudy() {
    const uc = byKey[$('#stUc').value], tipo = $('#stTipo').value, n = +$('#stN').value, tema = $('#stTema').value.trim();
    const out = $('#stOut'), go = $('#stGo');
    if (!uc) { out.textContent = 'Este semestre ainda não tem UCs: acrescenta-as em 🎓 (barra lateral).'; return; }
    if (tipo === 'rever') { // o baralho é local: não precisa de internet nem de chave
      const due = (await DB.byIndex('cards', 'uc', uc.key)).filter(c => c.due <= Date.now());
      out.innerHTML = '';
      if (due.length) renderReview(out, shuffle(due), uc);
      else out.textContent = 'Sem cartas para rever hoje 🎉 (gera flashcards para criar o baralho).';
      return;
    }
    if (!haveGen()) { out.textContent = needKeyText(); return; }
    out.textContent = '⏳ A gerar…'; go.disabled = true;
    try {
      const idx = await getIndex(uc.key);
      let trechos = '';
      if (idx.N) trechos = Core.formatContext(tema ? await hybrid(uc.key, tema, 8) : shuffle(idx.docs).slice(0, 8).map(d => ({ chunk: d.c })));
      if (tipo === 'resumo') {
        const md = await aiText({ system: 'És um professor que escreve resumos de estudo claros e rigorosos.', parts: [{ text: Core.summaryPrompt({ uc, tema, trechos }) }], temperature: 0.3 });
        if (!md.trim()) throw new Error('O modelo devolveu um resumo vazio. Tenta de novo.');
        out.innerHTML = ''; renderSummary(out, md, `resumo-${uc.key}${tema ? '-' + slug(tema) : ''}`); logAct('summary', uc.key);
        return;
      }
      const raw = await aiText({ system: 'És um professor que cria material de estudo rigoroso e claro.', parts: [{ text: Core.studyPrompt({ uc, tipo, n, tema, trechos }) }], temperature: 0.5, json: true });
      const itens = (Core.parseJSON(raw) || {}).itens;
      if (!Array.isArray(itens) || !itens.length) throw new Error('O modelo devolveu um formato inesperado. Tenta de novo.');
      out.innerHTML = '';
      if (tipo === 'quiz') renderQuiz(out, itens.filter(i => Array.isArray(i.opcoes) && Number.isInteger(i.correta)), uc);
      else {
        const ok = itens.filter(i => i.frente && i.verso);
        renderFlash(out, ok);
        await DB.putMany('cards', ok.map(i => ({ id: uuid(), uc: uc.key, frente: i.frente, verso: i.verso, due: Date.now(), ease: 2.5, interval: 0, reps: 0, upd: Date.now() })));
        toast(`${ok.length} cartas guardadas no baralho (separador "Rever").`); refreshDue(); markDirty();
      }
    } catch (e) { out.textContent = '⚠️ ' + e.message; } finally { go.disabled = false; }
  }

  function renderQuiz(out, itens, uc) {
    let ok = 0, done = 0;
    const score = document.createElement('p'); score.className = 'hint'; score.textContent = `0 / ${itens.length}`;
    out.appendChild(score);
    itens.forEach((it, qi) => {
      const c = document.createElement('div'); c.className = 'card';
      c.innerHTML = `<div class="md"><b>${qi + 1}.</b> ${rich(it.pergunta)}</div>`;
      const exp = document.createElement('div'); exp.className = 'md hint'; exp.hidden = true; exp.innerHTML = rich(it.explicacao || '');
      const btns = it.opcoes.map((o, oi) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.innerHTML = rich(o);
        b.onclick = () => {
          btns.forEach((x, xi) => { x.disabled = true; if (xi === it.correta) x.classList.add('ok'); });
          if (oi === it.correta) ok++; else { b.classList.add('bad'); alunoDif(uc.key, it.pergunta); }
          done++; exp.hidden = false; score.textContent = `${ok} / ${itens.length}${done === itens.length ? ' — terminado!' : ''}`;
          if (done === itens.length) logAct('quiz', uc.key, ok, itens.length);
        };
        c.appendChild(b); return b;
      });
      c.appendChild(exp); out.appendChild(c);
    });
  }

  function renderFlash(out, itens) {
    let i = 0, back = false;
    const card = document.createElement('div'); card.className = 'card flash md';
    const nav = document.createElement('div'); nav.className = 'row';
    const prev = Object.assign(document.createElement('button'), { type: 'button', textContent: '←' });
    const next = Object.assign(document.createElement('button'), { type: 'button', textContent: '→' });
    const info = document.createElement('span'); info.className = 'hint'; info.style.textAlign = 'center';
    const show = () => { card.innerHTML = rich(back ? itens[i].verso : itens[i].frente); info.textContent = `${i + 1} / ${itens.length} · toca no cartão para virar`; };
    card.onclick = () => { back = !back; show(); };
    prev.onclick = () => { i = (i - 1 + itens.length) % itens.length; back = false; show(); };
    next.onclick = () => { i = (i + 1) % itens.length; back = false; show(); };
    nav.append(prev, info, next); out.append(card, nav); show();
  }

  function renderReview(out, cards, uc) {
    let i = 0, good = 0, total = cards.length;
    const box = document.createElement('div'); out.appendChild(box);
    const step = () => {
      if (i >= cards.length) { box.innerHTML = '<p>✅ Revisão concluída! Volta amanhã.</p>'; logAct('review', uc.key, good, total); refreshDue(); return; }
      const c = cards[i]; box.innerHTML = '';
      const card = document.createElement('div'); card.className = 'card flash md'; card.innerHTML = rich(c.frente);
      const row = document.createElement('div'); row.className = 'row'; row.hidden = true;
      [['Errei', 0], ['Difícil', 1], ['Bom', 2], ['Fácil', 3]].forEach(([t, g]) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: t });
        b.onclick = async () => {
          const upd = Core.sm2(c, g); await DB.put('cards', upd); markDirty();
          if (g >= 2) good++;
          if (g === 0) { cards.push(upd); alunoDif(c.uc, c.frente); } // errou: volta a aparecer no fim desta sessão (e fica na memória)
          i++; step();
        };
        row.appendChild(b);
      });
      card.onclick = () => { card.innerHTML = rich(c.frente) + '<hr>' + rich(c.verso); row.hidden = false; };
      const info = document.createElement('p'); info.className = 'hint'; info.textContent = `${i + 1} / ${cards.length} · toca para ver a resposta`;
      box.append(card, info, row);
    };
    step();
  }

  function renderSummary(out, md, fname) {
    const m = { content: md, fname };
    const d = document.createElement('div'); d.className = 'card';
    d.innerHTML = `<div class="md">${rich(md)}</div><div class="acts"><button type="button" data-act="copy">📋</button><button type="button" data-act="md">⬇️ .md</button><button type="button" data-act="pdf">🖨️ PDF</button></div>`;
    d.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => exportMsg(b.dataset.act, m); });
    out.appendChild(d);
  }

  // ------------------------------------------------------------ progresso
  async function openProgress() {
    closeSide();
    const P = Core.progress({ cards: await DB.all('cards'), log: jget('actlog', []), plan: getPlan().items, files: await DB.all('files') });
    const out = $('#progOut'); out.innerHTML = '';
    const head = document.createElement('div'); head.className = 'card';
    head.innerHTML = `<b>🔥 Série: ${P.streak} dia${P.streak === 1 ? '' : 's'}</b><br><small>${P.cards} cartas no baralho · ${P.due} por rever hoje</small>` +
      (P.suggest ? `<br><small>💡 Sugestão: ${Core.esc(ucLabel(P.suggest.key))} (${Core.esc(P.suggest.why)})</small>` : '');
    out.appendChild(head);
    UCS.forEach(u => {
      const o = P.byUc[u.key], pct = o.cards ? Math.round(100 * o.mature / o.cards) : 0;
      const d = document.createElement('div'); d.className = 'prow';
      d.innerHTML = `<b>${Core.esc(u.emoji)} ${Core.esc(u.nome)}</b><div class="bar" title="cartas dominadas"><i style="width:${pct}%"></i></div>` +
        `<small>Cartas ${o.cards} (dominadas ${o.mature}, por rever ${o.due}) · Quiz ${o.quizPct === null ? '—' : `${o.quizPct}% (${o.quizN})`} · Plano ${o.planDone}/${o.planTotal} · ${o.files} ficheiro${o.files === 1 ? '' : 's'}</small>`;
      out.appendChild(d);
    });
    out.appendChild(statsCard());
    $('#prog').showModal();
  }

  // ---- 📈 estatísticas dos motores (últimos 30 dias): pedidos, respostas, tempo médio e falhas por tipo
  function statsCard() {
    const box = document.createElement('div'); box.className = 'card stats';
    const sum = Core.statSummary(S.stats, { days: 30 });
    const rows = Object.values(sum).filter(o => o.key !== 'cache').sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
    const hits = (sum.cache || { ok: 0 }).ok;
    const adapt = S.adaptOn ? Core.adaptiveOrder(S.chain, S.stats).why : {};
    const fails = o => Object.entries(o.err).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${Core.ERR_LABEL[k] || k} ${n}`).join(' · ') || '—';
    box.innerHTML = '<b>📈 Motores (últimos 30 dias)</b>' + (rows.length
      ? `<div class="tw"><table><thead><tr><th>Motor</th><th>Pedidos</th><th>Respostas</th><th>Tempo médio</th><th>Falhas</th></tr></thead><tbody>${rows.map(o =>
        `<tr${adapt[o.key] ? ' class="down"' : ''}><td>${Core.esc(statLabel(o.key))}${adapt[o.key] ? `<br><small>🧠 ${Core.esc(adapt[o.key])}</small>` : ''}</td><td data-l="Pedidos">${o.n}</td>` +
        `<td data-l="Respostas">${o.ok} (${Math.round(100 * o.rate)}%)</td><td data-l="Tempo médio">${o.ok ? (o.avgMs / 1000).toFixed(1) + ' s' : '—'}</td><td data-l="Falhas">${Core.esc(fails(o))}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="hint">Ainda sem números: aparecem à medida que fazes perguntas.</p>') +
      `<p class="hint">💾 ${hits} pergunta${hits === 1 ? '' : 's'} respondida${hits === 1 ? '' : 's'} pela cache (nenhum pedido gasto).${S.adaptOn ? ' 🧠 A ordem dos motores grátis ajusta-se a estes números (Definições).' : ''}</p>` +
      '<div class="row"><button type="button" data-st="csv">⬇️ CSV</button><button type="button" data-st="clear">🧹 Limpar números</button></div>';
    box.querySelector('[data-st=csv]').onclick = () => download(`ai-campus-motores-${Core.dayKey(Date.now())}.csv`, 'text/csv', Core.statsCSV(S.stats));
    box.querySelector('[data-st=clear]').onclick = () => {
      if (!confirm('Apagar as estatísticas dos motores? (a ordem automática recomeça do zero)')) return;
      S.stats = {}; jset('stats', S.stats); box.replaceWith(statsCard());
    };
    return box;
  }

  // ------------------------------------------------------------ plano de estudo
  function openPlan() { closeSide(); renderPlan(); $('#planMsg').textContent = ''; $('#plan').showModal(); }

  function renderPlan() {
    const keys = activeKeys(), ex = jget('exams', []).filter(e => keys.has(e.uc)), plan = getPlan(), list = $('#exList'), box = $('#planOut');
    list.innerHTML = ''; box.innerHTML = '';
    ex.forEach(e => {
      const d = document.createElement('div'); d.className = 'item';
      d.innerHTML = `<span class="t">${Core.esc(ucLabel(e.uc))} · ${Core.esc(e.nome)} · ${Core.esc(fmtDay(e.data))}</span><button aria-label="remover">✕</button>`;
      d.querySelector('button').onclick = () => { tombAdd('exam', e.id); jset('exams', jget('exams', []).filter(x => x.id !== e.id)); markDirty(); renderPlan(); };
      list.appendChild(d);
    });
    let last = '';
    plan.items.filter(p => Core.semOf(p) === semId()).sort((a, b) => a.data.localeCompare(b.data)).forEach(p => {
      if (p.data !== last) { last = p.data; const h = document.createElement('b'); h.textContent = fmtDay(p.data); box.appendChild(h); }
      const l = document.createElement('label'); l.className = 'check';
      l.innerHTML = `<input type="checkbox" ${p.feito ? 'checked' : ''}> ${Core.esc((byKey[p.uc]?.emoji || '') + ' ' + p.titulo)}`;
      l.querySelector('input').onchange = ev => { p.feito = ev.target.checked; p.upd = Date.now(); setPlan(plan); };
      box.appendChild(l);
    });
  }

  async function genPlan() {
    const keys = activeKeys(), ex = jget('exams', []).filter(e => keys.has(e.uc)), msg = $('#planMsg');
    if (!ex.length) { msg.textContent = 'Adiciona primeiro a data de um exame ou frequência.'; return; }
    if (!haveGen()) { msg.textContent = needKeyText(); return; }
    msg.textContent = '⏳ A planear…';
    try {
      const topicos = {};
      for (const u of UCS) {
        const idx = await getIndex(u.key), step = Math.max(1, Math.floor(idx.N / 6));
        topicos[u.nome] = idx.docs.filter((_, i) => i % step === 0).slice(0, 6).map(d => d.c.text.slice(0, 80));
      }
      const devidas = (await DB.all('cards')).filter(c => c.due <= Date.now() && keys.has(c.uc)).length;
      const raw = await aiText({ system: 'És um planeador de estudo realista.', parts: [{ text: Core.planPrompt({ hoje: Core.dayKey(Date.now()), exames: ex.map(e => ({ ...e, uc: byKey[e.uc]?.nome || e.uc })), topicos, devidas }) }], temperature: 0.3, json: true });
      const dias = (Core.parseJSON(raw) || {}).dias;
      if (!Array.isArray(dias) || !dias.length) throw new Error('Formato inesperado. Tenta de novo.');
      const items = dias.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.data) && d.titulo)
        .map(d => ({ id: uuid(), data: d.data, uc: Core.isActive(d.uc) ? d.uc : '', titulo: String(d.titulo), feito: false, upd: Date.now(), sem: semId() }));
      if (!items.length) throw new Error('O plano veio sem datas válidas. Tenta de novo.');
      // o plano novo substitui só o deste semestre (os outros semestres guardam o seu)
      setPlan({ gen: Date.now(), items: [...getPlan().items.filter(p => Core.semOf(p) !== semId()), ...items] }); msg.textContent = ''; renderPlan();
    } catch (e) { msg.textContent = '⚠️ ' + e.message; }
  }

  function exportICS() {
    const items = [
      ...jget('exams', []).filter(e => Core.isActive(e.uc)).map(e => ({ data: e.data, titulo: `📝 ${e.nome} — ${byKey[e.uc]?.nome || ''}` })),
      ...getPlan().items.filter(p => Core.semOf(p) === semId()).map(p => ({ data: p.data, titulo: `${byKey[p.uc]?.emoji || '📚'} ${p.titulo}` })),
    ];
    if (!items.length) { $('#planMsg').textContent = 'Nada para exportar.'; return; }
    download('plano-estudo.ics', 'text/calendar', Core.buildICS(items));
  }

  // ------------------------------------------------------------ definições, diagnóstico e backup
  // ---- motores grátis: a lista ordenada (rascunho até carregares em Guardar) e o estado de cada um
  function chainModels(p) {
    $('#chainModels').innerHTML = (Core.MODEL_HINTS[p] || []).map(m => `<option value="${Core.esc(m)}">`).join('');
  }
  function renderChain() {
    const box = $('#chainList'), now = Date.now();
    const adapt = $('#adaptOn') && $('#adaptOn').checked ? Core.adaptiveOrder(S.chainDraft, S.stats).why : {}; // o que o 🧠 desce, e porquê
    box.innerHTML = '';
    S.chainDraft.forEach((l, i) => {
      const why = l.off ? 'desligado' : availWhy(l.p) || Core.linkBlocked(S.cstate, l, now);
      const st = (why ? (l.off ? why : '⚠️ ' + why) : '✅ pronto') + (!l.off && adapt[Core.linkKey(l)] ? ` · 🧠 ${adapt[Core.linkKey(l)]}` : '');
      const d = document.createElement('div');
      d.className = 'item crow' + (l.off ? ' off' : '');
      d.innerHTML = `<input type="checkbox" aria-label="usar este motor" ${l.off ? '' : 'checked'}><span class="cinfo"><span class="t">${Core.esc(Core.linkLabel(l))}</span>` +
        `<small class="cst" title="${Core.esc(st)}">${Core.esc(st)}</small></span>` +
        '<button type="button" aria-label="subir">↑</button><button type="button" aria-label="descer">↓</button><button type="button" aria-label="tirar">✕</button>';
      const [on, up, down, del] = d.querySelectorAll('input, button');
      on.onchange = () => { if (on.checked) delete l.off; else l.off = true; renderChain(); };
      up.onclick = () => { if (i) { S.chainDraft.splice(i - 1, 0, S.chainDraft.splice(i, 1)[0]); renderChain(); } };
      down.onclick = () => { if (i < S.chainDraft.length - 1) { S.chainDraft.splice(i + 1, 0, S.chainDraft.splice(i, 1)[0]); renderChain(); } };
      del.onclick = () => { S.chainDraft.splice(i, 1); renderChain(); };
      box.appendChild(d);
    });
    if (!S.chainDraft.length) box.innerHTML = '<p class="hint">Sem motores: ao guardar volta a ordem por omissão.</p>';
  }

  function openSettings(msg = '') {
    $('#keyIn').value = S.key; $('#modelIn').value = S.model; $('#histIn').value = S.hist;
    $('#ckeyIn').value = S.ckey; $('#cmodelIn').value = S.cmodel; $('#effortIn').value = S.effort;
    $('#okeyIn').value = S.okey; $('#tkeyIn').value = S.tkey; $('#akeyIn').value = S.akey; $('#skeyIn').value = S.skey;
    $('#proxyIn').value = S.proxy; $('#tokenIn').value = S.token; $('#ocrAuto').checked = S.ocrAuto;
    $('#cacheOn').checked = S.cacheOn; $('#verifyOn').checked = S.verifyOn; $('#adaptOn').checked = S.adaptOn; cacheInfo();
    S.cstate = Core.chainPrune(S.cstate, Date.now());
    S.chainDraft = S.chain.map(l => ({ ...l })); renderChain(); chainModels($('#chainP').value); $('#freeMsg').textContent = '';
    $('#engNow').textContent = engineName();
    $('#gClient').value = D.clientId; $('#gStatus').textContent = driveStatusText();
    const al = alunoGet(); $('#alNome').value = al.nome; $('#alSobre').value = al.sobre; $('#alAuto').checked = al.auto; renderMemoria();
    $('#setMsg').textContent = msg; $('#settings').returnValue = ''; $('#settings').showModal();
  }

  function saveSettings() {
    S.key = $('#keyIn').value.trim(); S.model = $('#modelIn').value.trim() || 'gemini-flash-latest';
    S.ckey = $('#ckeyIn').value.trim(); S.cmodel = $('#cmodelIn').value.trim() || Core.CLAUDE_MODEL; S.effort = $('#effortIn').value || 'medium';
    S.okey = $('#okeyIn').value.trim(); S.tkey = $('#tkeyIn').value.trim(); S.akey = $('#akeyIn').value.trim(); S.skey = $('#skeyIn').value.trim();
    S.hist = Math.max(0, Math.min(30, +$('#histIn').value || 0));
    S.proxy = $('#proxyIn').value.trim().replace(/\/$/, ''); S.token = $('#tokenIn').value.trim(); S.ocrAuto = $('#ocrAuto').checked;
    S.cacheOn = $('#cacheOn').checked; S.verifyOn = $('#verifyOn').checked; S.adaptOn = $('#adaptOn').checked;
    lset('gcache', S.cacheOn ? '1' : '0'); lset('gverify', S.verifyOn ? '1' : '0'); lset('gadapt', S.adaptOn ? '1' : '0');
    S.chain = Core.normChain(S.chainDraft);
    D.clientId = $('#gClient').value.trim();
    { const al = alunoGet(), nome = $('#alNome').value.replace(/\s+/g, ' ').trim(), sobre = $('#alSobre').value.trim(), auto = $('#alAuto').checked;
      if (nome !== al.nome || sobre !== al.sobre || auto !== al.auto) alunoSet({ ...al, nome, sobre, auto, upd: Date.now() }); }
    lset('gkey', S.key); lset('gmodel', S.model); lset('ghist', S.hist); lset('gproxy', S.proxy); lset('gtoken', S.token);
    lset('ckey', S.ckey); lset('cmodel', S.cmodel); lset('geffort', S.effort);
    lset('okey', S.okey); lset('tkey', S.tkey); lset('akey', S.akey); lset('skey', S.skey); jset('chain', S.chain);
    lset('gocr', S.ocrAuto ? '1' : '0'); lset('gclient', D.clientId);
    S.embModel = null; S.embShape = undefined; S.embOne = false; S.idx.clear(); S.cdrop = noCdrop(); // as definições novas podem já aceitar o que antes foi recusado
    S.cstate.auth = {}; S.cstate.bad = {}; saveCState(); // chaves e modelos novos: volta a experimentar (os limites atingidos mantêm-se)
    toast('Definições guardadas.');
  }

  // Aplica por instantes o que está escrito nas Definições (sem gravar) e repõe o estado no fim.
  async function withTyped(fn) {
    const K = ['key', 'ckey', 'proxy', 'token', 'model', 'cmodel', 'effort', 'embModel', 'embShape', 'okey', 'tkey', 'akey', 'skey', 'chain'];
    const prev = Object.fromEntries(K.map(k => [k, S[k]]));
    S.key = $('#keyIn').value.trim() || S.key; S.ckey = $('#ckeyIn').value.trim() || S.ckey;
    S.proxy = $('#proxyIn').value.trim().replace(/\/$/, ''); S.token = $('#tokenIn').value.trim() || S.token;
    S.model = $('#modelIn').value.trim() || 'gemini-flash-latest'; S.cmodel = $('#cmodelIn').value.trim() || Core.CLAUDE_MODEL;
    S.effort = $('#effortIn').value || S.effort; S.embModel = null; S.embShape = undefined;
    S.okey = $('#okeyIn').value.trim(); S.tkey = $('#tkeyIn').value.trim(); S.akey = $('#akeyIn').value.trim(); S.skey = $('#skeyIn').value.trim();
    S.chain = Core.normChain(S.chainDraft);
    try { return await fn(); } finally { Object.assign(S, prev); }
  }

  // Diagnóstico do Automático: um pedido mínimo a cada motor da lista (gasta 1 pedido de cada) e as fontes externas.
  async function diagnoseAuto(t, lines) {
    for (const l of S.chain.filter(x => !x.off)) {
      const why = availWhy(l.p);
      if (why) { lines.push(`⚪ ${Core.linkLabel(l)}: ${why}`); continue; }
      await t(Core.linkLabel(l), async () => {
        try {
          const r = await runLink(l, { system: 'Responde em 1 frase.', parts: [{ text: 'Diz ok' }], fast: true }, null, undefined);
          return ` — ${r.text.trim().slice(0, 30)}`;
        } catch (e) {
          const c = Core.classifyError(l.p, errInfo(e), Date.now());
          Core.chainMark(S.cstate, l, c); saveCState();
          throw new Error(c.kind === 'limit' ? `esgotado ${Core.untilText(c.until, Date.now())}` : `${c.why}${c.kind === 'bad' ? '' : ` (${e.message.slice(0, 120)})`}`);
        }
      });
    }
    await t('Fontes externas: Wikipédia', async () => { const r = await extWiki('matriz', undefined); if (!r.length) throw new Error('sem resultados'); return ` (${r.length})`; });
    await t(`Fontes externas: pesquisa web (Tavily${S.tkey ? '' : S.proxy ? ', pelo proxy' : ', modo grátis sem conta'})`, async () => {
      const r = await extWeb('o que é uma matriz inversa', undefined); if (!r.length) throw new Error('sem resultados'); return ` (${r.length})`;
    });
  }

  async function diagnose() {
    const m = $('#setMsg'), lines = [];
    m.style.whiteSpace = 'pre-line';
    // Claude: ordens mais diretas (o modelo sabe fazer a conta de cabeça) e sem repetições nem recuos silenciosos, para mostrar o erro verdadeiro.
    const prompt = tool => (!isClaude() ? (tool === 'code' ? 'Calcula 123*456 usando código.' : tool === 'search' ? 'Pesquisa na web: que dia é hoje?' : 'Diz ok')
      : tool === 'code' ? 'Usa a ferramenta de execução de código (Python) para calcular 123456789*987654321 e responde com o resultado.'
        : tool === 'search' ? 'Usa a pesquisa web para ver que dia é hoje e responde com a data.' : 'Diz ok');
    const q = tool => ({ system: 'Responde em 1 frase.', parts: [{ text: prompt(tool) }], tool });
    const o = isClaude() ? { noFallback: true, retries: 0 } : undefined;
    const t = async (name, fn) => {
      m.textContent = [...lines, `⏳ ${name}…`].join('\n');
      try { lines.push(`✅ ${name}${(await fn()) || ''}`); } catch (e) { lines.push(`⚠️ ${name}: ${e.message}`); }
    };
    S.diag = true; // os pedidos de teste não contam para as estatísticas (nem para a ordem automática)
    try { await withTyped(async () => {
      if (isAuto()) await diagnoseAuto(t, lines);
      else {
        await t('Texto', async () => { await aiText(q(), undefined, o); });
        await t('Streaming', async () => { await aiStream(q(), null, undefined, o); });
        await t('Execução de código', async () => { if (!(await aiStream(q('code'), null, undefined, o)).calcs.length) throw new Error('o modelo não usou a ferramenta'); });
        if (isClaude()) await t('Pesquisa web', async () => { await aiStream(q('search'), null, undefined, o); });
        else { // no Gemini (plano grátis) a pesquisa são as fontes externas da app
          await t('Fontes externas: Wikipédia', async () => { const r = await extWiki('matriz', undefined); if (!r.length) throw new Error('sem resultados'); return ` (${r.length})`; });
          await t('Fontes externas: pesquisa web (Tavily)', async () => { const r = await extWeb('o que é uma matriz inversa', undefined); if (!r.length) throw new Error('sem resultados'); return ` (${r.length})`; });
        }
      }
      // A pesquisa por significado é sempre do Gemini (o Claude não tem embeddings): com o Claude só existe se houver chave Gemini.
      if (!isClaude() || haveEmb()) await t(isClaude() ? 'Embeddings (Gemini)' : 'Embeddings', async () => { const v = await embedTexts(['teste'], 'RETRIEVAL_QUERY'); if (!v.length) throw new Error('indisponível (a pesquisa fica só por palavras)'); return ` (${isCfEmb(v.model) ? 'Workers AI · ' + v.model : v.model})`; });
      else lines.push('ℹ️ Pesquisa por significado: sem chave Gemini a pesquisa nos apontamentos usa só palavras (os embeddings são do Gemini).');
    }); } finally { S.diag = false; }
    m.textContent = lines.join('\n');
  }

  // ---- 💾 cache: quantas respostas estão guardadas e quantos pedidos já poupou
  async function cacheInfo() {
    const el = $('#cacheInfo');
    try {
      const all = await DB.all('cache'), now = Date.now(), n = k => all.filter(e => e.kind === k && Core.cacheFresh(e, now)).length;
      const hits = (Core.statSummary(S.stats, { days: 30 }).cache || { ok: 0 }).ok;
      el.textContent = `${n('ans')} respostas e ${n('ext')} pesquisas guardadas · ${hits} pergunta${hits === 1 ? '' : 's'} respondida${hits === 1 ? '' : 's'} pela cache nos últimos 30 dias.`;
    } catch (e) { el.textContent = ''; }
  }

  const stripBlob = ({ blob, mover, ...f }) => f; // (o ficheiro e a marca «mover» ficam só neste aparelho)

  async function collectState() { // estado sincronizável: sem ficheiros, sem embeddings e sem imagens das conversas
    return {
      app: 'ai-campus', version: 3, updated: Date.now(), semestres: Core.semestres(), aluno: alunoGet(),
      chats: (await DB.all('chats')).map(c => ({ ...c, messages: c.messages.map(({ imgs, ...m }) => m) })),
      cards: await DB.all('cards'), files: (await DB.all('files')).map(stripBlob),
      exams: jget('exams', []), plan: getPlan(), tomb: jget('tomb', {}), actlog: jget('actlog', []),
    };
  }

  async function makeBackup() {
    const s = await collectState();
    s.chats = await DB.all('chats'); // o backup manual mantém as imagens das conversas
    s.chunks = Core.sortChunks(await DB.all('chunks')).map(({ emb, embM, ...c }) => c);
    return s;
  }
  const backupName = () => `ai-campus-backup-${Core.dayKey(Date.now())}.json`;

  async function exportBackup() {
    download(backupName(), 'application/json', JSON.stringify(await makeBackup()));
    $('#setMsg').textContent = 'Backup guardado (conversas, baralho, plano, progresso e texto dos apontamentos; sem PDFs/vídeos originais nem chave).';
  }

  async function shareBackup() {
    const f = new File([JSON.stringify(await makeBackup())], backupName(), { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: 'Backup AI Campus' }); $('#setMsg').textContent = 'Escolhe "Drive" na folha de partilha para guardar.'; } catch (e) { /* cancelado */ }
    } else { await exportBackup(); $('#setMsg').textContent += ' (Partilhar não é suportado aqui; guardei o ficheiro: envia-o para o Drive à mão.)'; }
  }

  // Grava um estado já fundido na base local (conversas, baralho, ficheiros, plano...). Nunca apaga o que não esteja em tomb.
  async function applyState(m, { fetchIndex = false } = {}) {
    const tomb = m.tomb || {};
    const oldChats = new Map((await DB.all('chats')).map(c => [c.id, c]));
    for (const id of oldChats.keys()) if (tomb[`chat:${id}`]) await DB.del('chats', id);
    const chatsOut = [];
    for (const c of m.chats) {
      const o = oldChats.get(c.id);
      if (o && (o.updated || 0) >= (c.updated || 0)) continue; // a versão local já é a mais recente
      if (o) c.messages = c.messages.map((x, i) => { const y = o.messages[i]; return y && y.imgs && y.role === x.role && y.content === x.content ? { ...x, imgs: y.imgs } : x; });
      chatsOut.push(c);
    }
    if (chatsOut.length) await DB.putMany('chats', chatsOut);
    if (m.cards.length) await DB.putMany('cards', m.cards);
    const oldFiles = new Map((await DB.all('files')).map(f => [f.id, f]));
    let libChanged = false;
    for (const id of oldFiles.keys()) if (tomb[`file:${id}`]) { await DB.del('files', id); await DB.delByIndex('chunks', 'fileId', id); S.pinned.delete(id); libChanged = true; }
    for (const f of m.files) {
      const o = oldFiles.get(f.id);
      if (!o) { await DB.put('files', { ...f, blob: null }); libChanged = true; }
      else if (o.driveId !== f.driveId || o.idxId !== f.idxId || (f.upd || 0) > (o.upd || 0)) { // (tipo e tema mudados noutro aparelho)
        const n = { ...o, driveId: f.driveId, idxId: f.idxId };
        if ((f.upd || 0) > (o.upd || 0)) { n.tipo = f.tipo; n.upd = f.upd; if (f.tema) n.tema = f.tema; else delete n.tema; delete n.mover; }
        await DB.put('files', n);
      }
    }
    if (libChanged) libBump(); // ficheiros novos ou apagados noutro aparelho: as respostas guardadas deixam de servir
    let novos = false;
    if (fetchIndex) {
      for (const f of m.files) {
        if (!f.idxId || (await DB.byIndex('chunks', 'fileId', f.id)).length) continue;
        try { await DB.putMany('chunks', await (await gfetch(`${DRIVE}/files/${f.idxId}?alt=media`)).json()); novos = true; } catch (e) { /* tenta na próxima sincronização */ }
      }
    }
    jset('exams', m.exams); jset('plan', m.plan); jset('tomb', tomb); jset('actlog', m.actlog);
    if (m.aluno) jset('aluno', Core.normAluno(m.aluno)); // 🙂 a memória do aluno (já junta com a deste aparelho)
    if (m.semestres) { // semestres e UCs criados ou mudados noutro aparelho
      const antes = JSON.stringify(Core.semestres());
      Core.setSemestres(m.semestres); jset('semestres', Core.semestres());
      if (JSON.stringify(Core.semestres()) !== antes) applySemUI();
    }
    S.idx.clear();
    await loadChats(); renderFiles(); refreshDue();
    const cur = S.chat && S.chats.find(c => c.id === S.chat.id);
    if (!S.busy && cur && (cur.updated || 0) > (S.chat.updated || 0)) { S.chat = cur; paintChat(); }
    else if (!S.chat.messages.length) paintChat();
    return novos;
  }

  async function importBackup(file) {
    try {
      let d = JSON.parse(await file.text());
      if (d.app !== 'ai-campus') throw new Error('Ficheiro inválido.');
      const soUcs = d.tipo === 'semestres';   // o ucs.json (🎓 deste telemóvel, de outro, ou do Mac)
      if (soUcs) d = { app: 'ai-campus', semestres: d };
      if (d.chunks?.length) await DB.putMany('chunks', d.chunks);
      const merged = Core.mergeSync(await collectState(), d); // junta com o que já tens, sem apagar
      await applyState(merged);
      $('#setMsg').textContent = soUcs ? `🎓 Semestres e UCs importados: estás em «${(Core.semestres().lista.find(x => x.id === semId()) || {}).nome}» (${UCS.length} UCs).`
        : `Importado: ${(d.chats || []).length} conversas, ${(d.files || []).length} ficheiros, ${(d.cards || []).length} cartas. Carrega em 🧠 para recriar a pesquisa por significado.`;
      markDirty();
    } catch (e) { $('#setMsg').textContent = '⚠️ ' + e.message; }
  }

  // ------------------------------------------------------------ Google Drive (sincronização opcional)
  const tokenOk = () => D.token && Date.now() < D.exp - 60000;
  const driveStatusText = () => !D.clientId ? 'Sem Client ID.' : !D.on ? 'Desligado.' : D.last ? `Ligado. Última sincronização: ${new Date(D.last).toLocaleString('pt-PT')}.` : 'Ligado. Ainda não sincronizou.';
  const gStatus = t => { $('#gStatus').textContent = t; };

  function syncBadge(state, msg) {
    const b = $('#syncBtn'); b.hidden = !D.on;
    b.className = 'badge-btn ' + state;
    b.textContent = { busy: '☁️ ⏳', ok: '☁️ ✓', auth: '☁️ !', err: '☁️ ✗' }[state] || '☁️';
    b.title = msg || { ok: 'Sincronizado', auth: 'Toca para sincronizar (pode pedir login Google)', busy: 'A sincronizar…', err: 'Erro de sincronização' }[state] || 'Sincronizar com o Google Drive';
  }

  function loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('Não consegui carregar o login Google (sem internet?).'));
      document.head.appendChild(s);
    });
  }

  async function driveToken(interactive = true) {
    if (tokenOk()) return D.token;
    if (!interactive) throw new Error('NEEDS_AUTH');
    if (!D.clientId) throw new Error('Define o Google Client ID em ⚙️ Definições (ver GUIA_DRIVE.md).');
    await loadGIS();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: D.clientId, scope: 'https://www.googleapis.com/auth/drive.file',
        callback: r => {
          if (r.error) return rej(new Error('Login Google: ' + (r.error_description || r.error)));
          D.token = r.access_token; D.exp = Date.now() + (+r.expires_in || 3600) * 1000; res(D.token);
        },
        error_callback: e => rej(new Error(`Login Google cancelado ou bloqueado (${e?.type || 'erro'}).`)),
      });
      tc.requestAccessToken({ prompt: '' });
    });
  }

  async function gfetch(url, opts = {}) {
    const tok = await driveToken(false);
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tok } });
    if (r.status === 401) { D.token = ''; throw new Error('NEEDS_AUTH'); }
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return r;
  }

  const gq = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function driveFind(name, parent, folder = false) {
    const qs = `name = '${gq(name)}' and '${parent}' in parents and trashed = false` + (folder ? " and mimeType = 'application/vnd.google-apps.folder'" : '');
    const j = await (await gfetch(`${DRIVE}/files?q=${encodeURIComponent(qs)}&fields=${encodeURIComponent('files(id,name)')}&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=10&spaces=drive`)).json();
    return j.files?.[0]?.id || '';
  }
  async function driveFolder(name, parent) {
    return (await driveFind(name, parent, true)) || (await (await gfetch(`${DRIVE}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
    })).json()).id;
  }
  async function drivePath(parts) {
    let parent = D.folder;
    for (let i = 0; i < parts.length; i++) {
      const k = parts.slice(0, i + 1).join('/');
      parent = D.paths[k] || (D.paths[k] = await driveFolder(parts[i], parent));
    }
    return parent;
  }
  async function driveUpload({ name, blob, parent, id }) {
    const b = 'aicampus' + Math.random().toString(36).slice(2), meta = id ? { name } : { name, parents: [parent] };
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${b}--`]);
    const r = await gfetch(`${DRIVE_UP}/files${id ? '/' + id : ''}?uploadType=multipart&fields=id`, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    return (await r.json()).id;
  }
  async function driveGet(id, asBlob = false) {
    const r = await gfetch(`${DRIVE}/files/${id}?alt=media`);
    return asBlob ? r.blob() : r.json();
  }
  async function driveMove(id, parent) {
    const j = await (await gfetch(`${DRIVE}/files/${id}?fields=parents`)).json();
    const velhos = (j.parents || []).filter(x => x !== parent);
    if (!velhos.length) return;
    await gfetch(`${DRIVE}/files/${id}?addParents=${encodeURIComponent(parent)}&removeParents=${encodeURIComponent(velhos.join(','))}&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }
  function driveDelete(id) { gfetch(`${DRIVE}/files/${id}`, { method: 'DELETE' }).catch(() => { /* melhor esforço */ }); }

  // Sincroniza: traz o estado do Drive, funde, grava e envia de volta (estado, ficheiros novos e o seu texto).
  async function syncDrive({ interactive = true } = {}) {
    if (D.busy) return false;
    if (S.busy) { if (interactive) toast('Espera que a resposta termine para sincronizar.'); return false; }
    D.busy = true; syncBadge('busy');
    try {
      await driveToken(interactive);
      if (!D.folder) { D.folder = await driveFolder('AI Campus', 'root'); lset('gfolder', D.folder); }
      const stateId = await driveFind(STATE_NAME, D.folder);
      const macId = await driveFind(MAC_NAME, D.folder); // ficheiros que o Mac enviou (enviar_telemovel.py)
      let novos = false;
      if (stateId || macId) {
        const remote = stateId ? await driveGet(stateId) : null;
        let mac = null;
        if (macId) { try { mac = await driveGet(macId); } catch (e) { if (e.message === 'NEEDS_AUTH') throw e; /* a lista do Mac a meio de ser escrita: fica para a próxima */ } }
        novos = await applyState(Core.mergeSync(await collectState(), mac ? Core.withMac(remote, mac) : remote), { fetchIndex: true });
      }
      for (const f of await DB.all('files')) {
        let dirty = false;
        if (f.blob && !f.driveId && f.blob.size <= MAX_DRIVE_FILE) {
          const parent = await drivePath(Core.driveParts(f));      // materias/<UC>/<tipo>/<tema>/
          f.driveId = await driveUpload({ name: f.name, blob: f.blob, parent }); delete f.mover; dirty = true;
        }
        if (f.driveId && f.mover) { // mudou de tipo ou de tema: passa para a pasta nova (se já não existir no Drive, deixa estar)
          try { await driveMove(f.driveId, await drivePath(Core.driveParts(f))); } catch (e) { if (e.message === 'NEEDS_AUTH') throw e; }
          delete f.mover; dirty = true;
        }
        if (!f.idxId) {
          const cs = Core.sortChunks(await DB.byIndex('chunks', 'fileId', f.id)).map(({ emb, embM, ...c }) => c);
          if (cs.length) { f.idxId = await driveUpload({ name: `chunks-${f.id}.json`, blob: new Blob([JSON.stringify(cs)], { type: 'application/json' }), parent: await drivePath(['index']) }); dirty = true; }
        }
        if (dirty) await DB.put('files', f);
      }
      await driveUpload({ name: STATE_NAME, blob: new Blob([JSON.stringify(await collectState())], { type: 'application/json' }), parent: D.folder, id: stateId });
      D.last = Date.now(); lset('glast', D.last); D.pending = false; syncBadge('ok');
      if (novos) embedMissing().catch(() => { /* a pesquisa fica só por palavras até haver quota */ });
      return true;
    } catch (e) {
      if (e.message === 'NEEDS_AUTH') { D.pending = true; syncBadge('auth'); }
      else { syncBadge('err', e.message); toast('Drive: ' + e.message, 6000); }
      return false;
    } finally { D.busy = false; }
  }

  // ------------------------------------------------------------ 🙂 👍/👎, aprender com as conversas e a memória nas Definições
  function opiniao(i, m, tipo) {
    const q = (S.chat.messages[i - 1] || {}).content || '', uc = (m.ucs || [])[0] || '', gid = `g:${S.chat.id}:${i}`;
    let al = alunoGet();
    const semGosto = a => ({ ...a, gostos: a.gostos.filter(g => g.id !== gid), del: { ...a.del, ...(a.gostos.some(g => g.id === gid) ? { [gid]: Date.now() } : {}) } });
    if (tipo === 'up') {
      if (m.fb === 'up') { delete m.fb; alunoSet(semGosto(al)); toast('👍 retirado.'); }
      else {
        m.fb = 'up'; delete m.fbWhy;
        al = semGosto(al); delete al.del[gid];
        al.gostos = [{ id: gid, t: Date.now(), uc, perfil: (byKey[uc] || {}).perfil || 'geral', q: q.slice(0, 240), a: m.content.slice(0, 1200) }, ...al.gostos];
        al.fb = [{ id: uuid(), t: Date.now(), uc, tipo: 'gostei' }, ...al.fb];
        alunoSet(al); toast('👍 Obrigado! As próximas respostas vão seguir este tom.');
      }
    } else if (tipo === 'down') {
      if (m.fb === 'down') { delete m.fb; delete m.fbWhy; }
      else { m.fb = 'down'; delete m.fbWhy; alunoSet(semGosto(al)); }
    } else if (Core.FB_TIPOS[tipo]) { // o porquê do 👎
      m.fbWhy = tipo;
      alunoAdd('fb', { uc, tipo });
      if (tipo === 'errada' && m.ck) DB.del('cache', m.ck).catch(() => {}); // uma resposta errada deixa de ser reutilizada
      toast(tipo === 'errada' ? 'Anotado: esta resposta já não volta da 💾 cache. Usa 🔄 ou pergunta de outra forma.' : `Anotado (${Core.FB_TIPOS[tipo]}): as próximas respostas vão ter isso em conta.`, 5000);
    }
    const el = document.querySelector(`#msgs .msg[data-i="${i}"]`);
    if (el) paintAssistant(el, m, false);
    saveChat();
  }

  // A cada 6 perguntas, um pedido rápido (grátis) tira até 2 notas sobre o aluno da conversa. Nunca com o Claude (gasta saldo).
  async function aprender() {
    const al = alunoGet();
    if (!al.auto || isClaude() || !haveGen()) return;
    const n = (+ls('memN', '0') || 0) + 1; lset('memN', n);
    if (n % 6) return;
    const msgs = S.chat.messages.filter(m => m.content && !m.error);
    if (msgs.length < 2) return;
    try {
      const raw = await aiText({ system: Core.FACTOS_SYSTEM, parts: [{ text: Core.factosPrompt(al, msgs) }], temperature: 0, json: true, fast: true });
      const novos = Core.parseFactos(raw, alunoGet()), uc = (msgs[msgs.length - 1].ucs || [])[0];
      if (novos.length) { const a = alunoGet(); a.factos = [...novos.map(txt => ({ id: uuid(), t: Date.now(), ...(uc ? { uc } : {}), txt })), ...a.factos]; alunoSet(a); }
    } catch (e) { /* sem quota agora: aprende da próxima vez */ }
  }

  function renderMemoria() {
    const al = alunoGet(), box = $('#alMem'); box.innerHTML = '';
    const linha = (lista, e, txt) => {
      const d = document.createElement('div'); d.className = 'item mem';
      d.innerHTML = `<span class="t">${Core.esc(txt)}</span><button type="button" aria-label="esquecer" title="Esquecer">✕</button>`;
      d.querySelector('button').onclick = () => { const a = alunoGet(); a[lista] = a[lista].filter(x => x.id !== e.id); a.del = { ...a.del, [e.id]: Date.now() }; alunoSet(a); renderMemoria(); };
      box.appendChild(d);
    };
    al.factos.forEach(f => linha('factos', f, `🧠 ${f.txt}${f.uc && byKey[f.uc] ? ` (${byKey[f.uc].nome})` : ''}`));
    al.dif.forEach(d => linha('dif', d, `✏️ errou: ${d.txt}${byKey[d.uc] ? ` (${byKey[d.uc].nome})` : ''}`));
    const pr = Core.prefsAluno(al);
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = `${al.gostos.length} resposta(s) com 👍 usadas como exemplo do tom` + (pr.length ? ` · pelo 👍/👎: ${pr.join('; ')}` : '') +
      (!al.factos.length && !al.dif.length ? ' · ainda não aprendeu nada sobre ti.' : '.');
    box.appendChild(p);
  }

  // Agenda uma sincronização silenciosa; se o login Google expirou, só marca "por sincronizar".
  function markDirty() {
    if (!D.on) return;
    clearTimeout(D.timer);
    D.timer = setTimeout(async () => {
      if (S.busy) return markDirty();
      if (tokenOk()) await syncDrive({ interactive: false }); else { D.pending = true; syncBadge('auth'); }
    }, 15000);
  }

  // ------------------------------------------------------------ 🎓 semestres e UCs
  // As listas de UCs (barra lateral, biblioteca, estudo, exames) são as do semestre ativo. Mantém a escolha se ainda existir.
  function renderUcSelects() {
    const opts = UCS.map(u => `<option value="${Core.esc(u.key)}">${Core.esc(u.emoji)} ${Core.esc(u.nome)}</option>`).join('');
    const prev = { mode: $('#mode').value || ls('mode', 'auto'), lib: $('#libUc').value, st: $('#stUc').value, ex: $('#exUc').value };
    $('#mode').innerHTML = '<option value="auto">🤖 Automático</option>' + opts;
    $('#libUc').innerHTML = opts; $('#stUc').innerHTML = opts; $('#exUc').innerHTML = opts;
    $('#mode').value = prev.mode === 'auto' || Core.isActive(prev.mode) ? prev.mode : 'auto';
    if (Core.isActive(prev.lib)) $('#libUc').value = prev.lib;
    else if ($('#mode').value !== 'auto') $('#libUc').value = $('#mode').value; // a biblioteca mostra a UC que está ativa
    if (Core.isActive(prev.st)) $('#stUc').value = prev.st;
    if (Core.isActive(prev.ex)) $('#exUc').value = prev.ex;
    const sem = Core.semestres().lista.find(x => x.id === semId());
    $('#semBtn').textContent = `🎓 ${sem ? sem.nome : 'Semestre'}`;
  }
  // Depois de mudar de semestre ou de UCs: listas, conversas, biblioteca, baralho e o ecrã inicial.
  function applySemUI() {
    renderUcSelects();
    if (S.chat && Core.semOf(S.chat) !== semId() && !S.busy) newChat();
    else { renderChatList(); if (S.chat && !S.chat.messages.length) paintChat(); }
    renderFiles(); refreshDue();
    if ($('#semDlg').open) renderSem();
  }
  function saveSemestres(s) { Core.setSemestres(s); jset('semestres', Core.semestres()); markDirty(); applySemUI(); }
  function editSem(fn) { // muda o semestre ativo e grava (com a hora, para a sincronização saber qual é o mais recente)
    const s = Core.semestres(), act = s.lista.find(x => x.id === s.atual);
    fn(act, s); act.upd = Date.now(); saveSemestres(s);
  }
  async function ucUsage(key) { // ficheiros, cartas e exames de uma UC (uma UC com dados não se tira: nada se perde)
    const [fs, cs] = await Promise.all([DB.byIndex('files', 'uc', key), DB.byIndex('cards', 'uc', key)]);
    return fs.length + cs.length + jget('exams', []).filter(e => e.uc === key).length;
  }
  const perfilDesc = k => {
    const P = Core.PERFIS[k] || Core.PERFIS.geral;
    return [P.tool === 'code' ? 'calcula com código' : 'pesquisa e argumenta, sem calculadora', P.verify && 'contas confirmadas por um 2.º motor',
      P.so && 'consulta o Stack Overflow', P.paper && 'consulta artigos científicos'].filter(Boolean).join(' · ');
  };
  let ucEdit = null; // chave da UC em edição (null = acrescentar uma nova)
  function ucFormFill(u) {
    ucEdit = u ? u.key : null;
    $('#ucNome').value = u ? u.nome : ''; $('#ucEmoji').value = u ? u.emoji : ''; $('#ucPerfil').value = u ? u.perfil : 'geral';
    $('#ucKw').value = u ? u.kw || '' : ''; $('#ucBack').value = u ? u.back || '' : '';
    $('#ucGuardar').textContent = u ? '💾 Guardar alterações' : '＋ Acrescentar'; $('#ucCancelar').hidden = !u;
    $('#ucFormTit').textContent = u ? `✏️ ${u.nome}` : '＋ Acrescentar UC'; $('#ucPerfilDesc').textContent = perfilDesc($('#ucPerfil').value);
    if (u) $('#ucFormBox').open = true;
  }
  function renderSem() {
    const s = Core.semestres(), act = s.lista.find(x => x.id === s.atual);
    $('#semSel').innerHTML = s.lista.map(x => `<option value="${Core.esc(x.id)}">${Core.esc(x.nome)} · ${x.ucs.length} UC${x.ucs.length === 1 ? '' : 's'}</option>`).join('');
    $('#semSel').value = s.atual; $('#semRen').value = act.nome; $('#semDel').hidden = s.lista.length < 2;
    const box = $('#semUcs'); box.innerHTML = '';
    if (!act.ucs.length) box.innerHTML = '<p class="hint">Este semestre ainda não tem UCs: acrescenta-as em baixo (ao escrever o nome aparecem as mais comuns).</p>';
    act.ucs.forEach((u, i) => {
      const d = document.createElement('div'); d.className = 'item urow';
      d.innerHTML = `<span>${Core.esc(u.emoji)}</span><span class="t">${Core.esc(u.nome)}<small> · ${Core.esc((Core.PERFIS[u.perfil] || Core.PERFIS.geral).nome)}</small></span>` +
        '<button type="button" aria-label="editar">✏️</button><button type="button" aria-label="subir">↑</button><button type="button" aria-label="descer">↓</button><button type="button" aria-label="tirar">✕</button>';
      const [ed, up, dn, del] = d.querySelectorAll('button');
      ed.onclick = () => ucFormFill(u);
      const mover = k => editSem(x => { const j = i + k; if (j >= 0 && j < x.ucs.length) x.ucs.splice(j, 0, x.ucs.splice(i, 1)[0]); });
      up.onclick = () => mover(-1); dn.onclick = () => mover(1);
      del.onclick = async () => {
        const n = await ucUsage(u.key);
        if (n) { $('#semMsg').textContent = `«${u.nome}» já tem ${n} ficheiro(s), carta(s) ou exame(s): não a tiro, para nada se perder. Para mudar de UCs, cria um semestre novo.`; return; }
        if (!confirm(`Tirar «${u.nome}» deste semestre?`)) return;
        editSem(x => { x.ucs = x.ucs.filter(y => y.key !== u.key); });
        if (ucEdit === u.key) ucFormFill(null);
      };
      box.appendChild(d);
    });
  }
  function openSem() {
    closeSide(); renderSem(); ucFormFill(null); $('#semMsg').textContent = ''; $('#semDlg').showModal();
  }
  function initSem() {
    $('#semBtn').onclick = openSem;
    $('#ucPerfil').innerHTML = Object.entries(Core.PERFIS).map(([k, P]) => `<option value="${k}">${Core.esc(P.nome)}</option>`).join('');
    $('#ucCatalogo').innerHTML = Core.CATALOGO_UCS.map(c => `<option value="${Core.esc(c.nome)}">`).join('');
    $('#ucPerfil').onchange = () => { $('#ucPerfilDesc').textContent = perfilDesc($('#ucPerfil').value); };
    $('#ucNome').oninput = () => { // um nome do catálogo preenche o tipo, o emoji e as palavras-chave (só ao acrescentar)
      if (ucEdit) return;
      const c = Core.CATALOGO_UCS.find(x => Core.normQ(x.nome) === Core.normQ($('#ucNome').value));
      if (!c) return;
      $('#ucPerfil').value = c.perfil; $('#ucPerfilDesc').textContent = perfilDesc(c.perfil);
      if (!$('#ucEmoji').value) $('#ucEmoji').value = c.emoji;
      if (!$('#ucKw').value) $('#ucKw').value = c.kw;
    };
    $('#ucCancelar').onclick = () => ucFormFill(null);
    $('#ucGuardar').onclick = () => {
      const nome = $('#ucNome').value.replace(/\s+/g, ' ').trim();
      if (!nome) { $('#semMsg').textContent = 'Escreve o nome da UC.'; return; }
      const d = { nome, emoji: $('#ucEmoji').value.trim(), perfil: $('#ucPerfil').value, kw: $('#ucKw').value.trim(), back: $('#ucBack').value.trim() };
      const repetida = UCS.find(u => Core.normQ(u.nome) === Core.normQ(nome) && u.key !== ucEdit);
      if (repetida) { $('#semMsg').textContent = `Já existe «${repetida.nome}» neste semestre.`; return; }
      if (ucEdit) {
        const key = ucEdit;
        editSem(x => {
          const u = x.ucs.find(y => y.key === key); if (!u) return;
          if (u.nome !== nome) for (const k of ['role', 'ex']) if (u[k]) u[k] = u[k].split(u.nome).join(nome); // a personalidade acompanha o nome novo
          Object.assign(u, { nome, emoji: d.emoji || u.emoji, perfil: d.perfil });
          for (const k of ['kw', 'back']) { if (d[k]) u[k] = d[k]; else delete u[k]; }
        });
        $('#semMsg').textContent = `✅ «${nome}» atualizada.`;
      } else {
        const u = Core.newUC(d, Core.semestres());
        editSem(x => { x.ucs.push(u); });
        $('#semMsg').textContent = `✅ «${nome}» acrescentada (${perfilDesc(u.perfil)}).`;
      }
      ucFormFill(null);
    };
    $('#semSel').onchange = () => {
      const s = Core.semestres(); s.atual = $('#semSel').value; s.atualUpd = Date.now(); saveSemestres(s);
      $('#semMsg').textContent = `🎓 Agora estás em «${s.lista.find(x => x.id === s.atual).nome}». Os outros semestres ficam guardados.`;
    };
    $('#semRen').onchange = () => { const n = $('#semRen').value.replace(/\s+/g, ' ').trim(); if (n) editSem(x => { x.nome = n; }); };
    $('#semCriar').onclick = () => {
      const s = Core.semestres(), nome = $('#semNome').value.replace(/\s+/g, ' ').trim() || `Semestre ${s.lista.length + 1}`;
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      s.lista.push({ id, nome, upd: Date.now(), ucs: [] }); s.atual = id; s.atualUpd = Date.now();
      saveSemestres(s); $('#semNome').value = ''; ucFormFill(null); $('#ucFormBox').open = true;
      $('#semMsg').textContent = `🆕 «${nome}» criado e ativo. Acrescenta as UCs em baixo. O semestre anterior fica guardado: voltas a ele quando quiseres.`;
    };
    $('#semDel').onclick = async () => {
      const s = Core.semestres(), act = s.lista.find(x => x.id === s.atual);
      let n = 0;
      for (const u of act.ucs) n += await ucUsage(u.key);
      n += S.chats.filter(c => Core.semOf(c) === act.id).length + getPlan().items.filter(p => Core.semOf(p) === act.id).length;
      if (n) { $('#semMsg').textContent = `«${act.nome}» tem conversas, ficheiros, cartas ou plano: não o apago (podes só mudar de semestre).`; return; }
      if (!confirm(`Apagar o semestre «${act.nome}» (está vazio)?`)) return;
      s.lista = s.lista.filter(x => x.id !== act.id); s.apagados = { ...s.apagados, [act.id]: Date.now() };
      s.atual = s.lista[0].id; s.atualUpd = Date.now(); saveSemestres(s);
      $('#semMsg').textContent = `🗑️ «${act.nome}» apagado.`;
    };
    $('#semExport').onclick = () => download('ucs.json', 'application/json', JSON.stringify({ app: 'ai-campus', tipo: 'semestres', ...Core.semestres() }, null, 1));
  }

  // ------------------------------------------------------------ arranque
  const closeSide = () => document.body.classList.remove('side-open');

  // Motor ativo: o seletor da barra lateral, a caixa das fontes/pesquisa web (cada família com o seu interruptor) e o que as Definições testam.
  function applyEngineUI() {
    $('#engine').value = S.engine;
    $('#webLbl').textContent = isClaude() ? '🌐 Pesquisar na web (além do cálculo; paga)' : '🌐 Fontes externas (Wikipédia, Stack Overflow, artigos, web)';
    $('#web').checked = ls(webKey(), isClaude() ? '0' : '1') === '1';
    $('#engNow').textContent = engineName();
    document.body.dataset.engine = S.engine;
  }

  function init() {
    renderUcSelects(); initSem();
    $('#estilo').value = ls('estilo', 'tutor');
    $('#mode').onchange = () => { lset('mode', $('#mode').value); if ($('#mode').value !== 'auto') { $('#libUc').value = $('#mode').value; renderFiles(); } };
    $('#estilo').onchange = () => lset('estilo', $('#estilo').value);
    $('#web').onchange = () => lset(webKey(), $('#web').checked ? '1' : '0');
    applyEngineUI();
    $('#engine').onchange = () => {
      S.engine = ENGINES.includes($('#engine').value) ? $('#engine').value : 'auto'; lset('gengine', S.engine); applyEngineUI();
      if (!haveGen()) openSettings(isClaude() ? 'Cola a tua chave da API Anthropic (sk-ant-…) para usar o Claude.' : isAuto() ? NEED_FREE : 'Cola a tua chave Gemini para usar o Gemini.');
    };
    // motores grátis (Definições)
    $('#chainP').innerHTML = Object.entries(Core.PROVIDERS).map(([k, P]) => `<option value="${k}">${P.icon} ${P.nome}</option>`).join('');
    $('#chainP').onchange = () => chainModels($('#chainP').value);
    $('#chainAdd').onclick = () => {
      const m = $('#chainM').value.trim();
      if (!m) { $('#freeMsg').textContent = 'Escreve o nome do modelo (a lista sugere alguns).'; return; }
      S.chainDraft.push({ p: $('#chainP').value, m }); $('#chainM').value = ''; renderChain();
    };
    $('#chainDefault').onclick = () => { S.chainDraft = Core.DEFAULT_CHAIN.map(l => ({ ...l })); renderChain(); };
    $('#chainClear').onclick = () => { S.cstate = Core.newChainState(); saveCState(); renderChain(); $('#freeMsg').textContent = 'Estados limpos: a app volta a experimentar todos os motores.'; };
    $('#orModels').onclick = async () => { // lista pública do OpenRouter: os modelos grátis que aceitam ferramentas (para o cálculo)
      $('#freeMsg').textContent = '⏳ A ver os modelos grátis do OpenRouter…';
      try {
        const j = await getJSON('https://openrouter.ai/api/v1/models', undefined);
        const ids = (j.data || []).filter(x => /:free$/.test(x.id || '') && (x.supported_parameters || []).includes('tools')).map(x => x.id).sort();
        $('#chainP').value = 'openrouter';
        $('#chainModels').innerHTML = ids.map(id => `<option value="${Core.esc(id)}">`).join('');
        $('#freeMsg').textContent = ids.length ? `${ids.length} modelos grátis com ferramentas: escolhe um no campo do modelo e carrega em ＋.` : 'Não encontrei modelos grátis com ferramentas agora.';
      } catch (e) { $('#freeMsg').textContent = '⚠️ Não consegui ver a lista do OpenRouter: ' + e.message; }
    };
    $('#pyTest').onclick = async () => {
      $('#freeMsg').textContent = '⏳ A preparar o Python…';
      const out = await pyRun('import sympy as sp\nx = sp.symbols("x")\nprint(sp.integrate(x**2, (x, 0, 3)))\nprint(123*456)', undefined, s => { $('#freeMsg').textContent = '⏳ ' + s; });
      $('#freeMsg').textContent = out.startsWith('ERRO') ? '⚠️ ' + out : `✅ Python no telemóvel a funcionar: ${out.replace(/\n/g, ' · ')}`;
    };
    $('#libUc').onchange = renderFiles; $('#libFiltro').onchange = renderFiles;
    $('#libTipo').innerHTML = '<option value="auto">Tipo: pelo ficheiro</option>' + Object.entries(Core.TIPOS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    $('#fdGuardar').onclick = saveFileEdit;
    // cache, verificação e ordem automática (Definições)
    $('#adaptOn').onchange = renderChain; // mostra logo o que o 🧠 desceria
    $('#cacheClear').onclick = async () => {
      try { await DB.clear('cache'); } catch (e) { /* ignora */ }
      extCache.clear(); cacheInfo();
      $('#freeMsg').textContent = '';
      $('#setMsg').textContent = '🧹 Cache limpa: as próximas perguntas vão todas aos motores.';
    };

    $('#openSide').onclick = () => document.body.classList.add('side-open');
    $('#closeSide').onclick = closeSide; $('#overlay').onclick = closeSide;
    $('#newChat').onclick = () => { newChat(); closeSide(); };
    $('#expChat').onclick = exportChat;

    $('#addFile').onclick = () => $('#fileIn').click();
    $('#fileIn').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
    $('#camBtn').onclick = () => $('#imgIn').click();
    $('#imgIn').onchange = async e => {
      for (const f of e.target.files) { try { S.images.push(await compressImage(f)); } catch (err) { toast('Não consegui ler a imagem.'); } }
      e.target.value = ''; renderChips();
    };
    // 📷 Capturas de ecrã também se colam (⌘V / Ctrl+V, ou «Colar» no teclado do telemóvel) ou se arrastam para a caixa da pergunta.
    const addImgs = async fs => {
      const imgs = fs.filter(f => f && /^image\//.test(f.type));
      for (const f of imgs) { try { S.images.push(await compressImage(f)); } catch (err) { toast('Não consegui ler a imagem.'); } }
      if (imgs.length) { renderChips(); toast(`📷 ${imgs.length} imagem(ns) junta(s) à pergunta`, 2500); }
      return imgs.length;
    };
    $('#input').addEventListener('paste', e => {
      const fs = [...(e.clipboardData?.items || [])].filter(it => it.kind === 'file').map(it => it.getAsFile());
      if (fs.some(f => f && /^image\//.test(f.type))) { e.preventDefault(); addImgs(fs); }
    });
    $('#composer').addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    $('#composer').addEventListener('drop', e => { const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) { e.preventDefault(); addImgs(fs); } });

    const input = $('#input');
    input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
    input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } };
    $('#composer').onsubmit = e => { e.preventDefault(); send(); };
    $('#msgs').addEventListener('click', e => {
      const who = e.target.closest('.tags .by'); // no telemóvel não há "title" ao passar o rato: um toque mostra quem respondeu e quem falhou
      if (who) { toast(who.title, 9000, true); return; }
      const w = e.target.closest('[data-why]');
      if (w) { const i = +w.closest('.msg').dataset.i, m = S.chat.messages[i]; if (m) opiniao(i, m, w.dataset.why); return; }
      const b = e.target.closest('[data-act]'); if (!b) return;
      const i = +b.closest('.msg').dataset.i, m = S.chat.messages[i]; if (!m) return;
      if (b.dataset.act === 'redo') redo(i);
      else if (b.dataset.act === 'up' || b.dataset.act === 'down') opiniao(i, m, b.dataset.act);
      else exportMsg(b.dataset.act, m);
    });

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) $('#micBtn').hidden = true;
    else $('#micBtn').onclick = () => {
      if (S.rec) { S.rec.stop(); return; }
      const rec = S.rec = new SR(); rec.lang = 'pt-PT'; rec.interimResults = true;
      const base = input.value ? input.value + ' ' : '';
      rec.onresult = ev => { input.value = base + [...ev.results].map(r => r[0].transcript).join(''); input.oninput(); };
      rec.onend = () => { S.rec = null; $('#micBtn').textContent = '🎤'; };
      rec.onerror = () => toast('Não consegui usar o microfone (permissão?).');
      $('#micBtn').textContent = '🔴'; rec.start();
    };

    // definições
    $('#setBtn').onclick = () => { closeSide(); openSettings(); };
    $('#settings').addEventListener('close', () => { if ($('#settings').returnValue === 'ok') saveSettings(); });
    $('#setCancel').onclick = () => $('#settings').close('cancel'); // sem botão "submit" a Cancelar, Enter num campo grava (Guardar é o botão por omissão)
    for (const id of ['#study', '#plan', '#semDlg', '#fileDlg']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
    $('#testKey').onclick = async () => {
      $('#setMsg').textContent = '⏳ A testar…';
      if (isClaude()) { // testa o que está escrito nos campos, mesmo sem gravar
        S.diag = true;
        try {
          const t = await withTyped(() => aiText({ system: 'Responde em 1 frase.', parts: [{ text: 'Responde apenas: ok' }], fast: true }, undefined, { retries: 0 }));
          $('#setMsg').textContent = '✅ Ligação OK: ' + t.trim().slice(0, 40);
        } catch (e) { $('#setMsg').textContent = '⚠️ ' + e.message; } finally { S.diag = false; }
        return;
      }
      const key = $('#keyIn').value.trim() || S.key, model = $('#modelIn').value.trim() || 'gemini-flash-latest';
      try {
        const j = await (await fetchGemini('generateContent', { contents: [{ role: 'user', parts: [{ text: 'Responde apenas: ok' }] }] }, undefined, model, key)).json();
        $('#setMsg').textContent = '✅ Ligação OK: ' + (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().slice(0, 40);
      } catch (e) { $('#setMsg').textContent = '⚠️ ' + e.message; }
    };
    $('#diagBtn').onclick = diagnose;
    $('#exportBtn').onclick = exportBackup; $('#shareBtn').onclick = shareBackup;
    $('#importBtn').onclick = () => $('#importIn').click();
    $('#alLimpar').onclick = () => {
      if (!confirm('Esquecer tudo o que os agentes aprenderam sobre ti (notas, erros, 👍/👎)? O nome e o «sobre ti» ficam.')) return;
      const a = alunoGet(), del = { ...a.del };
      for (const k of ['factos', 'dif', 'gostos', 'fb']) a[k].forEach(e => { del[e.id] = Date.now(); });
      alunoSet({ ...a, factos: [], dif: [], gostos: [], fb: [], del }); renderMemoria();
    };
    $('#importIn').onchange = e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; };
    $('#reindexBtn').onclick = async () => {
      $('#setMsg').textContent = '⏳ A indexar por significado…'; S.embModel = null;
      const r = await embedMissing((d, t) => { $('#setMsg').textContent = `⏳ A indexar por significado… ${d}/${t}`; });
      $('#setMsg').textContent = !r.todo ? 'Tudo já indexado.' : r.done === r.todo ? `✅ ${r.done} excertos indexados.` : `⚠️ ${r.done}/${r.todo} indexados (sem modelo de embeddings ou limite de quota). Volta a carregar para continuar.`;
    };
    $('#wipeBtn').onclick = async () => {
      if (!confirm('Apagar TODAS as conversas, baralho, plano e a biblioteca deste telemóvel?' + (D.on ? '\n\nOs dados que já estão no Drive não são apagados e voltam na próxima sincronização: carrega em "Desligar" primeiro se não os queres.' : ''))) return;
      await DB.clearAll(); ['exams', 'plan', 'actlog', 'tomb'].forEach(k => localStorage.removeItem(k)); libBump(); extCache.clear();
      S.idx.clear(); S.pinned.clear(); await loadChats(); newChat(); renderFiles(); renderChips(); refreshDue();
      $('#setMsg').textContent = 'Tudo apagado (a chave mantém-se).';
    };

    // Drive
    $('#gConnect').onclick = async () => {
      const id = $('#gClient').value.trim();
      if (!id) return gStatus('Cola primeiro o Client ID (ver GUIA_DRIVE.md).');
      D.clientId = id; lset('gclient', id); D.token = ''; D.exp = 0; D.folder = ''; D.paths = {}; lset('gfolder', '');
      D.on = true; lset('gdrive', '1'); gStatus('⏳ A ligar…');
      const ok = await syncDrive({ interactive: true });
      gStatus(ok ? '✅ Ligado e sincronizado.' : '⚠️ Não consegui sincronizar (vê a mensagem). Se o login foi bloqueado, permite pop-ups para este site.');
    };
    $('#gSync').onclick = async () => {
      if (!D.on) return gStatus('Liga primeiro ao Drive.');
      gStatus('⏳ A sincronizar…'); const ok = await syncDrive({ interactive: true }); gStatus(ok ? '✅ ' + driveStatusText() : '⚠️ Não consegui sincronizar.');
    };
    $('#gDisc').onclick = () => {
      try { if (D.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(D.token, () => {}); } catch (e) { /* ignora */ }
      D.on = false; D.token = ''; D.exp = 0; D.folder = ''; D.paths = {}; lset('gdrive', '0'); lset('gfolder', '');
      syncBadge('idle'); gStatus('Desligado. Os dados que já estão no Drive e os do telemóvel mantêm-se.');
    };
    $('#syncBtn').onclick = () => syncDrive({ interactive: true });
    syncBadge(D.on ? 'auth' : 'idle');
    // O login Google só abre com um toque do utilizador: se a sessão expirou, o primeiro toque na app volta a sincronizar
    // (no máximo de 2 em 2 minutos, para não insistir se o utilizador cancelar o pop-up).
    let lastTry = 0;
    addEventListener('click', e => {
      if (!D.on || D.busy || e.target.closest('#settings, #syncBtn')) return;
      if (!(D.pending || !D.last || Date.now() - D.last > 600000) || Date.now() - lastTry < 120000) return;
      lastTry = Date.now(); syncDrive({ interactive: true });
    }, true);
    document.addEventListener('visibilitychange', () => { // ao voltar à app, sincroniza em silêncio se o login ainda é válido
      if (document.visibilityState === 'visible' && D.on && tokenOk() && Date.now() - D.last > 300000) syncDrive({ interactive: false });
    });

    // estudo, plano, progresso
    $('#studyBtn').onclick = () => openStudy();
    $('#stGo').onclick = generateStudy;
    $('#stTema').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); generateStudy(); } };
    $('#planBtn').onclick = openPlan;
    $('#progBtn').onclick = openProgress;
    $('#exAdd').onclick = () => {
      if (!UCS.length) { $('#planMsg').textContent = 'Este semestre ainda não tem UCs: acrescenta-as em 🎓.'; return; }
      const data = $('#exDate').value; if (!data) { $('#planMsg').textContent = 'Escolhe a data.'; return; }
      const ex = jget('exams', []); ex.push({ id: uuid(), uc: $('#exUc').value, data, nome: $('#exName').value.trim() || 'Exame' });
      jset('exams', ex); markDirty(); $('#exName').value = ''; $('#planMsg').textContent = ''; renderPlan();
    };
    $('#exName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#exAdd').click(); } };
    $('#planGo').onclick = genPlan;
    $('#icsBtn').onclick = exportICS;

    const net = () => ($('#net').hidden = navigator.onLine);
    addEventListener('online', net); addEventListener('offline', net); net();

    navigator.storage?.persist?.();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    newChat(); loadChats(); renderFiles(); refreshDue();
    setTimeout(cachePruneAll, 3000); // arrumação da cache (prazos e máximos), sem atrasar o arranque
    const go =new URLSearchParams(location.search).get('go'); // atalhos do ícone da app
    if (go === 'review') openStudy('rever'); else if (go === 'plan') openPlan(); else if (go === 'progress') openProgress();
    else if (!haveGen()) setTimeout(() => openSettings(isClaude() ? 'Bem-vindo! Cola a tua chave da API Anthropic para começar (ou muda o motor para Gemini na barra lateral).'
      : 'Bem-vindo! Cola a tua chave Gemini grátis para começar.' + (isAuto() ? ' Em 🔁 Motores grátis podes juntar mais motores para teres mais perguntas por dia.' : '')), 400);
  }

  init();
})();
