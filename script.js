// ---- SUPABASE SETUP ----
const SUPABASE_URL = 'https://edfahiauntmidsoviqft.supabase.co';
const SUPABASE_KEY = 'sb_publishable_u5JVuFHwvad2HSkef-ShZA_50gvcF3m';
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
    await loadDailyPctFromSB();

    _loaded = true;
    showToast('✅ โหลดข้อมูลสำเร็จ');
    renderAll();
    autoFetch();
    updateTodayPctRecord();
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
    await loadDailyPctFromSB();
    renderAll();
    autoFetch();
    updateTodayPctRecord();
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
  // ไม่สุ่มสร้างข้อมูลราคาย้อนหลังปลอมอีกต่อไป (เดิมใช้ Math.random ใส่ jitter)
  // ประวัติราคาจะมีเฉพาะรายการที่บันทึกจริงใน Supabase (ผ่าน "ประวัติราคา" ของแต่ละหุ้น) เท่านั้น
  _stocks.forEach(s => {
    if (!_history[s.ticker]) _history[s.ticker] = [];
  });
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
  const { error } = await sb.from('stocks').upsert(rows, { onConflict: 'ticker' });
  if (error) {
    console.error('[Prices] Supabase upsert error (real-time price refresh not saved):', error);
    showToast('⚠️ อัปเดตราคาไม่ถูกบันทึกลง Supabase: ' + (error.message || error.code), 'var(--red)');
  }
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

// ---- LINE CHART: % กำไร/ขาดทุนสะสมของพอร์ต (MAX เท่านั้น) ----
// เดิม: กราฟนี้เคยพล็อตเป็น "มูลค่า $" และอิงจาก "จุดจริง" แค่ 2 จุด (วันเริ่มลงทุน + วันนี้)
// เท่านั้น ทำให้เส้นเกือบตรงตลอดแล้วมากระตุกพรวดตอนท้าย และไม่ได้เก็บสะสมข้อมูลอะไรเพิ่มเลย
//
// แก้ไขใหม่:
// 1) แกน Y เปลี่ยนเป็น "% กำไร/ขาดทุนสะสมของพอร์ต" (เทียบกับต้นทุนรวม) แทนมูลค่าเป็นตัวเงิน
//    ตรงกับตัวเลข "กำไร/ขาดทุน" บนการ์ดสรุปด้านบนเป๊ะๆ ที่จุดสุดท้าย (วันนี้)
// 2) ใช้ตาราง daily_pct (Supabase) ที่ระบบบันทึก "% เปลี่ยนแปลงพอร์ตรายวัน" ไว้ทุกวันที่ตลาดปิด
//    (ผ่าน updateTodayPctRecord() + GitHub Action update-daily-pct.yml) เป็นข้อมูล "จุดจริง"
//    โดยไล่ compound ทีละวันจากจุดเริ่มลงทุน (ทุน 0%) มาเรื่อยๆ — ทุกวันที่ตลาดปิดและระบบบันทึกค่า
//    ใหม่ จุดจริงบนกราฟนี้จะเพิ่มขึ้นเองอัตโนมัติ (เก็บข้อมูลการเติบโตของพอร์ตไปเรื่อยๆ ตามที่ต้องการ)
// 3) ช่วงก่อนที่จะเริ่มเก็บ daily_pct (หรือวันที่ยังไม่มีข้อมูล) จะ "ประมาณการ" ด้วย compound growth
//    ระหว่าง 2 จุดจริงที่ใกล้ที่สุด (ไม่สุ่ม/ไม่ใช้ Math.random) เหมือนแนวทางเดิม
let lineChartInst = null;
let _lineChartTF = 'MAX'; // จำ timeframe ล่าสุดที่เลือก (คงไว้เวลากราฟ re-render จาก tick ราคา)
const PORTFOLIO_START = '2024-02-01'; // วันที่เริ่มลงทุนจริง (1 ก.พ. 67) — ใช้เป็นจุดเริ่มแกน x ของกราฟ = ทุน 0%

const THAI_MONTHS_ABBR = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function formatThaiDateShort(d) {
  const buddhistYear = (d.getFullYear() + 543) % 100;
  return `${d.getDate()} ${THAI_MONTHS_ABBR[d.getMonth()]} ${buddhistYear}`;
}

// คำนวณวันเริ่มต้นของแต่ละ timeframe (คลิปไม่ให้เกินวันที่เริ่มลงทุนจริง PORTFOLIO_START)
function tfStartDate(tf, today, portfolioStartDate) {
  const d = new Date(today);
  switch (tf) {
    case '1W': d.setDate(d.getDate() - 7); break;
    case '1M': d.setMonth(d.getMonth() - 1); break;
    case '3M': d.setMonth(d.getMonth() - 3); break;
    case '6M': d.setMonth(d.getMonth() - 6); break;
    case 'YTD': d.setMonth(0, 1); break;
    case '1Y': d.setFullYear(d.getFullYear() - 1); break;
    case 'MAX': default: return new Date(portfolioStartDate);
  }
  return d < portfolioStartDate ? new Date(portfolioStartDate) : d;
}

// ---- กราฟ: มูลค่าพอร์ตทั้งหมด (สะสมตั้งแต่วันเริ่มลงทุน) รองรับเลือกช่วงเวลา 1W/1M/3M/6M/YTD/1Y/MAX ----
function renderLineChart(tf) {
  if (tf) _lineChartTF = tf; else tf = _lineChartTF;

  // อัปเดตปุ่ม active
  document.querySelectorAll('#tfRow .tf-btn').forEach(b => {
    b.classList.toggle('tf-btn-active', b.dataset.tf === tf);
  });

  const stocks = getStocks();
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const portfolioStartDate = new Date(PORTFOLIO_START);
  const fromDate = tfStartDate(tf, today, portfolioStartDate);

  // เงินต้นจริง = ต้นทุนรวมของทุกหุ้นที่ถืออยู่ (shares × cost)
  const totalCostUSD = stocks.reduce((sum, s) => sum + parseFloat(s.cost) * parseFloat(s.shares), 0);
  // มูลค่าพอร์ตจริงวันนี้ (real): shares × ราคาปัจจุบันจริงของแต่ละหุ้น
  const realTodayUSD = stocks.reduce((sum, s) => sum + parseFloat(s.price) * parseFloat(s.shares), 0);
  // % กำไร/ขาดทุนรวมวันนี้ (ตัวเดียวกับที่การ์ดสรุปด้านบนแสดง) — ใช้โชว์บนหัวการ์ดเสมอ ไม่ว่าจะเลือกช่วงเวลาไหน
  const totalPctToday = totalCostUSD > 0 ? ((realTodayUSD - totalCostUSD) / totalCostUSD * 100) : 0;

  // ---- จุดจริงทั้งหมด: ไล่ compound จาก daily_pct (ใช้ interpolate เสมอ ไม่ขึ้นกับ timeframe ที่เลือกแสดง) ----
  // multiplier = มูลค่าพอร์ต ÷ ต้นทุนรวม ณ ขณะนั้น (1.00 = คืนทุนพอดี, 1.10 = กำไรสะสม 10%)
  const finalizedRecs = (_dailyPct || [])
    .filter(r => r.finalized && r.date >= PORTFOLIO_START && r.date <= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date));

  // จุดสุดท้าย (วันนี้) ใช้มูลค่าจริงตรงๆ เสมอ (แม่นยำ 100% ไม่ผ่านการ compound สะสมที่อาจคลาดเคลื่อนเล็กน้อย)
  const todayMultiplier = totalCostUSD > 0 ? (realTodayUSD / totalCostUSD) : 1;

  // ✦ FIX: ของเดิมไล่ compound "ไปข้างหน้า" โดยเริ่มนับ multiplier = 1.0 (เท่าทุนพอดี) ที่วันแรก
  // ที่มีข้อมูล daily_pct (ซึ่งเพิ่งเริ่มเก็บได้ไม่กี่สัปดาห์) ทั้งที่วันเริ่มลงทุนจริงคือ
  // PORTFOLIO_START (ก.พ. 67) — ทำให้ช่วงตั้งแต่ ก.พ. 67 ถึงก่อนวันที่เริ่มมี daily_pct ถูกมองว่า
  // "เท่าทุนตลอด" (เส้นแบน) แล้วต้องยัดการเติบโตทั้งหมดลงในช่วงไม่กี่สัปดาห์สุดท้าย → กราฟพุ่งตั้งฉาก
  //
  // แก้เป็นไล่ compound "ย้อนกลับ" จากมูลค่าจริงวันนี้ (ซึ่งรู้แน่นอน) ผ่าน % รายวันที่บันทึกไว้
  // ทำให้จุดจริงทุกจุดสอดคล้องกับมูลค่าวันนี้เป๊ะ ไม่มีจุด "รีเซ็ตเป็นเท่าทุน" ผิดที่ผิดทาง
  const realPoints = [{ t: portfolioStartDate.getTime(), m: 1 }]; // จุดเริ่มลงทุน = ทุน 100% (0% กำไร/ขาดทุน)
  let multiplier = todayMultiplier;
  for (let i = finalizedRecs.length - 1; i >= 0; i--) {
    const r = finalizedRecs[i];
    realPoints.push({ t: new Date(r.date).getTime(), m: multiplier });
    multiplier = multiplier / (1 + r.pct / 100); // ถอย 1 วันย้อนกลับ (ก่อนวันนี้จะเปลี่ยน pct%)
  }
  realPoints.push({ t: today.getTime(), m: todayMultiplier });
  realPoints.sort((a, b) => a.t - b.t);

  // เลขสุ่มแบบ deterministic (seed จาก string) — ใช้แทน Math.random เพื่อให้ค่าที่ "เมค" ขึ้นมา
  // คงที่เหมือนเดิมทุกครั้งที่ re-render กราฟ ไม่กระพริบเปลี่ยนไปมา
  function pseudoRandom(seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000; // 0..1
  }

  // ประมาณการเติบโตแบบ compound ระหว่างจุดจริง 2 จุดที่ใกล้ที่สุด
  // + เติมความเป็นธรรมชาติแบบกราฟหุ้นจริง (ขึ้นๆ ลงๆ เล็กน้อยรอบเส้นเทรนด์) ให้ช่วงที่ไม่มีข้อมูลจริงเก่าๆ
  //   ให้หน้าตาคล้ายตัวอย่างที่แนบมา — ค่าที่เมคนี้ deterministic ตาม seedKey (ไม่เปลี่ยนทุกครั้งที่โหลดใหม่)
  //   และจะเท่ากับ 0 ที่จุดจริงทั้งสองฝั่งเป๊ะๆ เสมอ (ไม่กระทบตัวเลขจริง)
  function estimateAt(ts, seedKey) {
    let lo = realPoints[0], hi = realPoints[realPoints.length - 1];
    for (let i = 0; i < realPoints.length - 1; i++) {
      if (ts >= realPoints[i].t && ts <= realPoints[i + 1].t) { lo = realPoints[i]; hi = realPoints[i + 1]; break; }
    }
    if (hi.t === lo.t) return lo.m;
    const frac = (ts - lo.t) / (hi.t - lo.t);
    let m;
    if (lo.m > 0 && hi.m > 0) m = lo.m * Math.pow(hi.m / lo.m, frac); // compound growth ระหว่าง 2 จุดจริง
    else m = lo.m + (hi.m - lo.m) * frac; // เผื่อกรณีค่าติดลบ/ศูนย์

    if (seedKey && frac > 0 && frac < 1) {
      const r1 = pseudoRandom(seedKey + '_a') - 0.5;
      const r2 = pseudoRandom(seedKey + '_b') - 0.5;
      const r3 = pseudoRandom(seedKey + '_c') - 0.5;
      const envelope = Math.sin(frac * Math.PI); // = 0 ที่ frac 0 และ 1 (จุดจริง) ไม่กระทบค่าจริงเลย
      const wave = Math.sin(frac * Math.PI * (3 + r1 * 3)) * 0.55
                 + Math.sin(frac * Math.PI * (8 + r2 * 5)) * 0.30
                 + Math.sin(frac * Math.PI * (15 + r3 * 6)) * 0.15;
      const noiseAmp = 0.025; // ความแรงของคลื่นเทียม ~2.5%
      m = m * (1 + envelope * wave * noiseAmp);
    }
    return m;
  }

  // สร้างวันเทรดทุกวัน จ-ศ ตั้งแต่จุดเริ่มของ timeframe ที่เลือก ถึงวันนี้ (ไว้ทำ label แกน x)
  const allDates = [];
  const cursor = new Date(fromDate);
  while (cursor <= today) {
    const dow = cursor.getDay();
    if (dow >= 1 && dow <= 5) allDates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  if (allDates.length === 0 || allDates[allDates.length - 1] !== todayKey) allDates.push(todayKey);

  // ลดจุดข้อมูลให้พอดีกราฟ (แสดงสูงสุดประมาณ 120 จุด) แต่ต้องเก็บวันแรกและวันนี้ไว้เสมอ
  let step = 1;
  if (allDates.length > 500) step = 5;
  else if (allDates.length > 250) step = 3;
  else if (allDates.length > 120) step = 2;
  const dates = allDates.filter((_, i) => i % step === 0 || i === allDates.length - 1);
  if (dates[0] !== allDates[0]) dates.unshift(allDates[0]);

  const realPointByDate = {};
  realPoints.forEach(p => { realPointByDate[new Date(p.t).toISOString().slice(0, 10)] = p.m; });

  // ---- เส้นเดียว: เริ่มต้นที่ $100 เป๊ะ แล้วไต่รูปทรงเดียวกับผลตอบแทน % จริงของพอร์ต
  // แต่ปรับสเกลให้จุดสุดท้าย (วันนี้) จบที่ "มูลค่าพอร์ตจริง" (realTodayUSD) พอดี ไม่ใช่แค่
  // ดัชนีเล็กๆ อีกต่อไป — คือ remap ช่วง multiplier [1 .. todayMultiplier] เป็นเส้นตรงไปยัง
  // ช่วงเงินจริง [100 .. realTodayUSD] รูปทรงกราฟ (ขึ้นๆ ลงๆ) เหมือนเดิมทุกจุด แค่สเกลปลายทาง
  // เปลี่ยนจากดัชนีเล็กๆ เป็นมูลค่าพอร์ตจริงวันนี้ ----
  const INDEX_BASE = 100; // เริ่มนับที่ $100 เสมอ
  const mRange = todayMultiplier - 1; // ช่วงของ multiplier จากจุดเริ่ม (1.0) ถึงวันนี้
  const shortRange = (tf === '1W' || tf === '1M');
  const labels = [], values = [], pointColors = [];
  dates.forEach((dateKey) => {
    const isRealPoint = Object.prototype.hasOwnProperty.call(realPointByDate, dateKey);
    const m = isRealPoint ? realPointByDate[dateKey] : estimateAt(new Date(dateKey).getTime(), dateKey);
    // frac = 0 ที่จุดเริ่ม (m=1), frac = 1 ที่วันนี้ (m=todayMultiplier) — remap เชิงเส้นไปเป็น
    // มูลค่าเงินจริงระหว่าง $100 ถึงมูลค่าพอร์ตจริงวันนี้ (realTodayUSD)
    const frac = mRange !== 0 ? (m - 1) / mRange : 0;
    const valUSD = INDEX_BASE + frac * (realTodayUSD - INDEX_BASE);
    const dispVal = currency === 'THB' ? valUSD * THB_RATE : valUSD;

    const d = new Date(dateKey);
    const lbl = shortRange ? `${d.getDate()}/${d.getMonth() + 1}` : `${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`;

    labels.push(lbl);
    values.push(parseFloat(dispVal.toFixed(2)));
    pointColors.push(isRealPoint ? '#8b5cf6' : 'rgba(90,100,120,0.5)');
  });

  // ---- อัปเดตส่วนหัว (hero): มูลค่ารวมวันนี้, THB equivalent, % กำไรสะสม, อัตราแลกเปลี่ยน ----
  const heroDateEl = document.getElementById('heroDateLabel');
  const heroValEl = document.getElementById('heroValueUSD');
  const heroThbEl = document.getElementById('heroValueTHB');
  const heroGainEl = document.getElementById('heroGainPct');
  const heroFxEl = document.getElementById('heroFxRate');
  if (heroDateEl) heroDateEl.textContent = formatThaiDateShort(today);
  if (heroValEl) heroValEl.innerHTML = `$${fmt(realTodayUSD)} <span class="hero-value-unit">USD</span>`;
  if (heroThbEl) heroThbEl.textContent = `≈ ${fmt(realTodayUSD * THB_RATE)} บาท`;
  if (heroGainEl) {
    const isPos = totalPctToday >= 0;
    heroGainEl.innerHTML = `กำไรของสินทรัพย์ที่ถืออยู่: <span class="${isPos ? 'green' : 'red'}">${isPos ? '↗' : '↘'} ${Math.abs(totalPctToday).toFixed(2)}%</span>`;
  }
  if (heroFxEl) heroFxEl.textContent = `อัตราแลกเปลี่ยน: 🇺🇸 1 USD = ${THB_RATE.toFixed(2)} บาท`;

  const infoEl = document.getElementById('lineChartInfo');
  if (infoEl) {
    const nRealPoints = realPoints.length;
    infoEl.innerHTML = `ช่วงเวลา: <b>${tf}</b>
      &nbsp;|&nbsp; ต้นทุนรวม ${fmtCur(totalCostUSD)}
      &nbsp;|&nbsp; มูลค่าจริงวันนี้ ${fmtCur(realTodayUSD)}
      &nbsp;|&nbsp; จุดข้อมูลจริง ${nRealPoints} จุด (จุดสีเทาคือข้อมูลเก่าที่ยังไม่มี % รายวันจริงบันทึกไว้ — ระบบเมคขึ้นให้ดูเป็นธรรมชาติ โดยยังยึดค่าที่จุดจริงทุกจุดเป๊ะๆ)
      &nbsp;|&nbsp; กราฟเริ่มที่ $100 แล้วไต่ตามผลตอบแทนจริงของพอร์ต จนจบที่มูลค่าพอร์ตจริงวันนี้`;
  }

  const ctx = document.getElementById('lineChart').getContext('2d');
  if (lineChartInst) lineChartInst.destroy();
  const grad = ctx.createLinearGradient(0, 0, 0, 140);
  grad.addColorStop(0, 'rgba(139,92,246,0.45)');
  grad.addColorStop(1, 'rgba(139,92,246,0.0)');

  lineChartInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'มูลค่าพอร์ต (เริ่มจาก $100)',
        data: values,
        borderColor: '#8b5cf6',
        backgroundColor: grad,
        borderWidth: 2,
        pointRadius: dates.length > 60 ? 0 : 2, // ซ่อนจุดถ้ามีข้อมูลเยอะ
        pointHoverRadius: 5,
        pointBackgroundColor: pointColors,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              return dates[idx] || items[0].label;
            },
            label: (item) => {
              const cur = currency === 'THB' ? '฿' : '$';
              return `${item.dataset.label}: ${cur}${fmt(item.parsed.y)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#5a6478', font: { size: 10 }, maxTicksLimit: 7 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#5a6478', font: { size: 10 },
            callback: v => (currency === 'THB' ? '฿' : '$') + fmt(v, 0)
          }
        }
      }
    }
  });
}



// ================================================================
// ==================== DAILY PORTFOLIO % CHANGE =================
// ================================================================
// แนวคิด: เก็บ "ตัวเลขเดียวต่อวัน" ที่บอกว่าพอร์ตเราขึ้น/ลงกี่ % ในวันนั้น
// (แบบเดียวกับที่โบรกเกอร์โชว์ "วันนี้ -1.35%") แทนที่จะคำนวณย้อนหลังจาก
// price_history ของแต่ละหุ้นแบบเดิม (ซึ่งพังง่ายเวลาข้อมูลบางตัวขาด/เพี้ยน)
//
// สูตรที่ใช้ (ใช้ได้กับทุกวัน ไปตลอด):
//   % เปลี่ยนแปลงพอร์ต = Σ(จำนวนหุ้น_i × Δราคา_i) / Σ(จำนวนหุ้น_i × ราคาปิดก่อนหน้า_i) × 100
//   โดย Δราคา_i = ราคาล่าสุด − ราคาปิดก่อนหน้า (ราคาปิดก่อนหน้าได้จาก Finnhub "pc" หรือ price_history)
// นี่คือค่าเฉลี่ยถ่วงน้ำหนักด้วยมูลค่าของ % การเปลี่ยนแปลงแต่ละตัว ตรงกับตัวเลข -1.35% ที่พอร์ตโชว์จริง
//
// กฎการบันทึก:
//   - ตลาดยังไม่เปิดวันนี้ (ก่อน 09:30 ET หรือเสาร์-อาทิตย์) -> บันทึก 0.00 ไปก่อน (ยังไม่ finalize)
//   - ตลาดเปิดอยู่ (09:30-16:00 ET จ-ศ) -> คำนวณสดจากราคาล่าสุด อัปเดตเรื่อยๆ (ยังไม่ finalize)
//   - ตลาดปิดแล้ววันนี้ (หลัง 16:00 ET) -> ล็อกค่าสุดท้ายของวันนั้นไว้ (finalize = true) ไม่บันทึกทับอีก
//   - ข้อมูลเก่าก่อนที่ฟีเจอร์นี้เริ่มใช้งาน -> ไม่มีให้ปล่อยว่าง (แสดง "–")

let _dailyPct = []; // [{ date:'YYYY-MM-DD', pct: number, finalized: bool }]
let _dayChangeData = {}; // { TICKER: { change, prevClose } } อัปเดตเฉพาะตอน fetchRealPrices() สำเร็จ (ไม่โดน cosmetic jitter ของ tickPrices ทับ)
let _weeklyOffset = 0; // 0 = สัปดาห์นี้, -1 = สัปดาห์ก่อน, ...

// วันหยุดตลาดหุ้นสหรัฐฯ (NYSE/Nasdaq) ปี 2026 -- ตลาดปิดทั้งวัน ไม่มีการเทรดเลย
const NYSE_HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);
function isNyseHoliday(dateKey) { return NYSE_HOLIDAYS_2026.has(dateKey); }

async function loadDailyPctFromSB() {
  try {
    const { data, error } = await sb.from('daily_pct').select('*').order('date', { ascending: true });
    if (error) throw error;
    _dailyPct = (data || []).map(r => ({ date: r.date, pct: parseFloat(r.pct), finalized: !!r.finalized }));
  } catch (e) {
    // ตาราง daily_pct อาจยังไม่ถูกสร้างใน Supabase -> ใช้ localStorage ไปก่อน (ดูวิธีสร้างตารางในคำอธิบายที่แนบมา)
    try { _dailyPct = JSON.parse(localStorage.getItem('daily_pct') || '[]'); } catch (e2) { _dailyPct = []; }
  }
}

function _saveDailyPctLocal() {
  try { localStorage.setItem('daily_pct', JSON.stringify(_dailyPct)); } catch (e) {}
}

async function upsertDailyPct(date, pct, finalized) {
  const idx = _dailyPct.findIndex(r => r.date === date);
  if (idx >= 0) _dailyPct[idx] = { date, pct, finalized };
  else _dailyPct.push({ date, pct, finalized });
  _saveDailyPctLocal();
  try {
    const { error } = await sb.from('daily_pct').upsert({ date, pct, finalized }, { onConflict: 'date' });
    if (error) throw error;
  } catch (e) {
    console.warn('[DailyPct] Supabase upsert ไม่สำเร็จ (เก็บไว้ในเครื่องแทน):', e.message || e);
  }
}

// เวลาปัจจุบันฝั่งตลาดนิวยอร์ก (ET) — ไม่ต้องพึ่ง library เพิ่ม ใช้ Intl ในตัวเบราว์เซอร์
function nyseNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour')), minute: parseInt(get('minute')),
    weekday: get('weekday')
  };
}

function nyseSessionStatus() {
  const n = nyseNow();
  const isHoliday = isNyseHoliday(n.dateKey);
  const isWeekday = !['Sat', 'Sun'].includes(n.weekday) && !isHoliday;
  const mins = n.hour * 60 + n.minute;
  const openMins = 9 * 60 + 30, closeMins = 16 * 60;
  return {
    dateKey: n.dateKey,
    isWeekday,
    isHoliday,
    isOpen: isWeekday && mins >= openMins && mins < closeMins,
    hasClosedToday: isWeekday && mins >= closeMins,
    beforeOpenToday: !isWeekday || mins < openMins
  };
}

// % เปลี่ยนแปลงพอร์ตวันนี้ (ถ่วงน้ำหนักด้วยมูลค่า) จากราคาล่าสุด vs ราคาปิดก่อนหน้า
// แหล่งข้อมูล: หลัก = Finnhub (แม่นสุด, สดตามตลาดเปิด) / สำรอง = price_history (ราคาปิดที่บันทึกไว้จาก GitHub Action รายวัน)
function computePortfolioDayChangePct() {
  const stocks = getStocks();
  const h = getHistory();
  const todayKey = nyseSessionStatus().dateKey;
  let num = 0, den = 0, coveredValue = 0, totalValue = 0;

  stocks.forEach(s => {
    const shares = parseFloat(s.shares) || 0;
    if (shares <= 0) return;
    const price = parseFloat(s.price);
    if (!(price > 0)) return;
    totalValue += shares * price;

    let prevClose = null;
    const dc = _dayChangeData[s.ticker];
    if (dc && dc.prevClose > 0) {
      prevClose = dc.prevClose;
    } else {
      const arr = (h[s.ticker] || []).filter(x => x.date < todayKey).sort((a, b) => a.date.localeCompare(b.date));
      if (arr.length) prevClose = arr[arr.length - 1].price;
    }
    if (!(prevClose > 0)) return;

    // ✦ SAFETY NET: ถ้าหุ้นตัวไหนเดี่ยวๆ ขยับเกิน ±50% ใน 1 วัน แปลว่าราคา prevClose
    // (มักมาจาก price_history ที่ข้อมูลพัง/ราคาหลุด) น่าจะผิดปกติ — ตัดตัวนั้นทิ้งจากสูตร
    // แทนที่จะปล่อยให้ตัวเลขเพี้ยนตัวเดียวลากทั้งพอร์ตให้ผิดไปด้วย (ต้นตอของบั๊ก -15.96% ก่อนหน้านี้)
    const tickerPct = (price - prevClose) / prevClose * 100;
    if (Math.abs(tickerPct) > 50) return;

    num += shares * (price - prevClose);
    den += shares * prevClose;
    coveredValue += shares * price;
  });

  if (den <= 0 || totalValue <= 0) return null;
  // ต้องมีข้อมูลราคาปิดก่อนหน้าครอบคลุมพอร์ตอย่างน้อย 60% ของมูลค่า ไม่งั้นตัวเลขจะไม่น่าเชื่อถือ
  if (coveredValue / totalValue < 0.6) return null;

  const result = (num / den) * 100;
  // ✦ SAFETY NET: พอร์ตกระจายหุ้นหลายตัว ปกติไม่ควรขยับเกิน ±20%/วัน ถ้าเกิน แปลว่าข้อมูลน่าจะ
  // ปนเปื้อนอยู่ดี (แม้ผ่านตัวกรองรายตัวมาแล้ว) -> ไม่บันทึกไว้ก่อน รอรอบถัดไปที่ข้อมูลสะอาดกว่า
  if (Math.abs(result) > 20) return null;
  return result;
}

// เรียกทุกครั้งหลัง fetchRealPrices() (และตอนโหลดแอปครั้งแรก) เพื่ออัปเดต/ล็อกค่าของ "วันนี้"
async function updateTodayPctRecord() {
  const sess = nyseSessionStatus();
  const todayKey = sess.dateKey;
  if (sess.isHoliday) { renderWeeklyChange(); return; } // วันหยุดตลาด -- ไม่คำนวณ ไม่บันทึกอะไรเลย
  const existing = _dailyPct.find(r => r.date === todayKey);
  if (existing?.finalized) return; // ล็อกไปแล้ว ไม่บันทึกทับ

  if (sess.beforeOpenToday) {
    // ตลาดยังไม่เปิด (หรือวันหยุดสุดสัปดาห์) -> เป็น 0.00 ไปก่อน
    if (!existing || existing.pct !== 0 || existing.finalized) await upsertDailyPct(todayKey, 0, false);
    renderWeeklyChange();
    return;
  }

  const livePct = computePortfolioDayChangePct();
  if (livePct === null) return; // ยังไม่มีข้อมูลราคาพอ รอรอบถัดไป
  await upsertDailyPct(todayKey, parseFloat(livePct.toFixed(2)), sess.hasClosedToday);
  renderWeeklyChange();
}

function weeklyChangeNav(delta, reset) {
  _weeklyOffset = reset ? 0 : (_weeklyOffset + delta);
  if (_weeklyOffset > 0) _weeklyOffset = 0; // ห้ามดูล่วงหน้าเกินสัปดาห์นี้
  renderWeeklyChange();
}

// แปลง Date -> 'YYYY-MM-DD' ตามเวลา "ท้องถิ่นของเบราว์เซอร์" (ห้ามใช้ toISOString ตรงนี้ เพราะ
// toISOString แปลงเป็น UTC ก่อน สำหรับคนไทย (UTC+7) เที่ยงคืนท้องถิ่นจะกลายเป็นบ่าย/เย็นของ "เมื่อวาน"
// ใน UTC ทำให้วันที่เพี้ยนถอยหลังไป 1 วันทั้งตาราง)
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- WEEKLY PORTFOLIO % CHANGE TABLE — แสดงทีละ 1 สัปดาห์ (จ-ศ) พร้อมปุ่มย้อนหลัง/ถัดไป ----
function renderWeeklyChange() {
  const DOW_TH = ['', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.'];
  const head = document.getElementById('weeklyChangeHead');
  const tbody = document.getElementById('weeklyChangeBody');
  const rangeLabel = document.getElementById('weeklyRangeLabel');
  if (!head || !tbody) return;

  // หาวันจันทร์ของ "สัปดาห์นี้" (ถ้าวันนี้เป็น เสาร์/อาทิตย์ ให้ใช้จันทร์ของสัปดาห์ที่ผ่านมา)
  const today = new Date();
  const todayDow = today.getDay(); // 0=อา 1=จ ... 6=ส
  const diffToMonday = todayDow === 0 ? -6 : (1 - todayDow);
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() + diffToMonday);
  thisMonday.setHours(0, 0, 0, 0);

  // ขยับตาม offset (หน่วย: สัปดาห์)
  const monday = new Date(thisMonday);
  monday.setDate(thisMonday.getDate() + _weeklyOffset * 7);

  const weekDates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    weekDates.push(localDateKey(d));
  }

  // header: วันในสัปดาห์ (ไม่ต้องมีคอลัมน์ "สัปดาห์" แบบเดิมแล้ว เพราะโชว์แค่สัปดาห์เดียว)
  head.innerHTML = DOW_TH.slice(1).map(d => `<th>${d}</th>`).join('') +
    `<th class="wc-total-head">รวม/สัปดาห์</th>`;

  // label ช่วงวันที่ เช่น "30/6 - 4/7"
  if (rangeLabel) {
    const [, fm, fd] = weekDates[0].split('-').map(Number);
    const [, lm, ld] = weekDates[4].split('-').map(Number);
    rangeLabel.innerHTML = `${fd}/${fm} - ${ld}/${lm}` + (_weeklyOffset === 0 ? '<span class="wc-this-week-tag">สัปดาห์นี้</span>' : '');
  }

  const cells = weekDates.map(dateKey => {
    const isFuture = dateKey > nyseSessionStatus().dateKey;
    const [, mm, dd] = dateKey.split('-').map(Number);
    const dateLabel = `<div class="wc-day-date">${dd}/${mm}</div>`;

    if (isFuture) return `<td class="wc-day-cell wc-future"><div class="wc-day-value flat">–</div>${dateLabel}</td>`;

    const rec = _dailyPct.find(r => r.date === dateKey);
    if (!rec) {
      // แยกให้ชัดว่า "ไม่มีข้อมูล" เพราะวันหยุดตลาด (ไม่มีการเทรดจริง ๆ) กับ "ไม่มีข้อมูล" เพราะ
      // ระบบยังบันทึกไม่ทัน/พัง — ทั้งสองแบบไม่นับใน % รวมของสัปดาห์เหมือนกัน แต่ label ต่างกันเพื่อไม่ให้สับสน
      if (isNyseHoliday(dateKey)) {
        return `<td class="wc-day-cell wc-empty wc-holiday" title="ตลาดหุ้นสหรัฐฯ ปิดทำการวันนี้ (วันหยุด) — ไม่มีการเทรด จึงไม่นับ % วันนี้"><div class="wc-day-value flat">ปิด</div>${dateLabel}</td>`;
      }
      return `<td class="wc-day-cell wc-empty" title="ยังไม่มีข้อมูล % ของวันนี้"><div class="wc-day-value flat">–</div>${dateLabel}</td>`;
    }

    const pct = rec.pct;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const sign = pct > 0 ? '+' : '';
    const title = rec.finalized ? '' : ' title="ค่าระหว่างวัน ยังไม่ปิดตลาด"';
    const pending = rec.finalized ? '' : '<span class="wc-pending-dot">⏳</span>';
    return `<td class="wc-day-cell"${title}><div class="wc-day-value ${cls}">${sign}${pct.toFixed(2)}%${pending}</div>${dateLabel}</td>`;
  });

  // % รวมทั้งสัปดาห์ = compound ของวันที่มีข้อมูลจริงในสัปดาห์นั้น
  const weekRecs = weekDates.map(dk => _dailyPct.find(r => r.date === dk)).filter(Boolean);
  let weekTotal = `<td class="wc-total-cell"><div class="wc-day-value flat">–</div><div class="wc-total-label">ไม่มีข้อมูล</div></td>`;
  if (weekRecs.length) {
    const compound = weekRecs.reduce((acc, r) => acc * (1 + r.pct / 100), 1);
    const weekPct = (compound - 1) * 100;
    const anyPending = weekRecs.some(r => !r.finalized);
    const cls = weekPct > 0 ? 'up' : weekPct < 0 ? 'down' : 'flat';
    const sign = weekPct > 0 ? '+' : '';
    const pending = anyPending ? '<span class="wc-pending-dot">⏳</span>' : '';
    weekTotal = `<td class="wc-total-cell"><div class="wc-day-value ${cls}">${sign}${weekPct.toFixed(2)}%${pending}</div><div class="wc-total-label">${weekRecs.length}/5 วัน</div></td>`;
  }

  tbody.innerHTML = `<tr>
    ${cells.join('')}
    ${weekTotal}
  </tr>`;
}


let pieChartInst = null;
function renderPieChart() {
  const stocks = getStocks();
  const labels = stocks.map(s => s.ticker);
  const values = stocks.map(s => parseFloat(s.price) * parseFloat(s.shares));
  const colors = stocks.map(s => s.color || '#888');
  const total = values.reduce((a, b) => a + b, 0);
  const ctx = document.getElementById('pieChart').getContext('2d');
  if (pieChartInst) pieChartInst.destroy();

  // Plugin ที่วาด label ชื่อหุ้นซ้อนในวงตรงๆ (เฉพาะ slice ที่ใหญ่พอ)
  const innerLabelPlugin = {
    id: 'innerLabel',
    afterDatasetsDraw(chart) {
      const { ctx: c, data } = chart;
      const ds = chart.getDatasetMeta(0);
      const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
      ds.data.forEach((arc, i) => {
        const pct = (data.datasets[0].data[i] / total) * 100;
        if (pct < 4) return; // slice เล็กเกินไป ไม่ใส่ label (กันซ้อนทับ)
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const r = (arc.innerRadius + arc.outerRadius) / 2;
        const x = arc.x + Math.cos(angle) * r;
        const y = arc.y + Math.sin(angle) * r;
        const fontSize = pct > 8 ? 11 : 9;
        c.save();
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = '#fff';
        c.font = `bold ${fontSize}px Inter, sans-serif`;
        c.shadowColor = 'rgba(0,0,0,0.7)';
        c.shadowBlur = 3;
        c.fillText(data.labels[i], x, y);
        c.restore();
      });
    }
  };

  pieChartInst = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#111419', borderWidth: 2 }] },
    plugins: [innerLabelPlugin],
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#e8edf5', font: { size: 10 }, boxWidth: 12, padding: 8 }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              const amt = ctx.parsed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return ` ${ctx.label}:  $${amt}  (${pct}%)`;
            }
          },
          bodyFont: { size: 13 },
          padding: 10,
        }
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

// ---- TWELVE DATA (แหล่งกราฟย้อนหลังหลัก — official API, มี CORS รองรับตรง ไม่ต้องพึ่ง proxy) ----
// สมัครฟรีได้ที่ https://twelvedata.com/pricing แล้วเอา API key มาใส่ตรงนี้
const TWELVE_DATA_KEY = '9197b19f8cf6436abf0769f025a61ffe';
let twelveDataKeyOk = null; // null = unknown/untested, true = working, false = confirmed invalid/quota หมด

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
    updateTodayPctRecord(); // ยังอัปเดตสถานะ "ก่อนเปิดตลาด = 0.00" ได้แม้ Finnhub ใช้ไม่ได้ (ใช้ price_history สำรอง)
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
      // เก็บ Δราคา/ราคาปิดก่อนหน้าแยกไว้ต่างหาก (tickPrices ทับ livePrices.change ทุกวินาที เลยใช้ตัวนี้แทนสำหรับคำนวณ % รายวันของพอร์ต)
      _dayChangeData[s.ticker] = { change: r.change, prevClose: r.price - r.change };
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
    updateTape();
    // ✦ FIX: ไม่ re-render การ์ดสรุป/hero/กราฟทุกครั้งที่ดึงราคาจริงใหม่ (ทุก 5 นาที) แล้ว —
    // ผู้ใช้อยากให้ "มูลค่าสินทรัพย์ทั้งหมด" นิ่ง ไม่ขยับระหว่างวัน จะขยับก็ต่อเมื่อจบวัน/รีเฟรชหน้าใหม่
    // เท่านั้น (ราคาจริงยังถูกบันทึกลง s.price/DB ตามปกติ แค่ไม่เอามาอัปเดตหน้าจอทันที)
    checkPriceAlerts();
  } else {
    lbl.textContent = 'LIVE (sim)';
  }

  updateTodayPctRecord();

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
    // ✦ FIX: ไม่ re-render มูลค่ารวม/hero/กราฟตามรอบนี้แล้ว (ให้นิ่งจนกว่าจะจบวัน/รีเฟรชหน้าใหม่)
    // อัตราแลกเปลี่ยนใหม่จะมีผลตอนคำนวณรอบถัดไปที่ผู้ใช้รีเฟรชหน้าเองแทน
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
  // ✦ FIX: มูลค่าสินทรัพย์ทั้งหมด (การ์ดสรุปด้านบน + hero) ไม่ควรขยับทุกวินาทีตาม tick
  // จำลองราคาแบบนี้ — ผู้ใช้ต้องการให้ตัวเลขนิ่ง แล้วค่อยขยับจริงตอนจบวัน (ปิดตลาด/อัปเดตราคาจริง)
  // เท่านั้น ตัดการเรียก updateLiveSummary() และการแปะทับจุดสุดท้ายของกราฟเส้นออกจาก tick นี้
  // (เดิมเป็นสาเหตุที่ตัวเลข/กราฟกระตุกแม้ราคาจริงไม่ได้เปลี่ยน) ตารางหุ้นรายตัวยังไหวเป็น
  // cosmetic effect ได้ตามปกติ (updateLiveTable ด้านบน) แต่ยอดรวมจะนิ่งจนกว่าจะมีราคาจริงใหม่
  // เข้ามาจาก fetchRealPrices()/updateTodayPctRecord() ตอนจบวัน
  updateTape();
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
  renderWeeklyChange();
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

function renderWatchlistSide() {
  const el = document.getElementById('watchlistSide');
  if (!el) return;
  const stocks = getStocks();
  const searchEl = document.getElementById('watchlistSearch');
  const q = (searchEl ? searchEl.value : '').trim().toUpperCase();

  const rows = stocks
    .map((s, i) => ({ s, i })) // keep original index for openDetail()
    .filter(({ s }) => !q || s.ticker.toUpperCase().includes(q));

  if (!rows.length) {
    el.innerHTML = `<div style="padding:16px 6px;color:var(--muted);font-size:0.78rem;text-align:center">ไม่พบหุ้นที่ค้นหา</div>`;
    return;
  }

  el.innerHTML = rows.map(({ s, i }) => {
    const lp = livePrices[s.ticker];
    const price = lp ? lp.price : parseFloat(s.price);
    const pct = lp ? lp.pct : 0;
    const isActive = i === detailState.idx;
    const chgColor = pct >= 0 ? 'var(--green, #2ecc71)' : 'var(--red)';
    return `
      <div onclick="openDetail(${i})" class="watchlist-row${isActive ? ' active' : ''}">
        <span class="mono" style="font-weight:700;font-size:0.78rem">${s.ticker}</span>
        <span class="mono" style="font-size:0.72rem">$${fmt(price)}</span>
        <span class="mono" style="font-size:0.68rem;color:${chgColor}">${pct >= 0 ? '+' : ''}${fmt(pct,2)}%</span>
      </div>`;
  }).join('');
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
  renderWatchlistSide();
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

// ---- Real historical candles from Twelve Data (official API, ไม่ต้องพึ่ง CORS proxy) ----
function tfToTwelveData(tf) {
  return {
    '1D': { interval: '15min', outputsize: 32  },
    '1M': { interval: '1day',  outputsize: 30  },
    '3M': { interval: '1day',  outputsize: 90  },
    '6M': { interval: '1day',  outputsize: 180 },
    '1Y': { interval: '1week', outputsize: 52  },
    '5Y': { interval: '1month',outputsize: 60  },
  }[tf] || { interval: '1day', outputsize: 30 };
}

async function fetchTwelveDataCandles(ticker, tf) {
  if (!TWELVE_DATA_KEY || TWELVE_DATA_KEY.includes('ใส่_API_KEY')) {
    throw new Error('TWELVE_DATA_NO_KEY'); // ยังไม่ได้ตั้งค่า key — ข้ามไปแหล่งถัดไปเงียบๆ
  }
  if (twelveDataKeyOk === false) throw new Error('TWELVE_DATA_AUTH_FAILED');
  const { interval, outputsize } = tfToTwelveData(tf);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_DATA_KEY}`;
  const res = await fetchWithTimeout(url, 8000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.status === 'error' || !Array.isArray(data.values) || !data.values.length) {
    // code 401/403 = key ผิด, 429 = เกินโควต้าฟรี (800 req/วัน)
    if (data.code === 401 || data.code === 403) twelveDataKeyOk = false;
    throw new Error(data.message || 'No data from Twelve Data');
  }
  twelveDataKeyOk = true;
  // Twelve Data ส่งข้อมูลใหม่สุดมาก่อน (descending) — ต้อง reverse ให้เรียงเก่า→ใหม่
  const candles = data.values.slice().reverse().map(v => ({
    t: new Date(v.datetime.length > 10 ? v.datetime : v.datetime + 'T00:00:00').getTime(),
    o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close),
    v: v.volume ? parseInt(v.volume) : 0
  })).filter(c => !isNaN(c.o) && !isNaN(c.h) && !isNaN(c.l) && !isNaN(c.c));
  if (!candles.length) throw new Error('Empty candles from Twelve Data');
  return candles;
}

// ---- Real historical candles from Yahoo Finance (no key needed, ใช้ CORS proxy เดียวกับ VIX/ราคาทอง) ----
// ใช้เป็นแหล่งสำรองเมื่อ Finnhub ใช้ไม่ได้ (free tier ของ Finnhub มักบล็อก /stock/candle)
function tfToYahoo(tf) {
  return {
    '1D': { range: '1d',  interval: '5m'  },
    '1M': { range: '1mo', interval: '1d'  },
    '3M': { range: '3mo', interval: '1d'  },
    '6M': { range: '6mo', interval: '1d'  },
    '1Y': { range: '1y',  interval: '1wk' },
    '5Y': { range: '5y',  interval: '1mo' },
  }[tf] || { range: '1mo', interval: '1d' };
}

async function fetchYahooCandles(ticker, tf) {
  const { range, interval } = tfToYahoo(tf);
  const YAHOO_URL = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const attempts = [
    { url: YAHOO_URL, label: 'Yahoo Finance' },
    { url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(YAHOO_URL), label: 'Yahoo Finance (ผ่าน CORS proxy)' },
    { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(YAHOO_URL), label: 'Yahoo Finance (ผ่าน CORS proxy สำรอง)' },
  ];
  let lastErr = new Error('Yahoo fetch failed');
  for (const a of attempts) {
    try {
      const r = await fetchWithTimeout(a.url, 8000);
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result || !result.timestamp || !result.timestamp.length) { lastErr = new Error('No data'); continue; }
      const ts = result.timestamp;
      const q = result.indicators?.quote?.[0] || {};
      const candles = ts.map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] || 0
      })).filter(c => c.o != null && c.h != null && c.l != null && c.c != null);
      if (!candles.length) { lastErr = new Error('Empty candles'); continue; }
      return candles;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
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

  // เรียงลำดับแหล่งข้อมูลจากน่าเชื่อถือสุด -> สำรอง -> จำลอง (สุดท้ายจริงๆ)
  const sources = [
    { fn: fetchTwelveDataCandles, label: 'Twelve Data' },
    { fn: fetchYahooCandles,      label: 'Yahoo Finance' },
    { fn: fetchFinnhubCandles,    label: 'Finnhub' },
  ];

  let done = false;
  for (const src of sources) {
    try {
      const real = await src.fn(ticker, tf);
      if (real.length) {
        // keep last candle's close in sync with current live price for a smooth "live tail"
        real[real.length - 1].c = base;
        real[real.length - 1].h = Math.max(real[real.length - 1].h, base);
        real[real.length - 1].l = Math.min(real[real.length - 1].l, base);
      }
      detailState.candles = real;
      detailState.dataSource = 'real';
      setChartDataSourceLabel(`✅ ราคาจริงจาก ${src.label}`, 'var(--green)');
      done = true;
      break;
    } catch (err) {
      console.warn(`[${src.label}] candle fetch failed, trying next source:`, err.message);
    }
  }

  if (!done) {
    detailState.candles = genCandles(base, tf, ticker);
    detailState.dataSource = 'mock';
    setChartDataSourceLabel('⚠️ ใช้กราฟจำลอง (ดึงราคาจริงไม่สำเร็จทุกแหล่ง)', 'var(--red)');
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
  renderWatchlistSide();
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
  const rows = detailState.drawings.map(d => ({
    id: d.id, ticker: d.ticker, type: d.type, color: d.color,
    data: JSON.stringify({ p1: d.p1, p2: d.p2 || null })
  }));
  // Replace-all-for-ticker strategy: delete then insert (simplest correctness for small datasets)
  const del = await sb.from('chart_drawings').delete().eq('ticker', detailState.ticker);
  if (del.error) { console.error('[Drawings] delete error:', del.error); return; }
  if (rows.length) {
    const ins = await sb.from('chart_drawings').insert(rows.filter(r=>r.ticker===detailState.ticker));
    if (ins.error) {
      console.error('[Drawings] insert error:', ins.error);
      showToast('⚠️ บันทึกเส้นวาดไม่สำเร็จ: ' + (ins.error.message || ins.error.code), 'var(--red)');
    }
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
  const { error } = await sb.from('price_alerts').insert({ id:a.id, ticker:a.ticker, cond:a.cond, price:a.price, triggered:false });
  if (error) {
    console.error('[Alerts] Supabase insert error:', error);
    showToast('⚠️ ตั้งเตือนใน Supabase ไม่สำเร็จ (ใช้ได้แค่ session นี้): ' + (error.message || error.code), 'var(--red)');
  } else {
    showToast('🔔 ตั้งเตือนแล้ว');
  }
}
async function removeAlert(id) {
  detailState.alerts = detailState.alerts.filter(a=>a.id!==id);
  renderAlertsUI();
  drawChart();
  const { error } = await sb.from('price_alerts').delete().eq('id', id);
  if (error) console.error('[Alerts] Supabase delete error:', error);
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
  if (name === 'gold') initGoldTab();
  if (name === 'news') initNewsTab();
  if (name === 'feargreed') fetchVixFearGreed();
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

// สลับฟอร์ม: ถ้าเลือก "ฝากเงิน/ดอกเบี้ย" ไม่ต้องกรอกอัตราแลก (ซ่อนช่องอัตราแลกไปเลย)
function onTxTypeChange() {
  const type = document.getElementById('txType').value;
  const rateWrap = document.getElementById('txRateWrap');
  const amountEl = document.getElementById('txAmount');
  const hintEl = document.getElementById('txCurrencyHint');
  if (type === 'interest') {
    rateWrap.style.display = 'none';
    amountEl.placeholder = 'จำนวนเงินที่ฝาก/ดอกเบี้ย (THB)';
    if (hintEl) hintEl.textContent = '';
  } else if (type === 'interest_usd') {
    rateWrap.style.display = 'none';
    amountEl.placeholder = 'จำนวนเงินที่ฝาก/ดอกเบี้ย (USD)';
    if (hintEl) hintEl.textContent = '💵 บันทึกเป็น USD โดยตรง จะรวมเข้า "USD คงเหลือ" ทันที';
  } else {
    rateWrap.style.display = '';
    amountEl.placeholder = 'จำนวน THB';
    if (hintEl) hintEl.textContent = '';
  }
}

async function addWalletTx() {
  const type   = document.getElementById('txType').value;
  const amount = parseFloat(document.getElementById('txAmount').value);
  const date   = document.getElementById('txDate').value || new Date().toISOString().slice(0, 10);
  const note   = document.getElementById('txNote').value.trim();

  if (isNaN(amount) || amount <= 0) { showToast('กรุณากรอกจำนวนเงิน', 'var(--red)'); return; }

  let tx;
  if (type === 'interest') {
    // เงินฝาก/ดอกเบี้ย (THB): เก็บเป็น THB ล้วนๆ ไม่มีอัตราแลก ไม่กระทบ avg rate หรือ FX P&L ของการแลกเงินเลย
    tx = { id: 'w' + Date.now(), type: 'interest', amount, rate: 0, usd: 0, date, note: note || 'ฝากเงิน/ดอกเบี้ย' };
  } else if (type === 'interest_usd') {
    // เงินฝาก/ดอกเบี้ย (USD): เก็บเป็น USD ตรงๆ ไม่มีอัตราแลก ไม่กระทบ avg rate หรือ FX P&L
    // แต่จะถูกรวมเข้า "USD คงเหลือ" ทันที (เหมือนได้ USD เพิ่มมาโดยไม่ต้องแลกเงิน)
    tx = { id: 'w' + Date.now(), type: 'interest_usd', amount: 0, rate: 0, usd: amount, date, note: note || 'ฝากเงิน/ดอกเบี้ย (USD)' };
  } else {
    const rate = parseFloat(document.getElementById('txRate').value);
    if (isNaN(rate) || rate <= 0) { showToast('กรุณากรอกอัตราแลก THB/USD', 'var(--red)'); return; }
    const usd = parseFloat((amount / rate).toFixed(4));
    tx = { id: 'w' + Date.now(), type: 'fx_buy', amount, rate, usd, date, note };
  }
  _walletTxs.push(tx);

  const { error } = await sb.from('wallet_transactions').insert({ ...tx });
  if (error) {
    console.error('[Wallet] Supabase insert error:', error);
    localStorage.setItem('wallet_txs', JSON.stringify(_walletTxs));
    showToast('⚠️ บันทึกลง Supabase ไม่สำเร็จ (เก็บไว้ในเครื่องชั่วคราว): ' + (error.message || error.code), 'var(--red)');
  } else {
    showToast(type === 'interest' ? '🏦 บันทึกเงินฝาก/ดอกเบี้ย (THB) แล้ว' : type === 'interest_usd' ? '💵 บันทึกเงินฝาก/ดอกเบี้ย (USD) แล้ว' : '💱 บันทึกการแลกเงินแล้ว');
  }

  ['txAmount', 'txRate', 'txNote'].forEach(id => document.getElementById(id).value = '');
  renderWalletTab();
}

async function deleteWalletTx(id) {
  _walletTxs = _walletTxs.filter(t => t.id !== id);
  const { error } = await sb.from('wallet_transactions').delete().eq('id', id);
  if (error) {
    console.error('[Wallet] Supabase delete error:', error);
    localStorage.setItem('wallet_txs', JSON.stringify(_walletTxs));
    showToast('⚠️ ลบใน Supabase ไม่สำเร็จ: ' + (error.message || error.code), 'var(--red)');
  }
  renderWalletTab();
}

function renderWalletTab() {
  // รวม fx_buy (manual) + exchange (legacy auto-import ก่อน v3)
  const fxTxs      = _walletTxs.filter(t => t.type === 'fx_buy' || t.type === 'deposit');
  const fxBuyTHB   = _walletTxs.filter(t => t.type === 'fx_buy').reduce((a, t) => a + t.amount, 0);
  const fxBuyUSD   = _walletTxs.filter(t => t.type === 'fx_buy').reduce((a, t) => a + (t.usd || 0), 0);
  const legacyTHB  = _walletTxs.filter(t => t.type === 'deposit').reduce((a, t) => a + t.amount, 0); // legacy ฝากเงิน
  const totalFxTHB = fxBuyTHB + legacyTHB;

  // ต้นทุน USD จากพอร์ตหุ้น (_stocks) — ดึงตรงจาก portfolio
  const portfolioCostUSD = _stocks.reduce((a, s) => a + (parseFloat(s.cost || 0) * parseFloat(s.shares || 0)), 0);
  // ต้นทุน THB = cost USD × avg rate ที่แลก
  const avgRate = fxBuyUSD > 0 ? fxBuyTHB / fxBuyUSD : THB_RATE;
  const portfolioCostTHB = portfolioCostUSD * avgRate;

  // เงินฝาก/ดอกเบี้ยที่ฝากเป็น USD โดยตรง (ไม่ผ่านอัตราแลก) — บวกเข้า USD คงเหลือทันที
  const interestUSD = _walletTxs.filter(t => t.type === 'interest_usd').reduce((a, t) => a + (t.usd || 0), 0);

  // USD คงเหลือ = USD แลกมา + USD ฝาก/ดอกเบี้ยตรง - ต้นทุน USD ในพอร์ต
  const usdBalance = fxBuyUSD + interestUSD - portfolioCostUSD;

  // กำไร/ขาดทุนค่าเงิน (FX P&L):
  // มูลค่าพอร์ตปัจจุบัน (THB) = _stocks.reduce price × shares × currentRate
  const portfolioValueTHB = _stocks.reduce((a, s) => a + (parseFloat(s.price || s.cost || 0) * parseFloat(s.shares || 0)), 0) * THB_RATE;
  // fxPnl คำนวณด้านล่างตอน render cards แล้ว

  // sell returns
  const sellReturns = _walletTxs.filter(t => t.type === 'sell_return').reduce((a, t) => a + t.amount, 0);
  // เงินฝาก/ดอกเบี้ย (THB ล้วนๆ ไม่มีอัตราแลก) — แยกออกจากการแลกเงิน ไม่กระทบ avg rate / FX P&L ด้านบนเลย
  const interestTHB = _walletTxs.filter(t => t.type === 'interest').reduce((a, t) => a + t.amount, 0);

  // FX P&L: เปรียบเทียบ avg rate ที่เราแลก vs THB_RATE ปัจจุบัน
  // ถ้าแลกแพง (avgRate > THB_RATE ปัจจุบัน) = ขาดทุนค่าเงิน
  const rateDiff = THB_RATE - avgRate; // บวก = ปัจจุบันแพงกว่า (เราแลกถูก), ลบ = เราแลกแพง
  const fxPnlUSD = fxBuyUSD; // USD ที่เราแลก
  const fxPnlTHB = rateDiff * fxBuyUSD; // กำไร/ขาดทุนค่าเงิน (THB)
  const fxPnlPct = avgRate > 0 ? (rateDiff / avgRate * 100) : 0;

  document.getElementById('walletCards').innerHTML = `
    <div class="card">
      <div class="card-label">💱 THB ที่แลกรวม</div>
      <div class="card-value">฿${fmt(fxBuyTHB)}</div>
      <div class="card-sub">${_walletTxs.filter(t => t.type === 'fx_buy').length} ครั้ง</div>
    </div>
    <div class="card">
      <div class="card-label">💵 USD รวมที่ได้</div>
      <div class="card-value">$${fmt(fxBuyUSD, 2)}</div>
      <div class="card-sub">จาก ฿${fmt(fxBuyTHB)}</div>
    </div>
    <div class="card" style="border:1px solid rgba(255,255,255,0.08)">
      <div class="card-label">⚖️ avg rate ของเรา</div>
      <div class="card-value" style="font-size:1.1rem">${fxBuyUSD > 0 ? avgRate.toFixed(4) : '—'} <span style="font-size:0.7rem;color:var(--muted)">THB/USD</span></div>
      <div class="card-sub">แลก ${_walletTxs.filter(t => t.type === 'fx_buy').length} ครั้ง weighted avg</div>
    </div>
    <div class="card" style="border:1px solid rgba(255,255,255,0.08)">
      <div class="card-label">🌐 อัตราปัจจุบัน (BOT)</div>
      <div class="card-value" style="font-size:1.1rem">${THB_RATE.toFixed(4)} <span style="font-size:0.7rem;color:var(--muted)">THB/USD</span></div>
      <div class="card-sub ${rateDiff >= 0 ? 'green' : 'red'}" style="font-size:0.82rem;font-weight:600">
        ${rateDiff >= 0 ? '▲ ปัจจุบันแพงกว่า' : '▼ ปัจจุบันถูกกว่า'} ${Math.abs(rateDiff).toFixed(4)} THB/USD
      </div>
    </div>
    <div class="card">
      <div class="card-label">📈 กำไร/ขาดทุนค่าเงิน</div>
      <div class="card-value ${fxPnlTHB >= 0 ? 'green' : 'red'}">${fxPnlTHB >= 0 ? '+' : ''}฿${fmt(Math.abs(fxPnlTHB), 0)}</div>
      <div class="card-sub ${fxPnlTHB >= 0 ? 'green' : 'red'}">
        ${fxPnlTHB >= 0 ? '✅ แลกถูก ได้กำไรค่าเงิน' : '⚠️ แลกแพง ขาดทุนค่าเงิน'}<br>
        ${fxPnlPct >= 0 ? '+' : ''}${fxPnlPct.toFixed(2)}% | $${fmt(fxBuyUSD,2)} × ${rateDiff >= 0 ? '+' : ''}${rateDiff.toFixed(4)}
      </div>
    </div>
    <div class="card">
      <div class="card-label">💵 USD คงเหลือ</div>
      <div class="card-value ${usdBalance >= 0 ? 'green' : 'red'}">${usdBalance >= 0 ? '+' : ''}$${fmt(usdBalance, 2)}</div>
      <div class="card-sub">แลกมา $${fmt(fxBuyUSD,2)}${interestUSD > 0 ? ' + ฝาก/ดอกเบี้ย $' + fmt(interestUSD,2) : ''} / ลงทุนไป $${fmt(portfolioCostUSD,2)}</div>
    </div>
    <div class="card">
      <div class="card-label">📤 รับจากขายหุ้น</div>
      <div class="card-value ${sellReturns > 0 ? 'green' : ''}">${sellReturns > 0 ? '+฿' + fmt(sellReturns) : '—'}</div>
      <div class="card-sub">${_walletTxs.filter(t => t.type === 'sell_return').length} รายการ</div>
    </div>
    <div class="card">
      <div class="card-label">🏦 เงินฝาก/ดอกเบี้ย (THB)</div>
      <div class="card-value ${interestTHB > 0 ? 'green' : ''}">${interestTHB > 0 ? '+฿' + fmt(interestTHB) : '—'}</div>
      <div class="card-sub">${_walletTxs.filter(t => t.type === 'interest').length} รายการ · ไม่ผูกกับอัตราแลกเปลี่ยน</div>
    </div>
    <div class="card">
      <div class="card-label">🏦 เงินฝาก/ดอกเบี้ย (USD)</div>
      <div class="card-value ${interestUSD > 0 ? 'green' : ''}">${interestUSD > 0 ? '+$' + fmt(interestUSD,2) : '—'}</div>
      <div class="card-sub">${_walletTxs.filter(t => t.type === 'interest_usd').length} รายการ · รวมเข้า USD คงเหลือทันที</div>
    </div>
  `;

  // Chart: สะสม THB ที่แลก ต่อครั้ง
  const sorted = [..._walletTxs].filter(t => t.type === 'fx_buy').sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const chartLabels = [], chartVals = [], rateVals = [];
  sorted.forEach(t => {
    running += t.amount;
    chartLabels.push(t.date.slice(5));
    chartVals.push(parseFloat(running.toFixed(2)));
    rateVals.push(t.rate || 0);
  });
  const ctx = document.getElementById('walletChart').getContext('2d');
  if (walletChartInst) walletChartInst.destroy();
  const grad = ctx.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, 'rgba(0,200,120,0.3)');
  grad.addColorStop(1, 'rgba(0,200,120,0)');
  walletChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chartLabels,
      datasets: [
        { label: 'THB สะสม', data: chartVals, backgroundColor: 'rgba(0,153,255,0.5)', borderColor: '#0099ff', borderWidth: 1, yAxisID: 'y' },
        { label: 'อัตราแลก', data: rateVals, type: 'line', borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 4, yAxisID: 'y2' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, labels: { color: '#5a6478', font: { size: 10 } } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 }, callback: v => '฿' + fmt(v, 0) }, position: 'left' },
        y2: { grid: { display: false }, ticks: { color: '#f59e0b', font: { size: 10 }, callback: v => v.toFixed(2) }, position: 'right' }
      }
    }
  });

  // Table - แสดง fx_buy, sell_return, deposit (legacy), interest (ฝาก/ดอกเบี้ย THB) และ interest_usd (ฝาก/ดอกเบี้ย USD)
  const tbody = document.getElementById('walletBody');
  const txSorted = [..._walletTxs]
    .filter(t => t.type === 'fx_buy' || t.type === 'sell_return' || t.type === 'deposit' || t.type === 'interest' || t.type === 'interest_usd')
    .sort((a, b) => b.date.localeCompare(a.date));
  tbody.innerHTML = txSorted.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">ยังไม่มีรายการ</td></tr>`
    : txSorted.map(t => {
      const isSell = t.type === 'sell_return';
      const isInterest = t.type === 'interest';
      const isInterestUSD = t.type === 'interest_usd';
      const label = isSell ? '📤 ขายหุ้น' : isInterest ? '🏦 ฝาก/ดอกเบี้ย (THB)' : isInterestUSD ? '🏦 ฝาก/ดอกเบี้ย (USD)' : '💱 แลกเงิน';
      const amountCell = isInterestUSD
        ? `<td class="mono" style="color:var(--muted)">—</td>`
        : (isSell || isInterest)
          ? `<td class="mono green">+฿${fmt(t.amount)}</td>`
          : `<td class="mono tx-exchange">-฿${fmt(t.amount)}</td>`;
      const usdCell = isInterestUSD
        ? `<td class="mono green">+$${fmt(t.usd, 2)}</td>`
        : `<td class="mono green">${t.usd > 0 ? '+$' + fmt(t.usd, 4) : '—'}</td>`;
      return `<tr>
        <td class="mono" style="color:var(--muted)">${t.date}</td>
        ${amountCell}
        <td class="mono" style="color:var(--muted)">${t.rate > 0 ? t.rate.toFixed(4) : '—'}</td>
        ${usdCell}
        <td style="color:var(--muted);font-size:0.8rem">${label}${t.note ? ' · ' + t.note : ''}</td>
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
  const { error } = await sb.from('other_assets').insert({ ...asset });
  if (error) {
    console.error('[Assets] Supabase insert error:', error);
    localStorage.setItem('other_assets', JSON.stringify(_assets));
    showToast('⚠️ บันทึกสินทรัพย์ลง Supabase ไม่สำเร็จ: ' + (error.message || error.code), 'var(--red)');
  } else {
    showToast('🏦 เพิ่มสินทรัพย์แล้ว');
  }
  ['a_name', 'a_value', 'a_cost', 'a_note'].forEach(id => document.getElementById(id).value = '');
  renderAssetsTab();
}

async function deleteAsset(id) {
  _assets = _assets.filter(a => a.id !== id);
  const { error } = await sb.from('other_assets').delete().eq('id', id);
  if (error) {
    console.error('[Assets] Supabase delete error:', error);
    localStorage.setItem('other_assets', JSON.stringify(_assets));
    showToast('⚠️ ลบสินทรัพย์ใน Supabase ไม่สำเร็จ: ' + (error.message || error.code), 'var(--red)');
  }
  renderAssetsTab();
}

async function renderAssetsTab() {
  // ต้องมีราคาทองปัจจุบันก่อนถึงจะคำนวณมูลค่าออมทองได้ — ถ้ายังไม่เคยดึง (เช่น เข้าแท็บนี้
  // เป็นแท็บแรกโดยไม่ได้เปิดแท็บ "ออมทอง" มาก่อน) ให้ดึงราคาก่อน แล้วค่อย render การ์ด
  if (GOLD_PRICE_THB <= 0) await fetchGoldPrice();

  const totalAssets = _assets.reduce((a, x) => a + x.value, 0);
  const totalCostAssets = _assets.reduce((a, x) => a + (x.cost || 0), 0);
  const stocksValueTHB = getStocks().reduce((a, s) => a + parseFloat(s.price) * parseFloat(s.shares), 0) * THB_RATE;

  // มูลค่าปัจจุบันของออมทอง (จากแท็บ "ออมทอง" — น้ำหนักรวมทุกรายการ x ราคารับซื้อปัจจุบัน)
  const goldWeightTotal = _goldEntries.reduce((a, e) => a + e.weight, 0);
  const goldCostTotal = _goldEntries.reduce((a, e) => a + e.buy_price * e.weight, 0);
  const goldValueTHB = GOLD_PRICE_THB * goldWeightTotal;
  const goldPL = goldValueTHB - goldCostTotal;

  const netWorth = totalAssets + stocksValueTHB + goldValueTHB;

  const typeLabels = { crypto: 'Crypto', property: 'อสังหา', gold: 'ทอง', cash: 'เงินสด', fund: 'กองทุน', other: 'อื่น ๆ' };

  document.getElementById('assetCards').innerHTML = `
    <div class="card">
      <div class="card-label">Net Worth รวม (THB)</div>
      <div class="card-value" style="color:var(--gold)">฿${fmt(netWorth)}</div>
      <div class="card-sub">หุ้น + สินทรัพย์อื่น + ออมทอง</div>
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
      <div class="card-label">🥇 ออมทอง (มูลค่าปัจจุบัน)</div>
      <div class="card-value">฿${fmt(goldValueTHB)}</div>
      <div class="card-sub">${fmt(goldWeightTotal, 4)} บาท @ ฿${fmt(GOLD_PRICE_THB, 0)}/บาท</div>
    </div>
    <div class="card">
      <div class="card-label">กำไร/ขาดทุน (สินทรัพย์อื่น)</div>
      <div class="card-value ${totalAssets - totalCostAssets >= 0 ? 'green' : 'red'}">${totalAssets - totalCostAssets >= 0 ? '+' : ''}฿${fmt(totalAssets - totalCostAssets)}</div>
      <div class="card-sub">จากต้นทุน ฿${fmt(totalCostAssets)}</div>
    </div>
    <div class="card">
      <div class="card-label">กำไร/ขาดทุน (ออมทอง)</div>
      <div class="card-value ${goldPL >= 0 ? 'green' : 'red'}">${goldPL >= 0 ? '+' : ''}฿${fmt(goldPL)}</div>
      <div class="card-sub">จากต้นทุน ฿${fmt(goldCostTotal)}</div>
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
    { label: '🥇 ออมทอง', val: goldValueTHB, color: '#ffd700' },
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
      maintainAspectRatio: true,
      plugins: {
        legend: { position: 'right', labels: { color: '#e8edf5', font: { size: 11 }, boxWidth: 14, padding: 10 } },
        tooltip: { callbacks: { label: c => { const total = c.dataset.data.reduce((a, b) => a + b, 0); return ` ${c.label}: ฿${fmt(c.parsed)} (${((c.parsed / total) * 100).toFixed(1)}%)`; } } }
      },
      layout: { padding: 10 }
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
    const parsedRows = parseAllDimeRows(fullText);

    if (!parsedRows || parsedRows.length === 0) {
      statusEl.innerHTML = '<span style="color:var(--red)">❌ ไม่พบข้อมูลในรูปแบบที่รองรับ ตรวจสอบว่าเป็น PDF จาก KKP Dime</span>';
      return;
    }

    // เก็บ array ทุกรายการไว้ใน _pendingImport
    _pendingImport = parsedRows;
    const count = parsedRows.length;
    statusEl.innerHTML = `<span style="color:var(--green)">✅ พบ ${count} รายการ กรุณาตรวจสอบแล้วเลือกรายการที่ต้องการนำเข้า</span>`;

    // สร้าง preview table แสดงทุกรายการ + checkbox
    const invoiceNo = parsedRows[0].invoiceNo || '—';
    const fxRate = parsedRows[0].fxRate;
    let tableHTML = `
      <div style="margin-bottom:10px;font-size:0.82rem;color:var(--muted)">
        ใบกำกับภาษี: <strong>${invoiceNo}</strong> &nbsp;|&nbsp; อัตราแลก: 1 USD = ${fxRate} THB
      </div>
      <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead>
          <tr style="border-bottom:1px solid var(--border);color:var(--muted)">
            <th style="padding:6px 4px;text-align:center">
              <input type="checkbox" id="importSelectAll" onchange="toggleSelectAllImport(this.checked)" checked>
            </th>
            <th style="padding:6px 8px;text-align:left">Order ID</th>
            <th style="padding:6px 8px;text-align:left">วันที่</th>
            <th style="padding:6px 8px;text-align:left">ประเภท</th>
            <th style="padding:6px 8px;text-align:left">หุ้น</th>
            <th style="padding:6px 8px;text-align:right">จำนวนหุ้น</th>
            <th style="padding:6px 8px;text-align:right">ราคา/หน่วย</th>
            <th style="padding:6px 8px;text-align:right">มูลค่า USD</th>
            <th style="padding:6px 8px;text-align:right">มูลค่า THB</th>
          </tr>
        </thead>
        <tbody>
    `;
    parsedRows.forEach((p, i) => {
      const isBuy = p.txType === 'BUY';
      const typeLabel = isBuy ? '<span style="color:var(--green)">🟢 BUY</span>' : '<span style="color:var(--red)">🔴 SELL</span>';
      tableHTML += `
        <tr style="border-bottom:1px solid var(--border)" data-import-idx="${i}">
          <td style="padding:6px 4px;text-align:center">
            <input type="checkbox" class="import-row-cb" data-idx="${i}" checked>
          </td>
          <td style="padding:6px 8px;color:var(--muted);font-family:monospace">${p.orderId || '—'}</td>
          <td style="padding:6px 8px;font-family:monospace">${p.effectiveDate || '—'}</td>
          <td style="padding:6px 8px">${typeLabel}</td>
          <td style="padding:6px 8px;font-weight:700;color:var(--accent)">${p.ticker}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${fmt(p.shares, 4)}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">$${fmt(p.unitPrice)}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">$${fmt(p.grossUSD)}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">฿${fmt(p.grossTHB)}</td>
        </tr>
      `;
    });
    tableHTML += '</tbody></table></div>';

    document.getElementById('importExtracted').innerHTML = tableHTML;
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
  // Legacy wrapper — ใช้ parseAllDimeRows แล้วคืนค่าแรก
  return parseAllDimeRows(text)[0] || null;
}

function parseAllDimeRows(text) {
  const t = text.replace(/\s+/g, ' ');

  // หา Invoice No (ร่วมกันทุก row)
  const invoiceMatch = t.match(/DIMEOS\d+/);
  const invoiceNo = invoiceMatch ? invoiceMatch[0] : null;

  // หาอัตราแลก (ร่วมกัน)
  const fxMatchGlobal = t.match(/THB\/USD\s*=\s*([\d.]+)/i) || t.match(/1\s*USD\s*=\s*([\d.]+)\s*THB/i);
  const fxRateGlobal = fxMatchGlobal ? parseFloat(fxMatchGlobal[1]) : THB_RATE;

  // หาวันที่แรก (fallback)
  const dateMatchGlobal = t.match(/(\d{2}\/\d{2}\/\d{4})/);
  const effectiveDateGlobal = dateMatchGlobal ? dateMatchGlobal[1] : null;

  const rows = [];

  // Pattern: orderId  date  BUY|SEL  TICKER  [EXCH]  shares  unitPrice  USD  grossUSD  fee  wht  totalUSD  grossTHB  fee_thb  wht_thb  totalTHB
  const rowRe = /(\d{6,})\s+(\d{2}\/\d{2}\/\d{4})\s+(BUY|SEL(?:L)?)\s+([A-Z]{1,5})\s+\[[A-Z]+\]\s+([\d.]+)\s+([\d.]+)\s+USD\s+([\d,]+\.?\d*)\s+[\d,]+\.?\d*\s+[\d,]+\.?\d*\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+[\d,]+\.?\d*\s+[\d,]+\.?\d*\s+([\d,]+\.?\d*)/g;

  let m;
  while ((m = rowRe.exec(t)) !== null) {
    const orderId   = m[1];
    const rowDate   = m[2];
    const txType    = m[3] === 'SEL' ? 'SELL' : m[3];
    const ticker    = m[4];
    const shares    = parseFloat(m[5]);
    const unitPrice = parseFloat(m[6]);
    const grossUSD  = parseFloat(m[7].replace(/,/g, ''));
    const totalUSD  = parseFloat(m[8].replace(/,/g, ''));
    const grossTHB  = parseFloat(m[10].replace(/,/g, ''));
    if (!ticker || !shares || !unitPrice) continue;
    rows.push({ invoiceNo, orderId, txType, ticker, shares, unitPrice,
      grossUSD: grossUSD || shares * unitPrice,
      fxRate: fxRateGlobal,
      grossTHB: grossTHB || parseFloat((totalUSD * fxRateGlobal).toFixed(2)),
      effectiveDate: rowDate || effectiveDateGlobal });
  }

  // Fallback single-row parse (เอกสารรูปแบบอื่น)
  if (rows.length === 0) {
    const txTypeMatch = t.match(/\b(BUY|SELL|SEL)\b/);
    const txType = txTypeMatch ? (txTypeMatch[1] === 'SEL' ? 'SELL' : txTypeMatch[1]) : null;
    const tickerMatch = t.match(/(?:BUY|SELL|SEL)\s+([A-Z]{1,5})\s+\[/);
    const ticker = tickerMatch ? tickerMatch[1] : null;
    const sharesMatch = t.match(/(\d+\.\d{4,})\s+\d+\.\d{2}\s+USD/);
    const shares = sharesMatch ? parseFloat(sharesMatch[1]) : null;
    const unitPriceMatch = t.match(/\d+\.\d{4,}\s+(\d+\.\d{2})\s+USD/);
    const unitPrice = unitPriceMatch ? parseFloat(unitPriceMatch[1]) : null;
    const grossMatch = t.match(/USD\s+([\d,]+\.\d{2})/);
    const grossUSD = grossMatch ? parseFloat(grossMatch[1].replace(/,/g, '')) : (shares && unitPrice ? shares * unitPrice : null);
    const grossTHB = grossUSD ? parseFloat((grossUSD * fxRateGlobal).toFixed(2)) : null;
    const orderMatch = t.match(/(?:Order ID|เลขที่คำสั่ง)[^\d]*(\d{6,})/i) || t.match(/\b(\d{6})\b/);
    const orderId = orderMatch ? orderMatch[1] : null;
    if (ticker && shares && unitPrice) {
      rows.push({ invoiceNo, orderId, txType: txType || 'BUY', ticker, shares, unitPrice,
        grossUSD: grossUSD || shares * unitPrice, fxRate: fxRateGlobal,
        grossTHB: grossTHB || shares * unitPrice * fxRateGlobal,
        effectiveDate: effectiveDateGlobal });
    }
  }

  return rows;
}

// helper: process one parsed row into portfolio + wallet + history
async function processSingleImportRow(p) {
  const existing = _stocks.findIndex(s => s.ticker === p.ticker);
  if (p.txType === 'BUY') {
    if (existing >= 0) {
      const s = _stocks[existing];
      const oldCost = parseFloat(s.cost) * parseFloat(s.shares);
      const newCost = p.unitPrice * p.shares;
      const newShares = parseFloat(s.shares) + p.shares;
      const avgCost = (oldCost + newCost) / newShares;
      _stocks[existing].shares = newShares;
      _stocks[existing].cost = parseFloat(avgCost.toFixed(4));
      _stocks[existing].price = p.unitPrice;
      await saveStockToSB(_stocks[existing]);
    } else {
      const newColor = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      const entry = { ticker: p.ticker, shares: p.shares, cost: p.unitPrice, price: p.unitPrice, sector: 'Other', color: newColor };
      _stocks.push(entry);
      await saveStockToSB(entry);
    }
  } else if (p.txType === 'SELL') {
    if (existing >= 0) {
      const remainingShares = parseFloat(_stocks[existing].shares) - p.shares;
      if (remainingShares <= 0) {
        const removed = _stocks.splice(existing, 1)[0];
        try { await sb.from('stocks').delete().eq('id', removed.id); } catch (e) { }
      } else {
        _stocks[existing].shares = parseFloat(remainingShares.toFixed(4));
        await saveStockToSB(_stocks[existing]);
      }
    }
  }

  const dateStr = p.effectiveDate ? p.effectiveDate.split('/').reverse().join('-') : new Date().toISOString().slice(0, 10);
  if (p.grossTHB > 0) {
    const tx = {
      id: 'w' + Date.now() + Math.random().toString(36).slice(2, 6),
      type: p.txType === 'SELL' ? 'sell_return' : 'exchange',
      amount: p.grossTHB, rate: p.fxRate, usd: p.grossUSD, date: dateStr,
      note: `${p.txType === 'SELL' ? 'ขาย' : 'ซื้อ'} ${p.ticker} ${fmt(p.shares, 4)} หุ้น (PDF Import)`
    };
    _walletTxs.push(tx);
    try { await sb.from('wallet_transactions').insert({ ...tx }); } catch (e) { }
  }

  const hist = {
    id: 'ih' + Date.now() + Math.random().toString(36).slice(2, 6),
    invoice_no: p.invoiceNo, ticker: p.ticker, tx_type: p.txType, shares: p.shares,
    unit_price: p.unitPrice, gross_thb: p.grossTHB, fx_rate: p.fxRate,
    order_id: p.orderId, effective_date: p.effectiveDate, imported_at: new Date().toISOString()
  };
  _importHistory.unshift(hist);
  try { await sb.from('import_history').insert({ ...hist }); } catch (e) {
    localStorage.setItem('import_history', JSON.stringify(_importHistory));
  }
}

function toggleSelectAllImport(checked) {
  document.querySelectorAll('.import-row-cb').forEach(cb => cb.checked = checked);
}

async function confirmImport() {
  if (!_pendingImport) return;
  const allRows = Array.isArray(_pendingImport) ? _pendingImport : [_pendingImport];

  // หา checkbox ที่ติ๊ก
  const checkedIdxs = [...document.querySelectorAll('.import-row-cb:checked')].map(cb => parseInt(cb.dataset.idx));
  const toImport = allRows.filter((_, i) => checkedIdxs.includes(i));

  if (toImport.length === 0) {
    showToast('⚠️ กรุณาเลือกอย่างน้อย 1 รายการ', 'var(--yellow)');
    return;
  }

  const btn = document.getElementById('importConfirmBtn');
  btn.disabled = true;
  btn.textContent = `⏳ กำลังนำเข้า 0/${toImport.length}...`;

  try {
    let done = 0;
    for (const p of toImport) {
      await processSingleImportRow(p);
      done++;
      btn.textContent = `⏳ กำลังนำเข้า ${done}/${toImport.length}...`;
    }

    showToast(`✅ นำเข้าสำเร็จ ${done} รายการ`);
    _pendingImport = null;
    document.getElementById('importPreview').style.display = 'none';
    document.getElementById('importStatus').innerHTML = `<span style="color:var(--green)">✅ นำเข้าสำเร็จ ${done} รายการ</span>`;
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

// ================================================================
// ============ IMPORT FROM IMAGE (AI Vision Extraction) =========
// ================================================================
let _pendingImageImport = null;

function switchImportMode(mode) {
  document.getElementById('importModePdf').style.display = mode === 'pdf' ? '' : 'none';
  document.getElementById('importModeImage').style.display = mode === 'image' ? '' : 'none';
  document.getElementById('importTabPdfBtn').classList.toggle('active', mode === 'pdf');
  document.getElementById('importTabImgBtn').classList.toggle('active', mode === 'image');
  document.getElementById('importStatus').innerHTML = '';
  document.getElementById('importPreview').style.display = 'none';
  document.getElementById('imageImportPreview').style.display = 'none';
}

function imageDragOver(e) {
  e.preventDefault();
  document.getElementById('imageZone').classList.add('drag');
}
function imageDrop(e) {
  e.preventDefault();
  document.getElementById('imageZone').classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) importImageFile(file);
  else showToast('กรุณาเลือกไฟล์รูปภาพเท่านั้น', 'var(--red)');
}

// Lazily load Tesseract.js (UMD build) from CDN once, the same pattern used for pdf.js above.
async function ensureTesseractLoaded() {
  if (window.Tesseract) return;
  await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
}

async function importImageFile(file) {
  if (!file) return;

  const statusEl = document.getElementById('importStatus');
  document.getElementById('imageImportPreview').style.display = 'none';

  const thumb = document.getElementById('imagePreviewThumb');
  thumb.src = URL.createObjectURL(file);
  thumb.style.display = 'block';

  try {
    statusEl.innerHTML = '<span class="import-progress">⏳ กำลังโหลด OCR engine (ครั้งแรกอาจใช้เวลาสักหน่อย)...</span>';
    await ensureTesseractLoaded();

    statusEl.innerHTML = '<span class="import-progress">🔍 กำลังอ่านข้อความจากรูป (OCR) 0%...</span>';
    const { data: { text } } = await Tesseract.recognize(file, 'eng+tha', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          statusEl.innerHTML = `<span class="import-progress">🔍 กำลังอ่านข้อความจากรูป (OCR) ${pct}%...</span>`;
        }
      }
    });

    statusEl.innerHTML = '<span class="import-progress">🧩 กำลังแยกฟิลด์ข้อมูล...</span>';
    const parsed = parseSlipText(text);

    _pendingImageImport = parsed;
    statusEl.innerHTML = '<span style="color:var(--green)">✅ OCR อ่านข้อความสำเร็จ — กรุณาตรวจสอบ/แก้ไขข้อมูลด้านล่างก่อนยืนยัน</span>';
    renderImageExtracted(parsed, text);
    document.getElementById('imageImportPreview').style.display = 'block';

  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ เกิดข้อผิดพลาด: ${err.message}</span>`;
    console.error('OCR parse error:', err);
  }
}

// ---- Best-effort regex parsing of OCR'd slip text. Accuracy is inherently lower than
// AI vision since this is blind pattern-matching on noisy OCR output across many possible
// slip layouts (bank transfer apps, broker confirmation screenshots, etc). The result is
// always shown in an EDITABLE form (see renderImageExtracted) so the user can fix anything
// this misses or gets wrong — never trust this output silently. ----
function parseSlipText(text) {
  const t = text.replace(/[ \t]+/g, ' ');
  const flat = t.replace(/\s+/g, ' ');

  // ---- Guess transaction type ----
  const hasStockSignal = /\b(BUY|SELL|SEL)\b/i.test(flat) || /Order ID|เลขที่คำสั่ง|\[X/i.test(flat);
  const type = hasStockSignal ? 'stock_buy' : 'currency_exchange';

  // ---- BUY / SELL ----
  const txTypeMatch = flat.match(/\b(BUY|SELL|SEL)\b/i);
  const txType = txTypeMatch ? (txTypeMatch[1].toUpperCase() === 'SEL' ? 'SELL' : txTypeMatch[1].toUpperCase()) : 'BUY';

  // ---- Ticker: 2-5 uppercase letters, avoid common false positives ----
  const tickerBlacklist = new Set(['USD','THB','BUY','SELL','SEL','PDF','OCR','API','BOT','FX','ID']);
  let ticker = null;
  const tickerNearBuy = flat.match(/(?:BUY|SELL|SEL)\s+([A-Z]{2,5})\b/);
  if (tickerNearBuy && !tickerBlacklist.has(tickerNearBuy[1])) ticker = tickerNearBuy[1];
  if (!ticker) {
    const candidates = flat.match(/\b[A-Z]{2,5}\b/g) || [];
    ticker = candidates.find(c => !tickerBlacklist.has(c)) || null;
  }

  // ---- Numbers: collect all decimal numbers (with optional thousands separators) ----
  const numMatches = (flat.match(/\d[\d,]*\.\d{2,4}/g) || []).map(s => parseFloat(s.replace(/,/g, '')));

  // shares: smallish number with 3+ decimal places (e.g. 2.0000000)
  const sharesMatch = flat.match(/(\d+\.\d{3,})/);
  const shares = sharesMatch ? parseFloat(sharesMatch[1]) : null;

  // unit price: a 2-decimal number right before/after "USD"
  const unitPriceMatch = flat.match(/(\d[\d,]*\.\d{2})\s*USD/) || flat.match(/USD\s*(\d[\d,]*\.\d{2})/);
  const unitPrice = unitPriceMatch ? parseFloat(unitPriceMatch[1].replace(/,/g, '')) : null;

  // gross USD: largest 2-decimal number tagged with USD, fallback shares*unitPrice
  let grossUSD = unitPriceMatch ? unitPrice : null;
  if (shares && unitPrice) grossUSD = parseFloat((shares * unitPrice).toFixed(2));

  // FX rate: "THB/USD" style or a 2-3 decimal number in the 25-45 range (typical USD/THB range)
  const fxMatch = flat.match(/THB\s*\/?\s*USD\s*[=:]?\s*(\d{2}\.\d{2,4})/i);
  let fxRate = fxMatch ? parseFloat(fxMatch[1]) : (numMatches.find(n => n >= 25 && n <= 45) || THB_RATE);

  // gross THB: largest number found (heuristic — THB totals are usually the biggest figure on a slip)
  const grossTHB = numMatches.length ? Math.max(...numMatches) : (grossUSD ? parseFloat((grossUSD * fxRate).toFixed(2)) : null);

  // ---- Date: dd/mm/yyyy or dd-mm-yyyy ----
  const dateMatch = flat.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  let date = null;
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // ---- Reference / Order ID: digits after "เลขที่อ้างอิง", "Ref", "Order ID" or DIMEOS-style codes ----
  const refMatch = flat.match(/DIMEOS\d+/) ||
                    flat.match(/(?:เลขที่อ้างอิง|เลขอ้างอิง|Ref(?:erence)?(?:\s*No\.?)?|Order\s*ID)[^\dA-Za-z]*([A-Za-z0-9]{6,})/i);
  const orderId = refMatch ? refMatch[refMatch.length === 1 ? 0 : 1] : null;

  return {
    type,
    txType,
    ticker: type === 'stock_buy' ? ticker : null,
    shares: type === 'stock_buy' ? shares : null,
    unitPrice: type === 'stock_buy' ? unitPrice : null,
    grossUSD: type === 'stock_buy' ? grossUSD : null,
    grossTHB,
    fxRate,
    date,
    orderId,
    note: type === 'stock_buy' ? '' : 'แลกเงิน/โอนเงิน (OCR Image Import)'
  };
}

function toggleOcrStockFields() {
  const isStock = document.getElementById('oi_type').value === 'stock_buy';
  document.getElementById('ocrStockFields').style.display = isStock ? '' : 'none';
  const badge = document.getElementById('imageTypeBadge');
  if (isStock) {
    const sell = document.getElementById('oi_txType').value === 'SELL';
    badge.textContent = sell ? '🔴 ขายหุ้น' : '🟢 ซื้อหุ้น';
    badge.style.background = 'rgba(0,229,160,0.15)';
    badge.style.color = 'var(--accent)';
  } else {
    badge.textContent = '💱 แลกเงิน / โอนเงิน';
    badge.style.background = 'rgba(0,153,255,0.15)';
    badge.style.color = 'var(--accent2)';
  }
}

function renderImageExtracted(p, rawText) {
  document.getElementById('oi_type').value = p.type || 'currency_exchange';
  document.getElementById('oi_txType').value = p.txType || 'BUY';
  document.getElementById('oi_ticker').value = p.ticker || '';
  document.getElementById('oi_shares').value = p.shares != null ? p.shares : '';
  document.getElementById('oi_unitPrice').value = p.unitPrice != null ? p.unitPrice : '';
  document.getElementById('oi_grossUSD').value = p.grossUSD != null ? p.grossUSD : '';
  document.getElementById('oi_fxRate').value = p.fxRate != null ? p.fxRate : '';
  document.getElementById('oi_grossTHB').value = p.grossTHB != null ? p.grossTHB : '';
  document.getElementById('oi_date').value = p.date || '';
  document.getElementById('oi_orderId').value = p.orderId || '';
  document.getElementById('oi_note').value = p.note || '';
  document.getElementById('ocrRawText').textContent = rawText || '(ไม่มีข้อความ)';
  toggleOcrStockFields();
  document.getElementById('oi_txType').onchange = toggleOcrStockFields;
}

async function confirmImageImport() {
  if (!_pendingImageImport) return;
  // Read current values from the editable form — the user may have corrected OCR's guesses.
  const p = {
    type: document.getElementById('oi_type').value,
    txType: document.getElementById('oi_txType').value,
    ticker: document.getElementById('oi_ticker').value.trim().toUpperCase() || null,
    shares: parseFloat(document.getElementById('oi_shares').value) || null,
    unitPrice: parseFloat(document.getElementById('oi_unitPrice').value) || null,
    grossUSD: parseFloat(document.getElementById('oi_grossUSD').value) || null,
    fxRate: parseFloat(document.getElementById('oi_fxRate').value) || THB_RATE,
    grossTHB: parseFloat(document.getElementById('oi_grossTHB').value) || null,
    date: document.getElementById('oi_date').value || null,
    orderId: document.getElementById('oi_orderId').value.trim() || null,
    note: document.getElementById('oi_note').value.trim() || null
  };
  const btn = document.getElementById('imageConfirmBtn');
  btn.disabled = true;
  btn.textContent = '⏳ กำลังนำเข้า...';

  try {
    const dateStr = p.date || new Date().toISOString().slice(0, 10);

    if (p.type === 'stock_buy' && p.ticker) {
      const existing = _stocks.findIndex(s => s.ticker === p.ticker);
      const shares = p.shares || 0;
      const unitPrice = p.unitPrice || 0;
      if (existing >= 0 && (p.txType || 'BUY') === 'BUY') {
        const s = _stocks[existing];
        const oldCost = parseFloat(s.cost) * parseFloat(s.shares);
        const newCost = unitPrice * shares;
        const newShares = parseFloat(s.shares) + shares;
        const avgCost = newShares > 0 ? (oldCost + newCost) / newShares : unitPrice;
        _stocks[existing].shares = newShares;
        _stocks[existing].cost = parseFloat(avgCost.toFixed(4));
        _stocks[existing].price = unitPrice || _stocks[existing].price;
        await saveStockToSB(_stocks[existing]);
      } else if ((p.txType || 'BUY') === 'BUY') {
        const newColor = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        const entry = { ticker: p.ticker, shares, cost: unitPrice, price: unitPrice, sector: 'Other', color: newColor };
        _stocks.push(entry);
        await saveStockToSB(entry);
      } else if ((p.txType || 'BUY') === 'SELL') {
        // ลดหุ้นในพอร์ต
        if (existing >= 0) {
          const remainingShares = parseFloat(_stocks[existing].shares) - shares;
          if (remainingShares <= 0) {
            const removed = _stocks.splice(existing, 1)[0];
            try { await sb.from('stocks').delete().eq('id', removed.id); } catch (e) { }
          } else {
            _stocks[existing].shares = parseFloat(remainingShares.toFixed(4));
            await saveStockToSB(_stocks[existing]);
          }
        }
      }

      const hist = {
        id: 'ih' + Date.now(), invoice_no: p.orderId, ticker: p.ticker, tx_type: p.txType || 'BUY',
        shares, unit_price: unitPrice, gross_thb: p.grossTHB || 0, fx_rate: p.fxRate || THB_RATE,
        order_id: p.orderId, effective_date: dateStr, imported_at: new Date().toISOString()
      };
      _importHistory.unshift(hist);
      try { await sb.from('import_history').insert({ ...hist }); } catch (e) {
        localStorage.setItem('import_history', JSON.stringify(_importHistory));
      }
    }

    // ทุกเคส ถ้ามีมูลค่า THB ให้บันทึกลง wallet ตามทิศทาง BUY/SELL
    if (p.grossTHB > 0) {
      const isSell = p.type === 'stock_buy' && (p.txType || 'BUY') === 'SELL';
      const note = p.type === 'stock_buy'
        ? (isSell ? `ขาย ${p.ticker} ${fmt(p.shares || 0, 4)} หุ้น (AI Image Import)` : `ซื้อ ${p.ticker} ${fmt(p.shares || 0, 4)} หุ้น (AI Image Import)`)
        : (p.note || 'แลกเงิน/โอนเงิน (AI Image Import)');
      const tx = {
        id: 'w' + Date.now(),
        type: isSell ? 'sell_return' : 'exchange',
        amount: p.grossTHB, rate: p.fxRate || THB_RATE,
        usd: p.grossUSD || (p.fxRate ? p.grossTHB / p.fxRate : null), date: dateStr, note
      };
      _walletTxs.push(tx);
      try { await sb.from('wallet_transactions').insert({ ...tx }); } catch (e) { }
    }

    showToast(p.type === 'stock_buy' ? `✅ นำเข้า ${p.ticker} สำเร็จ` : '✅ นำเข้ารายการแลกเงินสำเร็จ');
    _pendingImageImport = null;
    document.getElementById('imageImportPreview').style.display = 'none';
    document.getElementById('importStatus').innerHTML = '<span style="color:var(--green)">✅ นำเข้าข้อมูลเรียบร้อยแล้ว</span>';
    document.getElementById('imagePreviewThumb').style.display = 'none';
    renderAll();
    renderImportHistory();
  } catch (err) {
    showToast('❌ นำเข้าไม่สำเร็จ: ' + err.message, 'var(--red)');
    console.error(err);
  }
  btn.disabled = false;
  btn.textContent = '✅ ยืนยันนำเข้าข้อมูล';
}

function cancelImageImport() {
  _pendingImageImport = null;
  document.getElementById('imageImportPreview').style.display = 'none';
  document.getElementById('importStatus').innerHTML = '';
  document.getElementById('imageInput').value = '';
  document.getElementById('imagePreviewThumb').style.display = 'none';
  document.getElementById('ocrRawText').textContent = '';
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
  await loadGoldFromSB();
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



// ================================================================
// ==================== GOLD TAB =================================
// ================================================================
let _goldEntries = [];
let GOLD_PRICE_THB = 0;       // ใช้เป็นมูลค่าปัจจุบันของพอร์ต = ราคา "รับซื้อ" (เงินจริงที่จะได้ถ้าขายวันนี้)
let GOLD_PRICE_BUY_THB = 0;   // รับซื้อ — ทองคำแท่ง 96.5%
let GOLD_PRICE_SELL_THB = 0;  // ขายออก — ทองคำแท่ง 96.5%
let GOLD_PRICE_SOURCE = '';
let GOLD_PRICE_UPDATED = '';
const GOLD_GRAM_PER_BAHT = 15.244; // 1 บาททอง = 15.244 กรัม

async function fetchGoldPrice() {
  // ---- 1) แหล่งหลัก: สมาคมค้าทองคำ (Gold Traders Association of Thailand) ----
  // ราคาทองคำแท่ง 96.5% ที่ร้านทองทั่วประเทศใช้อ้างอิงจริง (ไม่ใช่ค่าประมาณจากราคาทองโลก)
  // ดึงผ่าน community API ที่ crawl ข้อมูลจาก goldtraders.or.th โดยตรง
  //
  // หมายเหตุ: ลองตรงๆ ก่อน แล้วถ้าติด CORS (เบราว์เซอร์บล็อกเพราะปลายทางไม่ส่ง
  // Access-Control-Allow-Origin) ค่อยลองผ่าน public CORS proxy เป็นทางสำรอง —
  // ทั้งสองแบบดึงจากแหล่งข้อมูลเดียวกัน แค่เส้นทางการเชื่อมต่อต่างกัน
  function extractGoldBar(d) {
    const bar = d?.response?.price?.gold_bar;
    if (d?.status !== 'success' || !bar?.buy || !bar?.sell) return null;
    const buy = parseFloat(String(bar.buy).replace(/,/g, ''));
    const sell = parseFloat(String(bar.sell).replace(/,/g, ''));
    if (!(buy > 0 && sell > 0)) return null;
    return { buy, sell, updated: [d.response.update_date, d.response.update_time].filter(Boolean).join(' '),
             updateDate: d.response.update_date, updateTime: d.response.update_time };
  }

  // แปลง "DD/MM/YYYY" + "HH:MM" (ตีความเป็นเวลาไทย UTC+7 ตามที่ workflow เขียนไว้) -> epoch ms
  // ไว้เช็คว่าไฟล์แคช gold-price.json เก่าไปหรือยัง (บั๊กเดิม: โค้ดรับค่าจาก cache มาใช้ตรงๆ
  // โดยไม่เคยเช็คความสดเลย ถึงแม้ comment จะเขียนไว้ว่า "ถ้าข้อมูลเก่าเกิน 2 ชม. ให้ลองแหล่งสด" ก็ตาม
  // ทำให้เวลา GitHub Action (cron ทุก 30 นาที) หยุดรันเฉยๆ — ซึ่ง GitHub จะปิด scheduled workflow
  // อัตโนมัติถ้า repo ไม่มี commit ใหม่เกิน 60 วัน — เว็บจะโชว์ราคาเก่าค้างไว้เป็น "ราคาปัจจุบัน" ไปเรื่อยๆ
  function goldUpdatedToMs(dateStr, timeStr) {
    if (!dateStr) return null;
    const [d, m, y] = dateStr.split('/').map(Number);
    if (!d || !m || !y) return null;
    let hh = 0, mm = 0;
    if (timeStr) { const parts = timeStr.split(':').map(Number); hh = parts[0] || 0; mm = parts[1] || 0; }
    return Date.UTC(y, m - 1, d, hh - 7, mm); // -7 เพื่อแปลงเวลาไทยกลับเป็น UTC
  }

  const STALE_HOURS = 3; // ตลาดทองในไทยขยับได้ตลอดวันทำการ ถ้าแคชเก่ากว่านี้ถือว่าใช้ไม่ได้แล้ว
  let staleCandidate = null; // เผื่อแหล่งสดทุกอันล่ม จะได้ใช้ตัวนี้แทน (ดีกว่า default 61000 เดา)

  const CHNWT_URL = 'https://api.chnwt.dev/thai-gold-api/latest';
  const attempts = [
    { url: './gold-price.json', label: 'สมาคมค้าทองคำ (GitHub Actions cache)', isLocalCache: true },
    { url: CHNWT_URL, label: 'สมาคมค้าทองคำ (goldtraders.or.th)' },
    { url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(CHNWT_URL), label: 'สมาคมค้าทองคำ (ผ่าน CORS proxy)' },
    { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(CHNWT_URL), label: 'สมาคมค้าทองคำ (ผ่าน CORS proxy สำรอง)' },
  ];
  for (const src of attempts) {
    try {
      const r = await fetch(src.url);
      if (!r.ok) { console.warn(`[Gold] ${src.label} -> HTTP ${r.status}`); continue; }
      const d = await r.json();
      const parsed = extractGoldBar(d);
      if (parsed) {
        if (src.isLocalCache) {
          const updatedMs = goldUpdatedToMs(parsed.updateDate, parsed.updateTime);
          const ageHours = updatedMs ? (Date.now() - updatedMs) / 3600000 : Infinity;
          if (ageHours > STALE_HOURS) {
            console.warn(`[Gold] ${src.label} เก่าเกินไป (${ageHours.toFixed(1)} ชม.) — ข้ามไปลองแหล่งสดก่อน`);
            staleCandidate = { parsed, label: src.label, ageHours };
            continue; // ไม่ return ทันที ไปลองแหล่งสดถัดไปก่อน
          }
        }
        GOLD_PRICE_BUY_THB = parsed.buy;
        GOLD_PRICE_SELL_THB = parsed.sell;
        GOLD_PRICE_THB = parsed.buy; // มูลค่าพอร์ต = ราคารับซื้อ (สิ่งที่จะได้จริงถ้าขายวันนี้)
        GOLD_PRICE_SOURCE = src.label;
        GOLD_PRICE_UPDATED = parsed.updated;
        try { localStorage.setItem('gold_price_cache', JSON.stringify({ buy: parsed.buy, sell: parsed.sell, updated: parsed.updated })); } catch (e) {}
        console.log(`[Gold] ✅ ${src.label}: buy=${parsed.buy} sell=${parsed.sell}`);
        return GOLD_PRICE_THB;
      }
      console.warn(`[Gold] ${src.label} -> response shape unexpected:`, d);
    } catch (e) {
      // ชนิด error ที่เห็นในคอนโซลตรงนี้คือเบาะแสสำคัญ: "Failed to fetch" มักแปลว่า CORS
      // ถูกบล็อก, ส่วน error เกี่ยวกับ JSON.parse แปลว่าปลายทางไม่ได้ตอบเป็น JSON จริง
      console.warn(`[Gold] ${src.label} failed:`, e.message);
    }
  }

  // ---- 1.5) ทุกแหล่งสดล่ม แต่มีแคชเก่า (เกิน 3 ชม.) อยู่ -> ใช้แคชนั้นแทนแต่บอกชัดว่าเก่าแค่ไหน ----
  // (ยังดีกว่าประมาณการจาก spot หรือ default 61000 เพราะเป็นราคาจริงจากสมาคม แค่ไม่ล่าสุด)
  if (staleCandidate) {
    GOLD_PRICE_BUY_THB = staleCandidate.parsed.buy;
    GOLD_PRICE_SELL_THB = staleCandidate.parsed.sell;
    GOLD_PRICE_THB = staleCandidate.parsed.buy;
    GOLD_PRICE_SOURCE = `⚠️ ${staleCandidate.label} (เก่าแล้ว ~${staleCandidate.ageHours.toFixed(1)} ชม. — ตรวจสอบว่า GitHub Action "Update Gold Price" ยังรันอยู่หรือไม่)`;
    GOLD_PRICE_UPDATED = staleCandidate.parsed.updated;
    try { localStorage.setItem('gold_price_cache', JSON.stringify({ buy: staleCandidate.parsed.buy, sell: staleCandidate.parsed.sell, updated: staleCandidate.parsed.updated })); } catch (e) {}
    return GOLD_PRICE_THB;
  }

  // ---- 2) สำรองสุดท้าย: ประมาณการจากราคาทองโลก (Spot) แปลงเป็น THB/บาท ----
  // ใช้เฉพาะตอนแหล่งข้อมูลจริงข้างบนล่มทั้งคู่ — ไม่ใช่ราคาจริงจากสมาคม ค่าจะเพี้ยนจากราคาตลาดจริงได้
  const spotApis = [
    { url: 'https://data-asg.goldprice.org/dbXRates/USD', parse: d => d.items[0].xauPrice },
    { url: 'https://api.metals.live/v1/spot/gold', parse: d => d[0].price },
  ];
  for (const api of spotApis) {
    try {
      const r = await fetch(api.url);
      const d = await r.json();
      const spotUSD = api.parse(d);
      if (spotUSD > 0) {
        const est = parseFloat(((spotUSD / 31.1035) * GOLD_GRAM_PER_BAHT * THB_RATE).toFixed(2));
        GOLD_PRICE_BUY_THB = est;
        GOLD_PRICE_SELL_THB = est;
        GOLD_PRICE_THB = est;
        GOLD_PRICE_SOURCE = '⚠️ ประมาณการจากราคาทองโลก (ดึงราคาสมาคมค้าทองคำไม่สำเร็จ)';
        GOLD_PRICE_UPDATED = new Date().toLocaleString('th-TH');
        console.log('[Gold] ใช้ค่าประมาณการจาก spot price:', est);
        return GOLD_PRICE_THB;
      }
    } catch (e) { continue; }
  }

  // ---- 3) ทุกแหล่งล่มหมด: ใช้ราคาล่าสุดที่เคยดึงได้สำเร็จ (เก็บไว้ใน localStorage) ก่อนจะใช้ค่า default ----
  try {
    const cached = JSON.parse(localStorage.getItem('gold_price_cache') || 'null');
    if (cached?.buy > 0) {
      GOLD_PRICE_BUY_THB = cached.buy;
      GOLD_PRICE_SELL_THB = cached.sell || cached.buy;
      GOLD_PRICE_THB = cached.buy;
      GOLD_PRICE_SOURCE = '📦 ราคาล่าสุดที่เคยดึงได้ (ดึงสดไม่สำเร็จตอนนี้)';
      GOLD_PRICE_UPDATED = cached.updated || '—';
      return GOLD_PRICE_THB;
    }
  } catch (e) {}

  GOLD_PRICE_BUY_THB = GOLD_PRICE_BUY_THB || 61000;
  GOLD_PRICE_SELL_THB = GOLD_PRICE_SELL_THB || GOLD_PRICE_BUY_THB;
  GOLD_PRICE_THB = GOLD_PRICE_THB || GOLD_PRICE_BUY_THB;
  GOLD_PRICE_SOURCE = GOLD_PRICE_SOURCE || '❌ ดึงราคาทองไม่สำเร็จ (ใช้ค่าเดิม/ค่าประมาณ)';
  GOLD_PRICE_UPDATED = GOLD_PRICE_UPDATED || '—';
  return GOLD_PRICE_THB;
}

async function loadGoldFromSB() {
  try {
    const { data, error } = await sb.from('gold_entries').select('*').order('date', { ascending: true });
    if (error) throw error;
    _goldEntries = (data || []).map(r => ({ ...r, buy_price: parseFloat(r.buy_price), weight: parseFloat(r.weight) }));
  } catch (e) {
    _goldEntries = JSON.parse(localStorage.getItem('gold_entries') || '[]');
  }
}

async function saveGoldToSB(entry) {
  const { error } = await sb.from('gold_entries').upsert({ ...entry });
  if (error) {
    console.error('[Gold] Supabase upsert error:', error);
    localStorage.setItem('gold_entries', JSON.stringify(_goldEntries));
    showToast('⚠️ บันทึกทองลง Supabase ไม่สำเร็จ (เก็บไว้ในเครื่องชั่วคราว): ' + (error.message || error.code), 'var(--red)');
  }
}

async function initGoldTab() {
  document.getElementById('goldPriceMeta').textContent = '⏳ กำลังโหลดราคาทอง...';
  document.getElementById('goldBuyVal').textContent = '—';
  document.getElementById('goldSellVal').textContent = '—';
  await fetchGoldPrice();
  document.getElementById('goldBuyVal').textContent = '฿' + fmt(GOLD_PRICE_BUY_THB, 0);
  document.getElementById('goldSellVal').textContent = '฿' + fmt(GOLD_PRICE_SELL_THB, 0);
  document.getElementById('goldPriceMeta').innerHTML =
    `📡 ${GOLD_PRICE_SOURCE}${GOLD_PRICE_UPDATED && GOLD_PRICE_UPDATED !== '—' ? ' · อัปเดต ' + GOLD_PRICE_UPDATED : ''}`;
  const gcPriceEl = document.getElementById('gc_price');
  if (gcPriceEl && !gcPriceEl.value && GOLD_PRICE_BUY_THB > 0) gcPriceEl.value = GOLD_PRICE_BUY_THB;
  renderGoldTab();
}

async function addGoldEntry() {
  const buyPrice  = parseFloat(document.getElementById('g_buyPrice').value);
  const priceMode = document.getElementById('g_priceMode').value; // 'rate' = ต่อบาททอง, 'total' = ยอดรวมที่จ่าย
  const weight    = parseFloat(document.getElementById('g_weight').value);
  const unit      = document.getElementById('g_unit').value;
  const date      = document.getElementById('g_date').value || new Date().toISOString().slice(0, 10);
  const note      = document.getElementById('g_note').value.trim();

  if (isNaN(buyPrice) || buyPrice <= 0) { showToast('กรุณากรอกราคาที่ซื้อ', 'var(--red)'); return; }
  if (isNaN(weight)   || weight   <= 0) { showToast('กรุณากรอกน้ำหนัก', 'var(--red)'); return; }

  // แปลงเป็น บาททอง เสมอ
  const weightBaht = unit === 'gram' ? parseFloat((weight / GOLD_GRAM_PER_BAHT).toFixed(6)) : weight;
  const weightGram = unit === 'gram' ? weight : parseFloat((weight * GOLD_GRAM_PER_BAHT).toFixed(4));

  // ✦ FIX: เดิมเก็บ buy_price ตรงๆ ตามที่กรอก โดยสมมติว่าเป็น "อัตรา/บาททอง" เสมอ
  // แต่ถ้าผู้ใช้กรอกเป็น "ยอดรวมที่จ่าย" จริงๆ (เช่น จ่าย 2,600 บาทซื้อทอง 1 กรัม) ระบบจะเอา
  // ยอดนั้นไปคูณกับน้ำหนักซ้ำอีกทีตอนคำนวณ (cost = buy_price × weight) ทำให้ต้นทุนที่ใช้คำนวณ
  // เพี้ยนไปมาก (ต่ำเกินจริงหลายสิบเท่า) กำไร % เลยพุ่งเกินจริง (เช่น +2448%) — ตอนนี้ถ้าเลือกโหมด
  // "ยอดรวมที่จ่าย" จะหารด้วยน้ำหนัก (บาททอง) ก่อนเก็บ ให้ buy_price เป็นอัตรา/บาททองเสมอ ตรงกับที่
  // renderGoldTab() คาดหวัง (cost = buy_price × weight ถึงจะตรงกับยอดที่จ่ายจริง)
  const buyRatePerBaht = priceMode === 'total' ? parseFloat((buyPrice / weightBaht).toFixed(2)) : buyPrice;

  const entry = {
    id: 'g' + Date.now(),
    buy_price: buyRatePerBaht,   // THB ต่อ บาททอง (เก็บเป็นอัตราเสมอ ไม่ว่าจะกรอกโหมดไหน)
    weight: weightBaht,    // บาททอง
    weight_gram: weightGram,
    unit: 'baht',
    date, note
  };
  _goldEntries.push(entry);
  await saveGoldToSB(entry);

  ['g_buyPrice', 'g_weight', 'g_note'].forEach(id => document.getElementById(id).value = '');
  showToast('🥇 เพิ่มรายการทองแล้ว');
  renderGoldTab();
}

async function deleteGoldEntry(id) {
  _goldEntries = _goldEntries.filter(e => e.id !== id);
  const { error } = await sb.from('gold_entries').delete().eq('id', id);
  if (error) {
    console.error('[Gold] Supabase delete error:', error);
    localStorage.setItem('gold_entries', JSON.stringify(_goldEntries));
    showToast('⚠️ ลบทองใน Supabase ไม่สำเร็จ: ' + (error.message || error.code), 'var(--red)');
  }
  renderGoldTab();
}

function renderGoldTab() {
  if (GOLD_PRICE_THB <= 0) return;

  // Summary stats
  let totalCost = 0, totalWeight = 0, totalCurrentVal = 0;
  _goldEntries.forEach(e => {
    totalCost       += e.buy_price * e.weight;
    totalWeight     += e.weight;
    totalCurrentVal += GOLD_PRICE_THB * e.weight;
  });
  const totalPL     = totalCurrentVal - totalCost;
  const totalPLPct  = totalCost > 0 ? (totalPL / totalCost * 100) : 0;
  const avgBuyPrice = totalWeight > 0 ? totalCost / totalWeight : 0;

  document.getElementById('goldCards').innerHTML = `
    <div class="card">
      <div class="card-label">⚖️ น้ำหนักรวม</div>
      <div class="card-value">${fmt(totalWeight, 4)} บาท</div>
      <div class="card-sub">≈ ${fmt(totalWeight * GOLD_GRAM_PER_BAHT, 3)} กรัม</div>
    </div>
    <div class="card">
      <div class="card-label">💸 ต้นทุนรวม</div>
      <div class="card-value">฿${fmt(totalCost)}</div>
      <div class="card-sub">avg ฿${fmt(avgBuyPrice, 0)}/บาท</div>
    </div>
    <div class="card">
      <div class="card-label">💰 มูลค่าปัจจุบัน</div>
      <div class="card-value">฿${fmt(totalCurrentVal)}</div>
      <div class="card-sub">@ ฿${fmt(GOLD_PRICE_THB, 0)}/บาท (ราคารับซื้อ)</div>
    </div>
    <div class="card">
      <div class="card-label">📈 กำไร/ขาดทุน</div>
      <div class="card-value ${totalPL >= 0 ? 'green' : 'red'}">${totalPL >= 0 ? '+' : ''}฿${fmt(totalPL)}</div>
      <div class="card-sub ${totalPL >= 0 ? 'green' : 'red'}">${totalPLPct >= 0 ? '+' : ''}${totalPLPct.toFixed(2)}%</div>
    </div>
    <div class="card">
      <div class="card-label">⚖️ avg ราคาซื้อของเรา</div>
      <div class="card-value" style="font-size:1rem">฿${fmt(avgBuyPrice, 0)}<span style="font-size:0.7rem;color:var(--muted)">/บาท</span></div>
      <div class="card-sub ${GOLD_PRICE_THB >= avgBuyPrice ? 'green' : 'red'}">
        ปัจจุบัน ${GOLD_PRICE_THB >= avgBuyPrice ? '▲ สูงกว่า' : '▼ ต่ำกว่า'} ${fmt(Math.abs(GOLD_PRICE_THB - avgBuyPrice), 0)} THB/บาท
      </div>
    </div>
  `;

  // Table rows
  const tbody = document.getElementById('goldBody');
  if (_goldEntries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:24px">ยังไม่มีรายการ — กรอกด้านบนเพื่อเพิ่ม</td></tr>`;
    return;
  }
  tbody.innerHTML = _goldEntries.map((e, i) => {
    const currentVal = GOLD_PRICE_THB * e.weight;
    const cost       = e.buy_price * e.weight;
    const pl         = currentVal - cost;
    const plPct      = cost > 0 ? (pl / cost * 100) : 0;
    return `<tr>
      <td class="mono" style="color:var(--muted)">${i + 1}</td>
      <td class="mono" style="color:var(--muted)">${e.date || '—'}</td>
      <td class="mono">฿${fmt(e.buy_price, 0)}<span style="color:var(--muted);font-size:0.75rem">/บาท</span></td>
      <td class="mono">${fmt(e.weight, 4)} บาท<br><span style="color:var(--muted);font-size:0.75rem">${fmt(e.weight * GOLD_GRAM_PER_BAHT, 3)} g</span></td>
      <td class="mono">฿${fmt(GOLD_PRICE_THB, 0)}<span style="color:var(--muted);font-size:0.75rem">/บาท</span></td>
      <td class="mono ${pl >= 0 ? 'green' : 'red'}">${pl >= 0 ? '+' : ''}฿${fmt(pl, 0)}</td>
      <td class="mono ${plPct >= 0 ? 'green' : 'red'}">${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%</td>
      <td style="color:var(--muted);font-size:0.8rem">${e.note || ''}</td>
      <td><button class="btn-icon del" onclick="deleteGoldEntry('${e.id}')">✕</button></td>
    </tr>`;
  }).join('');
}


// ================================================================
// ==================== BACKUP / RESTORE ==========================
// ================================================================
const BACKUP_TABLES = [
  'stocks', 'price_history', 'chart_drawings', 'price_alerts',
  'wallet_transactions', 'other_assets', 'import_history', 'gold_entries'
];

async function backupAllData() {
  showToast('💾 กำลังรวบรวมข้อมูลทั้งหมด...');
  const backup = {
    _meta: {
      app: 'Portfolio Tracker',
      created_at: new Date().toISOString(),
      tables: BACKUP_TABLES
    }
  };

  try {
    for (const table of BACKUP_TABLES) {
      const { data, error } = await sb.from(table).select('*');
      if (error) {
        console.warn(`[Backup] ตาราง ${table} ดึงไม่สำเร็จ:`, error.message);
        backup[table] = { __error: error.message };
        continue;
      }
      backup[table] = data || [];
    }

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `portfolio-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast('✅ ดาวน์โหลดไฟล์สำรองแล้ว เก็บไว้ให้ดี');
  } catch (e) {
    console.error('[Backup] ล้มเหลว:', e);
    showToast('❌ สำรองข้อมูลไม่สำเร็จ: ' + e.message, 'var(--red)');
  }
}

async function restoreAllData(event) {
  const file = event.target.files[0];
  event.target.value = ''; // reset input ให้เลือกไฟล์เดิมซ้ำได้
  if (!file) return;

  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch (e) {
    showToast('❌ ไฟล์ไม่ใช่ JSON ที่ถูกต้อง', 'var(--red)');
    return;
  }

  const tablesInFile = BACKUP_TABLES.filter(t => Array.isArray(backup[t]));
  if (tablesInFile.length === 0) {
    showToast('❌ ไม่พบข้อมูลที่กู้คืนได้ในไฟล์นี้', 'var(--red)');
    return;
  }

  const totalRows = tablesInFile.reduce((sum, t) => sum + backup[t].length, 0);
  const confirmed = confirm(
    `กู้คืนข้อมูลจากไฟล์สำรอง?\n\n` +
    `พบ ${tablesInFile.length} ตาราง รวม ${totalRows} แถว\n` +
    (backup._meta?.created_at ? `สร้างไฟล์เมื่อ: ${new Date(backup._meta.created_at).toLocaleString('th-TH')}\n\n` : '\n') +
    `⚠️ ข้อมูลปัจจุบันในตารางเหล่านี้จะถูกเขียนทับด้วยข้อมูลในไฟล์ (อัปเสิร์ตตาม id/ticker)\n` +
    `กดตกลงเพื่อดำเนินการต่อ`
  );
  if (!confirmed) return;

  showToast('📥 กำลังกู้คืนข้อมูล...');
  const results = [];

  // ลำดับสำคัญ: stocks ก่อน เพราะตารางอื่นอ้างอิง ticker จาก stocks
  const order = ['stocks', 'price_history', 'chart_drawings', 'price_alerts',
                 'wallet_transactions', 'other_assets', 'import_history', 'gold_entries'];

  for (const table of order) {
    if (!tablesInFile.includes(table)) continue;
    const rows = backup[table];
    if (!rows.length) continue;
    try {
      const conflictKey = table === 'stocks' ? 'ticker'
        : table === 'price_history' ? 'ticker,date'
        : 'id';
      const { error } = await sb.from(table).upsert(rows, { onConflict: conflictKey });
      if (error) throw error;
      results.push(`✅ ${table}: ${rows.length} แถว`);
    } catch (e) {
      console.error(`[Restore] ตาราง ${table} ล้มเหลว:`, e);
      results.push(`❌ ${table}: ${e.message}`);
    }
  }

  console.log('[Restore] สรุปผล:\n' + results.join('\n'));
  showToast('✅ กู้คืนข้อมูลเสร็จแล้ว กำลังโหลดหน้าใหม่...');
  setTimeout(() => location.reload(), 1500);
}


// ================================================================
// ==================== GOLD CALCULATOR ===========================
// ================================================================
function calcGoldRecalc() {
  // ตอนแก้ "ราคาทอง" ให้คำนวณจากช่องที่ผู้ใช้กรอกไว้ล่าสุด (เช็คว่าช่องไหนมีค่าอยู่)
  const amountVal = parseFloat(document.getElementById('gc_amount')?.value);
  const weightVal = parseFloat(document.getElementById('gc_weight')?.value);
  if (weightVal > 0 && !(amountVal > 0)) {
    calcGoldFromWeight();
  } else {
    calcGoldFromAmount();
  }
}

function calcGoldFromAmount() {
  const amount = parseFloat(document.getElementById('gc_amount')?.value);
  const priceInput = parseFloat(document.getElementById('gc_price')?.value);
  const price = priceInput > 0 ? priceInput : GOLD_PRICE_BUY_THB;
  const outEl = document.getElementById('gc_result');
  if (!outEl) return;

  if (!(amount > 0) || !(price > 0)) {
    outEl.innerHTML = `<span style="color:var(--muted)">กรอกจำนวนเงินและราคาทอง (หรือกด "ใช้ราคาปัจจุบัน")</span>`;
    return;
  }

  const baht = amount / price;
  const gram = baht * GOLD_GRAM_PER_BAHT;
  outEl.innerHTML =
    `เงิน <b class="mono">฿${fmt(amount, 0)}</b> ที่ราคาทอง <b class="mono">฿${fmt(price, 0)}</b>/บาท ซื้อได้ ` +
    `<b class="mono green">${fmt(baht, 4)} บาททอง</b> (≈ <b class="mono green">${fmt(gram, 3)} กรัม</b>)`;
}

function calcGoldFromWeight() {
  const weight = parseFloat(document.getElementById('gc_weight')?.value);
  const unit = document.getElementById('gc_weightUnit')?.value || 'baht';
  const priceInput = parseFloat(document.getElementById('gc_price')?.value);
  const price = priceInput > 0 ? priceInput : GOLD_PRICE_BUY_THB;
  const outEl = document.getElementById('gc_result');
  if (!outEl) return;

  if (!(weight > 0) || !(price > 0)) {
    outEl.innerHTML = `<span style="color:var(--muted)">กรอกน้ำหนักและราคาทอง (หรือกด "ใช้ราคาปัจจุบัน")</span>`;
    return;
  }

  const baht = unit === 'gram' ? weight / GOLD_GRAM_PER_BAHT : weight;
  const gram = unit === 'gram' ? weight : weight * GOLD_GRAM_PER_BAHT;
  const totalCost = baht * price;
  outEl.innerHTML =
    `ทอง <b class="mono">${fmt(baht, 4)} บาท</b> (≈ <b class="mono">${fmt(gram, 3)} กรัม</b>) ที่ราคา <b class="mono">฿${fmt(price, 0)}</b>/บาท ใช้เงิน ` +
    `<b class="mono green">฿${fmt(totalCost, 0)}</b>`;
}

function useCurrentGoldPriceInCalc() {
  const el = document.getElementById('gc_price');
  if (!el) return;
  if (GOLD_PRICE_BUY_THB > 0) {
    el.value = GOLD_PRICE_BUY_THB;
    showToast('📡 ใช้ราคาทองปัจจุบัน (รับซื้อ) แล้ว');
  } else {
    showToast('⏳ ยังไม่มีราคาทอง ลองเปิดแท็บออมทองก่อน', 'var(--red)');
  }
  calcGoldRecalc();
}


// ================================================================
// ==================== NEWS & EARNINGS (Finnhub) =================
// ================================================================
const FINNHUB_API_KEY = 'd91ogphr01qnefog34agd91ogphr01qnefog34b0';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

function newsDateStr(d) { return d.toISOString().slice(0, 10); }

function newsTimeAgo(unixSeconds) {
  if (!unixSeconds) return '';
  const diffMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ชม.ที่แล้ว`;
  const days = Math.floor(hrs / 24);
  return `${days} วันที่แล้ว`;
}

// ---- ดึงข้อมูลแบบมี timeout กันหน้าจอค้างถ้าแหล่งข้อมูลตอบช้า/ไม่ตอบเลย ----
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- แปลข่าวเป็นภาษาไทยแบบง่ายๆ ด้วย Google Translate (ฟรี ไม่ต้องใช้ API key) ----
// ใช้ endpoint สาธารณะของ Google ที่เปิด CORS ให้เรียกตรงจากเบราว์เซอร์ได้ ถ้าแปลพลาดจะคืนข้อความเดิม (อังกฤษ) แทน
const _translateCache = new Map();
async function translateToThai(text) {
  if (!text) return text;
  if (_translateCache.has(text)) return _translateCache.get(text);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=th&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetchWithTimeout(url, 6000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const translated = (d?.[0] || []).map(seg => seg[0]).join('') || text;
    _translateCache.set(text, translated);
    return translated;
  } catch (e) {
    _translateCache.set(text, text); // แปลไม่สำเร็จ ใช้ข้อความเดิมแทน ไม่ทำให้ทั้งหน้าพัง
    return text;
  }
}

function renderNewsItems(containerEl, items, emptyMsg) {
  if (!items || items.length === 0) {
    containerEl.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">${emptyMsg}</div>`;
    return;
  }
  containerEl.innerHTML = items.map(n => `
    <a href="${n.url}" target="_blank" rel="noopener" style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);text-decoration:none;color:inherit">
      ${n.image ? `<img src="${n.image}" onerror="this.style.display='none'" style="width:84px;height:60px;object-fit:cover;border-radius:6px;flex-shrink:0">` : ''}
      <div style="min-width:0">
        ${n.ticker ? `<span class="mono" style="font-size:0.7rem;color:var(--accent);background:rgba(127,127,127,0.12);padding:1px 6px;border-radius:4px">${n.ticker}</span>` : ''}
        <div style="font-weight:600;margin-top:4px;line-height:1.35">${n.headline_th || n.headline}</div>
        <div style="color:var(--muted);font-size:0.78rem;margin-top:4px">${n.source || ''} · ${newsTimeAgo(n.datetime)} · 🌐 แปลอัตโนมัติ</div>
      </div>
    </a>
  `).join('');
}

async function fetchHoldingsNews() {
  const el = document.getElementById('newsHoldingsList');
  const tickers = [...new Set(getStocks().map(s => s.ticker))];
  if (tickers.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">ยังไม่มีหุ้นในพอร์ต</div>`;
    return;
  }
  el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">⏳ กำลังโหลดและแปลข่าว...</div>`;

  const to = new Date();
  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000); // ย้อนหลัง 7 วัน
  const fromStr = newsDateStr(from), toStr = newsDateStr(to);

  try {
    const results = await Promise.all(tickers.map(async (ticker) => {
      try {
        const r = await fetchWithTimeout(`${FINNHUB_BASE}/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`);
        if (!r.ok) return [];
        const d = await r.json();
        // เอาแค่ 2 ข่าวล่าสุดต่อหุ้น พอเห็นภาพรวม ไม่ดึงเยอะเกินไป
        return (Array.isArray(d) ? d : []).slice(0, 2).map(n => ({ ...n, ticker }));
      } catch (e) { return []; }
    }));
    // เรียงข่าวล่าสุดก่อน เอาแค่ 15 ข่าวรวม (สำคัญๆ พอ ไม่ดึงมาทั้งหมด)
    const merged = results.flat().sort((a, b) => (b.datetime || 0) - (a.datetime || 0)).slice(0, 15);

    // แปลหัวข้อข่าวเป็นไทยทีละข่าว (จำกัดจำนวนแล้วเลยไม่หนักเกินไป)
    await Promise.all(merged.map(async n => { n.headline_th = await translateToThai(n.headline); }));

    renderNewsItems(el, merged, 'ไม่พบข่าวล่าสุดของหุ้นที่ถือใน 7 วันที่ผ่านมา');
  } catch (e) {
    console.error('[News] holdings news failed:', e);
    el.innerHTML = `<div style="color:var(--red);text-align:center;padding:24px">❌ ดึงข่าวไม่สำเร็จ: ${e.message}</div>`;
  }
}

async function fetchMarketNews() {
  const el = document.getElementById('newsMarketList');
  el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">⏳ กำลังโหลดและแปลข่าว...</div>`;
  try {
    const r = await fetchWithTimeout(`${FINNHUB_BASE}/news?category=general&token=${FINNHUB_API_KEY}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    // เอาแค่ 8 ข่าวสำคัญล่าสุด ไม่ดึงข่าวทั่วไปทั้งหมด
    const items = (Array.isArray(d) ? d : []).slice(0, 8);
    await Promise.all(items.map(async n => { n.headline_th = await translateToThai(n.headline); }));
    renderNewsItems(el, items, 'ไม่พบข่าวภาพรวมตลาดในขณะนี้');
  } catch (e) {
    console.error('[News] market news failed:', e);
    el.innerHTML = `<div style="color:var(--red);text-align:center;padding:24px">❌ ดึงข่าวไม่สำเร็จ: ${e.message}</div>`;
  }
}

async function fetchEarningsCalendar() {
  const el = document.getElementById('earningsCalendarList');
  const tickers = [...new Set(getStocks().map(s => s.ticker))];
  if (tickers.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">ยังไม่มีหุ้นในพอร์ต</div>`;
    return;
  }
  el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">⏳ กำลังโหลดปฏิทิน...</div>`;

  // หมายเหตุ: เรียก endpoint นี้แบบระบุ symbol ทีละตัว (ไม่ใช่ดึงปฏิทินรวมทั้งตลาดมา filter)
  // เพราะ Finnhub free tier เวลาดึงปฏิทินรวมทั้งตลาดจะไม่ค่อยครอบคลุมหุ้นเล็ก/หุ้นที่ยังไม่มี estimate
  // แต่ถ้าระบุ &symbol=TICKER ตรงๆ จะได้ข้อมูลของหุ้นตัวนั้นครบกว่ามาก (ยืนยันจาก doc/ตัวอย่างการใช้งานจริงของ Finnhub)
  const from = new Date(Date.now() - 14 * 24 * 3600 * 1000);   // ย้อนหลัง 14 วัน เผื่อเพิ่งประกาศไปไม่นาน
  const to = new Date(Date.now() + 200 * 24 * 3600 * 1000);    // มองล่วงหน้า 200 วัน (ครอบคลุมเกินกว่า 1 ไตรมาส)
  const fromStr = newsDateStr(from), toStr = newsDateStr(to);

  try {
    const results = await Promise.all(tickers.map(async (ticker) => {
      try {
        const r = await fetchWithTimeout(`${FINNHUB_BASE}/calendar/earnings?from=${fromStr}&to=${toStr}&symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_API_KEY}`);
        if (!r.ok) return [];
        const d = await r.json();
        return (d.earningsCalendar || []);
      } catch (e) { return []; }
    }));

    let all = results.flat();
    // ต่อตัวอาจมีหลายแถว (ทั้งที่ประกาศไปแล้วและที่ยังไม่ประกาศ) — เอาเฉพาะแถวที่ใกล้วันนี้ที่สุดต่อ 1 ticker
    const today = newsDateStr(new Date());
    const byTicker = {};
    all.forEach(e => {
      if (!byTicker[e.symbol] || Math.abs(new Date(e.date) - new Date(today)) < Math.abs(new Date(byTicker[e.symbol].date) - new Date(today))) {
        byTicker[e.symbol] = e;
      }
    });
    all = Object.values(byTicker).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    if (all.length === 0) {
      el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:24px">ไม่พบกำหนดการประกาศผลประกอบการของหุ้นที่ถือในช่วงนี้ (Finnhub free tier อาจยังไม่มี estimate ของบางตัว)</div>`;
      return;
    }

    el.innerHTML = `<table><thead><tr>
        <th>วันที่ประกาศ</th><th>หุ้น</th><th>ช่วงเวลา</th><th>EPS คาดการณ์</th><th>รายได้คาดการณ์</th>
      </tr></thead><tbody>` +
      all.map(e => {
        const hourLabel = { bmo: '🌅 ก่อนตลาดเปิด', amc: '🌙 หลังตลาดปิด', dmh: '🕐 ระหว่างวัน' }[e.hour] || (e.hour || '—');
        const isPast = e.date && e.date < today;
        return `<tr style="${isPast ? 'opacity:0.5' : ''}">
          <td class="mono">${e.date || '—'}${isPast ? ' (ประกาศแล้ว)' : ''}</td>
          <td class="mono" style="font-weight:700">${e.symbol}</td>
          <td>${hourLabel}</td>
          <td class="mono">${e.epsEstimate != null ? e.epsEstimate : '—'}</td>
          <td class="mono">${e.revenueEstimate != null ? fmt(e.revenueEstimate, 0) : '—'}</td>
        </tr>`;
      }).join('') + `</tbody></table>` +
      (tickers.length > all.length ? `<div style="color:var(--muted);font-size:0.78rem;padding:12px 4px 0">⚠️ พบข้อมูลของ ${all.length}/${tickers.length} ตัว ตัวที่เหลือ Finnhub ยังไม่มี estimate วันประกาศให้ในช่วงนี้</div>` : '');
  } catch (e) {
    console.error('[News] earnings calendar failed:', e);
    el.innerHTML = `<div style="color:var(--red);text-align:center;padding:24px">❌ ดึงปฏิทินไม่สำเร็จ: ${e.message}</div>`;
  }
}

function switchNewsSub(name) {
  ['holdings', 'market', 'calendar'].forEach(n => {
    document.getElementById('newsSub_' + n).style.display = (n === name) ? '' : 'none';
    document.getElementById('newsSubBtn_' + n).classList.toggle('active', n === name);
  });
}

let _newsTabLoaded = false;
function initNewsTab() {
  if (_newsTabLoaded) return; // โหลดครั้งแรกพอ ไม่ดึงซ้ำทุกครั้งที่สลับแท็บ (กด 🔄 เพื่อรีเฟรชเอง)
  _newsTabLoaded = true;
  fetchHoldingsNews();
  fetchMarketNews();
  fetchEarningsCalendar();
}

function refreshNewsTab() {
  fetchHoldingsNews();
  fetchMarketNews();
  fetchEarningsCalendar();
}


// ================================================================
// ==================== FEAR & GREED (VIX-based) ===================
// ================================================================
function fgScoreFromVix(vix) {
  // VIX ~10 ถือว่าตลาดสงบมาก (โลภสุดขีด) ถึง ~40 ถือว่าตลาดตื่นตระหนก (กลัวสุดขีด)
  // map กลับด้าน: VIX สูง -> score ต่ำ (กลัว), VIX ต่ำ -> score สูง (โลภ)
  const lo = 10, hi = 40;
  const clamped = Math.min(hi, Math.max(lo, vix));
  const pct = (clamped - lo) / (hi - lo); // 0 (สงบ) .. 1 (ตื่นตระหนก)
  return Math.round((1 - pct) * 100);
}

function fgLabel(score) {
  if (score >= 75) return { text: 'โลภสุดขีด (Extreme Greed)', emoji: '🤑', color: '#16a085' };
  if (score >= 55) return { text: 'โลภ (Greed)', emoji: '🙂', color: '#2ecc71' };
  if (score >= 45) return { text: 'กลาง ๆ (Neutral)', emoji: '😐', color: '#f1c40f' };
  if (score >= 25) return { text: 'กลัว (Fear)', emoji: '😟', color: '#e67e22' };
  return { text: 'กลัวสุดขีด (Extreme Fear)', emoji: '😱', color: '#c0392b' };
}

async function fetchVixFearGreed() {
  const metaEl = document.getElementById('fgMeta');
  metaEl.textContent = '⏳ กำลังโหลดข้อมูล VIX...';

  let vix = null, change = null, source = '';

  // หมายเหตุ: Finnhub free tier ไม่รองรับ symbol ดัชนีอย่าง ^VIX (ทดสอบแล้วได้ "Symbol not supported")
  // เลยใช้ Yahoo Finance เป็นแหล่งหลักโดยตรง ผ่าน CORS proxy เดียวกับที่ใช้ดึงราคาทอง/อัตราแลกเปลี่ยนอยู่แล้ว
  const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX';
  const attempts = [
    { url: YAHOO_URL, label: 'Yahoo Finance' },
    { url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(YAHOO_URL), label: 'Yahoo Finance (ผ่าน CORS proxy)' },
    { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(YAHOO_URL), label: 'Yahoo Finance (ผ่าน CORS proxy สำรอง)' },
  ];
  for (const src of attempts) {
    try {
      const r = await fetchWithTimeout(src.url, 7000);
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice > 0) {
        vix = meta.regularMarketPrice;
        change = meta.regularMarketPrice - (meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice);
        source = src.label;
        break;
      }
    } catch (e) { console.warn(`[FearGreed] ${src.label} failed:`, e.message); }
  }

  if (vix === null) {
    // ---- 3) ใช้ค่าที่เคยดึงได้ล่าสุดจาก localStorage ----
    try {
      const cached = JSON.parse(localStorage.getItem('vix_cache') || 'null');
      if (cached?.vix > 0) {
        vix = cached.vix; change = cached.change || 0;
        source = '📦 ค่าล่าสุดที่เคยดึงได้ (ดึงสดไม่สำเร็จตอนนี้)';
      }
    } catch (e) {}
  }

  if (vix === null) {
    metaEl.textContent = '❌ ดึงข้อมูล VIX ไม่สำเร็จ ลองกด 🔄 อีกครั้ง';
    return;
  }

  try { localStorage.setItem('vix_cache', JSON.stringify({ vix, change })); } catch (e) {}

  const score = fgScoreFromVix(vix);
  const lbl = fgLabel(score);

  metaEl.textContent = `📡 แหล่งข้อมูล: ${source} · อัปเดต ${new Date().toLocaleString('th-TH')}`;
  document.getElementById('fgPointer').style.left = score + '%';
  document.getElementById('fgScoreLabel').textContent = `${lbl.emoji} ${score}`;
  document.getElementById('fgScoreLabel').style.color = lbl.color;
  document.getElementById('fgScoreText').textContent = lbl.text;
  document.getElementById('fgVixVal').textContent = vix.toFixed(2);
  const changeEl = document.getElementById('fgVixChange');
  changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2);
  changeEl.style.color = change >= 0 ? 'var(--red)' : 'var(--green, #2ecc71)'; // VIX ขึ้น = ตลาดกลัวมากขึ้น เลยใช้สีแดง
}

// ===== AUTO-FIT CARD VALUE TEXT =====
// แทนที่จะตัดตัวเลขด้วย "..." เมื่อล้นกล่อง (card-value) ให้ลดขนาดฟอนต์ลงอัตโนมัติ
// จนพอดีกับพื้นที่ที่มี แล้วค่อยแสดงตัวเลขแบบเต็มๆ
(function () {
  function fitOne(el) {
    if (!el || !el.isConnected) return;
    // เก็บขนาดฟอนต์ตั้งต้น (จาก CSS หรือ inline style) ไว้ครั้งแรกที่เจอ element นี้
    if (!el.dataset.baseFontPx) {
      const cs = window.getComputedStyle(el);
      el.dataset.baseFontPx = parseFloat(cs.fontSize);
    }
    const base = parseFloat(el.dataset.baseFontPx);
    const min = Math.max(base * 0.45, 10); // ไม่ให้เล็กเกินไปจนอ่านไม่ออก
    let size = base;
    el.style.fontSize = size + 'px';
    let guard = 0;
    while (el.scrollWidth > el.clientWidth + 0.5 && size > min && guard < 60) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
      guard++;
    }
  }

  function fitAllCardValues() {
    document.querySelectorAll('.card-value').forEach(fitOne);
  }

  let rafId = null;
  function scheduleFit() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      fitAllCardValues();
    });
  }

  const mo = new MutationObserver(scheduleFit);
  document.addEventListener('DOMContentLoaded', () => {
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleFit();
  });
  window.addEventListener('resize', scheduleFit);
  window.__fitAllCardValues = fitAllCardValues;
})();
