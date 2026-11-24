// Put screener frontend: setup → live scan → results, polling /api/scan.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (v, d = 2) => (typeof v === 'number' ? v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : esc(v ?? '-'));
  const strikeFmt = (k) => k.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const trimNum = (n, dp) => Number(n.toFixed(dp)).toString();
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  let scan = null;          // last snapshot from the server
  let logSeq = 0;
  let pollTimer = null;
  let view = 'grouped';

  // ── views / routing ─────────────────────
  function show(name) {
    for (const v of ['setup', 'scan', 'results']) $(`view-${v}`).hidden = v !== name;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
    window.scrollTo(0, 0);
  }

  function route() {
    const h = location.hash.replace('#', '') || '/';
    if (h === '/scan' && scan && isRunning(scan)) return show('scan');
    if (h === '/results' && scan && hasResult(scan)) { renderResults(); return show('results'); }
    if (h === '/scan' || h === '/results') {
      location.replace('#/');
      return;
    }
    show('setup');
  }

  const isRunning = (s) => s.status === 'starting' || s.status === 'running';
  const hasResult = (s) => ['done', 'stopped', 'error'].includes(s.status);

  function updateNav() {
    document.querySelector('[data-nav=scan]').hidden = !(scan && isRunning(scan));
    document.querySelector('[data-nav=results]').hidden = !(scan && hasResult(scan));
  }

  // ── 1 · setup ───────────────────────────
  const below = $('below'), prem = $('prem'), premNum = $('prem-num');

  function readInputs() {
    return { strike_below: Number(below.value), prem_min_pct: Math.min(100, Math.max(0.1, Number(premNum.value) || 5)) };
  }

  function updateExplain() {
    const { strike_below: b, prem_min_pct: p } = readInputs();
    const need = p * 0.15;
    const needTxt = trimNum(need, need < 1 ? 3 : 2);
    const exStrike = 1000 * (1 - b / 100);
    const cut = Math.max(0, Math.min(100, ((1 - b / 100) - 0.6) / 0.4 * 100));
    $('below-val').textContent = b;
    $('below-val-2').textContent = b;
    $('need-pct').textContent = needTxt;
    $('need-pct-2').textContent = needTxt;
    $('prem-val').textContent = trimNum(p, 2);
    $('prem-val-2').textContent = trimNum(p, 2);
    $('ex-zone').style.width = cut + '%';
    $('ex-cut').style.left = cut + '%';
    $('ex-cut-label').style.left = cut + '%';
    $('ex-cut-label').textContent = '₹' + Math.round(exStrike).toLocaleString('en-IN');
    $('ex-strike').textContent = '₹' + Math.round(exStrike).toLocaleString('en-IN');
    $('ex-need').textContent = `₹${(exStrike * need / 100).toFixed(2)} / share`;
  }

  below.addEventListener('input', updateExplain);
  prem.addEventListener('input', () => { premNum.value = prem.value; updateExplain(); });
  premNum.addEventListener('input', () => {
    const v = Number(premNum.value);
    if (v >= 0.5 && v <= 20) prem.value = v;
    updateExplain();
  });

  async function startScan(params) {
    $('run-error').hidden = true;
    $('run').disabled = true;
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      logSeq = 0;
      $('log').innerHTML = '';
      scan = null;
      await poll();
      if (scan && isRunning(scan)) location.hash = '#/scan';
    } catch (e) {
      $('run-error').textContent = 'Could not start the scan: ' + e.message;
      $('run-error').hidden = false;
      show('setup');
    } finally {
      $('run').disabled = false;
    }
  }

  $('run').addEventListener('click', () => startScan(readInputs()));

  async function marketNote() {
    try {
      const s = await (await fetch('/api/status')).json();
      $('run-note').textContent = 'About 220 stocks, roughly 6–8 minutes. ' +
        (s.market_open ? 'Market is open: premiums are live.' : 'Market is closed: premiums will be the last traded prices.');
    } catch (_) { /* keep the default note */ }
  }

  // ── 2 · scanning ────────────────────────
  async function poll() {
    clearTimeout(pollTimer);
    let s;
    try {
      s = await (await fetch(`/api/scan?since=${logSeq}`)).json();
    } catch (_) {
      pollTimer = setTimeout(poll, 3000);
      return;
    }
    if (s.status === 'none') { scan = null; updateNav(); pollTimer = setTimeout(poll, 10000); return; }
    if (scan && s.id !== scan.id && logSeq > 0) {
      // a scan started elsewhere (another tab or browser): its log restarts at 1
      logSeq = 0;
      $('log').innerHTML = '';
      scan = { id: s.id, status: 'reset' };
      return poll();
    }
    const wasRunning = scan && isRunning(scan);
    const changed = !scan || scan.id !== s.id || scan.status !== s.status;
    scan = s;
    updateNav();
    renderScan(s);
    if (isRunning(s)) {
      pollTimer = setTimeout(poll, 1000);
      return;
    }
    // idle: keep checking now and then so a scan started elsewhere shows up here
    pollTimer = setTimeout(poll, 10000);
    if (wasRunning || location.hash === '#/scan') {
      location.hash = '#/results';
      route();
    } else if (changed && location.hash === '#/results') {
      route();
    }
  }

  function renderScan(s) {
    $('scan-stage').textContent = s.status === 'running' ? 'Scanning' : s.stage + '…';
    $('scan-done').textContent = s.done;
    $('scan-total').textContent = s.total || '…';
    $('scan-below').textContent = s.strike_below;
    $('scan-prem').textContent = s.prem_min_pct;
    $('scan-elapsed').textContent = mmss(s.elapsed);
    $('scan-eta').textContent = s.done > 3 && s.total ? mmss(s.elapsed / s.done * (s.total - s.done)) : '…';
    $('closed-note').hidden = s.market_open;

    const cells = $('cells');
    const n = s.total || 0;
    if (cells.children.length !== n) cells.innerHTML = '<i></i>'.repeat(n);
    s.cells.forEach((c, i) => { if (cells.children[i]) cells.children[i].className = c; });
    cells.setAttribute('aria-valuemax', n);
    cells.setAttribute('aria-valuenow', s.done);

    const log = $('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.querySelector('.cur')?.remove();
    for (const e of s.log) {
      const row = document.createElement('div');
      row.className = 'log-row';
      const idx = e.i ? `[${String(e.i).padStart(3, ' ')}/${s.total}]` : '';
      row.innerHTML = `<span class="d">${esc(idx)}</span><span>${esc(e.sym)}</span>` +
        `<span class="c-cmp">${e.cmp ? '₹' + inr(e.cmp) : ''}</span><span class="d c-lot">${e.lot ? 'lot ' + e.lot : ''}</span>` +
        `<span class="${esc(e.kind)}">${e.kind === 'none' ? '— ' : ''}${esc(e.text)}</span>`;
      log.appendChild(row);
      logSeq = Math.max(logSeq, e.seq);
    }
    while (log.children.length > 300) log.firstChild.remove();
    if (isRunning(s) && s.current) {
      const cur = document.createElement('div');
      cur.className = 'log-row cur';
      cur.innerHTML = `<span class="d">[${String(s.done + 1).padStart(3, ' ')}/${s.total}]</span><span>${esc(s.current)}</span><span class="d" style="grid-column: span 3">reading option chain…</span>`;
      log.appendChild(cur);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;

    $('found-count').textContent = `${s.stocks.length} stock${s.stocks.length === 1 ? '' : 's'} · ${s.matches} strike${s.matches === 1 ? '' : 's'}`;
    $('found').innerHTML = s.stocks.map((st) =>
      `<div class="found-row"><strong>${esc(st.symbol)}</strong><span class="muted small">${st.strikes.length} strike${st.strikes.length === 1 ? '' : 's'} · best <strong class="p">${st.best.toFixed(2)}%</strong></span></div>`
    ).join('');
    $('skip-count').textContent = s.skipped.length;
    $('skip-list').textContent = s.skipped.length ? s.skipped.join(', ') : 'None yet.';
  }

  $('stop').addEventListener('click', async () => {
    $('stop').disabled = true;
    await fetch('/api/scan/stop', { method: 'POST' }).catch(() => {});
    $('stop').textContent = 'Stopping…';
  });

  // ── 3 · results ─────────────────────────
  function renderResults() {
    const s = scan;
    const all = s.stocks.flatMap((st) => st.strikes);
    const untraded = all.filter((m) => !m.volume).length;
    // strikes with no trades in the last session carry a stale last price: hidden unless asked for
    const stocks = s.stocks.map((st) => {
      const strikes = onlyTraded ? st.strikes.filter((m) => m.volume > 0) : st.strikes;
      return strikes.length ? { ...st, strikes, best: Math.max(...strikes.map((m) => m.prem_pct_of_margin)) } : null;
    }).filter(Boolean).sort((a, b) => b.best - a.best);
    const shown = stocks.reduce((n, st) => n + st.strikes.length, 0);
    const any = stocks.length > 0;
    const allStale = all.length > 0 && !any;
    const when = new Date(s.started_at * 1000).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const scanned = s.status === 'done' ? `${s.total} scanned` : `${s.done} of ${s.total} scanned`;
    const sub = [s.expiry ? `Expiry ${s.expiry}` : null, `strike ≥ ${s.strike_below}% below`, `premium ≥ ${s.prem_min_pct}% of margin`,
      `${scanned}, ${s.skipped.length} skipped`, s.as_of ? `prices as of ${s.as_of}` : `run ${when}`,
      onlyTraded && untraded ? `${untraded} untraded strike${untraded === 1 ? '' : 's'} hidden` : null].filter(Boolean).join(' · ');

    const flag = $('res-flag');
    flag.hidden = s.status === 'done';
    flag.textContent = s.status === 'error' ? `Scan failed: ${s.error || 'unknown error'}` : 'Stopped early: results cover only the stocks scanned';

    $('res-h1').textContent = any ? `${shown} strike${shown === 1 ? '' : 's'} in ${stocks.length} stock${stocks.length === 1 ? '' : 's'}`
      : allStale ? 'No traded matches' : 'No matches';
    $('res-h1').hidden = !any;   // the empty and stale sections carry their own heading
    $('res-sub').textContent = sub;
    $('csv').hidden = !s.has_csv || !any;
    $('csv').href = '/api/scan/csv' + (onlyTraded ? '?traded=1' : '');
    $('traded-wrap').hidden = untraded === 0 && onlyTraded;
    $('only-traded').checked = onlyTraded;
    document.querySelector('.seg').hidden = !any;
    $('empty').hidden = any || allStale;
    $('stale').hidden = !allStale;
    $('res-grouped').hidden = !any || view !== 'grouped';
    $('res-flat').hidden = !any || view !== 'flat';
    $('v-grouped').setAttribute('aria-pressed', view === 'grouped');
    $('v-flat').setAttribute('aria-pressed', view === 'flat');

    if (allStale) {
      $('stale-why').textContent = `All ${all.length} strike${all.length === 1 ? '' : 's'} that passed had no trades in the last session, so their premiums are old last prices you probably can't get. ` +
        (s.market_open ? 'Try again later in the session.' : 'Run the scan again during market hours (9:15 to 15:30 IST).');
      return;
    }
    if (!any) return renderEmpty(s);

    // ruler span: from `span`% below the price up to the price, wide enough for the user's line and the deepest strike shown
    const deepest = Math.max(...stocks.flatMap((st) => st.strikes.map((m) => m.pct_below_cmp)));
    const span = Math.min(60, Math.max(20, s.strike_below * 2, Math.ceil((deepest + 2) / 5) * 5));
    const pos = (k, cmp) => Math.max(0, Math.min(100, (k / cmp - (1 - span / 100)) / (span / 100) * 100));
    const cut = (span - s.strike_below) / span * 100;
    const barMax = Math.max(s.prem_min_pct * 2, ...stocks.map((st) => st.best)) * 1.1;

    $('ruler-legend').innerHTML = `<span>Ruler: ${span}% below the price → price.</span>` +
      `<span><i class="tick"></i>your ${s.strike_below}% line</span><span><i class="dot"></i>strike that passes</span><span><i class="ring"></i>checked, pays too little</span>`;

    $('cards').innerHTML = stocks.map((st) => {
      const fails = st.fails.filter((k) => k / st.cmp >= 1 - span / 100);
      const hasRange = typeof st.week52_high === 'number' && typeof st.week52_low === 'number' && st.week52_high > st.week52_low;
      const p52 = hasRange ? Math.max(0, Math.min(100, (st.cmp - st.week52_low) / (st.week52_high - st.week52_low) * 100)) : null;
      const rows = st.strikes.map((m) => {
        const thin = !m.volume ? ' <span class="thin" title="No trades today; price may be stale">no trades</span>' : '';
        return `<tr><td class="strike">${strikeFmt(m.strike)}</td><td>${m.pct_below_cmp.toFixed(2)}%</td><td>₹${inr(m.pe_premium)}${thin}</td>` +
          `<td class="dim">${m.lot_size.toLocaleString('en-IN')}</td><td>₹${inr(m.total_premium, 0)}</td><td class="dim">₹${inr(m.margin, 0)}</td>` +
          `<td class="pctcol"><span class="pbar"><span class="track"><span class="fill" style="width:${Math.min(100, m.prem_pct_of_margin / barMax * 100)}%"></span></span><b>${m.prem_pct_of_margin.toFixed(2)}%</b></span></td>` +
          `<td>${esc(m.iv)}</td><td class="dim">${Number(m.oi).toLocaleString('en-IN')}</td><td class="dim">${Number(m.volume).toLocaleString('en-IN')}</td></tr>`;
      }).join('');
      const compact = st.strikes.map((m) =>
        `<div><span>${strikeFmt(m.strike)} PE</span><span class="muted">−${m.pct_below_cmp.toFixed(1)}%</span><span>₹${inr(m.pe_premium)}</span><span>${m.prem_pct_of_margin.toFixed(2)}%</span></div>`).join('');
      return `<article class="card">
        <div class="card-top">
          <div class="c-name"><strong>${esc(st.symbol)}</strong><span class="muted small">₹${inr(st.cmp)} · PE ${esc(st.pe_ratio)}</span></div>
          <div class="ruler" role="img" aria-label="${esc(st.symbol)}: ${st.strikes.length} strikes pass, ${fails.length} checked strikes pay too little">
            <div class="line"></div><div class="cut" style="left:${cut}%"></div>
            ${fails.map((k) => `<div class="f" style="left:${pos(k, st.cmp)}%" title="${strikeFmt(k)}"></div>`).join('')}
            ${st.strikes.map((m) => `<div class="p" style="left:${pos(m.strike, st.cmp)}%" title="${strikeFmt(m.strike)}: ${m.prem_pct_of_margin.toFixed(2)}%"></div>`).join('')}
            <div class="now"></div><div class="lo">−${span}%</div><div class="hi">now</div>
          </div>
          <div class="c-52">
            ${hasRange ? `<div class="ends"><span>52W ₹${inr(st.week52_low, 0)}</span><span>₹${inr(st.week52_high, 0)}</span></div><div class="bar"><i style="left:${p52}%"></i></div>` : '<span>52W range not available</span>'}
            <span>Underlying ₹${inr(st.underlying)}</span>
          </div>
          <div class="c-best"><strong>${st.best.toFixed(2)}%</strong><span class="muted small">best of margin</span></div>
        </div>
        <div class="strikes-box">
          <table><thead><tr><th scope="col">Strike</th><th scope="col">Below price</th><th scope="col">Premium / share</th><th scope="col">Lot</th><th scope="col">Premium / lot</th><th scope="col">Margin, est.</th><th scope="col" class="pctcol">Premium % of margin</th><th scope="col">IV</th><th scope="col">OI</th><th scope="col">Volume</th></tr></thead>
          <tbody>${rows}</tbody></table>
          <div class="compact">${compact}</div>
        </div>
      </article>`;
    }).join('');

    const flat = stocks.flatMap((st) => st.strikes).sort((a, b) => b.prem_pct_of_margin - a.prem_pct_of_margin);
    const heads = ['#', 'Symbol', 'CMP', 'Strike', '% OTM', 'Premium/share', 'Lot', 'Total premium', 'Margin', 'Prem % of margin', 'Expiry', 'Underlying', '52W high', '52W low', 'Stock PE', 'IV%', 'OI', 'Volume'];
    $('flat-table').innerHTML = `<thead><tr>${heads.map((h, i) => `<th scope="col"${i === 1 ? ' class="sym"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>` +
      flat.map((m, i) => `<tr><td>${i + 1}</td><td class="sym">${esc(m.symbol)}</td><td>${inr(m.cmp)}</td><td>${strikeFmt(m.strike)}</td><td>${m.pct_below_cmp.toFixed(2)}</td>` +
        `<td>${inr(m.pe_premium)}</td><td>${m.lot_size}</td><td>${inr(m.total_premium)}</td><td>${inr(m.margin)}</td><td class="pct">${m.prem_pct_of_margin.toFixed(2)}</td>` +
        `<td>${esc(m.expiry)}</td><td>${inr(m.underlying)}</td><td>${inr(m.week52_high)}</td><td>${inr(m.week52_low)}</td><td>${esc(m.pe_ratio)}</td>` +
        `<td>${esc(m.iv)}</td><td>${Number(m.oi).toLocaleString('en-IN')}</td><td>${Number(m.volume).toLocaleString('en-IN')}</td></tr>`).join('') + '</tbody>';
  }

  // ── 4 · no matches ──────────────────────
  let hintParams = {};
  function renderEmpty(s) {
    const need = s.prem_min_pct * 0.15;
    $('empty-why').textContent = `That asks for a put paying ${trimNum(need, 3)}% of its strike, ${s.strike_below}% or more under the price, on the nearest expiry (${s.expiry || 'unknown'}).` +
      (s.status === 'error' ? ` The scan also failed partway: ${s.error}.` : '');
    const p2 = Math.max(0.1, Math.round(s.prem_min_pct * 0.6 * 10) / 10);
    const b2 = Math.max(1, s.strike_below - 5);
    hintParams = { prem: { strike_below: s.strike_below, prem_min_pct: p2 }, below: { strike_below: b2, prem_min_pct: s.prem_min_pct } };
    $('hint-prem-t').textContent = `Lower the premium to ${p2}% of margin`;
    $('hint-prem-s').textContent = `Needs ${trimNum(p2 * 0.15, 3)}% of the strike instead of ${trimNum(need, 3)}%`;
    $('hint-below-t').textContent = `Move the strike line up to ${b2}% below`;
    $('hint-below').hidden = b2 === s.strike_below;
    $('hint-hours').textContent = s.market_open ? '9:15 to 15:30 IST. This run used live prices.' : '9:15 to 15:30 IST. This run used last traded prices.';
  }

  function rerun(p) {
    below.value = p.strike_below;
    premNum.value = p.prem_min_pct;
    if (p.prem_min_pct >= 0.5 && p.prem_min_pct <= 20) prem.value = p.prem_min_pct;
    updateExplain();
    startScan(p);
  }
  $('hint-prem').addEventListener('click', () => rerun(hintParams.prem));
  $('hint-below').addEventListener('click', () => rerun(hintParams.below));

  let onlyTraded = true;
  try { onlyTraded = localStorage.getItem('onlyTraded') !== '0'; } catch (_) { /* default on */ }
  function setOnlyTraded(v) {
    onlyTraded = v;
    try { localStorage.setItem('onlyTraded', v ? '1' : '0'); } catch (_) { /* per-viewer only */ }
    renderResults();
  }
  $('only-traded').addEventListener('change', (e) => setOnlyTraded(e.target.checked));
  $('show-stale').addEventListener('click', () => setOnlyTraded(false));

  $('v-grouped').addEventListener('click', () => { view = 'grouped'; renderResults(); });
  $('v-flat').addEventListener('click', () => { view = 'flat'; renderResults(); });

  // ── boot ────────────────────────────────
  window.addEventListener('hashchange', route);
  updateExplain();
  marketNote();
  poll().then(() => {
    if (scan) {
      below.value = scan.strike_below;
      premNum.value = scan.prem_min_pct;
      if (scan.prem_min_pct >= 0.5 && scan.prem_min_pct <= 20) prem.value = scan.prem_min_pct;
      updateExplain();
    }
    if (scan && isRunning(scan) && !location.hash) location.hash = '#/scan';
    route();
  });
})();
