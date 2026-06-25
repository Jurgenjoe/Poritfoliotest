// ---- SUPABASE SETUP ----
const SUPABASE_URL = 'https://vpkjwsypxjpouxegyfkw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wdGgFdHqIqH2E0tCkrzOUw_NtqRXbEu';
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

let THB_RATE = 32.48; // default fallback, will be updated from live API
let currency = 'USD';
let editIndex = -1;
let histTicker = null;
let histChartInst = null;

// ---- IN-MEMORY CACHE ----
let _stocks = [];
let _history = {}; // { TICKER: [{date, price}] }
let _loaded = false;

// ---- DEFAULT DATA ----
const defaultStocks = [
  { ticker:'RKLB', shares:50,  cost:28.5,  price:155.0, sector:'Tech',   color:'#00b4d8' },
  { ticker:'CRWD', shares:8,   cost:180.0, price:355.99,sector:'Tech',   color:'#ff6b35' },
  { ticker:'NVDA', shares:20,  cost:65.0,  price:138.22,sector:'Tech',   color:'#76b900' },
  { ticker:'TSM',  shares:15,  cost:80.0,  price:181.18,sector:'Tech',   color:'#0099ff' },
  { ticker:'ORCL', shares:8,   cost:110.0, price:187.91,sector:'Tech',   color:'#cc0000' },
  { ticker:'NVO',  shares:10,  cost:175.0, price:140.37,sector:'Health', color:'#0078d4' },
  { ticker:'LLY',  shares:2,   cost:470.0, price:624.94,sector:'Health', color:'#c8102e' },
  { ticker:'TMDX', shares:25,  cost:45.0,  price:36.57, sector:'Health', color:'#e63946' },
  { ticker:'IESC', shares:6,   cost:50.0,  price:80.26, sector:'Other',  color:'#4361ee' },
  { ticker:'SMH',  shares:1,   cost:254.0, price:387.90,sector:'ETF',    color:'#6a0572' },
  { ticker:'OKLO', shares:10,  cost:30.0,  price:34.64, sector:'Energy', color:'#ff9f1c' },
  { ticker:'GEV',  shares:2,   cost:149.0, price:164.84,sector:'Energy', color:'#0fa3b1' },
  { ticker:'DRAM', shares:20,  cost:12.0,  price:15.90, sector:'Other',  color:'#7b2d8b' },
];

// ---- SUPABASE DATA LAYER ----
function showToast(msg, color='var(--accent)') {
  let t = document.getElementById('sbToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'sbToast';
    t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:10px;font-family:var(--font-mono);font-size:0.8rem;color:#0a0c10;font-weight:700;transition:opacity 0.4s;pointer-events:none;`;
    document.body.appendChild(t);
  }
  t.style.background = color;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.style.opacity = '0', 2500);
}

async function loadFromSupabase() {
  showToast('⏳ กำลังโหลดข้อมูล...', '#0099ff');
  try {
    const { data: stocks, error: se } = await sb.from('stocks').select('*');
    if (se) throw se;

    if (!stocks || stocks.length === 0) {
      // First time: seed default data
      await seedDefaultData();
    } else {
      _stocks = stocks.map(s => ({
        ticker: s.ticker, shares: parseFloat(s.shares), cost: parseFloat(s.cost),
        price: parseFloat(s.price), sector: s.sector, color: s.color
      }));
    }

    const { data: hist, error: he } = await sb.from('price_history').select('*').order('date', { ascending: true });
    if (he) throw he;

    _history = {};
    (hist || []).forEach(r => {
      if (!_history[r.ticker]) _history[r.ticker] = [];
      _history[r.ticker].push({ date: r.date, price: parseFloat(r.price) });
    });

    // Seed history for tickers missing it
    await ensureHistory();

    _loaded = true;
    showToast('✅ โหลดข้อมูลสำเร็จ');
    renderAll();
    autoFetch();
    await loadAlertsFromSB();
    await loadDrawingsFromSB();
    startAlertWatcher();
  } catch(err) {
    const msg = err?.message || err?.error_description || err?.hint || err?.code || JSON.stringify(err) || 'Unknown error';
    console.error('Supabase load error:', msg, err);
    showToast('⚠️ Supabase: ' + msg, 'var(--red)');
    _stocks = JSON.parse(JSON.stringify(defaultStocks));
    _history = {};
    _loaded = true;
    renderAll();
    autoFetch();
    startAlertWatcher();
  }
}

async function seedDefaultData() {
  const rows = defaultStocks.map(s => ({
    ticker: s.ticker, shares: s.shares, cost: s.cost,
    price: s.price, sector: s.sector, color: s.color
  }));
  const { error } = await sb.from('stocks').upsert(rows, { onConflict: 'ticker' });
  if (error) throw error;
  _stocks = JSON.parse(JSON.stringify(defaultStocks));
}

async function ensureHistory() {
  const today = new Date();
  const toInsert = [];
  _stocks.forEach(s => {
    if (!_history[s.ticker] || _history[s.ticker].length === 0) {
      _history[s.ticker] = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate()-i);
        const key = d.toISOString().slice(0,10);
        const jitter = (Math.random()-0.5)*0.06;
        const p = parseFloat((s.price*(1 + jitter - (i*0.002))).toFixed(2));
        _history[s.ticker].push({ date: key, price: p });
        toInsert.push({ ticker: s.ticker, date: key, price: p });
      }
    }
  });
  if (toInsert.length > 0) {
    await sb.from('price_history').upsert(toInsert, { onConflict: 'ticker,date' });
  }
}

// ---- SYNC FUNCTIONS ----
function getStocks() { return _stocks; }

async function saveStockToSB(entry, isEdit) {
  const row = { ticker: entry.ticker, shares: entry.shares, cost: entry.cost,
                price: entry.price, sector: entry.sector, color: entry.color };
  const { error } = await sb.from('stocks').upsert(row, { onConflict: 'ticker' });
  if (error) { showToast('❌ บันทึกไม่สำเร็จ', 'var(--red)'); throw error; }
  showToast('💾 บันทึกแล้ว');
}

async function deleteStockFromSB(ticker) {
  const { error } = await sb.from('stocks').delete().eq('ticker', ticker);
  if (error) { showToast('❌ ลบไม่สำเร็จ', 'var(--red)'); throw error; }
  await sb.from('price_history').delete().eq('ticker', ticker);
  showToast('🗑️ ลบแล้ว');
}

async function saveHistoryEntryToSB(ticker, date, price) {
  const { error } = await sb.from('price_history').upsert(
    { ticker, date, price }, { onConflict: 'ticker,date' }
  );
  if (error) showToast('❌ บันทึก history ไม่สำเร็จ', 'var(--red)');
  else showToast('📅 บันทึก history แล้ว');
}

async function updatePricesInSB(updatedStocks) {
  const rows = updatedStocks.map(s => ({
    ticker: s.ticker, shares: s.shares, cost: s.cost,
    price: s.price, sector: s.sector, color: s.color
  }));
  await sb.from('stocks').upsert(rows, { onConflict: 'ticker' });
}

function getHistory() { return _history; }

// Stub (no-op) — history is saved per-entry via saveHistoryEntryToSB
function saveHistory(h) { _history = h; }

// ---- UTILS ----
function fmt(v, decimals=2) {
  return parseFloat(v).toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals});
}
function fmtCur(usd) {
  if (currency === 'THB') return '฿' + fmt(usd * THB_RATE);
  return '$' + fmt(usd);
}
function pctBadge(pct) {
  const cls = pct >= 0 ? 'green' : 'red';
  const arrow = pct >= 0 ? '↑' : '↓';
  return `<span class="${cls} mono">${arrow} ${Math.abs(pct).toFixed(2)}%</span>`;
}

// ---- SUMMARY ----
function renderSummary() {
  const stocks = getStocks();
  let totalValue = 0, totalCost = 0;
  stocks.forEach(s => {
    const val = parseFloat(s.price) * parseFloat(s.shares);
    const cost = parseFloat(s.cost) * parseFloat(s.shares);
    totalValue += val; totalCost += cost;
  });
  const totalPL = totalValue - totalCost;
  const totalPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  const el = document.getElementById('summaryCards');
  el.innerHTML = `
    <div class="card">
      <div class="card-label">มูลค่าพอร์ตทั้งหมด</div>
      <div class="card-value" id="sum_value">${fmtCur(totalValue)}</div>
      <div class="card-sub">${currency==='USD' ? '≈ ฿'+fmt(totalValue*THB_RATE) : '≈ $'+fmt(totalValue)}</div>
    </div>
    <div class="card">
      <div class="card-label">ต้นทุนรวม</div>
      <div class="card-value">${fmtCur(totalCost)}</div>
      <div class="card-sub">${stocks.length} สินทรัพย์</div>
    </div>
    <div class="card">
      <div class="card-label">กำไร / ขาดทุน</div>
      <div class="card-value ${totalPL>=0?'green':'red'}" id="sum_pl">${totalPL>=0?'+':''}${fmtCur(totalPL)}</div>
      <div class="card-badge ${totalPL>=0?'badge-green':'badge-red'}" id="sum_badge">${totalPL>=0?'↑':'↓'} ${Math.abs(totalPct).toFixed(2)}%</div>
    </div>
    <div class="card">
      <div class="card-label">อัตราแลกเปลี่ยน</div>
      <div class="card-value" style="font-size:1.1rem" id="fx_rate">1 USD = ${THB_RATE} THB</div>
      <div class="card-sub" id="fx_source">กำลังดึงข้อมูล...</div>
    </div>
  `;
}

// ---- LINE CHART ----
let lineChartInst = null;
function renderLineChart() {
  const stocks = getStocks();
  const h = getHistory();
  // Sum portfolio value over 30 days
  const today = new Date();
  const labels = [], values = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const key = d.toISOString().slice(0,10);
    labels.push(key.slice(5));
    let dayVal = 0;
    stocks.forEach(s => {
      const hist = (h[s.ticker]||[]).find(x=>x.date===key);
      const p = hist ? hist.price : parseFloat(s.price);
      dayVal += p * parseFloat(s.shares);
    });
    values.push(parseFloat((currency==='THB'? dayVal*THB_RATE : dayVal).toFixed(2)));
  }
  const ctx = document.getElementById('lineChart').getContext('2d');
  if (lineChartInst) lineChartInst.destroy();
  const grad = ctx.createLinearGradient(0,0,0,200);
  grad.addColorStop(0,'rgba(0,229,160,0.25)');
  grad.addColorStop(1,'rgba(0,229,160,0.0)');
  lineChartInst = new Chart(ctx, {
    type:'line',
    data:{
      labels,
      datasets:[{
        label:'มูลค่าพอร์ต',
        data:values,
        borderColor:'#00e5a0',
        backgroundColor:grad,
        borderWidth:2,
        pointRadius:2,
        pointHoverRadius:5,
        tension:0.4,
        fill:true
      }]
    },
    options:{
      responsive:true,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{
        label: ctx => (currency==='THB'?'฿':'$') + fmt(ctx.parsed.y)
      }}},
      scales:{
        x:{ grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#5a6478',font:{size:10},maxTicksLimit:6}},
        y:{ grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#5a6478',font:{size:10},callback:v=>(currency==='THB'?'฿':'$')+fmt(v,0)}}
      }
    }
  });
}

// ---- PIE CHART ----
let pieChartInst = null;
function renderPieChart() {
  const stocks = getStocks();
  const labels = stocks.map(s=>s.ticker);
  const values = stocks.map(s=>parseFloat(s.price)*parseFloat(s.shares));
  const colors = stocks.map(s=>s.color||'#888');
  const ctx = document.getElementById('pieChart').getContext('2d');
  if (pieChartInst) pieChartInst.destroy();
  pieChartInst = new Chart(ctx,{
    type:'doughnut',
    data:{ labels, datasets:[{ data:values, backgroundColor:colors, borderColor:'#111419', borderWidth:2 }] },
    options:{
      responsive:true,
      plugins:{
        legend:{ position:'right', labels:{color:'#e8edf5',font:{size:10},boxWidth:12,padding:8}},
        tooltip:{ callbacks:{ label: ctx => {
          const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
          const pct = ((ctx.parsed/total)*100).toFixed(1);
          return ` ${ctx.label}: ${pct}%`;
        }}}
      }
    }
  });
}

// ---- STOCK LOGO HELPERS ----
// Map ticker symbols to their company domains for logo lookup
const tickerDomainMap = {
  // Tech
  'AAPL': 'apple.com', 'MSFT': 'microsoft.com', 'GOOGL': 'google.com', 'GOOG': 'google.com',
  'META': 'meta.com', 'AMZN': 'amazon.com', 'NVDA': 'nvidia.com', 'TSLA': 'tesla.com',
  'NFLX': 'netflix.com', 'ORCL': 'oracle.com', 'CRM': 'salesforce.com', 'AMD': 'amd.com',
  'INTC': 'intel.com', 'QCOM': 'qualcomm.com', 'AVGO': 'broadcom.com', 'TSM': 'tsmc.com',
  'CRWD': 'crowdstrike.com', 'RKLB': 'rocketlabusa.com', 'OKLO': 'oklo.com',
  'DRAM': 'etf.com', 'PANW': 'paloaltonetworks.com', 'SNOW': 'snowflake.com',
  'PLTR': 'palantir.com', 'NET': 'cloudflare.com', 'DDOG': 'datadoghq.com',
  'ZS': 'zscaler.com', 'MDB': 'mongodb.com', 'MSTR': 'microstrategy.com',
  // Health
  'JNJ': 'jnj.com', 'PFE': 'pfizer.com', 'ABBV': 'abbvie.com', 'MRK': 'merck.com',
  'LLY': 'lilly.com', 'NVO': 'novonordisk.com', 'UNH': 'uhc.com', 'TMO': 'thermofisher.com',
  'ISRG': 'intuitive.com', 'DXCM': 'dexcom.com', 'TMDX': 'transmedics.com',
  'MRNA': 'modernatx.com', 'REGN': 'regeneron.com', 'VRTX': 'vrtx.com',
  // Finance
  'JPM': 'jpmorganchase.com', 'BAC': 'bankofamerica.com', 'WFC': 'wellsfargo.com',
  'GS': 'goldmansachs.com', 'MS': 'morganstanley.com', 'V': 'visa.com', 'MA': 'mastercard.com',
  'PYPL': 'paypal.com', 'SQ': 'squareup.com', 'COIN': 'coinbase.com',
  // Energy
  'XOM': 'exxonmobil.com', 'CVX': 'chevron.com', 'COP': 'conocophillips.com',
  'GEV': 'ge.com', 'NEE': 'nexteraenergy.com', 'ENPH': 'enphase.com',
  // ETF (use provider logos)
  'SPY': 'ssga.com', 'QQQ': 'invesco.com', 'IWM': 'ishares.com', 'VTI': 'vanguard.com',
  'ARKK': 'ark-funds.com', 'SMH': 'vaneck.com',
  // Other
  'IESC': 'iesc.com',
};

function tickerIconHTML(ticker, color) {
  const abbr = ticker.slice(0, 3);
  const domain = tickerDomainMap[ticker.toUpperCase()];
  if (domain) {
    const logodev = `https://img.logo.dev/${domain}?token=pk_X-1ZO13GSgeOoUrIuJ6BeQ&size=64&format=png`;
    const gfav = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    return `<div class="ticker-icon" style="background:transparent">
      <img src="${logodev}" alt="${ticker}"
        onerror="if(this._tried){this.style.display='none';this.nextElementSibling.style.display='flex';}else{this._tried=true;this.src='${gfav}';}"
        style="width:100%;height:100%;object-fit:contain;border-radius:50%;padding:2px">
      <span class="ticker-abbr" style="display:none;color:${color||'#aaa'}">${abbr}</span>
    </div>`;
  }
  return `<div class="ticker-icon" style="background:transparent">
    <span class="ticker-abbr" style="color:${color||'#aaa'}">${abbr}</span>
  </div>`;
}

// ---- TABLE ----
function renderTable() {
  let stocks = getStocks();
  const q = document.getElementById('searchInput').value.toUpperCase();
  const sort = document.getElementById('sortSelect').value;
  const sector = document.getElementById('filterSector').value;

  if (q) stocks = stocks.filter(s=>s.ticker.includes(q));
  if (sector) stocks = stocks.filter(s=>s.sector===sector);

  const totalValue = getStocks().reduce((a,s)=>a+parseFloat(s.price)*parseFloat(s.shares),0);

  stocks.sort((a,b)=>{
    const va=parseFloat(a.price)*parseFloat(a.shares), vb=parseFloat(b.price)*parseFloat(b.shares);
    const ga=((parseFloat(a.price)-parseFloat(a.cost))/parseFloat(a.cost))*100;
    const gb=((parseFloat(b.price)-parseFloat(b.cost))/parseFloat(b.cost))*100;
    if(sort==='value_desc') return vb-va;
    if(sort==='value_asc') return va-vb;
    if(sort==='gain_desc') return gb-ga;
    if(sort==='gain_asc') return ga-gb;
    if(sort==='ticker_asc') return a.ticker.localeCompare(b.ticker);
    return 0;
  });

  const allStocks = getStocks();
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = stocks.map(s => {
    const idx = allStocks.findIndex(x=>x.ticker===s.ticker);
    const val = parseFloat(s.price)*parseFloat(s.shares);
    const cost = parseFloat(s.cost)*parseFloat(s.shares);
    const pl = val - cost;
    const pct = cost>0 ? (pl/cost)*100 : 0;
    const weight = totalValue>0 ? (val/totalValue)*100 : 0;
    const plStr = (pl>=0?'+':'')+fmtCur(pl);
    const plCls = pl>=0?'green':'red';
    const abbr = s.ticker.slice(0,3);
    const dispVal = fmtCur(val);
    const dispCost = fmtCur(parseFloat(s.cost));
    const dispPrice = fmtCur(parseFloat(s.price));
    return `<tr>
      <td>
        <div class="ticker-cell" onclick="openDetail(${idx})">
          ${tickerIconHTML(s.ticker, s.color)}
          <div>
            <div class="ticker-name">${s.ticker}</div>
            <div class="ticker-weight" id="lw_${s.ticker}">${weight.toFixed(1)}% · ${s.sector}</div>
          </div>
        </div>
      </td>
      <td class="mono hide-sm" style="color:var(--muted)">${dispCost}<br><span style="font-size:0.72rem;color:var(--muted2)">${fmt(s.shares,3)} หุ้น</span></td>
      <td class="mono" id="lp_${s.ticker}">${dispPrice}<canvas class="sparkline" id="spark_${s.ticker}" width="50" height="20"></canvas></td>
      <td class="mono"><strong id="lv_${s.ticker}">${dispVal}</strong></td>
      <td class="mono hide-sm ${plCls}" id="ll_${s.ticker}">${plStr}</td>
      <td id="lpct_${s.ticker}">${pctBadge(pct)}</td>
      <td>
        <div class="action-btns">
          <button class="btn-icon" title="ประวัติ" onclick="event.stopPropagation();openHist(${idx})">📊</button>
          <button class="btn-icon" title="แก้ไข" onclick="event.stopPropagation();openModal(${idx})">✏️</button>
          <button class="btn-icon del" title="ลบ" onclick="event.stopPropagation();deleteStock(${idx})">🗑️</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ---- MODAL ----
function openModal(idx=-1) {
  editIndex = idx;
  const stocks = getStocks();
  const m = document.getElementById('modalTitle');
  if (idx >= 0) {
    m.textContent = 'แก้ไขหุ้น';
    const s = stocks[idx];
    document.getElementById('f_ticker').value = s.ticker;
    document.getElementById('f_cost').value = s.cost;
    document.getElementById('f_shares').value = s.shares;
    document.getElementById('f_price').value = s.price;
    document.getElementById('f_sector').value = s.sector||'Other';
    document.getElementById('f_color').value = s.color||'#00e5a0';
    document.getElementById('f_ticker').readOnly = true;
  } else {
    m.textContent = 'เพิ่มหุ้นใหม่';
    ['f_ticker','f_cost','f_shares','f_price'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('f_sector').value = 'Tech';
    document.getElementById('f_color').value = '#00e5a0';
    document.getElementById('f_ticker').readOnly = false;
  }
  document.getElementById('modalOverlay').classList.add('open');
}
function closeModal() { document.getElementById('modalOverlay').classList.remove('open'); }

async function saveStock() {
  const ticker = document.getElementById('f_ticker').value.trim().toUpperCase();
  const cost = parseFloat(document.getElementById('f_cost').value);
  const shares = parseFloat(document.getElementById('f_shares').value);
  const price = parseFloat(document.getElementById('f_price').value);
  const sector = document.getElementById('f_sector').value;
  const color = document.getElementById('f_color').value;
  if (!ticker || isNaN(cost)||isNaN(shares)||isNaN(price)) { alert('กรุณากรอกข้อมูลให้ครบ'); return; }

  const entry = { ticker, cost, shares, price, sector, color };

  if (editIndex >= 0) {
    _stocks[editIndex] = entry;
  } else {
    _stocks.push(entry);
    // init history for new stock
    if (!_history[ticker] || _history[ticker].length === 0) {
      _history[ticker] = [];
      const today = new Date();
      const histRows = [];
      for (let i=29;i>=0;i--) {
        const d = new Date(today); d.setDate(d.getDate()-i);
        const key = d.toISOString().slice(0,10);
        const j=(Math.random()-0.5)*0.04;
        const p=parseFloat((price*(1+j-(i*0.001))).toFixed(2));
        _history[ticker].push({date:key, price:p});
        histRows.push({ticker, date:key, price:p});
      }
      await sb.from('price_history').upsert(histRows, { onConflict: 'ticker,date' });
    }
  }

  try {
    await saveStockToSB(entry);
  } catch(e) { return; }

  closeModal();
  renderAll();
}

async function deleteStock(idx) {
  if (!confirm('ต้องการลบหุ้นนี้?')) return;
  const ticker = _stocks[idx].ticker;
  _stocks.splice(idx,1);
  delete _history[ticker];
  try {
    await deleteStockFromSB(ticker);
  } catch(e) {}
  renderAll();
}

// ---- HISTORY MODAL ----
function openHist(idx) {
  const stocks = getStocks();
  const s = stocks[idx];
  histTicker = s.ticker;
  document.getElementById('histTitle').textContent = `📊 ประวัติราคา — ${s.ticker}`;
  const h = getHistory();
  const hist = h[histTicker] || [];
  renderHistChart(hist);
  renderHistTable(hist);
  document.getElementById('histOverlay').classList.add('open');
}
function closeHist() { document.getElementById('histOverlay').classList.remove('open'); histTicker=null; }

function renderHistChart(hist) {
  const ctx = document.getElementById('histChart').getContext('2d');
  if (histChartInst) histChartInst.destroy();
  const grad = ctx.createLinearGradient(0,0,0,160);
  grad.addColorStop(0,'rgba(0,153,255,0.3)');
  grad.addColorStop(1,'rgba(0,153,255,0.0)');
  histChartInst = new Chart(ctx,{
    type:'line',
    data:{
      labels:hist.map(x=>x.date.slice(5)),
      datasets:[{
        data:hist.map(x=>x.price),
        borderColor:'#0099ff',
        backgroundColor:grad,
        borderWidth:2,pointRadius:2,tension:0.4,fill:true
      }]
    },
    options:{
      responsive:true,
      plugins:{legend:{display:false}},
      scales:{
        x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#5a6478',font:{size:9},maxTicksLimit:7}},
        y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#5a6478',font:{size:9},callback:v=>'$'+v}}
      }
    }
  });
}
function renderHistTable(hist) {
  const tbody = document.getElementById('histBody');
  const sorted = [...hist].reverse();
  tbody.innerHTML = sorted.map((x,i)=>{
    const prev = sorted[i+1];
    const chg = prev ? ((x.price-prev.price)/prev.price*100).toFixed(2) : null;
    const chgStr = chg===null ? '—' : `<span class="${chg>=0?'green':'red'}">${chg>=0?'+':''}${chg}%</span>`;
    return `<tr><td>${x.date}</td><td class="mono">$${fmt(x.price)}</td><td>${chgStr}</td></tr>`;
  }).join('');
}
async function addHistEntry() {
  const date = document.getElementById('histDate').value;
  const price = parseFloat(document.getElementById('histPrice').value);
  if (!date||isNaN(price)) { alert('กรุณากรอกวันที่และราคา'); return; }
  const h = getHistory();
  if (!h[histTicker]) h[histTicker]=[];
  const existing = h[histTicker].find(x=>x.date===date);
  if (existing) existing.price=price;
  else {
    h[histTicker].push({date,price});
    h[histTicker].sort((a,b)=>a.date.localeCompare(b.date));
  }
  saveHistory(h);
  await saveHistoryEntryToSB(histTicker, date, price);
  renderHistChart(h[histTicker]);
  renderHistTable(h[histTicker]);
  document.getElementById('histDate').value='';
  document.getElementById('histPrice').value='';
}

// ---- EXCHANGE RATE (live) ----
async function fetchExchangeRate() {
  // Try primary: Open Exchange Rates (free, no key needed for USD base)
  const apis = [
    {
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: d => d && d.rates && d.rates.THB ? d.rates.THB : null,
      label: 'Open Exchange Rates'
    },
    {
      url: 'https://api.fxratesapi.com/latest?base=USD&currencies=THB',
      parse: d => d && d.rates && d.rates.THB ? d.rates.THB : null,
      label: 'FX Rates API'
    },
    {
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      parse: d => d && d.usd && d.usd.thb ? d.usd.thb : null,
      label: 'Fawaz Currency API'
    }
  ];

  for (const api of apis) {
    try {
      const res = await fetch(api.url);
      if (!res.ok) continue;
      const data = await res.json();
      const rate = api.parse(data);
      if (rate && rate > 20 && rate < 60) { // sanity check: THB should be ~30-40 per USD
        THB_RATE = parseFloat(rate.toFixed(4));
        const now = new Date().toLocaleTimeString('th-TH', {hour:'2-digit',minute:'2-digit'});
        // Update card if rendered
        const rateEl = document.getElementById('fx_rate');
        const srcEl  = document.getElementById('fx_source');
        if (rateEl) rateEl.textContent = `1 USD = ${THB_RATE.toFixed(2)} THB`;
        if (srcEl)  srcEl.textContent  = `${api.label} · อัปเดต ${now}`;
        console.log(`[FX] Rate updated: 1 USD = ${THB_RATE} THB (${api.label})`);
        return true;
      }
    } catch(e) {
      console.warn(`[FX] ${api.label} failed:`, e);
    }
  }

  // All APIs failed — keep fallback
  const srcEl = document.getElementById('fx_source');
  if (srcEl) srcEl.textContent = 'อัตราสำรอง (ไม่สามารถดึงได้)';
  console.warn('[FX] All exchange rate APIs failed, using fallback:', THB_RATE);
  return false;
}

// ---- FINNHUB REAL PRICE FETCH ----
const FINNHUB_KEY = 'd8h7m9pr01qhjpmqv5tgd8h7m9pr01qhjpmqv5u0';
let lastFetchTime = null;
let fetchStatusTimer = null;
// Once we learn the key is bad (401/403), stop hammering the API for the rest of the session.
let finnhubKeyOk = null; // null = unknown/untested, true = working, false = confirmed invalid

async function fetchOneTicker(ticker) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    finnhubKeyOk = false;
    throw new Error('FINNHUB_AUTH_FAILED');
  }
  const data = await res.json();
  // data: { c: current, d: change, dp: changePct, h, l, o, pc }
  if (data && data.c && data.c > 0) {
    finnhubKeyOk = true;
    return { price: data.c, change: data.d || 0, changePct: data.dp || 0 };
  }
  return null;
}

async function fetchRealPrices() {
  // If we already confirmed the key is dead this session, don't spam requests —
  // just keep the simulated live engine running and tell the user once.
  if (finnhubKeyOk === false) {
    const lbl = document.getElementById('liveLabel');
    if (lbl) lbl.textContent = 'LIVE (sim · Finnhub key ใช้ไม่ได้)';
    return;
  }

  const stocks = getStocks();
  const btn = document.getElementById('refreshBtn');
  const lbl = document.getElementById('liveLabel');

  btn.textContent = '⏳ กำลังดึง...';
  btn.disabled = true;
  lbl.textContent = 'FETCHING';

  const results = {};
  let authFailed = false;
  // Finnhub free tier: 60 calls/min — fetch one by one with small delay
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    try {
      const r = await fetchOneTicker(s.ticker);
      if (r) results[s.ticker] = r;
    } catch(e) {
      if (e.message === 'FINNHUB_AUTH_FAILED') {
        authFailed = true;
        console.warn('[Finnhub] API key rejected (401/403) — stopping further requests this session.');
        break; // no point hitting the same dead key 13 more times
      }
      console.warn('Finnhub fetch failed:', s.ticker, e.message);
    }
    if (i < stocks.length - 1) await new Promise(r => setTimeout(r, 120));
  }

  if (authFailed) {
    showToast('⚠️ Finnhub API key หมดอายุ/ไม่ถูกต้อง (401) — ใช้ราคาจำลองแทน', 'var(--red)');
    btn.textContent = '🔑 Key ผิด';
    btn.disabled = false;
    lbl.textContent = 'LIVE (sim · key ใช้ไม่ได้)';
    return;
  }

  // Apply real prices
  let updated = 0;
  const storedStocks = getStocks();
  storedStocks.forEach(s => {
    const r = results[s.ticker];
    if (r) {
      if (livePrices[s.ticker]) {
        livePrices[s.ticker].price    = r.price;
        livePrices[s.ticker].prevPrice = r.price;
        livePrices[s.ticker].change   = r.change;
        livePrices[s.ticker].pct      = r.changePct;
        // re-seed sparkline history around real price
        const hist = [];
        let p = r.price * (0.99 + Math.random()*0.02);
        for (let i = 0; i < 60; i++) {
          p = p * (1 + (Math.random()-0.499)*0.003);
          hist.push(parseFloat(p.toFixed(2)));
        }
        hist[hist.length-1] = r.price;
        livePrices[s.ticker].history = hist;
      }
      s.price = r.price;
      updated++;
    }
  });
  if (updated > 0) {
    await updatePricesInSB(storedStocks);
    _stocks = storedStocks;
  }

  lastFetchTime = new Date();
  const timeStr = lastFetchTime.toLocaleTimeString('th-TH');

  btn.textContent = updated > 0 ? `✅ ${updated} ตัว` : '⚠️ ไม่สำเร็จ';
  btn.disabled = false;

  if (updated > 0) {
    lbl.textContent = `🕐 ${timeStr}`;
    renderTable();
    updateLiveTable();
    updateLiveSummary();
    updateTape();
    renderLineChart();
    checkPriceAlerts();
  } else {
    lbl.textContent = 'LIVE (sim)';
  }

  clearTimeout(fetchStatusTimer);
  fetchStatusTimer = setTimeout(() => {
    btn.textContent = '🔄 Refresh';
    if (!livePaused) lbl.textContent = 'LIVE';
  }, 6000);
}

// Auto-fetch on load, then every 5 minutes
async function autoFetch() {
  await fetchExchangeRate(); // fetch live FX rate first
  await fetchRealPrices();
  // Refresh stock prices every 5 min, FX rate every 15 min
  setInterval(fetchRealPrices, 5 * 60 * 1000);
  setInterval(async () => {
    await fetchExchangeRate();
    // Re-render summary to reflect new rate
    renderSummary();
    renderLineChart();
    updateLiveSummary();
  }, 15 * 60 * 1000);
}

function changeCurrency() {
  currency = document.getElementById('currencySelect').value;
  renderAll();
}

// ---- LIVE SIMULATION ENGINE ----
let liveInterval = null;
let liveSpeed = 1500;
let livePaused = false;
// livePrices: { TICKER: { price, prevPrice, change, pct, history:[last 60 ticks] } }
let livePrices = {};

function initLivePrices() {
  const stocks = getStocks();
  stocks.forEach(s => {
    const base = parseFloat(s.price);
    if (!livePrices[s.ticker]) {
      // seed 60-point mini history around base price (no bias)
      const hist = [];
      let p = base;
      for (let i=0;i<60;i++) {
        p = p * (1 + (Math.random()-0.5)*0.004);
        hist.push(parseFloat(p.toFixed(2)));
      }
      hist[hist.length-1] = base; // always end at real price
      livePrices[s.ticker] = { price: base, prevPrice: base, change: 0, pct: 0, history: hist };
    }
  });
}

function tickPrices() {
  if (livePaused) return;
  const stocks = getStocks();
  stocks.forEach(s => {
    const lp = livePrices[s.ticker];
    if (!lp) return;
    // Cosmetic-only random walk for the live "pulse" effect (sparklines, ticker tape, flashing cells).
    // It must NEVER be allowed to drift away from the real price — it snaps back hard every tick
    // so the portfolio total always reflects the actual last-known price, not accumulated noise.
    const base = parseFloat(s.price);
    const vol = base * 0.0015 * (Math.random() - 0.5) * 2; // tiny cosmetic jitter: ±0.15% of REAL price
    const newPrice = Math.max(0.01, base + vol);
    lp.prevPrice = lp.price;
    lp.price = parseFloat(newPrice.toFixed(2));
    lp.change = parseFloat((lp.price - base).toFixed(2));
    lp.pct = parseFloat(((lp.price - base)/base*100).toFixed(2));
    lp.history.push(lp.price);
    if (lp.history.length > 60) lp.history.shift();
  });
  updateLiveTable();
  // NOTE: summary cards (total portfolio value) intentionally use renderSummary()'s
  // real-price calculation, not this cosmetic tick — see updateLiveSummary() below.
  updateLiveSummary();
  updateTape();
  // line chart's live-updating last point also anchors to REAL price, not the jittered one
  if (lineChartInst) {
    let total = 0;
    stocks.forEach(s => { total += parseFloat(s.price) * parseFloat(s.shares); });
    const val = currency==='THB' ? total*THB_RATE : total;
    const data = lineChartInst.data.datasets[0].data;
    data[data.length-1] = parseFloat(val.toFixed(2));
    lineChartInst.update('none');
  }
  checkPriceAlerts();
  // live-update detail view chart if open
  if (detailState.open) updateDetailLivePrice();
}

function updateLiveSummary() {
  const stocks = getStocks();
  let totalValue=0, totalCost=0;
  stocks.forEach(s => {
    // Portfolio total ALWAYS uses the real stored price (s.price), never the cosmetic
    // jittered livePrices value — otherwise the total would visibly drift from what's
    // actually recorded, which is confusing ("เงินไม่เท่ากัน") even though nothing real changed.
    const p = parseFloat(s.price);
    totalValue += p * parseFloat(s.shares);
    totalCost  += parseFloat(s.cost) * parseFloat(s.shares);
  });
  const pl = totalValue - totalCost;
  const pct = totalCost>0?(pl/totalCost)*100:0;
  const v = document.getElementById('sum_value');
  const p2 = document.getElementById('sum_pl');
  if (v) {
    v.textContent = fmtCur(totalValue);
    const sub = v.parentElement.querySelector('.card-sub');
    if (sub) sub.textContent = currency==='USD' ? '≈ ฿'+fmt(totalValue*THB_RATE) : '≈ $'+fmt(totalValue);
  }
  if (p2) {
    p2.textContent = (pl>=0?'+':'')+fmtCur(pl);
    p2.className = 'card-value ' + (pl>=0?'green':'red');
  }
  const badge = document.getElementById('sum_badge');
  if (badge) {
    badge.textContent = (pct>=0?'↑':'↓') + ' ' + Math.abs(pct).toFixed(2) + '%';
    badge.className = 'card-badge ' + (pct>=0?'badge-green':'badge-red');
  }
}

function updateLiveTable() {
  const stocks = getStocks();
  const totalValue = stocks.reduce((a,s)=>a+(livePrices[s.ticker]?.price||parseFloat(s.price))*parseFloat(s.shares),0);
  stocks.forEach((s, idx) => {
    const lp = livePrices[s.ticker];
    if (!lp) return;
    const val = lp.price * parseFloat(s.shares);
    const cost = parseFloat(s.cost);
    const pl = lp.price - cost;
    const plPct = cost>0?(pl/cost)*100:0;
    const totalPL = val - parseFloat(s.cost)*parseFloat(s.shares);
    const weight = totalValue>0?(val/totalValue)*100:0;
    const up = lp.price >= lp.prevPrice;

    // price cell — update only the text node, preserving the sparkline canvas child
    const priceEl = document.getElementById(`lp_${s.ticker}`);
    if (priceEl) {
      // Update first text node only (don't destroy the canvas sparkline child)
      const textNode = priceEl.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        textNode.textContent = fmtCur(lp.price);
      } else {
        priceEl.insertBefore(document.createTextNode(fmtCur(lp.price)), priceEl.firstChild);
      }
      priceEl.classList.remove('flash-up','flash-dn');
      void priceEl.offsetWidth;
      priceEl.classList.add(up?'flash-up':'flash-dn');
    }
    // value cell
    const valEl = document.getElementById(`lv_${s.ticker}`);
    if (valEl) valEl.textContent = fmtCur(val);
    // pl cell
    const plEl = document.getElementById(`ll_${s.ticker}`);
    if (plEl) {
      plEl.textContent = (totalPL>=0?'+':'')+fmtCur(totalPL);
      plEl.className = 'mono hide-sm ' + (totalPL>=0?'green':'red');
    }
    // pct cell
    const pctEl = document.getElementById(`lpct_${s.ticker}`);
    if (pctEl) pctEl.innerHTML = pctBadge(plPct);
    // weight
    const wEl = document.getElementById(`lw_${s.ticker}`);
    if (wEl) wEl.textContent = weight.toFixed(1)+'% · '+s.sector;
    // sparkline
    drawSparkline(s.ticker, lp.history);
  });
}

function drawSparkline(ticker, data) {
  const cv = document.getElementById(`spark_${ticker}`);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const w=cv.width, h=cv.height;
  ctx.clearRect(0,0,w,h);
  if (data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max-min || 0.01;
  const up = data[data.length-1] >= data[0];
  ctx.beginPath();
  data.forEach((v,i) => {
    const x = (i/(data.length-1))*w;
    const y = h - ((v-min)/range)*(h-2) - 1;
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.strokeStyle = up ? '#00e5a0' : '#ff4d6a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function updateTape() {
  const stocks = getStocks();
  // build items x2 for seamless loop
  const items = stocks.map(s => {
    const lp = livePrices[s.ticker];
    if (!lp) return '';
    const up = lp.pct >= 0;
    return `<div class="tape-item">
      <span class="tape-ticker">${s.ticker}</span>
      <span class="tape-price">${fmtCur(lp.price)}</span>
      <span class="tape-chg ${up?'up':'dn'}">${up?'▲':'▼'}${Math.abs(lp.pct).toFixed(2)}%</span>
    </div>`;
  }).join('');
  const tape = document.getElementById('tapeTrack');
  if (tape) tape.innerHTML = items + items; // duplicate for seamless scroll
}

function setSpeed(ms, btnId) {
  liveSpeed = ms;
  livePaused = false;
  document.querySelectorAll('.speed-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById(btnId).classList.add('active');
  document.getElementById('spdP').textContent = '⏸';
  restartInterval();
}
function togglePause() {
  livePaused = !livePaused;
  const dot = document.getElementById('liveDot');
  const lbl = document.getElementById('liveLabel');
  const btn = document.getElementById('spdP');
  if (livePaused) {
    dot.style.animationPlayState = 'paused';
    dot.style.background = 'var(--muted)';
    lbl.textContent = 'PAUSED';
    btn.textContent = '▶';
  } else {
    dot.style.animationPlayState = 'running';
    dot.style.background = 'var(--green)';
    lbl.textContent = 'LIVE';
    btn.textContent = '⏸';
  }
}
function restartInterval() {
  if (liveInterval) clearInterval(liveInterval);
  liveInterval = setInterval(tickPrices, liveSpeed);
}

function renderAll() {
  renderSummary();
  renderLineChart();
  renderPieChart();
  renderTable();
  initLivePrices();
  updateTape();
  restartInterval();
}

// ===================================================================
// ====================  STOCK DETAIL VIEW (Webull-style)  =========
// ===================================================================

const detailState = {
  open: false,
  idx: -1,
  ticker: null,
  tf: '1M',
  candles: [],       // [{t, o, h, l, c, v}]
  drawTool: 'cursor',
  drawings: [],       // {id, type:'hline'|'trend', ticker, p1:{t,price}, p2:{t,price}(trend only), color}
  pendingPoint: null, // first click point for trend line
  view: { xMin:0, xMax:0, yMin:0, yMax:0 }, // data-space bounds currently shown
  hoverIdx: -1,
  candleW: 0,
  alerts: [],          // {id, ticker, cond:'above'|'below', price, triggered}
  dataSource: null,    // 'real' (Finnhub) | 'mock' (fallback simulated)
  indicators: { ema9:false, ema21:false, sma50:false, rsi:false }
};
let detailResizeObs = null;

function tfToDays(tf) {
  return { '1D':1, '1M':30, '3M':90, '6M':180, '1Y':365, '5Y':1825 }[tf] || 30;
}
// Finnhub resolution + lookback (in days) per timeframe
function tfToFinnhub(tf) {
  return {
    '1D': { resolution: '15',  days: 1    },  // 15-min bars, today
    '1M': { resolution: 'D',   days: 30   },
    '3M': { resolution: 'D',   days: 90   },
    '6M': { resolution: 'D',   days: 180  },
    '1Y': { resolution: 'W',   days: 365  },  // weekly bars for 1Y
    '5Y': { resolution: 'M',   days: 1825 },  // monthly bars for 5Y
  }[tf] || { resolution: 'D', days: 30 };
}

// ---- generate synthetic OHLC candles (FALLBACK ONLY, used when Finnhub candle data is unavailable) ----
// Fixed to be deterministic ACROSS timeframes: a single continuous daily random-walk is generated
// once per ticker (long enough for 1Y), then each timeframe just slices the tail of that same
// series and resamples it (e.g. weekly for 1Y) — so switching timeframes shows the SAME underlying
// price path at a different zoom level, instead of regenerating unrelated random data each time.
const _mockSeriesCache = {};
function getMockDailySeries(ticker, basePrice) {
  const key = ticker;
  if (_mockSeriesCache[key]) return _mockSeriesCache[key];
  let seed = 0;
  for (let i=0;i<ticker.length;i++) seed += ticker.charCodeAt(i) * (i+1);
  const rnd = mulberry32(seed);
  const totalDays = 1900; // enough for 5Y view + warm-up
  const path = [];
  let price = basePrice * 0.45; // start ~55% below current for 5Y
  for (let i = 0; i < totalDays; i++) {
    const remaining = totalDays - i;
    const drift = (basePrice - price) / Math.max(remaining, 1) * 0.6;
    const vol = price * 0.014;
    price = Math.max(0.5, price + drift + (rnd()-0.5)*vol*2);
    path.push(price);
  }
  path[path.length-1] = basePrice; // today's actual close
  _mockSeriesCache[key] = { path, rnd: mulberry32(seed+1) };
  return _mockSeriesCache[key];
}

function genCandles(basePrice, tf, ticker) {
  const { path, rnd } = getMockDailySeries(ticker, basePrice);
  const days = tfToDays(tf);
  const today = new Date();

  if (tf === '1D') {
    // synthesize 48 intraday 30-min bars ending at basePrice, walking from yesterday's close
    const prevClose = path[path.length-2] ?? basePrice*0.99;
    const candles = [];
    let price = prevClose;
    for (let i = 47; i >= 0; i--) {
      const t = new Date(today.getTime() - i * 30 * 60000);
      const remaining = i+1;
      const drift = (basePrice - price) / remaining * 0.5;
      const vol = price * 0.0035;
      const o = price;
      let c = o + drift + (rnd()-0.5)*vol*2;
      const h = Math.max(o,c) + rnd()*vol*0.5;
      const l = Math.min(o,c) - rnd()*vol*0.5;
      candles.push({ t: t.getTime(), o, h: Math.max(h,o,c), l: Math.min(l,o,c), c, v: Math.floor(80000+rnd()*500000) });
      price = c;
    }
    candles[candles.length-1].c = basePrice;
    candles[candles.length-1].h = Math.max(candles[candles.length-1].h, basePrice);
    candles[candles.length-1].l = Math.min(candles[candles.length-1].l, basePrice);
    return candles;
  }

  // Slice the last N days from the shared daily path (same series for every timeframe)
  const slice = path.slice(Math.max(0, path.length - days));
  const dailyCandles = slice.map((p, i) => {
    const prevP = i===0 ? p*0.998 : slice[i-1];
    const t = new Date(today); t.setDate(t.getDate() - (slice.length-1-i));
    const o = prevP, c = p;
    const vol = Math.abs(c-o) + p*0.004;
    const h = Math.max(o,c) + rnd()*vol*0.4;
    const l = Math.min(o,c) - rnd()*vol*0.4;
    return { t: t.getTime(), o, h: Math.max(h,o,c), l: Math.min(l,o,c), c, v: Math.floor(80000+rnd()*500000) };
  });

  if (tf !== '1Y' && tf !== '5Y') return dailyCandles;

  if (tf === '5Y') {
    // Resample daily -> monthly for 5Y
    const monthly = [];
    for (let i = 0; i < dailyCandles.length; i += 21) {
      const chunk = dailyCandles.slice(i, i+21);
      if (!chunk.length) continue;
      monthly.push({
        t: chunk[chunk.length-1].t,
        o: chunk[0].o,
        c: chunk[chunk.length-1].c,
        h: Math.max(...chunk.map(k=>k.h)),
        l: Math.min(...chunk.map(k=>k.l)),
        v: chunk.reduce((a,k)=>a+k.v,0)
      });
    }
    return monthly;
  }

  // Resample daily -> weekly for 1Y so we still show the SAME path, just lower resolution
  const weekly = [];
  for (let i = 0; i < dailyCandles.length; i += 7) {
    const chunk = dailyCandles.slice(i, i+7);
    if (!chunk.length) continue;
    weekly.push({
      t: chunk[chunk.length-1].t,
      o: chunk[0].o,
      c: chunk[chunk.length-1].c,
      h: Math.max(...chunk.map(k=>k.h)),
      l: Math.min(...chunk.map(k=>k.l)),
      v: chunk.reduce((a,k)=>a+k.v,0)
    });
  }
  return weekly;
}
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

async function openDetail(idx) {
  const stocks = getStocks();
  const s = stocks[idx];
  if (!s) return;
  detailState.open = true;
  detailState.idx = idx;
  detailState.ticker = s.ticker;
  detailState.tf = '1M';
  detailState.drawTool = 'cursor';
  detailState.pendingPoint = null;
  detailState.candles = [];

  document.getElementById('d_ticker').textContent = s.ticker;
  document.getElementById('d_sector').textContent = s.sector;
  document.querySelectorAll('#tfGroup .tf-btn').forEach(b=>b.classList.toggle('active', b.dataset.tf==='1M'));
  setDrawTool('cursor');

  renderPositionBlock(idx);
  renderAlertsUI();
  renderDrawnListUI();
  updateDetailLivePrice();

  document.getElementById('detailOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  // size canvas after layout settles, then fetch+draw
  requestAnimationFrame(async ()=> {
    setupCanvas();
    await loadCandlesForTicker(s.ticker, detailState.tf);
  });
  if (!detailResizeObs) {
    detailResizeObs = new ResizeObserver(()=>{ if(detailState.open){ setupCanvas(); drawChart(); } });
    detailResizeObs.observe(document.getElementById('candleCanvas').parentElement);
  }
}

function closeDetail() {
  detailState.open = false;
  document.getElementById('detailOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ---- Real historical candles from Finnhub, with graceful fallback to mock series ----
async function fetchFinnhubCandles(ticker, tf) {
  if (finnhubKeyOk === false) throw new Error('FINNHUB_AUTH_FAILED');
  const { resolution, days } = tfToFinnhub(tf);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400 - 86400; // small buffer
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    finnhubKeyOk = false;
    throw new Error('FINNHUB_AUTH_FAILED');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) {
    throw new Error(data && data.s ? ('Finnhub status: ' + data.s) : 'No data');
  }
  finnhubKeyOk = true;
  const candles = data.t.map((ts, i) => ({
    t: ts * 1000,
    o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v ? data.v[i] : 0
  }));
  return candles;
}

async function loadCandlesForTicker(ticker, tf) {
  const stocks = getStocks();
  const s = stocks.find(x=>x.ticker===ticker);
  const base = livePrices[ticker]?.price || parseFloat(s?.price || 100);

  setChartDataSourceLabel('⏳ กำลังดึงราคาจริง...', '#0099ff');
  try {
    const real = await fetchFinnhubCandles(ticker, tf);
    // keep last candle's close in sync with current live price for a smooth "live tail"
    if (real.length) {
      real[real.length-1].c = base;
      real[real.length-1].h = Math.max(real[real.length-1].h, base);
      real[real.length-1].l = Math.min(real[real.length-1].l, base);
    }
    detailState.candles = real;
    detailState.dataSource = 'real';
    setChartDataSourceLabel('✅ ราคาจริงจาก Finnhub', 'var(--green)');
  } catch (err) {
    if (err.message === 'FINNHUB_AUTH_FAILED') {
      console.warn('[Finnhub] Key invalid — using simulated chart (no further candle requests this session).');
    } else {
      console.warn('Finnhub candle fetch failed, falling back to simulated chart:', err.message);
    }
    detailState.candles = genCandles(base, tf, ticker);
    detailState.dataSource = 'mock';
    setChartDataSourceLabel(
      err.message === 'FINNHUB_AUTH_FAILED' ? '⚠️ Finnhub key ใช้ไม่ได้ — กราฟจำลอง' : '⚠️ ใช้กราฟจำลอง (ดึงราคาจริงไม่สำเร็จ)',
      'var(--red)'
    );
  }
  fitView();
  drawChart();
  initDateRangeUI();
}

function setChartDataSourceLabel(text, color) {
  const hint = document.getElementById('chartHint');
  if (hint) {
    hint.textContent = text;
    hint.style.color = color || 'var(--muted)';
    clearTimeout(hint._revertTimer);
    hint._revertTimer = setTimeout(() => {
      if (!detailState.open) return;
      const tool = detailState.drawTool;
      if (tool==='cursor') hint.textContent = 'เลื่อนดูกราฟ';
      else if (tool==='hline') hint.textContent = 'คลิกบนกราฟเพื่อตีเส้นแนวนอน';
      else if (tool==='trend') hint.textContent = 'คลิก 2 จุดเพื่อตีเส้นเทรนด์';
      hint.style.color = 'var(--muted)';
    }, 3500);
  }
  // persistent badge in topbar
  const badge = document.getElementById('d_datasource');
  if (badge) {
    if (detailState.dataSource === 'real') {
      badge.textContent = '● REAL DATA';
      badge.style.background = 'rgba(0,229,160,0.12)';
      badge.style.color = 'var(--green)';
    } else if (detailState.dataSource === 'mock') {
      badge.textContent = '● SIMULATED';
      badge.style.background = 'rgba(255,77,106,0.12)';
      badge.style.color = 'var(--red)';
    } else {
      badge.textContent = '';
    }
  }
}

function fitView() {
  const c = detailState.candles;
  if (!c.length) return;
  let lo = Infinity, hi = -Infinity;
  c.forEach(k => { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
  const pad = (hi-lo)*0.08 || hi*0.02;
  detailState.view = { xMin: 0, xMax: c.length-1, yMin: lo-pad, yMax: hi+pad };
}

// ---- timeframe switching ----
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#tfGroup .tf-btn');
  if (!btn) return;
  document.querySelectorAll('#tfGroup .tf-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  detailState.tf = btn.dataset.tf;
  await loadCandlesForTicker(detailState.ticker, detailState.tf);
});

function setDrawTool(tool) {
  detailState.drawTool = tool;
  detailState.pendingPoint = null;
  ['cursor','hline','trend'].forEach(t=>{
    const map = { cursor:'toolCursor', hline:'toolHLine', trend:'toolTrend' };
    document.getElementById(map[t]).classList.toggle('active', t===tool);
  });
  const hint = document.getElementById('chartHint');
  if (tool==='cursor') hint.textContent = 'เลื่อนดูกราฟ';
  else if (tool==='hline') hint.textContent = 'คลิกบนกราฟเพื่อตีเส้นแนวนอน';
  else if (tool==='trend') hint.textContent = 'คลิก 2 จุดเพื่อตีเส้นเทรนด์';
}

function clearLastDrawing() {
  const arr = detailState.drawings.filter(d=>d.ticker===detailState.ticker);
  if (!arr.length) return;
  const last = arr[arr.length-1];
  detailState.drawings = detailState.drawings.filter(d=>d.id!==last.id);
  saveDrawingsToSB();
  renderDrawnListUI();
  drawChart();
}
function clearAllDrawings() {
  if (!confirm('ลบเส้นทั้งหมดของ ' + detailState.ticker + ' ?')) return;
  detailState.drawings = detailState.drawings.filter(d=>d.ticker!==detailState.ticker);
  saveDrawingsToSB();
  renderDrawnListUI();
  drawChart();
}

// ---- Indicators: EMA / SMA / RSI ----
function toggleIndicator(key) {
  detailState.indicators[key] = !detailState.indicators[key];
  document.querySelector(`.ind-btn[data-ind="${key}"]`).classList.toggle('active', detailState.indicators[key]);
  document.getElementById('rsiPaneWrap').style.display = detailState.indicators.rsi ? 'block' : 'none';
  if (detailState.indicators.rsi) setupRsiCanvas();
  drawChart();
}
function calcEMA(closes, period) {
  const k = 2/(period+1);
  const out = new Array(closes.length).fill(null);
  let ema = null;
  closes.forEach((c,i)=>{
    if (i < period-1) return;
    if (ema === null) {
      ema = closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
    } else {
      ema = c*k + ema*(1-k);
    }
    out[i] = ema;
  });
  return out;
}
function calcSMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i=period-1;i<closes.length;i++) {
    let sum=0; for(let j=i-period+1;j<=i;j++) sum+=closes[j];
    out[i] = sum/period;
  }
  return out;
}
function calcRSI(closes, period=14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period+1) return out;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++) {
    const diff = closes[i]-closes[i-1];
    if (diff>=0) gains+=diff; else losses-=diff;
  }
  let avgGain = gains/period, avgLoss = losses/period;
  out[period] = avgLoss===0 ? 100 : 100 - (100/(1+avgGain/avgLoss));
  for (let i=period+1;i<closes.length;i++) {
    const diff = closes[i]-closes[i-1];
    const gain = diff>0?diff:0, loss = diff<0?-diff:0;
    avgGain = (avgGain*(period-1)+gain)/period;
    avgLoss = (avgLoss*(period-1)+loss)/period;
    out[i] = avgLoss===0 ? 100 : 100 - (100/(1+avgGain/avgLoss));
  }
  return out;
}

// ---- Canvas setup & rendering ----
let dctx = null, dcanvas = null, DPR = 1;
let rctx = null, rcanvas = null;
function setupCanvas() {
  dcanvas = document.getElementById('candleCanvas');
  const wrap = dcanvas.parentElement;
  DPR = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth - 28; // minus padding
  const cssH = 420;
  dcanvas.style.width = cssW + 'px';
  dcanvas.style.height = cssH + 'px';
  dcanvas.width = cssW * DPR;
  dcanvas.height = cssH * DPR;
  dctx = dcanvas.getContext('2d');
  dctx.setTransform(DPR,0,0,DPR,0,0);
}
function setupRsiCanvas() {
  rcanvas = document.getElementById('rsiCanvas');
  if (!rcanvas) return;
  const wrap = rcanvas.parentElement;
  const cssW = wrap.clientWidth - 28;
  const cssH = 110;
  rcanvas.style.width = cssW + 'px';
  rcanvas.style.height = cssH + 'px';
  rcanvas.width = cssW * DPR;
  rcanvas.height = cssH * DPR;
  rctx = rcanvas.getContext('2d');
  rctx.setTransform(DPR,0,0,DPR,0,0);
}

function priceToY(price, view, h) {
  return h - ((price - view.yMin) / (view.yMax - view.yMin)) * h;
}
function yToPrice(y, view, h) {
  return view.yMin + (1 - y/h) * (view.yMax - view.yMin);
}
function idxToX(i, view, w) {
  return ((i - view.xMin) / (view.xMax - view.xMin || 1)) * w;
}
function xToIdx(x, view, w) {
  return view.xMin + (x / w) * (view.xMax - view.xMin);
}

// Right-axis price gutter width (px) reserved on the right side of the chart
const AXIS_GUTTER = 64;

function drawChart() {
  if (!dctx || !dcanvas) return;
  const fullW = dcanvas.width / DPR, h = dcanvas.height / DPR;
  const w = fullW - AXIS_GUTTER; // plotting area excludes the right price axis gutter
  dctx.clearRect(0,0,fullW,h);
  const candles = detailState.candles;
  if (!candles.length) return;
  const view = detailState.view;

  // grid + right-side price axis
  dctx.strokeStyle = 'rgba(255,255,255,0.05)';
  dctx.lineWidth = 1;
  const gridLines = 6;
  for (let i=0;i<=gridLines;i++) {
    const y = (h/gridLines)*i;
    dctx.beginPath(); dctx.moveTo(0,y); dctx.lineTo(w,y); dctx.stroke();
    const price = yToPrice(y, view, h);
    // axis background chip
    dctx.fillStyle = '#181d24';
    dctx.fillRect(w+1, Math.max(0,y-9), AXIS_GUTTER-1, 18);
    dctx.fillStyle = '#cfd6e3';
    dctx.font = 'bold 12px "Space Mono", monospace';
    dctx.textAlign = 'left';
    const py = i===0 ? 12 : (i===gridLines ? h-4 : y+4);
    dctx.fillText('$'+price.toFixed(2), w+8, py);
  }
  // separator line between plot and axis
  dctx.strokeStyle = 'rgba(255,255,255,0.1)';
  dctx.beginPath(); dctx.moveTo(w,0); dctx.lineTo(w,h); dctx.stroke();

  // candles
  const visibleN = Math.max(1, view.xMax - view.xMin);
  const candleW = Math.max(1.5, (w / visibleN) * 0.62);
  detailState.candleW = candleW;
  const startI = Math.max(0, Math.floor(view.xMin));
  const endI = Math.min(candles.length-1, Math.ceil(view.xMax));

  for (let i = startI; i <= endI; i++) {
    const k = candles[i];
    if (!k) continue;
    const x = idxToX(i, view, w);
    const yO = priceToY(k.o, view, h);
    const yC = priceToY(k.c, view, h);
    const yH = priceToY(k.h, view, h);
    const yL = priceToY(k.l, view, h);
    const up = k.c >= k.o;
    const color = up ? '#00e5a0' : '#ff4d6a';
    dctx.strokeStyle = color;
    dctx.fillStyle = color;
    dctx.lineWidth = 1;
    // wick
    dctx.beginPath(); dctx.moveTo(x, yH); dctx.lineTo(x, yL); dctx.stroke();
    // body
    const bodyTop = Math.min(yO,yC), bodyH = Math.max(1, Math.abs(yO-yC));
    dctx.fillRect(x - candleW/2, bodyTop, candleW, bodyH);
  }

  // ---- Indicator overlays (EMA9 / EMA21 / SMA50) ----
  const closes = candles.map(k=>k.c);
  function plotLine(series, color) {
    dctx.strokeStyle = color;
    dctx.lineWidth = 1.6;
    dctx.beginPath();
    let started = false;
    for (let i = startI; i <= endI; i++) {
      const v = series[i];
      if (v == null) continue;
      const x = idxToX(i, view, w);
      const y = priceToY(v, view, h);
      if (!started) { dctx.moveTo(x,y); started = true; } else { dctx.lineTo(x,y); }
    }
    if (started) dctx.stroke();
  }
  if (detailState.indicators.ema9) plotLine(calcEMA(closes,9), '#f5c842');
  if (detailState.indicators.ema21) plotLine(calcEMA(closes,21), '#0099ff');
  if (detailState.indicators.sma50) plotLine(calcSMA(closes,50), '#ff6b35');

  // x-axis date labels
  {
    const xLabelCount = Math.min(6, endI - startI + 1);
    const step = Math.max(1, Math.floor((endI - startI + 1) / xLabelCount));
    dctx.fillStyle = '#5a6478';
    dctx.font = '9px "Space Mono", monospace';
    dctx.textAlign = 'center';
    for (let i = startI; i <= endI; i += step) {
      const k = candles[i];
      if (!k) continue;
      const x = idxToX(i, view, w);
      const dt = new Date(k.t);
      let label;
      if (detailState.tf === '1D') {
        label = dt.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:false});
      } else if (detailState.tf === '5Y') {
        label = dt.toLocaleDateString('en-US', {month:'short', year:'2-digit'});
      } else if (detailState.tf === '1Y') {
        label = dt.toLocaleDateString('en-US', {month:'short', year:'2-digit'});
      } else {
        label = dt.toLocaleDateString('en-US', {day:'numeric', month:'short'});
      }
      dctx.fillText(label, Math.max(30, Math.min(x, w-30)), h - 4);
    }
    dctx.textAlign = 'left';
  }

  // drawings (hlines, trendlines) for this ticker
  const myDrawings = detailState.drawings.filter(d=>d.ticker===detailState.ticker);
  myDrawings.forEach(d => {
    dctx.strokeStyle = d.color || '#f5c842';
    dctx.lineWidth = 1.4;
    dctx.setLineDash([]);
    if (d.type === 'hline') {
      const y = priceToY(d.p1.price, view, h);
      dctx.beginPath(); dctx.moveTo(0,y); dctx.lineTo(w,y); dctx.stroke();
      dctx.fillStyle = d.color || '#f5c842';
      dctx.font = 'bold 10px "Space Mono", monospace';
      const label = '$'+d.p1.price.toFixed(2);
      dctx.fillRect(w+1, y-9, AXIS_GUTTER-1, 18);
      dctx.fillStyle = '#0a0c10';
      dctx.fillText(label, w+8, y+3);
    } else if (d.type === 'trend') {
      const x1 = idxToX(d.p1.i, view, w), y1 = priceToY(d.p1.price, view, h);
      const x2 = idxToX(d.p2.i, view, w), y2 = priceToY(d.p2.price, view, h);
      dctx.beginPath(); dctx.moveTo(x1,y1); dctx.lineTo(x2,y2); dctx.stroke();
      dctx.fillStyle = d.color || '#f5c842';
      dctx.beginPath(); dctx.arc(x1,y1,3,0,7); dctx.fill();
      dctx.beginPath(); dctx.arc(x2,y2,3,0,7); dctx.fill();
    }
  });

  // alert lines (dashed) for this ticker
  detailState.alerts.filter(a=>a.ticker===detailState.ticker && !a.triggered).forEach(a => {
    const y = priceToY(a.price, view, h);
    if (y < -10 || y > h+10) return;
    dctx.strokeStyle = a.cond==='above' ? 'rgba(0,229,160,0.6)' : 'rgba(255,77,106,0.6)';
    dctx.lineWidth = 1.2;
    dctx.setLineDash([5,4]);
    dctx.beginPath(); dctx.moveTo(0,y); dctx.lineTo(w,y); dctx.stroke();
    dctx.setLineDash([]);
    dctx.fillStyle = a.cond==='above' ? '#00e5a0' : '#ff4d6a';
    dctx.font = '9px "Space Mono", monospace';
    dctx.fillText((a.cond==='above'?'🔔≥ $':'🔔≤ $')+a.price.toFixed(2), 6, y-4 < 10 ? y+12 : y-4);
  });

  // pending trend point preview
  if (detailState.pendingPoint && detailState.drawTool==='trend') {
    const px = idxToX(detailState.pendingPoint.i, view, w);
    const py = priceToY(detailState.pendingPoint.price, view, h);
    dctx.fillStyle = '#f5c842';
    dctx.beginPath(); dctx.arc(px,py,4,0,7); dctx.fill();
  }

  // crosshair
  if (detailState.hoverIdx >= 0) {
    const k = candles[Math.round(detailState.hoverIdx)];
    if (k) {
      const x = idxToX(Math.round(detailState.hoverIdx), view, w);
      dctx.strokeStyle = 'rgba(255,255,255,0.25)';
      dctx.lineWidth = 1;
      dctx.setLineDash([3,3]);
      dctx.beginPath(); dctx.moveTo(x,0); dctx.lineTo(x,h); dctx.stroke();
      if (detailState._hoverY != null) {
        dctx.beginPath(); dctx.moveTo(0,detailState._hoverY); dctx.lineTo(w,detailState._hoverY); dctx.stroke();
        // highlighted price chip at crosshair y, on the axis
        const hoverPrice = yToPrice(detailState._hoverY, view, h);
        dctx.setLineDash([]);
        dctx.fillStyle = '#0099ff';
        dctx.fillRect(w+1, detailState._hoverY-9, AXIS_GUTTER-1, 18);
        dctx.fillStyle = '#fff';
        dctx.font = 'bold 12px "Space Mono", monospace';
        dctx.fillText('$'+hoverPrice.toFixed(2), w+8, detailState._hoverY+3);
      }
      dctx.setLineDash([]);
    }
  }

  if (detailState.indicators.rsi) drawRsiPane(startI, endI, view);
}

function drawRsiPane(startI, endI, view) {
  if (!rctx || !rcanvas) return;
  const fullW = rcanvas.width/DPR, h = rcanvas.height/DPR;
  const w = fullW - AXIS_GUTTER;
  rctx.clearRect(0,0,fullW,h);
  const closes = detailState.candles.map(k=>k.c);
  const rsi = calcRSI(closes,14);

  // gridlines at 30/50/70
  [30,50,70].forEach(level=>{
    const y = h - (level/100)*h;
    rctx.strokeStyle = level===50 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)';
    rctx.beginPath(); rctx.moveTo(0,y); rctx.lineTo(w,y); rctx.stroke();
    rctx.fillStyle = '#181d24';
    rctx.fillRect(w+1, y-8, AXIS_GUTTER-1, 16);
    rctx.fillStyle = '#cfd6e3';
    rctx.font = '10px "Space Mono", monospace';
    rctx.fillText(level, w+8, y+3);
  });
  rctx.strokeStyle = 'rgba(255,255,255,0.1)';
  rctx.beginPath(); rctx.moveTo(w,0); rctx.lineTo(w,h); rctx.stroke();

  rctx.strokeStyle = '#0099ff';
  rctx.lineWidth = 1.6;
  rctx.beginPath();
  let started = false;
  for (let i = startI; i <= endI; i++) {
    const v = rsi[i];
    if (v == null) continue;
    const x = idxToX(i, view, w);
    const y = h - (v/100)*h;
    if (!started) { rctx.moveTo(x,y); started = true; } else { rctx.lineTo(x,y); }
  }
  if (started) rctx.stroke();

  rctx.fillStyle = '#5a6478';
  rctx.font = '9px "Space Mono", monospace';
  rctx.fillText('RSI(14)', 6, 12);
}

// ---- mouse interaction: pan/zoom, drawing ----
function attachCanvasEvents() {
  const cv = document.getElementById('candleCanvas');
  let isPanning = false, panStartX = 0, panStartView = null;

  function plotWidth(rect) { return rect.width - AXIS_GUTTER; }

  cv.onmousedown = (e) => {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const w = plotWidth(rect), h = rect.height;
    const i = xToIdx(x, detailState.view, w);
    const price = yToPrice(y, detailState.view, h);

    if (detailState.drawTool === 'hline') {
      detailState.drawings.push({ id: 'd'+Date.now(), type:'hline', ticker: detailState.ticker, p1:{price}, color:'#f5c842' });
      saveDrawingsToSB();
      renderDrawnListUI();
      drawChart();
      return;
    }
    if (detailState.drawTool === 'trend') {
      if (!detailState.pendingPoint) {
        detailState.pendingPoint = { i, price };
        drawChart();
      } else {
        detailState.drawings.push({
          id:'d'+Date.now(), type:'trend', ticker: detailState.ticker,
          p1: detailState.pendingPoint, p2:{i, price}, color:'#0099ff'
        });
        detailState.pendingPoint = null;
        saveDrawingsToSB();
        renderDrawnListUI();
        drawChart();
      }
      return;
    }
    // cursor tool -> pan
    isPanning = true; panStartX = x; panStartView = {...detailState.view};
  };

  cv.onmousemove = (e) => {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const w = plotWidth(rect), h = rect.height;
    detailState.hoverIdx = xToIdx(x, detailState.view, w);
    detailState._hoverY = y;

    const i = Math.round(detailState.hoverIdx);
    const k = detailState.candles[i];
    const readout = document.getElementById('crosshairReadout');
    if (k) {
      const dt = new Date(k.t);
      const dstr = detailState.tf==='1D' ? dt.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'}) : dt.toLocaleDateString('th-TH',{day:'2-digit',month:'short',year:'2-digit'});
      readout.style.display = 'block';
      readout.innerHTML = `${dstr}<br>O ${k.o.toFixed(2)} H ${k.h.toFixed(2)}<br>L ${k.l.toFixed(2)} C ${k.c.toFixed(2)}<br>ราคา: $${yToPrice(y,detailState.view,h).toFixed(2)}`;
    }

    if (isPanning) {
      const w2 = plotWidth(rect);
      const dx = x - panStartX;
      const shift = -(dx / w2) * (panStartView.xMax - panStartView.xMin);
      let xMin = panStartView.xMin + shift, xMax = panStartView.xMax + shift;
      const span = xMax - xMin;
      if (xMin < 0) { xMin = 0; xMax = span; }
      if (xMax > detailState.candles.length-1) { xMax = detailState.candles.length-1; xMin = xMax-span; }
      detailState.view.xMin = xMin; detailState.view.xMax = xMax;
    }
    drawChart();
  };

  cv.onmouseup = () => { isPanning = false; };
  cv.onmouseleave = () => { isPanning = false; detailState.hoverIdx = -1; document.getElementById('crosshairReadout').style.display='none'; drawChart(); };

  cv.onwheel = (e) => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = plotWidth(rect);
    const candles = detailState.candles;
    if (!candles.length) return;
    const centerI = xToIdx(x, detailState.view, w);
    const zoom = e.deltaY > 0 ? 1.12 : 0.89;
    let { xMin, xMax } = detailState.view;
    let newMin = centerI - (centerI - xMin) * zoom;
    let newMax = centerI + (xMax - centerI) * zoom;
    // Minimum visible span scales with dataset size so zoom-out isn't clamped
    // to a tiny window on timeframes with few candles (e.g. 1D, 5Y monthly bars).
    const minSpan = Math.max(3, Math.min(8, candles.length - 1));
    if (newMax - newMin < minSpan) return;
    if (newMin < 0) newMin = 0;
    if (newMax > candles.length - 1) newMax = candles.length - 1;
    if (newMax - newMin < minSpan) return;
    detailState.view.xMin = newMin; detailState.view.xMax = newMax;
    drawChart();
  };
}
attachCanvasEvents();

// ---- Zoom Out ----
function zoomOutChart() {
  const c = detailState.candles;
  if (!c.length) return;
  const v = detailState.view;
  const span = v.xMax - v.xMin;
  const center = (v.xMin + v.xMax) / 2;
  let newSpan = span * 1.6;
  // allow zooming out to the FULL dataset regardless of timeframe
  const maxSpan = c.length - 1;
  if (newSpan > maxSpan) newSpan = maxSpan;
  let newMin = center - newSpan / 2;
  let newMax = center + newSpan / 2;
  if (newMin < 0) { newMax -= newMin; newMin = 0; }
  if (newMax > maxSpan) { newMin -= (newMax - maxSpan); newMax = maxSpan; }
  if (newMin < 0) newMin = 0;
  detailState.view.xMin = newMin;
  detailState.view.xMax = newMax;
  // re-fit Y range to whatever is now visible so candles aren't squashed
  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, Math.floor(newMin)); i <= Math.min(c.length-1, Math.ceil(newMax)); i++) {
    lo = Math.min(lo, c[i].l); hi = Math.max(hi, c[i].h);
  }
  const pad = (hi-lo)*0.08 || hi*0.02;
  detailState.view.yMin = lo - pad;
  detailState.view.yMax = hi + pad;
  drawChart();
}

// ---- Date Range ----
function applyDateRange() {
  const fromVal = document.getElementById('rangeFrom').value;
  const toVal   = document.getElementById('rangeTo').value;
  if (!fromVal && !toVal) return;
  const c = detailState.candles;
  if (!c.length) return;
  const fromTs = fromVal ? new Date(fromVal).getTime() : -Infinity;
  const toTs   = toVal   ? new Date(toVal + 'T23:59:59').getTime() : Infinity;
  let xMin = 0, xMax = c.length - 1;
  for (let i = 0; i < c.length; i++) {
    if (c[i].t >= fromTs) { xMin = i; break; }
  }
  for (let i = c.length - 1; i >= 0; i--) {
    if (c[i].t <= toTs) { xMax = i; break; }
  }
  if (xMax <= xMin) return;
  detailState.view.xMin = xMin;
  detailState.view.xMax = xMax;
  // re-fit Y to visible candles
  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, Math.floor(xMin)); i <= Math.min(c.length-1, Math.ceil(xMax)); i++) {
    lo = Math.min(lo, c[i].l); hi = Math.max(hi, c[i].h);
  }
  const pad = (hi-lo)*0.08 || hi*0.02;
  detailState.view.yMin = lo - pad;
  detailState.view.yMax = hi + pad;
  drawChart();
}

function resetDateRange() {
  document.getElementById('rangeFrom').value = '';
  document.getElementById('rangeTo').value   = '';
  fitView();
  drawChart();
}

// Populate date range defaults when opening detail
function initDateRangeUI() {
  const c = detailState.candles;
  if (!c.length) return;
  const fmt = ts => new Date(ts).toISOString().slice(0,10);
  document.getElementById('rangeFrom').value = fmt(c[0].t);
  document.getElementById('rangeTo').value   = fmt(c[c.length-1].t);
}

function quickAlertFromCrosshair() {
  if (detailState.hoverIdx < 0 || !dctx) {
    alert('เลื่อนเมาส์ไปบนกราฟที่ตำแหน่งราคาที่ต้องการก่อน แล้วกดปุ่มนี้');
    return;
  }
  const rect = dcanvas.getBoundingClientRect();
  const h = rect.height;
  const price = yToPrice(detailState._hoverY ?? h/2, detailState.view, h);
  const current = livePrices[detailState.ticker]?.price || price;
  document.getElementById('alertCond').value = price >= current ? 'above' : 'below';
  document.getElementById('alertPrice').value = price.toFixed(2);
  document.getElementById('alertPrice').focus();
}

// ---- Key stats panel ----
function renderKeyStats() {
  const candles = detailState.candles;
  if (!candles.length) return;
  const last = candles[candles.length-1];
  const stocks = getStocks();
  const s = stocks.find(x=>x.ticker===detailState.ticker);
  const lp = livePrices[detailState.ticker];
  const price = lp?.price || last.c;
  let hi=-Infinity, lo=Infinity, vol=0;
  candles.forEach(k=>{ hi=Math.max(hi,k.h); lo=Math.min(lo,k.l); vol+=k.v; });
  const stats = [
    { label:'เปิด (Open)', val: '$'+last.o.toFixed(2) },
    { label:'สูงสุด (High)', val: '$'+hi.toFixed(2) },
    { label:'ต่ำสุด (Low)', val: '$'+lo.toFixed(2) },
    { label:'ปริมาณ (Volume)', val: (vol/1e6).toFixed(2)+'M' },
    { label:'ราคาซื้อของคุณ', val: '$'+parseFloat(s?.cost||0).toFixed(2) },
    { label:'จำนวนหุ้น', val: fmt(s?.shares||0,3) },
    { label:'มูลค่ารวม', val: fmtCur(price*(s?.shares||0)) },
    { label:'กำไร/ขาดทุน %', val: (s?.cost ? (((price-s.cost)/s.cost)*100).toFixed(2) : '0.00')+'%' },
  ];
  document.getElementById('keyStats').innerHTML = stats.map(st=>`
    <div class="kstat"><div class="kstat-label">${st.label}</div><div class="kstat-val">${st.val}</div></div>
  `).join('');
}

function renderPositionBlock(idx) {
  const s = getStocks()[idx];
  if (!s) return;
  const lp = livePrices[s.ticker];
  const price = lp?.price || parseFloat(s.price);
  const val = price * parseFloat(s.shares);
  const cost = parseFloat(s.cost) * parseFloat(s.shares);
  const pl = val - cost;
  const pct = cost>0 ? (pl/cost)*100 : 0;
  document.getElementById('positionBlock').innerHTML = `
    <div class="position-row"><span class="lbl">จำนวนหุ้น</span><span class="val">${fmt(s.shares,3)}</span></div>
    <div class="position-row"><span class="lbl">ราคาต้นทุน</span><span class="val">$${fmt(s.cost)}</span></div>
    <div class="position-row"><span class="lbl">มูลค่าปัจจุบัน</span><span class="val">${fmtCur(val)}</span></div>
    <div class="position-row"><span class="lbl">กำไร/ขาดทุน</span><span class="val ${pl>=0?'green':'red'}">${pl>=0?'+':''}${fmtCur(pl)} (${pct>=0?'+':''}${pct.toFixed(2)}%)</span></div>
  `;
}

function updateDetailLivePrice() {
  if (!detailState.open) return;
  const lp = livePrices[detailState.ticker];
  const s = getStocks().find(x=>x.ticker===detailState.ticker);
  const price = lp?.price || parseFloat(s?.price||0);
  const base = parseFloat(s?.price||price);
  const chg = price - base, pct = base ? (chg/base*100) : 0;
  document.getElementById('d_price').textContent = fmtCur(price);
  const chgEl = document.getElementById('d_chg');
  chgEl.textContent = `${chg>=0?'+':''}${fmt(chg)} (${pct>=0?'+':''}${pct.toFixed(2)}%)`;
  chgEl.className = 'detail-chg ' + (chg>=0?'green':'red');
  renderKeyStats();
  if (detailState.idx >= 0) renderPositionBlock(detailState.idx);
  if (dctx) {
    // update last candle close live for a "live tail"
    const c = detailState.candles;
    if (c.length) {
      c[c.length-1].c = price;
      c[c.length-1].h = Math.max(c[c.length-1].h, price);
      c[c.length-1].l = Math.min(c[c.length-1].l, price);
    }
    drawChart();
  }
}

// ---- Drawn lines list UI ----
function renderDrawnListUI() {
  const list = detailState.drawings.filter(d=>d.ticker===detailState.ticker);
  const el = document.getElementById('drawnList');
  if (!list.length) { el.innerHTML = '<div class="drawn-empty">ยังไม่มีเส้นที่ตีไว้</div>'; return; }
  el.innerHTML = list.map(d => {
    const label = d.type==='hline' ? `เส้นแนวนอน $${d.p1.price.toFixed(2)}` : `เส้นเทรนด์ $${d.p1.price.toFixed(2)} → $${d.p2.price.toFixed(2)}`;
    return `<div class="drawn-item"><span><span class="swatch" style="background:${d.color}"></span>${label}</span><button class="alert-del" onclick="removeDrawing('${d.id}')">✕</button></div>`;
  }).join('');
}
function removeDrawing(id) {
  detailState.drawings = detailState.drawings.filter(d=>d.id!==id);
  saveDrawingsToSB();
  renderDrawnListUI();
  drawChart();
}

// ---- Persist drawings to Supabase (table: chart_drawings) ----
async function saveDrawingsToSB() {
  try {
    const rows = detailState.drawings.map(d => ({
      id: d.id, ticker: d.ticker, type: d.type, color: d.color,
      data: JSON.stringify({ p1: d.p1, p2: d.p2 || null })
    }));
    // Replace-all-for-ticker strategy: delete then insert (simplest correctness for small datasets)
    await sb.from('chart_drawings').delete().eq('ticker', detailState.ticker);
    if (rows.length) await sb.from('chart_drawings').insert(rows.filter(r=>r.ticker===detailState.ticker));
  } catch(e) {
    console.warn('chart_drawings table may not exist yet:', e.message);
  }
}
async function loadDrawingsFromSB() {
  try {
    const { data, error } = await sb.from('chart_drawings').select('*');
    if (error) throw error;
    detailState.drawings = (data||[]).map(r => {
      const parsed = JSON.parse(r.data);
      return { id:r.id, ticker:r.ticker, type:r.type, color:r.color, p1:parsed.p1, p2:parsed.p2 };
    });
  } catch(e) {
    console.warn('No chart_drawings table found (optional) — drawings will be session-only.', e.message);
  }
}

// ---- Price Alerts ----
function renderAlertsUI() {
  const list = detailState.alerts.filter(a=>a.ticker===detailState.ticker);
  document.getElementById('alertCount').textContent = list.length ? `(${list.length})` : '';
  const el = document.getElementById('alertList');
  if (!list.length) { el.innerHTML = '<div class="alert-empty">ยังไม่มีการตั้งเตือน</div>'; return; }
  el.innerHTML = list.map(a => `
    <div class="alert-item">
      <span class="alert-cond ${a.cond}">${a.cond==='above'?'≥':'≤'} $${fmt(a.price)}</span>
      <button class="alert-del" onclick="removeAlert('${a.id}')">✕</button>
    </div>
  `).join('');
}

async function addAlert() {
  const cond = document.getElementById('alertCond').value;
  const price = parseFloat(document.getElementById('alertPrice').value);
  if (isNaN(price) || price <= 0) { alert('กรุณากรอกราคาที่ถูกต้อง'); return; }
  const a = { id:'a'+Date.now(), ticker: detailState.ticker, cond, price, triggered:false };
  detailState.alerts.push(a);
  document.getElementById('alertPrice').value = '';
  renderAlertsUI();
  drawChart();
  try {
    await sb.from('price_alerts').insert({ id:a.id, ticker:a.ticker, cond:a.cond, price:a.price, triggered:false });
  } catch(e) { console.warn('price_alerts table may not exist yet:', e.message); }
  showToast('🔔 ตั้งเตือนแล้ว');
}
async function removeAlert(id) {
  detailState.alerts = detailState.alerts.filter(a=>a.id!==id);
  renderAlertsUI();
  drawChart();
  try { await sb.from('price_alerts').delete().eq('id', id); } catch(e) {}
}
async function loadAlertsFromSB() {
  try {
    const { data, error } = await sb.from('price_alerts').select('*').eq('triggered', false);
    if (error) throw error;
    detailState.alerts = (data||[]).map(r => ({ id:r.id, ticker:r.ticker, cond:r.cond, price:parseFloat(r.price), triggered:r.triggered }));
  } catch(e) {
    console.warn('No price_alerts table found (optional) — alerts will be session-only.', e.message);
  }
}

function checkPriceAlerts() {
  if (!detailState.alerts.length) return;
  detailState.alerts.forEach(a => {
    if (a.triggered) return;
    const price = livePrices[a.ticker]?.price;
    if (price == null) return;
    const hit = a.cond==='above' ? price >= a.price : price <= a.price;
    if (hit) {
      a.triggered = true;
      fireAlertToast(a, price);
      sendLineNotification(`🔔 ${a.ticker} ${a.cond==='above'?'ขึ้นถึง':'ลงถึง'} $${fmt(a.price)}\nราคาปัจจุบัน: $${fmt(price)}`);
      sb.from('price_alerts').update({ triggered: true }).eq('id', a.id).then(()=>{}).catch(()=>{});
      if (detailState.open && detailState.ticker===a.ticker) { renderAlertsUI(); drawChart(); }
    }
  });
  // prune triggered after firing once
  detailState.alerts = detailState.alerts.filter(a=>!a.triggered);
}

// ---- LINE notification ----
// NOTE: calling api.line.me directly from the browser puts your channel
// access token in plain view (page source / devtools network tab) for
// anyone who opens this page. Treat it as public if you deploy this file
// anywhere other than your own machine, and rotate it in the LINE
// Developers Console if that ever happens.
const LINE_CHANNEL_ACCESS_TOKEN = 'DfQJgR1RKumXshI6faWEKBHnZzYmfPMMuZJvU4dTA/9pUEkSWHTccrhppsqVZUhN4ZipaW1Z4JzLz1polGtoeuZm8PZ9J8RytYq+isrljujXih2mIAgRCnfO6fAomsyqQriCvRGnftGgjGjRR5LbTgdB04t89/1O/w1cDnyilFU=';
const LINE_USER_ID = 'Uc10f293775ce693cdd62833236082a18'; // the "Your user ID" value from Basic settings

const LINE_WORKER_URL = 'https://crimson-resonance-d086.joeitnac.workers.dev/';

async function sendLineNotification(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || LINE_CHANNEL_ACCESS_TOKEN.startsWith('PASTE_')) {
    console.warn('LINE notification skipped: token/user ID not set.');
    return;
  }
  try {
    const res = await fetch(LINE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: LINE_CHANNEL_ACCESS_TOKEN,
        to: LINE_USER_ID,
        messages: [{ type: 'text', text }]
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('LINE push failed:', res.status, err);
    } else {
      console.log('LINE notification sent!');
    }
  } catch (e) {
    console.error('LINE push error:', e);
  }
}

function fireAlertToast(a, price) {
  const t = document.createElement('div');
  t.className = 'toast-alert';
  t.innerHTML = `<div class="ta-title">🔔 ${a.ticker} ${a.cond==='above'?'ขึ้นถึง':'ลงถึง'} $${fmt(a.price)}</div>
                  <div class="ta-body">ราคาปัจจุบัน: $${fmt(price)}</div>`;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .4s'; setTimeout(()=>t.remove(),400); }, 6000);
}

function startAlertWatcher() {
  setInterval(checkPriceAlerts, 3000);
}

// ---- KEYBOARD: ESC closes detail view ----
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && detailState.open) closeDetail();
});

// ================================================================
// ==================== NEW FEATURES JS ==========================
// ================================================================

// ---- TAB SWITCH ----
function switchTab(name) {
  document.querySelectorAll('.tab-page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab_' + name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(el => {
    if (el.getAttribute('onclick') && el.getAttribute('onclick').includes("'" + name + "'")) el.classList.add('active');
  });
  if (name === 'summary') renderSummaryTab();
  if (name === 'wallet') renderWalletTab();
  if (name === 'assets') renderAssetsTab();
  if (name === 'import') renderImportHistory();
}

// ================================================================
// ==================== SUMMARY TAB ==============================
// ================================================================
let barPLChart = null, sectorChart = null;

function renderSummaryTab() {
  const stocks = getStocks();
  let totalValue = 0, totalCost = 0;
  stocks.forEach(s => {
    totalValue += parseFloat(s.price) * parseFloat(s.shares);
    totalCost += parseFloat(s.cost) * parseFloat(s.shares);
  });
  const totalPL = totalValue - totalCost;
  const totalPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  const totalValueTHB = totalValue * THB_RATE;
  const totalCostTHB = totalCost * THB_RATE;
  const totalPLTHB = totalValueTHB - totalCostTHB;

  // Summary cards
  document.getElementById('sumCards2').innerHTML = `
    <div class="card">
      <div class="card-label">มูลค่าพอร์ต (THB)</div>
      <div class="card-value">฿${fmt(totalValueTHB)}</div>
      <div class="card-sub">≈ $${fmt(totalValue)}</div>
    </div>
    <div class="card">
      <div class="card-label">ต้นทุนรวม (THB)</div>
      <div class="card-value">฿${fmt(totalCostTHB)}</div>
      <div class="card-sub">${stocks.length} หุ้น</div>
    </div>
    <div class="card">
      <div class="card-label">กำไร/ขาดทุน (THB)</div>
      <div class="card-value ${totalPL >= 0 ? 'green' : 'red'}">${totalPL >= 0 ? '+' : ''}฿${fmt(totalPLTHB)}</div>
      <div class="card-badge ${totalPL >= 0 ? 'badge-green' : 'badge-red'}">${totalPL >= 0 ? '↑' : '↓'} ${Math.abs(totalPct).toFixed(2)}%</div>
    </div>
    <div class="card">
      <div class="card-label">อัตราแลกเปลี่ยน</div>
      <div class="card-value" style="font-size:1rem">1 USD = ${THB_RATE.toFixed(2)} THB</div>
      <div class="card-sub">อัปเดตอัตโนมัติ</div>
    </div>
  `;

  // Bar PL Chart
  const labels = stocks.map(s => s.ticker);
  const plData = stocks.map(s => parseFloat(((parseFloat(s.price) - parseFloat(s.cost)) / parseFloat(s.cost) * 100).toFixed(2)));
  const colors = plData.map(v => v >= 0 ? 'rgba(0,229,160,0.7)' : 'rgba(255,77,106,0.7)');
  const ctx1 = document.getElementById('barPLChart').getContext('2d');
  if (barPLChart) barPLChart.destroy();
  barPLChart = new Chart(ctx1, {
    type: 'bar',
    data: { labels, datasets: [{ data: plData, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y.toFixed(2) + '%' } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 }, callback: v => v + '%' } }
      }
    }
  });

  // Sector Chart
  const sectorTotals = {};
  stocks.forEach(s => {
    const v = parseFloat(s.price) * parseFloat(s.shares);
    sectorTotals[s.sector] = (sectorTotals[s.sector] || 0) + v;
  });
  const secColors = { Tech: '#00e5a0', Health: '#0099ff', Energy: '#ff9f1c', Finance: '#f5c842', ETF: '#a082ff', Other: '#5a6478' };
  const ctx2 = document.getElementById('sectorChart').getContext('2d');
  if (sectorChart) sectorChart.destroy();
  sectorChart = new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: Object.keys(sectorTotals),
      datasets: [{ data: Object.values(sectorTotals), backgroundColor: Object.keys(sectorTotals).map(k => secColors[k] || '#888'), borderColor: '#111419', borderWidth: 2 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: '#e8edf5', font: { size: 10 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: c => { const total = c.dataset.data.reduce((a, b) => a + b, 0); return ` ${c.label}: ${((c.parsed / total) * 100).toFixed(1)}%`; } } }
      }
    }
  });

  // Summary table
  const tbody = document.getElementById('summaryTableBody');
  tbody.innerHTML = stocks.map(s => {
    const val = parseFloat(s.price) * parseFloat(s.shares);
    const cost = parseFloat(s.cost) * parseFloat(s.shares);
    const pl = val - cost;
    const pct = cost > 0 ? (pl / cost) * 100 : 0;
    return `<tr>
      <td>${tickerIconHTML(s.ticker, s.color)} <span style="margin-left:8px;font-weight:700">${s.ticker}</span></td>
      <td class="mono">${fmt(s.shares, 4)}</td>
      <td class="mono">$${fmt(s.cost)}</td>
      <td class="mono">$${fmt(s.price)}</td>
      <td class="mono">฿${fmt(val * THB_RATE)}</td>
      <td class="mono" style="color:var(--muted)">฿${fmt(cost * THB_RATE)}</td>
      <td class="mono ${pl >= 0 ? 'green' : 'red'}">${pl >= 0 ? '+' : ''}฿${fmt(pl * THB_RATE)}</td>
      <td>${pctBadge(pct)}</td>
    </tr>`;
  }).join('');
}

// ================================================================
// ==================== WALLET TAB ===============================
// ================================================================
let _walletTxs = [];
let walletChartInst = null;

async function loadWalletFromSB() {
  try {
    const { data, error } = await sb.from('wallet_transactions').select('*').order('date', { ascending: true });
    if (error) throw error;
    _walletTxs = (data || []).map(r => ({ ...r, amount: parseFloat(r.amount), rate: parseFloat(r.rate || 0), usd: parseFloat(r.usd || 0) }));
  } catch (e) {
    _walletTxs = JSON.parse(localStorage.getItem('wallet_txs') || '[]');
  }
}

async function addWalletTx() {
  const type = document.getElementById('txType').value;
  const amount = parseFloat(document.getElementById('txAmount').value);
  const rate = parseFloat(document.getElementById('txRate').value) || THB_RATE;
  const date = document.getElementById('txDate').value || new Date().toISOString().slice(0, 10);
  const note = document.getElementById('txNote').value.trim();
  if (isNaN(amount) || amount <= 0) { showToast('กรุณากรอกจำนวนเงิน', 'var(--red)'); return; }

  const usd = type === 'exchange' ? parseFloat((amount / rate).toFixed(4)) : 0;
  const tx = { id: 'w' + Date.now(), type, amount, rate, usd, date, note };
  _walletTxs.push(tx);

  try {
    await sb.from('wallet_transactions').insert({ ...tx });
  } catch (e) {
    localStorage.setItem('wallet_txs', JSON.stringify(_walletTxs));
  }

  ['txAmount', 'txRate', 'txNote'].forEach(id => document.getElementById(id).value = '');
  showToast('💰 บันทึกแล้ว');
  renderWalletTab();
}

async function deleteWalletTx(id) {
  _walletTxs = _walletTxs.filter(t => t.id !== id);
  try { await sb.from('wallet_transactions').delete().eq('id', id); } catch (e) {
    localStorage.setItem('wallet_txs', JSON.stringify(_walletTxs));
  }
  renderWalletTab();
}

function renderWalletTab() {
  const deposits = _walletTxs.filter(t => t.type === 'deposit').reduce((a, t) => a + t.amount, 0);
  const withdraws = _walletTxs.filter(t => t.type === 'withdraw').reduce((a, t) => a + t.amount, 0);
  const exchanges = _walletTxs.filter(t => t.type === 'exchange').reduce((a, t) => a + t.amount, 0);
  const totalUSD = _walletTxs.filter(t => t.type === 'exchange').reduce((a, t) => a + (t.usd || 0), 0);
  const balance = deposits - withdraws - exchanges;

  document.getElementById('walletCards').innerHTML = `
    <div class="card">
      <div class="card-label">ยอดเงิน THB คงเหลือ</div>
      <div class="card-value ${balance >= 0 ? 'green' : 'red'}">฿${fmt(balance)}</div>
      <div class="card-sub">ฝากสุทธิ ฿${fmt(deposits - withdraws)}</div>
    </div>
    <div class="card">
      <div class="card-label">เงินที่แลกซื้อหุ้น</div>
      <div class="card-value">฿${fmt(exchanges)}</div>
      <div class="card-sub">≈ $${fmt(totalUSD)} USD</div>
    </div>
    <div class="card">
      <div class="card-label">ฝากรวมทั้งหมด</div>
      <div class="card-value">฿${fmt(deposits)}</div>
      <div class="card-sub">${_walletTxs.filter(t => t.type === 'deposit').length} ครั้ง</div>
    </div>
    <div class="card">
      <div class="card-label">ค่าเฉลี่ยอัตราแลก</div>
      <div class="card-value" style="font-size:1rem">${_walletTxs.filter(t=>t.type==='exchange').length > 0 ? (exchanges / totalUSD).toFixed(4) : THB_RATE.toFixed(4)}</div>
      <div class="card-sub">THB/USD เฉลี่ยที่แลก</div>
    </div>
  `;

  // Wallet line chart
  const sorted = [..._walletTxs].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const chartLabels = [], chartVals = [];
  sorted.forEach(t => {
    if (t.type === 'deposit') running += t.amount;
    else if (t.type === 'withdraw') running -= t.amount;
    else if (t.type === 'exchange') running -= t.amount;
    chartLabels.push(t.date.slice(5));
    chartVals.push(parseFloat(running.toFixed(2)));
  });
  const ctx = document.getElementById('walletChart').getContext('2d');
  if (walletChartInst) walletChartInst.destroy();
  const grad = ctx.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, 'rgba(0,153,255,0.3)');
  grad.addColorStop(1, 'rgba(0,153,255,0)');
  walletChartInst = new Chart(ctx, {
    type: 'line',
    data: { labels: chartLabels, datasets: [{ data: chartVals, borderColor: '#0099ff', backgroundColor: grad, borderWidth: 2, tension: 0.4, fill: true, pointRadius: 3 }] },
    options: {
      responsive: true, plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 }, callback: v => '฿' + fmt(v, 0) } }
      }
    }
  });

  // Wallet table
  const tbody = document.getElementById('walletBody');
  const txSorted = [..._walletTxs].sort((a, b) => b.date.localeCompare(a.date));
  tbody.innerHTML = txSorted.length === 0 ? `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">ยังไม่มีรายการ</td></tr>` :
    txSorted.map(t => {
      const cls = t.type === 'deposit' ? 'tx-deposit' : t.type === 'withdraw' ? 'tx-withdraw' : 'tx-exchange';
      const label = t.type === 'deposit' ? '💚 ฝาก' : t.type === 'withdraw' ? '🔴 ถอน' : '🔄 แลก';
      const sign = t.type === 'deposit' ? '+' : '-';
      return `<tr>
        <td class="mono" style="color:var(--muted)">${t.date}</td>
        <td><span class="${cls}">${label}</span></td>
        <td class="mono ${cls}">${sign}฿${fmt(t.amount)}</td>
        <td class="mono" style="color:var(--muted)">${t.rate > 0 ? t.rate.toFixed(4) : '—'}</td>
        <td class="mono">${t.usd > 0 ? '$' + fmt(t.usd, 4) : '—'}</td>
        <td style="color:var(--muted);font-size:0.8rem">${t.note || ''}</td>
        <td><button class="btn-icon del" onclick="deleteWalletTx('${t.id}')">✕</button></td>
      </tr>`;
    }).join('');
}

// ================================================================
// ==================== OTHER ASSETS TAB =========================
// ================================================================
let _assets = [];
let networthChartInst = null;

async function loadAssetsFromSB() {
  try {
    const { data, error } = await sb.from('other_assets').select('*');
    if (error) throw error;
    _assets = (data || []).map(r => ({ ...r, value: parseFloat(r.value), cost: parseFloat(r.cost || 0) }));
  } catch (e) {
    _assets = JSON.parse(localStorage.getItem('other_assets') || '[]');
  }
}

async function addAsset() {
  const name = document.getElementById('a_name').value.trim();
  const type = document.getElementById('a_type').value;
  const value = parseFloat(document.getElementById('a_value').value);
  const cost = parseFloat(document.getElementById('a_cost').value) || 0;
  const note = document.getElementById('a_note').value.trim();
  if (!name || isNaN(value)) { showToast('กรุณากรอกข้อมูลให้ครบ', 'var(--red)'); return; }

  const asset = { id: 'ast' + Date.now(), name, type, value, cost, note };
  _assets.push(asset);
  try {
    await sb.from('other_assets').insert({ ...asset });
  } catch (e) {
    localStorage.setItem('other_assets', JSON.stringify(_assets));
  }
  ['a_name', 'a_value', 'a_cost', 'a_note'].forEach(id => document.getElementById(id).value = '');
  showToast('🏦 เพิ่มสินทรัพย์แล้ว');
  renderAssetsTab();
}

async function deleteAsset(id) {
  _assets = _assets.filter(a => a.id !== id);
  try { await sb.from('other_assets').delete().eq('id', id); } catch (e) {
    localStorage.setItem('other_assets', JSON.stringify(_assets));
  }
  renderAssetsTab();
}

function renderAssetsTab() {
  const totalAssets = _assets.reduce((a, x) => a + x.value, 0);
  const totalCostAssets = _assets.reduce((a, x) => a + (x.cost || 0), 0);
  const stocksValueTHB = getStocks().reduce((a, s) => a + parseFloat(s.price) * parseFloat(s.shares), 0) * THB_RATE;
  const netWorth = totalAssets + stocksValueTHB;

  const typeLabels = { crypto: 'Crypto', property: 'อสังหา', gold: 'ทอง', cash: 'เงินสด', fund: 'กองทุน', other: 'อื่น ๆ' };

  document.getElementById('assetCards').innerHTML = `
    <div class="card">
      <div class="card-label">Net Worth รวม (THB)</div>
      <div class="card-value" style="color:var(--gold)">฿${fmt(netWorth)}</div>
      <div class="card-sub">หุ้น + สินทรัพย์อื่น</div>
    </div>
    <div class="card">
      <div class="card-label">สินทรัพย์อื่น (THB)</div>
      <div class="card-value">฿${fmt(totalAssets)}</div>
      <div class="card-sub">${_assets.length} รายการ</div>
    </div>
    <div class="card">
      <div class="card-label">พอร์ตหุ้น (THB)</div>
      <div class="card-value">฿${fmt(stocksValueTHB)}</div>
      <div class="card-sub">${getStocks().length} ตัว</div>
    </div>
    <div class="card">
      <div class="card-label">กำไร/ขาดทุน (สินทรัพย์อื่น)</div>
      <div class="card-value ${totalAssets - totalCostAssets >= 0 ? 'green' : 'red'}">${totalAssets - totalCostAssets >= 0 ? '+' : ''}฿${fmt(totalAssets - totalCostAssets)}</div>
      <div class="card-sub">จากต้นทุน ฿${fmt(totalCostAssets)}</div>
    </div>
  `;

  const tbody = document.getElementById('assetsBody');
  tbody.innerHTML = _assets.length === 0 ? `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">ยังไม่มีสินทรัพย์</td></tr>` :
    _assets.map(a => {
      const pl = a.value - (a.cost || 0);
      const pct = a.cost > 0 ? (pl / a.cost) * 100 : 0;
      return `<tr>
        <td><span class="asset-type-badge type-${a.type}">${typeLabels[a.type] || a.type}</span></td>
        <td style="font-weight:700">${a.name}</td>
        <td class="mono">฿${fmt(a.value)}</td>
        <td class="mono" style="color:var(--muted)">฿${fmt(a.cost || 0)}</td>
        <td class="mono ${pl >= 0 ? 'green' : 'red'}">${pl >= 0 ? '+' : ''}฿${fmt(pl)}</td>
        <td>${pctBadge(pct)}</td>
        <td style="color:var(--muted);font-size:0.8rem">${a.note || ''}</td>
        <td><button class="btn-icon del" onclick="deleteAsset('${a.id}')">✕</button></td>
      </tr>`;
    }).join('');

  // Net Worth Chart
  const netData = [
    { label: 'พอร์ตหุ้น', val: stocksValueTHB, color: '#00e5a0' },
    ...Object.entries(
      _assets.reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + a.value; return acc; }, {})
    ).map(([type, val]) => ({ label: typeLabels[type] || type, val, color: { crypto: '#f5c842', property: '#0099ff', gold: '#ffd700', cash: '#00e5a0', fund: '#a082ff', other: '#5a6478' }[type] || '#888' }))
  ].filter(d => d.val > 0);

  const ctx = document.getElementById('networthChart').getContext('2d');
  if (networthChartInst) networthChartInst.destroy();
  networthChartInst = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: netData.map(d => d.label), datasets: [{ data: netData.map(d => d.val), backgroundColor: netData.map(d => d.color), borderColor: '#111419', borderWidth: 2 }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: '#e8edf5', font: { size: 11 }, boxWidth: 14, padding: 10 } },
        tooltip: { callbacks: { label: c => { const total = c.dataset.data.reduce((a, b) => a + b, 0); return ` ${c.label}: ฿${fmt(c.parsed)} (${((c.parsed / total) * 100).toFixed(1)}%)`; } } }
      }
    }
  });
}

// ================================================================
// ==================== IMPORT PDF TAB ===========================
// ================================================================
let _pendingImport = null;
let _importHistory = [];

async function loadImportHistoryFromSB() {
  try {
    const { data, error } = await sb.from('import_history').select('*').order('imported_at', { ascending: false });
    if (error) throw error;
    _importHistory = data || [];
  } catch (e) {
    _importHistory = JSON.parse(localStorage.getItem('import_history') || '[]');
  }
}

function importDragOver(e) {
  e.preventDefault();
  document.getElementById('importZone').classList.add('drag');
}
function importDrop(e) {
  e.preventDefault();
  document.getElementById('importZone').classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') importPDFFile(file);
  else showToast('กรุณาเลือกไฟล์ PDF เท่านั้น', 'var(--red)');
}

async function importPDFFile(file) {
  if (!file) return;
  const statusEl = document.getElementById('importStatus');
  statusEl.innerHTML = '<span class="import-progress">⏳ กำลังอ่าน PDF...</span>';
  document.getElementById('importPreview').style.display = 'none';

  try {
    // Load PDF.js from CDN (ใช้ legacy build ที่ไม่มี worker เพื่อหลีกเลี่ยง DataCloneError)
    if (!window.pdfjsLib) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      // ปิด worker เพื่อหลีกเลี่ยง DataCloneError กับ Headers object
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    }

    const arrayBuffer = await file.arrayBuffer();
    // ใช้ Uint8Array แทน ArrayBuffer โดยตรง และ disableWorker
    const typedArray = new Uint8Array(arrayBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: typedArray, disableWorker: true });
    const pdf = await loadingTask.promise;

    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(item => item.str).join(' ') + '\n';
    }

    statusEl.innerHTML = '<span class="import-progress">🔍 วิเคราะห์ข้อมูล...</span>';
    const parsed = parseDimePDF(fullText);

    if (!parsed) {
      statusEl.innerHTML = '<span style="color:var(--red)">❌ ไม่พบข้อมูลในรูปแบบที่รองรับ ตรวจสอบว่าเป็น PDF จาก KKP Dime</span>';
      return;
    }

    _pendingImport = parsed;
    statusEl.innerHTML = '<span style="color:var(--green)">✅ อ่านข้อมูลสำเร็จ กรุณาตรวจสอบด้านล่างก่อนนำเข้า</span>';

    document.getElementById('importExtracted').innerHTML = [
      ['เลขที่ใบกำกับภาษี', parsed.invoiceNo],
      ['ประเภทรายการ', parsed.txType === 'BUY' ? '🟢 ซื้อ (BUY)' : '🔴 ขาย (SELL)'],
      ['หุ้น / Ticker', `<strong style="color:var(--accent)">${parsed.ticker}</strong>`],
      ['จำนวนหุ้น', fmt(parsed.shares, 4) + ' หน่วย'],
      ['ราคาต่อหน่วย', '$' + fmt(parsed.unitPrice) + ' USD'],
      ['มูลค่ารวม (USD)', '$' + fmt(parsed.grossUSD)],
      ['อัตราแลก (BOT)', '1 USD = ' + parsed.fxRate + ' THB'],
      ['มูลค่ารวม (THB)', '฿' + fmt(parsed.grossTHB)],
      ['วันที่ทำรายการ', parsed.effectiveDate],
      ['Order ID', parsed.orderId],
    ].map(([label, val]) => `<div class="extracted-row"><span class="extracted-label">${label}</span><span class="extracted-val">${val}</span></div>`).join('');

    document.getElementById('importPreview').style.display = 'block';
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ เกิดข้อผิดพลาด: ${err.message}</span>`;
    console.error('PDF parse error:', err);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function parseDimePDF(text) {
  // ลบ whitespace ซ้ำและ normalize
  const t = text.replace(/\s+/g, ' ');

  // หา Invoice No
  const invoiceMatch = t.match(/DIMEOS\d+/);
  const invoiceNo = invoiceMatch ? invoiceMatch[0] : null;

  // หา Order ID
  const orderMatch = t.match(/(?:Order ID|เลขที่คำสั่ง)[^\d]*(\d{6,})/i) || t.match(/\b(\d{6})\b/);
  const orderId = orderMatch ? orderMatch[1] : null;

  // หา BUY/SELL type
  const txTypeMatch = t.match(/\b(BUY|SELL|SEL)\b/);
  const txType = txTypeMatch ? (txTypeMatch[1] === 'SEL' ? 'SELL' : txTypeMatch[1]) : null;

  // หา ticker - ค้นหาหลัง BUY/SELL
  const tickerMatch = t.match(/(?:BUY|SELL|SEL)\s+([A-Z]{1,5})\s+\[X/);
  const ticker = tickerMatch ? tickerMatch[1] : null;

  // หาจำนวนหุ้น - pattern: 2.0000000 หรือ N.XXXXXXX
  const sharesMatch = t.match(/(\d+\.\d{4,})\s+\d+\.\d{2}\s+USD/);
  const shares = sharesMatch ? parseFloat(sharesMatch[1]) : null;

  // หาราคาต่อหน่วย
  const unitPriceMatch = t.match(/\d+\.\d{4,}\s+(\d+\.\d{2})\s+USD/);
  const unitPrice = unitPriceMatch ? parseFloat(unitPriceMatch[1]) : null;

  // หามูลค่ารวม USD (Gross Amount)
  const grossMatch = t.match(/USD\s+([\d,]+\.\d{2})/);
  const grossUSD = grossMatch ? parseFloat(grossMatch[1].replace(',', '')) : (shares && unitPrice ? shares * unitPrice : null);

  // หาอัตราแลกเปลี่ยน THB/USD
  const fxMatch = t.match(/THB\/USD\s*=\s*([\d.]+)/i) || t.match(/(\d{2}\.\d{2,4})\s*(?:80000|บัญชี)/);
  const fxRate = fxMatch ? parseFloat(fxMatch[1]) : THB_RATE;

  // หามูลค่า THB
  const thbMatch = t.match(/([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(?:รวมมูลค่าซื้อ|Total Buy)/i);
  let grossTHB = thbMatch ? parseFloat(thbMatch[1].replace(',', '')) : null;
  if (!grossTHB && grossUSD && fxRate) grossTHB = parseFloat((grossUSD * fxRate).toFixed(2));

  // หาวันที่
  const dateMatch = t.match(/(\d{2}\/\d{2}\/\d{4})/);
  const effectiveDate = dateMatch ? dateMatch[1] : null;

  if (!ticker || !shares || !unitPrice) return null;

  return { invoiceNo, orderId, txType: txType || 'BUY', ticker, shares, unitPrice, grossUSD: grossUSD || shares * unitPrice, fxRate, grossTHB: grossTHB || (shares * unitPrice * fxRate), effectiveDate };
}

async function confirmImport() {
  if (!_pendingImport) return;
  const p = _pendingImport;
  const btn = document.getElementById('importConfirmBtn');
  btn.disabled = true;
  btn.textContent = '⏳ กำลังนำเข้า...';

  try {
    // ค้นหาว่ามีหุ้นนี้ในพอร์ตแล้วหรือไม่
    const existing = _stocks.findIndex(s => s.ticker === p.ticker);
    if (existing >= 0 && p.txType === 'BUY') {
      // Average down: คำนวณ cost เฉลี่ยใหม่
      const s = _stocks[existing];
      const oldCost = parseFloat(s.cost) * parseFloat(s.shares);
      const newCost = p.unitPrice * p.shares;
      const newShares = parseFloat(s.shares) + p.shares;
      const avgCost = (oldCost + newCost) / newShares;
      _stocks[existing].shares = newShares;
      _stocks[existing].cost = parseFloat(avgCost.toFixed(4));
      _stocks[existing].price = p.unitPrice;
      await saveStockToSB(_stocks[existing]);
    } else if (p.txType === 'BUY') {
      // เพิ่มหุ้นใหม่
      const newColor = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      const entry = { ticker: p.ticker, shares: p.shares, cost: p.unitPrice, price: p.unitPrice, sector: 'Other', color: newColor };
      _stocks.push(entry);
      await saveStockToSB(entry);
    }

    // บันทึก wallet transaction
    if (p.grossTHB > 0) {
      const tx = { id: 'w' + Date.now(), type: 'exchange', amount: p.grossTHB, rate: p.fxRate, usd: p.grossUSD, date: p.effectiveDate ? p.effectiveDate.split('/').reverse().join('-') : new Date().toISOString().slice(0, 10), note: `ซื้อ ${p.ticker} ${fmt(p.shares, 4)} หุ้น (PDF Import)` };
      _walletTxs.push(tx);
      try { await sb.from('wallet_transactions').insert({ ...tx }); } catch (e) { }
    }

    // บันทึก import history
    const hist = { id: 'ih' + Date.now(), invoice_no: p.invoiceNo, ticker: p.ticker, tx_type: p.txType, shares: p.shares, unit_price: p.unitPrice, gross_thb: p.grossTHB, fx_rate: p.fxRate, order_id: p.orderId, effective_date: p.effectiveDate, imported_at: new Date().toISOString() };
    _importHistory.unshift(hist);
    try { await sb.from('import_history').insert({ ...hist }); } catch (e) {
      localStorage.setItem('import_history', JSON.stringify(_importHistory));
    }

    showToast(`✅ นำเข้า ${p.ticker} สำเร็จ`);
    _pendingImport = null;
    document.getElementById('importPreview').style.display = 'none';
    document.getElementById('importStatus').innerHTML = '<span style="color:var(--green)">✅ นำเข้าข้อมูลเรียบร้อยแล้ว</span>';
    renderAll();
    renderImportHistory();
  } catch (err) {
    showToast('❌ นำเข้าไม่สำเร็จ: ' + err.message, 'var(--red)');
    console.error(err);
  }
  btn.disabled = false;
  btn.textContent = '✅ ยืนยันนำเข้าข้อมูล';
}

function cancelImport() {
  _pendingImport = null;
  document.getElementById('importPreview').style.display = 'none';
  document.getElementById('importStatus').innerHTML = '';
  document.getElementById('pdfInput').value = '';
}

function renderImportHistory() {
  const tbody = document.getElementById('importHistBody');
  tbody.innerHTML = _importHistory.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">ยังไม่มีประวัติการ Import</td></tr>`
    : _importHistory.map(h => `<tr>
        <td class="mono" style="color:var(--muted);font-size:0.78rem">${h.imported_at ? new Date(h.imported_at).toLocaleString('th-TH') : ''}</td>
        <td class="mono" style="font-size:0.75rem">${h.invoice_no || '—'}</td>
        <td style="font-weight:700;color:var(--accent)">${h.ticker}</td>
        <td class="mono">${fmt(h.shares, 4)}</td>
        <td class="mono">$${fmt(h.unit_price)}</td>
        <td class="mono">฿${fmt(h.gross_thb)}</td>
        <td class="mono" style="color:var(--muted)">${h.fx_rate}</td>
      </tr>`).join('');
}

// ---- LOGIN ----
const CORRECT_PIN = '8888';
let pinInput = '';

function pinPress(digit) {
  if (!digit || pinInput.length >= 4) return;
  pinInput += digit;
  updateDots();
  if (pinInput.length === 4) {
    setTimeout(checkPin, 120);
  }
}

function pinDel() {
  pinInput = pinInput.slice(0, -1);
  updateDots();
  document.getElementById('loginError').textContent = '';
}

function updateDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('dot' + i);
    dot.className = 'pin-dot' + (i < pinInput.length ? ' filled' : '');
  }
}

function checkPin() {
  if (pinInput === CORRECT_PIN) {
    document.getElementById('loginOverlay').classList.add('hidden');
    sessionStorage.setItem('portfolio_auth', '1');
    bootApp();
  } else {
    // Shake and reset
    const dots = document.getElementById('pinDots');
    for (let i = 0; i < 4; i++) document.getElementById('dot' + i).className = 'pin-dot error';
    dots.classList.add('shake');
    document.getElementById('loginError').textContent = 'รหัสไม่ถูกต้อง ลองอีกครั้ง';
    setTimeout(() => {
      dots.classList.remove('shake');
      pinInput = '';
      updateDots();
      document.getElementById('loginError').textContent = '';
    }, 800);
  }
}

async function bootApp() {
  await loadFromSupabase();
  await loadWalletFromSB();
  await loadAssetsFromSB();
  await loadImportHistoryFromSB();
}

// Keyboard support
document.addEventListener('keydown', e => {
  if (document.getElementById('loginOverlay').classList.contains('hidden')) return;
  if (e.key >= '0' && e.key <= '9') pinPress(e.key);
  if (e.key === 'Backspace') pinDel();
});

// Check if already authenticated this session
if (sessionStorage.getItem('portfolio_auth') === '1') {
  document.getElementById('loginOverlay').classList.add('hidden');
  bootApp();
}

