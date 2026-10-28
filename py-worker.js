/* Python no telemóvel (Pyodide, WebAssembly) num worker à parte: corre os cálculos que os motores grátis pedem com a ferramenta
   «python», sem servidor. Carrega da primeira vez (~20 MB, depois fica na cache da app). Mensagens: { id, code } -> { id, phase: 'run' }
   quando começa a correr, e no fim { id, ok, out }. A app mede o tempo e pára o worker se o código não terminar. */
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/';
let ready = null;

async function boot() {
  const { loadPyodide } = await import(PYODIDE + 'pyodide.mjs');
  const py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage(['sympy']);
  return py;
}

self.onmessage = async ({ data }) => {
  const { id, code } = data || {};
  try {
    if (!ready) ready = boot().catch(e => { ready = null; throw e; });
    const py = await ready;
    self.postMessage({ id, phase: 'run' });
    await py.loadPackagesFromImports(code); // numpy & companhia só se o código os importar
    let out = '';
    const write = s => { if (out.length < 20000) out += s + '\n'; };
    py.setStdout({ batched: write });
    py.setStderr({ batched: write });
    const ns = py.globals.get('dict')(); // cada cálculo num espaço de nomes limpo
    let r;
    try {
      r = await py.runPythonAsync(code, { globals: ns });
      if (r !== undefined && r !== null) write(String(r));
    } finally {
      if (r && typeof r.destroy === 'function') r.destroy();
      ns.destroy();
    }
    self.postMessage({ id, ok: true, out: out.trimEnd() || '(sem output: usa print() para mostrar os resultados)' });
  } catch (e) {
    self.postMessage({ id, ok: false, out: String((e && e.message) || e).slice(-4000) });
  }
};
