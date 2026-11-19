'use strict';
const $ = s => document.querySelector(s);
const el = (t, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(t), props);
  kids.flat().forEach(k => n.append(k));
  return n;
};
const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const PALETTE = ['#3b82f6', '#f97316', '#10b981', '#ec4899', '#eab308', '#8b5cf6', '#06b6d4', '#ef4444',
  '#84cc16', '#a855f7', '#14b8a6', '#f43f5e', '#64748b', '#78716c', '#22c55e', '#0ea5e9'];

let S = ls.get('settings', { url: '', token: '', cur: '₽' });
let data = ls.get('data', []);
let cats = ls.get('cats', { expense: ['Прочее'], income: ['Другие доходы'] });
let month = ym(new Date());
let filterCat = null;
let pending = [];

function ym(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
const fmt = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ' + S.cur;
const allCats = () => [...cats.expense, ...cats.income];
const colorOf = c => PALETTE[Math.max(0, allCats().indexOf(c)) % PALETTE.length];

// ---------- API ----------
async function api(payload) {
  if (!S.url || !S.token) throw new Error('Укажите URL и токен в настройках');
  const r = await fetch(S.url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // без preflight
    body: JSON.stringify({ ...payload, token: S.token }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
}

async function refresh() {
  const j = await api({ action: 'list' });
  data = j.rows; cats = { expense: j.expense, income: j.income };
  ls.set('data', data); ls.set('cats', cats);
  renderAll();
}

// ---------- views ----------
function show(v) {
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== 'v-' + v);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.v));

const inMonth = () => data.filter(r => r.date.startsWith(month));

function renderOverview() {
  const [y, m] = month.split('-').map(Number);
  $('#month-title').textContent = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/^./, c => c.toUpperCase()).replace(/ г\.$/, '');
  const rows = inMonth();
  const exp = rows.filter(r => r.type === 'expense'), inc = rows.filter(r => r.type === 'income');
  const se = exp.reduce((a, r) => a + r.amount, 0), si = inc.reduce((a, r) => a + r.amount, 0);
  $('#sum-exp').textContent = fmt(se); $('#sum-inc').textContent = fmt(si);
  const bal = $('#sum-bal'); bal.textContent = fmt(si - se); bal.style.color = si - se < 0 ? 'var(--neg)' : 'var(--pos)';

  const by = {};
  exp.forEach(r => by[r.category] = (by[r.category] || 0) + r.amount);
  const list = Object.entries(by).sort((a, b) => b[1] - a[1]);
  drawDonut(list, se);

  const lg = $('#legend'); lg.replaceChildren();
  list.forEach(([c, v]) => lg.append(el('li', { onclick: () => { filterCat = c; renderOps(); show('ops'); } },
    el('span', { className: 'dot', style: 'background:' + colorOf(c) }),
    el('span', {}, c, el('small', {}, Math.round(v / se * 100) + '%')),
    el('span', { className: 'amt' }, fmt(v)))));
  drawBars(exp, y, m);
}

function drawDonut(list, total) {
  const box = $('#donut');
  if (!total) { box.replaceChildren(el('div', { className: 'empty' }, 'Нет расходов за месяц')); return; }
  const R = 70, C = 2 * Math.PI * R, GAP = list.length > 1 ? 2 : 0;
  let off = 0, parts = '';
  list.forEach(([c, v]) => {
    const len = v / total * C;
    parts += `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${colorOf(c)}" stroke-width="28"
      stroke-dasharray="${Math.max(len - GAP, 0.5)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"/>`;
    off += len;
  });
  box.innerHTML = `<svg viewBox="0 0 200 200" role="img" aria-label="Расходы по категориям">${parts}
    <text x="100" y="96" text-anchor="middle" font-size="11" fill="currentColor" opacity=".6">Расходы</text>
    <text x="100" y="116" text-anchor="middle" font-size="16" font-weight="700" fill="currentColor">${fmt(total)}</text></svg>`;
}

function drawBars(exp, y, m) {
  const days = new Date(y, m, 0).getDate(), v = Array(days).fill(0);
  exp.forEach(r => v[Number(r.date.slice(8, 10)) - 1] += r.amount);
  const max = Math.max(...v, 1), W = 300, H = 90, bw = W / days;
  let s = '';
  v.forEach((x, i) => {
    const h = x / max * H;
    if (x) s += `<rect x="${i * bw + 1}" y="${H - h}" width="${Math.max(bw - 2, 1)}" height="${h}" rx="2" fill="var(--accent)"/>`;
  });
  $('#bars').innerHTML = `<svg viewBox="0 0 ${W} ${H + 16}" width="100%">${s}
    <line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="var(--line)"/>
    <text x="0" y="${H + 12}" font-size="9" fill="currentColor" opacity=".6">1</text>
    <text x="${W}" y="${H + 12}" font-size="9" text-anchor="end" fill="currentColor" opacity=".6">${days}</text></svg>`;
}

function renderOps() {
  const rows = inMonth().filter(r => !filterCat || r.category === filterCat)
    .sort((a, b) => b.date.localeCompare(a.date));
  const chip = $('#clear-filter');
  chip.hidden = !filterCat; chip.textContent = filterCat ? filterCat + ' ✕' : '';
  chip.onclick = () => { filterCat = null; renderOps(); };
  const box = $('#ops'); box.replaceChildren();
  if (!rows.length) { box.append(el('div', { className: 'empty' }, 'Нет операций')); return; }
  let last = '';
  rows.forEach(r => {
    if (r.date !== last) {
      last = r.date;
      const [y, m, d] = r.date.split('-').map(Number);
      box.append(el('div', { className: 'day' }, new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })));
    }
    box.append(el('div', { className: 'op' },
      el('span', { className: 'dot', style: 'background:' + colorOf(r.category) }),
      el('div', { className: 'd' }, r.description || r.category, el('small', {}, r.category)),
      el('div', { className: 'a' + (r.type === 'income' ? ' inc' : '') }, (r.type === 'income' ? '+' : '−') + fmt(r.amount)),
      el('button', { className: 'x', 'aria-label': 'Удалить', onclick: () => del(r) }, '✕')));
  });
}

async function del(r) {
  if (!confirm(`Удалить «${r.description || r.category}» ${fmt(r.amount)}?`)) return;
  data = data.filter(x => x.id !== r.id); ls.set('data', data); renderAll();
  try { await api({ action: 'delete', id: r.id }); } catch (e) { alert(e.message); refresh().catch(() => {}); }
}

// ---------- add / review ----------
const status = (t, err) => { const s = $('#status'); s.textContent = t; s.className = 'status' + (err ? ' err' : ''); };

async function prep(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = el('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}

$('#file').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  let added = 0, dups = 0;
  for (let i = 0; i < files.length; i++) {
    status(`Распознаю ${i + 1} из ${files.length}…`);
    try {
      const j = await api({ action: 'parse', image: await prep(files[i]), mediaType: 'image/jpeg' });
      j.rows.forEach(r => {
        if (pending.some(p => p.id === r.id)) return;
        pending.push({ ...r, include: !r.dup }); added++; if (r.dup) dups++;
      });
    } catch (err) { status(`Скриншот ${i + 1}: ${err.message}`, true); renderReview(); return; }
  }
  status(`Найдено операций: ${added}` + (dups ? `, уже в таблице: ${dups} (отключены)` : '') + '. Проверьте и сохраните.');
  renderReview();
};

$('#manual').onclick = () => {
  const d = new Date();
  pending.push({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
    amount: '', type: 'expense', category: cats.expense[cats.expense.length - 1], description: '', include: true });
  renderReview();
};

function renderReview() {
  const box = $('#review'); box.replaceChildren();
  pending.forEach(r => {
    const sel = el('select', { onchange: () => r.category = sel.value });
    const fill = () => {
      sel.replaceChildren(...(r.type === 'income' ? cats.income : cats.expense).map(c => el('option', { value: c, selected: c === r.category }, c)));
      r.category = sel.value;
    };
    fill();
    const type = el('select', { onchange: () => { r.type = type.value; fill(); } },
      el('option', { value: 'expense', selected: r.type === 'expense' }, 'Расход'),
      el('option', { value: 'income', selected: r.type === 'income' }, 'Доход'));
    const row = el('div', { className: 'rv' + (r.include ? '' : ' off') },
      el('input', { type: 'checkbox', checked: r.include, onchange: e => { r.include = e.target.checked; row.classList.toggle('off', !r.include); } }),
      el('input', { type: 'date', value: r.date, onchange: e => r.date = e.target.value }),
      el('input', { type: 'number', inputMode: 'decimal', step: '0.01', placeholder: 'Сумма', value: r.amount, oninput: e => r.amount = e.target.value }),
      el('input', { className: 'full', placeholder: 'Описание', value: r.description, oninput: e => r.description = e.target.value }),
      type, sel);
    type.className = ''; row.children[row.children.length - 2].style.gridColumn = '2';
    if (r.dup) row.prepend(el('div', { className: 'tag' }, 'Уже есть в таблице'));
    box.append(row);
  });
  $('#save').hidden = !pending.length;
}

$('#save').onclick = async () => {
  const rows = pending.filter(r => r.include && Number(r.amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .map(r => ({ ...r, amount: Number(r.amount) }));
  if (!rows.length) return status('Нечего сохранять: проверьте дату и сумму', true);
  const btn = $('#save'); btn.disabled = true; status('Сохраняю…');
  try {
    const j = await api({ action: 'add', rows });
    pending = []; renderReview(); status(`Сохранено: ${j.added}`);
    await refresh();
  } catch (e) { status(e.message, true); }
  btn.disabled = false;
};

// ---------- settings ----------
$('#s-url').value = S.url; $('#s-token').value = S.token; $('#s-cur').value = S.cur;
$('#s-save').onclick = async () => {
  S = { url: $('#s-url').value.trim(), token: $('#s-token').value.trim(), cur: $('#s-cur').value.trim() || '₽' };
  ls.set('settings', S);
  const m = $('#s-msg'); m.className = 'status'; m.textContent = 'Проверяю…';
  try { await refresh(); m.textContent = 'Подключено ✓'; show('overview'); }
  catch (e) { m.className = 'status err'; m.textContent = e.message; }
};

$('#prev').onclick = () => shift(-1);
$('#next').onclick = () => shift(1);
function shift(d) {
  const [y, m] = month.split('-').map(Number);
  month = ym(new Date(y, m - 1 + d, 1)); filterCat = null; renderAll();
}

function renderAll() { renderOverview(); renderOps(); }

renderAll();
if (!S.url) show('settings'); else refresh().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
