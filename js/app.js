/* 扶養チェッカー 画面処理 */
(function () {
  'use strict';
  const C = window.FuyouCalc;
  const RULES = window.FuyouRules;
  const KEY = 'fuyou-checker:v1';
  const APP_VERSION = '1.4.0'; // index.html の data-app-version と ?v= も一緒に上げる
  const JOB_COLORS = ['#2f7d6d', '#d9822b', '#5b6abf', '#c2477a', '#7a8b2f', '#3a8fb7'];

  // ---------- 状態 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultYear = RULES.RULES[now.getFullYear()] ? now.getFullYear() : Math.max(...RULES.years);

  function defaultState() {
    return {
      version: 1,
      settings: { year: defaultYear, birthDate: '', dependentType: 'parent', juminKyuchi: 1, isStudent: false, isSenior: false, otherIncome: 0, contractAnnual: '', useManualProjection: false, plannedExtra: '' },
      jobs: [],
      payments: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    } catch (e) {
      return defaultState();
    }
  }
  let state = load();

  /** 保存して、本当に書き込めたか読み戻して確認する。成功なら true */
  function save() {
    try {
      const json = JSON.stringify(state);
      localStorage.setItem(KEY, json);
      if (localStorage.getItem(KEY) !== json) throw new Error('verify');
      if (typeof scheduleAutoSync === 'function') scheduleAutoSync();
      return true;
    } catch (e) {
      toast('保存できませんでした。プライベートブラウズ／容量不足の可能性があります。バックアップを書き出してください', 'error');
      return false;
    }
  }

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  // ---------- 小物 ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => (n == null || isNaN(n) ? '-' : Math.round(n).toLocaleString('ja-JP') + '円');
  const man = (n) => {
    const v = n / 10000;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + '万円';
  };
  /** 画面上部に通知を出す。type: 'ok' | 'error' | 'info' */
  function toast(msg, type = 'info') {
    const t = $('#toast');
    t.textContent = (type === 'ok' ? '✓ ' : type === 'error' ? '⚠ ' : '') + msg;
    t.className = 'toast show ' + type;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), type === 'error' ? 6000 : 4000);
  }
  /** ボタンの横に「保存しました」を残す（消えない） */
  function setStatus(id, msg, type = 'ok') {
    const el = $('#' + id);
    if (!el) return;
    const d = new Date();
    el.textContent = `${type === 'ok' ? '✓' : '⚠'} ${msg}（${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}）`;
    el.className = 'save-status ' + type;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  let highlightId = null;
  const jobColor = (id) => JOB_COLORS[Math.max(0, state.jobs.findIndex((j) => j.id === id)) % JOB_COLORS.length];

  // ---------- タブ ----------
  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  function showTab(name) {
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- 年の選択 ----------
  const yearSelect = $('#yearSelect');
  yearSelect.innerHTML = RULES.years.map((y) => `<option value="${y}">${y}年</option>`).join('');
  yearSelect.addEventListener('change', () => { state.settings.year = Number(yearSelect.value); save(); renderAll(); });

  // ---------- ダッシュボード ----------
  const STATUS = {
    ok: { label: 'セーフ', cls: 'ok' },
    near: { label: 'もうすぐ', cls: 'near' },
    warn: { label: 'このままだと超える', cls: 'warn' },
    over: { label: '超えた', cls: 'over' },
  };

  function renderDashboard(s) {
    const hasData = state.jobs.length > 0 && state.payments.length > 0;
    const ob = $('#onboarding');
    if (!hasData) {
      ob.classList.remove('hidden');
      ob.innerHTML = `
        <h2>はじめかた</h2>
        <ol class="steps">
          <li class="${state.settings.birthDate ? 'done' : ''}"><button class="link" data-go="settings">自分の情報</button>で生年月日と「だれの扶養か」を入力</li>
          <li class="${state.jobs.length ? 'done' : ''}"><button class="link" data-go="jobs">バイト先</button>を登録（掛け持ちなら全部）</li>
          <li class="${state.payments.length ? 'done' : ''}"><button class="link" data-go="payments">給料の記録</button>に給与明細の金額を入力</li>
        </ol>
        <p class="muted small">まず触ってみたいなら、<button class="link" id="obSample">サンプルデータ</button>を入れてみてください。</p>`;
      $$('[data-go]', ob).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
      $('#obSample', ob).addEventListener('click', loadSample);
    } else {
      ob.classList.add('hidden');
    }

    // 上部の数字
    const nextWall = s.walls.filter((w) => !w.info && w.status !== 'over').sort((a, b) => a.limit - b.limit)[0];
    $('#stats').innerHTML = `
      <div class="stat"><span class="stat-label">${s.year}年にもらった額</span><span class="stat-value">${yen(s.ytd.gross)}</span><span class="stat-sub">通勤手当 ${yen(s.ytd.commute)} は別</span></div>
      <div class="stat"><span class="stat-label">年末の見込み</span><span class="stat-value">${yen(s.projected)}</span><span class="stat-sub">${s.settings.useManualProjection ? '自分で入力した予定から' : s.remainingMonths ? `直近の平均 ${yen(s.avgMonthly)}/月 × 残り${s.remainingMonths}か月` : 'この年は確定'}</span></div>
      <div class="stat ${nextWall ? STATUS[nextWall.status].cls : ''}"><span class="stat-label">次の壁まで</span><span class="stat-value">${nextWall ? yen(nextWall.remaining) : '—'}</span><span class="stat-sub">${nextWall ? `${esc(nextWall.label)}（${man(nextWall.limit)}）${nextWall.perMonth != null ? `／残り月あたり ${yen(nextWall.perMonth)}` : ''}` : 'すべての壁を超えています'}</span></div>
      <div class="stat"><span class="stat-label">引かれた所得税</span><span class="stat-value">${yen(s.ytd.withholding)}</span><span class="stat-sub">${s.tax.refund > 0 ? `約${yen(s.tax.refund)} 戻る可能性` : '今年の税額の見込み ' + yen(s.tax.projected.tax)}</span></div>`;

    $('#projectionNote').textContent = s.age != null ? `${s.year}年12月31日時点で${s.age}歳として判定` : '生年月日を入れると年齢に合わせて判定します';

    renderWallBar(s);

    $('#walls').innerHTML = s.walls.map((w) => {
      const st = w.info ? { label: w.status === 'ok' || w.status === 'near' ? '情報' : '切替あり', cls: 'info' } : STATUS[w.status];
      return `<div class="wall ${st.cls}">
        <div class="wall-amount">${man(w.limit)}<small>${w.inclusive ? '以下ならOK' : '未満ならOK'}</small></div>
        <div class="wall-body">
          <div class="wall-title">${esc(w.label)} <span class="who">${esc(w.who)}に影響</span></div>
          <div class="wall-desc">超えると：${esc(w.over)}</div>
          ${w.status !== 'over' && !w.info ? `<div class="wall-rest">あと <strong>${yen(w.remaining)}</strong>${w.perMonth != null ? `（残り${s.remainingMonths}か月なら 月 ${yen(w.perMonth)} まで）` : ''}</div>` : ''}
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>`;
    }).join('');

    renderShaho(s);
    renderTax(s);
    renderAdvice(s);
    renderMonths(s);
  }

  function renderWallBar(s) {
    const limits = s.walls.map((w) => w.limit);
    if (s.shaho && !s.shaho.ownShaho) limits.push(s.shaho.limit);
    const max = Math.max(...limits, s.projected) * 1.08;
    const pct = (v) => Math.min(100, (v / max) * 100);
    const marks = s.walls.map((w) => ({ v: w.limit, label: man(w.limit), cls: w.info ? 'info' : '' }));
    if (s.shaho && !s.shaho.ownShaho) marks.push({ v: s.shaho.limit, label: `社保${man(s.shaho.limit)}`, cls: 'shaho' });
    marks.sort((a, b) => a.v - b.v);
    $('#wallBar').innerHTML = `
      <div class="bar">
        <div class="bar-proj" style="width:${pct(s.projected)}%"></div>
        <div class="bar-fill" style="width:${pct(s.ytd.gross)}%"></div>
        ${marks.map((m, i) => `<div class="bar-mark ${m.cls} ${i % 2 ? 'low' : ''}" style="left:${pct(m.v)}%"><span>${esc(m.label)}</span></div>`).join('')}
      </div>
      <div class="bar-legend"><span><i class="sw fill"></i>もらった額 ${yen(s.ytd.gross)}</span><span><i class="sw proj"></i>年末の見込み ${yen(s.projected)}</span></div>`;
  }

  function renderShaho(s) {
    const el = $('#shaho');
    if (!s.shaho) {
      el.innerHTML = '<p class="muted">扶養に入っていない設定です。勤務先の社会保険の加入条件だけ下に表示します。</p>' + jobChecksHtml(s);
      return;
    }
    const sh = s.shaho;
    const statusTxt = (st) => ({ ok: '<span class="badge ok">セーフ</span>', near: '<span class="badge near">近い</span>', over: '<span class="badge over">超える</span>', unknown: '<span class="badge info">未入力</span>' }[st]);
    el.innerHTML = `
      ${sh.ownShaho ? '<div class="note warn">勤務先の社会保険に入る条件を満たしているため、扶養（健康保険）からは外れる見込みです。</div>' : ''}
      <p>扶養に入れるのは <strong>年収${man(sh.limit)}未満</strong>（月 約${yen(sh.monthlyLimit)} 未満）の見込みのとき。<br><span class="muted small">税金と違い、<strong>通勤手当を含み</strong>、1〜12月ではなく「これから1年の見込み」で判定します。</span></p>
      <table class="mini">
        <tr><th>契約上の見込み年収</th><td>${sh.contractAnnual ? yen(sh.contractAnnual) : '<span class="muted">バイト先に契約月収を入れると表示</span>'}</td><td>${statusTxt(sh.statusContract)}</td></tr>
        <tr><th>最近のペース ×12</th><td>${yen(sh.paceAnnual)}</td><td>${statusTxt(sh.statusPace)}</td></tr>
      </table>
      ${sh.overMonths.length ? `<p class="small">月の目安を超えた月：${sh.overMonths.map((m) => m + '月').join('、')}<br><span class="muted">一時的なら、勤務先の「一時的な収入増加」の証明で扶養に残れる場合があります。</span></p>` : ''}
      <h3>勤務先で社会保険に入る条件</h3>
      ${jobChecksHtml(s)}`;
  }

  function jobChecksHtml(s) {
    if (!s.jobChecks.length) return '<p class="muted small">バイト先が未登録です。</p>';
    return '<ul class="jobchecks">' + s.jobChecks.map((c) => `
      <li><span class="dot" style="background:${jobColor(c.job.id)}"></span><strong>${esc(c.job.name)}</strong>
        ${c.covered ? '<span class="badge warn">加入対象</span>' : '<span class="badge ok">対象外</span>'}
        <div class="muted small">${c.reasons.map(esc).join(' / ')}</div></li>`).join('') +
      '</ul><p class="muted small">2026年10月から月8.8万円（106万円の壁）の条件はなくなり、「週20時間以上」が目安になりました。掛け持ちの時間は合算しません。</p>';
  }

  function renderTax(s) {
    const t = s.tax;
    const pd = s.parentDeduction;
    $('#taxBox').innerHTML = `
      <table class="mini">
        <tr><th>今年の所得税（見込み）</th><td>${yen(t.projected.tax)}</td></tr>
        <tr><th>ここまでの源泉徴収の合計</th><td>${yen(s.ytd.withholding)}</td></tr>
        <tr><th>給与所得（＝年収−${man(s.rules.kyuyoMin)}）</th><td>${yen(t.projected.kyuyoShotoku)}</td></tr>
        ${pd ? `<tr><th>親が受けられる控除</th><td>${esc(pd.name)}${pd.amount ? `（${man(pd.amount)}）` : ''}</td></tr>` : ''}
      </table>
      <h3>バイト先ごと</h3>
      <ul class="jobchecks">${state.jobs.map((j) => {
        const b = s.byJob[j.id] || { gross: 0, withholding: 0 };
        return `<li><span class="dot" style="background:${jobColor(j.id)}"></span><strong>${esc(j.name)}</strong> <span class="badge ${j.taxColumn === 'kou' ? 'ok' : 'info'}">${j.taxColumn === 'kou' ? '甲欄' : '乙欄'}</span>
          <div class="small">支給 ${yen(b.gross)} ／ 源泉 ${yen(b.withholding)}</div></li>`;
      }).join('') || '<li class="muted small">バイト先が未登録です。</li>'}</ul>`;
  }

  function renderAdvice(s) {
    const items = [...s.advice];
    const overs = s.walls.filter((w) => !w.info && (w.status === 'warn' || w.status === 'over'));
    for (const w of overs) {
      items.unshift({ level: w.status === 'over' ? 'danger' : 'warn', title: `${w.label}（${man(w.limit)}）${w.status === 'over' ? 'を超えました' : 'を超えそうです'}`,
        body: w.who === '親' || w.who === '配偶者' ? `${w.who}に伝えておきましょう。${w.who}の年末調整で申告する内容が変わります。` : w.over });
    }
    for (const miss of missingPays(s.year)) {
      items.push({ level: 'warn', title: `記録し忘れ？ ${miss.job.name}の給料`, body: `${miss.dates.map(fmtDay).join('、')} の支給が記録されていません。給与明細を見て「給料の記録」から入力しましょう（働いていない月なら無視してOK）。` });
    }
    for (const pw of s.paymentWarnings.slice(0, 3)) {
      items.push({ level: pw.level, title: `${pw.payDate} ${pw.jobName} の源泉徴収`, body: pw.msg });
    }
    if (!items.length) items.push({ level: 'good', title: '今のところ問題なし', body: 'このペースなら扶養の範囲内です。シフトが増えたら記録してまた確認しましょう。' });
    $('#advice').innerHTML = items.map((a) => `<div class="advice ${a.level}"><div class="advice-title">${esc(a.title)}</div><div class="advice-body">${esc(a.body)}</div></div>`).join('');
  }

  function renderMonths(s) {
    const max = Math.max(...s.months.map((m) => m.gross + m.commute), s.shaho ? s.shaho.monthlyLimit : 0, 1) * 1.1;
    const line = s.shaho && !s.shaho.ownShaho ? s.shaho.monthlyLimit : null;
    $('#monthChart').innerHTML = `
      <div class="mplot">
        ${line ? `<div class="mline" style="bottom:${(line / max) * 100}%"><span>社保の目安 月${yen(line)}</span></div>` : ''}
        ${s.months.map((m) => {
          const segs = Object.entries(m.byJob).map(([jid, g]) => `<div class="seg" style="height:${(g / max) * 100}%;background:${jobColor(jid)}" title="${esc(state.jobs.find((j) => j.id === jid)?.name || '')} ${yen(g)}"></div>`).join('');
          const com = m.commute ? `<div class="seg commute" style="height:${(m.commute / max) * 100}%" title="通勤手当 ${yen(m.commute)}"></div>` : '';
          return `<div class="mstack">${segs}${com}</div>`;
        }).join('')}
      </div>
      <div class="mlabels">${s.months.map((m) => `<div><div class="mval">${m.gross ? Math.round(m.gross / 1000) + 'k' : ''}</div><div class="mlabel">${m.month}月</div></div>`).join('')}</div>`;
    $('#monthLegend').innerHTML = state.jobs.map((j) => `<span><i class="sw" style="background:${jobColor(j.id)}"></i>${esc(j.name)}</span>`).join('') + '<span><i class="sw commute"></i>通勤手当</span><span class="muted">（支給日の月で集計）</span>';
  }

  // ---------- 給料の記録 ----------
  const pf = $('#paymentForm');
  function fillJobSelect() {
    const sel = pf.elements.jobId;
    const cur = sel.value;
    sel.innerHTML = state.jobs.length ? state.jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.name)}</option>`).join('') : '<option value="">先にバイト先を登録してください</option>';
    if (cur && state.jobs.some((j) => j.id === cur)) sel.value = cur;
  }
  // 入力中に「課税分」と振込額のチェックを表示
  function readPaymentForm() {
    const f = pf.elements;
    const n = (el) => (el.value === '' ? null : Number(el.value) || 0);
    const total = n(f.total) ?? 0, commute = n(f.commute) ?? 0, withholding = n(f.withholding) ?? 0, shaho = n(f.shaho) ?? 0, net = n(f.net);
    return { total, commute, withholding, shaho, net, gross: total - commute };
  }
  function paymentProblems(v) {
    const errors = [], notes = [];
    if (v.commute > v.total) errors.push('交通費が総支給額より大きくなっています。総支給額は交通費込みの合計を入れてください');
    if (v.net != null && v.total > 0) {
      const expected = v.total - v.withholding - v.shaho;
      const diff = expected - v.net; // 住民税・寮費・前払いなどの天引きがあればプラス
      if (v.net > v.total) errors.push('振込額が総支給額より多くなっています。総支給額に交通費や手当を入れ忘れていませんか？');
      else if (v.net === v.total && (v.withholding > 0 || v.shaho > 0)) errors.push('総支給額と振込額が同じです。総支給額に通帳の振込額（手取り）を入れていませんか？');
      else if (diff < 0) errors.push(`総支給 − 所得税 − 社保 = ${yen(expected)} なのに、振込額のほうが ${yen(-diff)} 多いです。明細の数字をもう一度確認してください`);
      else if (diff > 0) notes.push(`総支給 − 所得税 − 社保 = ${yen(expected)}。振込額との差 ${yen(diff)} は、住民税や制服代など別の天引きなら問題ありません`);
      else notes.push('振込額とぴったり合っています ✓');
    }
    return { errors, notes };
  }
  function renderBreakdown() {
    const v = readPaymentForm();
    const el = $('#paymentBreakdown');
    if (!v.total) { el.innerHTML = ''; return; }
    const { errors, notes } = paymentProblems(v);
    el.innerHTML = `
      <div class="bd-row"><span>税金の計算に使う額（課税分）</span><strong>${yen(Math.max(0, v.gross))}</strong><span class="muted small">＝ 総支給 ${yen(v.total)} − 交通費 ${yen(v.commute)}</span></div>
      <div class="bd-row"><span>社会保険の判定に使う額</span><strong>${yen(v.total)}</strong><span class="muted small">交通費込み</span></div>
      ${errors.map((m) => `<div class="bd-msg error">${esc(m)}</div>`).join('')}
      ${notes.map((m) => `<div class="bd-msg">${esc(m)}</div>`).join('')}`;
  }
  pf.addEventListener('input', renderBreakdown);

  // ---------- 給料日から支給日を自動入力 ----------
  const HD = window.FuyouHolidays;
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const fmtDay = (dateStr) => { const d = new Date(dateStr + 'T00:00:00'); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
  const currentJob = () => state.jobs.find((j) => j.id === pf.elements.jobId.value);
  let payDateAuto = true; // 手で日付を変えたら、バイト先を変えても上書きしない

  function autoFillPayDate() {
    const job = currentJob();
    if (job && job.payDay && payDateAuto && !pf.elements.id.value) {
      const p = HD.lastPayDateOnOrBefore(job, todayStr);
      if (p) pf.elements.payDate.value = p.date;
    }
    renderPayDateHint();
  }
  function renderPayDateHint() {
    const job = currentJob();
    const el = $('#payDateHint');
    if (!job || !job.payDay) { el.innerHTML = job ? '給料日を登録すると自動で入ります（バイト先タブ）' : ''; return; }
    const v = pf.elements.payDate.value;
    const ref = v ? HD.stepPayDate(job, v, 0) : null;
    const matches = ref && ref.date === v;
    el.innerHTML = `${esc(HD.describe(job))}<br>
      <button type="button" class="link" data-step="-1">‹ 前の月</button>
      <button type="button" class="link" data-step="1">次の月 ›</button>
      ${v && !matches ? '<span class="warn-text">給料日と違う日です</span>' : ''}
      ${matches && ref.shifted ? `<span>（${fmtDay(ref.nominal)}が${esc(ref.reason)}のため）</span>` : ''}`;
    $$('[data-step]', el).forEach((b) => b.addEventListener('click', () => {
      const base = pf.elements.payDate.value || todayStr;
      const n = HD.stepPayDate(job, base, Number(b.dataset.step));
      if (n) { pf.elements.payDate.value = n.date; payDateAuto = false; renderPayDateHint(); }
    }));
  }
  pf.elements.jobId.addEventListener('change', autoFillPayDate);
  pf.elements.payDate.addEventListener('input', () => { payDateAuto = false; renderPayDateHint(); });

  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.jobs.length) { toast('先にバイト先を登録してください', 'error'); showTab('jobs'); return; }
    const f = pf.elements;
    const v = readPaymentForm();
    const { errors } = paymentProblems(v);
    if (v.commute > v.total) { toast('交通費が総支給額より大きくなっています', 'error'); return; }
    if (errors.length && !confirm(errors.join('\n') + '\n\nこのまま保存しますか？')) return;
    const rec = {
      id: f.id.value || uid(), jobId: f.jobId.value, payDate: f.payDate.value,
      gross: v.gross, commute: v.commute, // 保存は「課税分」と「交通費」に分けておく
      withholding: v.withholding, shaho: v.shaho, net: v.net, memo: f.memo.value.trim(),
    };
    const i = state.payments.findIndex((p) => p.id === rec.id);
    if (i >= 0) state.payments[i] = rec; else state.payments.push(rec);
    if (!save()) { setStatus('paymentStatus', '保存に失敗しました。入力内容は残しています', 'error'); return; }
    const keepJob = rec.jobId;
    resetPaymentForm();
    pf.elements.jobId.value = keepJob;
    autoFillPayDate();
    const jn = state.jobs.find((j) => j.id === rec.jobId)?.name || '';
    const what = `${rec.payDate} ${jn} ${yen(rec.gross + rec.commute)}`;
    toast(`${what} を${i >= 0 ? '更新' : '保存'}しました`, 'ok');
    setStatus('paymentStatus', `${what} を${i >= 0 ? '更新' : '保存'}しました`);
    if (!rec.payDate.startsWith(String(state.settings.year))) {
      toast(`保存しました。ただし支給日が${rec.payDate.slice(0, 4)}年なので、${state.settings.year}年の一覧には出ません（右上で年を切り替え）`, 'info');
    }
    highlightId = rec.id;
    renderAll();
  });
  function resetPaymentForm() {
    pf.reset();
    pf.elements.id.value = '';
    pf.elements.payDate.value = todayStr;
    payDateAuto = true;
    $('#paymentSubmit').textContent = '追加する';
    $('#paymentCancel').hidden = true;
    renderBreakdown();
    if (typeof autoFillPayDate === 'function') autoFillPayDate();
  }
  $('#paymentCancel').addEventListener('click', resetPaymentForm);

  function renderPayments() {
    const year = state.settings.year;
    const list = state.payments.filter((p) => p.payDate.startsWith(String(year))).sort((a, b) => b.payDate.localeCompare(a.payDate));
    $('#paymentListTitle').textContent = `${year}年の記録（${list.length}件）`;
    const jobName = (id) => state.jobs.find((j) => j.id === id)?.name || '（削除済み）';
    $('#paymentTable').innerHTML = list.length ? `
      <thead><tr><th>支給日</th><th>バイト先</th><th class="num">総支給（交通費込）</th><th class="num">うち交通費</th><th class="num">課税分</th><th class="num">所得税</th><th class="num">社保</th><th class="num">振込額</th><th>メモ</th><th></th></tr></thead>
      <tbody>${list.map((p) => `<tr data-row="${esc(p.id)}" class="${p.id === highlightId ? 'just-saved' : ''}">
        <td>${esc(p.payDate)}</td><td><span class="dot" style="background:${jobColor(p.jobId)}"></span>${esc(jobName(p.jobId))}</td>
        <td class="num">${yen((p.gross || 0) + (p.commute || 0))}</td><td class="num">${yen(p.commute || 0)}</td><td class="num strong">${yen(p.gross)}</td><td class="num">${yen(p.withholding)}</td><td class="num">${yen(p.shaho)}</td><td class="num muted">${p.net != null ? yen(p.net) : '-'}</td>
        <td class="memo">${esc(p.memo)}</td>
        <td class="actions"><button class="btn tiny" data-edit="${esc(p.id)}">編集</button><button class="btn tiny danger" data-del="${esc(p.id)}">削除</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">まだ記録がありません。</td></tr></tbody>';
    if (highlightId) {
      const row = $(`[data-row="${CSS.escape(highlightId)}"]`, $('#paymentTable'));
      if (row && $('#tab-payments').classList.contains('active')) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightId = null;
    }
    $$('[data-edit]', $('#paymentTable')).forEach((b) => b.addEventListener('click', () => {
      const p = state.payments.find((x) => x.id === b.dataset.edit);
      if (!p) return;
      const f = pf.elements;
      f.id.value = p.id; f.jobId.value = p.jobId; f.payDate.value = p.payDate; f.total.value = (p.gross || 0) + (p.commute || 0);
      f.commute.value = p.commute || ''; f.withholding.value = p.withholding || ''; f.shaho.value = p.shaho || '';
      f.net.value = p.net != null ? p.net : ''; f.memo.value = p.memo || '';
      payDateAuto = false;
      renderBreakdown();
      renderPayDateHint();
      $('#paymentSubmit').textContent = '更新する';
      $('#paymentCancel').hidden = false;
      pf.scrollIntoView({ behavior: 'smooth' });
    }));
    $$('[data-del]', $('#paymentTable')).forEach((b) => b.addEventListener('click', () => {
      state.payments = state.payments.filter((x) => x.id !== b.dataset.del);
      save(); renderAll(); toast('削除しました', 'ok');
    }));
  }

  $('#exportCsv').addEventListener('click', () => {
    const jobName = (id) => state.jobs.find((j) => j.id === id)?.name || '';
    const rows = [['支給日', 'バイト先', '総支給額（交通費込み）', 'うち交通費', '課税分', '所得税', '社会保険料', '振込額', 'メモ']];
    state.payments.slice().sort((a, b) => a.payDate.localeCompare(b.payDate)).forEach((p) => rows.push([p.payDate, jobName(p.jobId), (p.gross || 0) + (p.commute || 0), p.commute || 0, p.gross, p.withholding, p.shaho, p.net ?? '', p.memo || '']));
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download('﻿' + csv, `baito-kyuryo-${todayStr}.csv`, 'text/csv');
  });

  // ---------- バイト先 ----------
  const jf = $('#jobForm');
  jf.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = jf.elements;
    const rec = {
      id: f.id.value || uid(), name: f.name.value.trim(), taxColumn: f.taxColumn.value,
      weeklyHours: Number(f.weeklyHours.value) || 0, contractMonthly: Number(f.contractMonthly.value) || 0,
      companyLarge: f.companyLarge.checked, fullTimeLike: f.fullTimeLike.checked, active: f.active.checked,
      payDay: f.payDay.value === '' ? '' : f.payDay.value === 'end' ? 'end' : Number(f.payDay.value), payShift: f.payShift.value,
    };
    if (!rec.name) return;
    const i = state.jobs.findIndex((j) => j.id === rec.id);
    if (i >= 0) state.jobs[i] = rec; else state.jobs.push(rec);
    if (!save()) { setStatus('jobStatus', '保存に失敗しました', 'error'); return; }
    if (rec.taxColumn === 'kou' && state.jobs.filter((j) => j.taxColumn === 'kou' && j.active !== false).length > 1) toast(`「${rec.name}」を保存しました。注意：甲欄（扶養控除等申告書）は1か所だけです`, 'error');
    else toast(`「${rec.name}」を${i >= 0 ? '更新' : '登録'}しました`, 'ok');
    resetJobForm();
    setStatus('jobStatus', `「${rec.name}」を${i >= 0 ? '更新' : '登録'}しました`);
    renderAll();
  });
  function resetJobForm() {
    jf.reset(); jf.elements.id.value = ''; jf.elements.active.checked = true;
    jf.elements.taxColumn.value = state.jobs.some((j) => j.taxColumn === 'kou') ? 'otsu' : 'kou';
    $('#jobSubmit').textContent = '登録する'; $('#jobCancel').hidden = true;
    renderPayPreview();
  }
  // 登録前に「この設定だと何日になるか」を見せる
  function renderPayPreview() {
    const f = jf.elements;
    const job = { payDay: f.payDay.value === 'end' ? 'end' : Number(f.payDay.value) || '', payShift: f.payShift.value };
    const el = $('#payPreview');
    if (!job.payDay) { el.innerHTML = ''; return; }
    const y = Number(todayStr.slice(0, 4)), m = Number(todayStr.slice(5, 7));
    const list = [];
    for (let k = 0; k < 6; k++) {
      const t = y * 12 + (m - 1) + k;
      const p = HD.payDate(job, Math.floor(t / 12), (t % 12) + 1);
      list.push(p.shifted ? `<span class="shifted" title="${esc(fmtDay(p.nominal))}は${esc(p.reason)}">${fmtDay(p.date)}</span>` : fmtDay(p.date));
    }
    el.innerHTML = `この設定だと：${list.join('、')}　<span class="shifted">色つき</span>＝土日祝でずれた日`;
  }
  jf.elements.payDay.addEventListener('change', renderPayPreview);
  jf.elements.payShift.addEventListener('change', renderPayPreview);
  $('#jobCancel').addEventListener('click', resetJobForm);

  function nextPay(job) {
    const y = Number(todayStr.slice(0, 4)), m = Number(todayStr.slice(5, 7));
    for (let k = 0; k < 3; k++) {
      const t = y * 12 + (m - 1) + k;
      const p = HD.payDate(job, Math.floor(t / 12), (t % 12) + 1);
      if (p && p.date >= todayStr) return fmtDay(p.date) + (p.shifted ? `（${esc(p.reason)}のため${p.date < p.nominal ? '前倒し' : '後ろ倒し'}）` : '');
    }
    return '-';
  }
  /** 給料日を過ぎているのに記録がない月（最初の記録より前の月は対象外） */
  function missingPays(year) {
    const out = [];
    const dayDiff = (a, b) => Math.abs(new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000;
    for (const job of state.jobs) {
      if (!job.payDay || job.active === false) continue;
      const pays = state.payments.filter((p) => p.jobId === job.id).map((p) => p.payDate).sort();
      if (!pays.length) continue;
      const dates = [];
      for (let m = 1; m <= 12; m++) {
        const pd = HD.payDate(job, year, m);
        if (!pd || pd.date > todayStr || pd.date < pays[0]) continue;
        if (!pays.some((d) => dayDiff(d, pd.date) <= 10)) dates.push(pd.date);
      }
      if (dates.length) out.push({ job, dates });
    }
    return out;
  }
  function renderJobs() {
    const el = $('#jobList');
    if (!state.jobs.length) { el.innerHTML = '<p class="muted">まだありません。掛け持ちしている場合は全部登録してください。</p>'; return; }
    el.innerHTML = state.jobs.map((j) => {
      const n = state.payments.filter((p) => p.jobId === j.id).length;
      return `<div class="job ${j.active === false ? 'inactive' : ''}">
        <span class="dot big" style="background:${jobColor(j.id)}"></span>
        <div class="job-body"><strong>${esc(j.name)}</strong> <span class="badge ${j.taxColumn === 'kou' ? 'ok' : 'info'}">${j.taxColumn === 'kou' ? '甲欄' : '乙欄'}</span>${j.active === false ? ' <span class="badge">退職</span>' : ''}
          <div class="muted small">週${j.weeklyHours || '?'}時間${j.contractMonthly ? ` ・契約月収 ${yen(j.contractMonthly)}` : ''}${j.companyLarge ? ' ・51人以上' : ''} ・記録${n}件</div>
          ${j.payDay ? `<div class="small">💴 ${esc(HD.describe(j))}${j.active !== false ? ` ・次は <strong>${nextPay(j)}</strong>` : ''}</div>` : ''}</div>
        <div class="actions"><button class="btn tiny" data-jedit="${esc(j.id)}">編集</button><button class="btn tiny danger" data-jdel="${esc(j.id)}">削除</button></div>
      </div>`;
    }).join('');
    $$('[data-jedit]', el).forEach((b) => b.addEventListener('click', () => {
      const j = state.jobs.find((x) => x.id === b.dataset.jedit);
      const f = jf.elements;
      f.id.value = j.id; f.name.value = j.name; f.taxColumn.value = j.taxColumn; f.weeklyHours.value = j.weeklyHours || '';
      f.contractMonthly.value = j.contractMonthly || ''; f.companyLarge.checked = !!j.companyLarge; f.fullTimeLike.checked = !!j.fullTimeLike; f.active.checked = j.active !== false;
      f.payDay.value = j.payDay ? String(j.payDay) : ''; f.payShift.value = j.payShift || 'before';
      renderPayPreview();
      $('#jobSubmit').textContent = '更新する'; $('#jobCancel').hidden = false;
      jf.scrollIntoView({ behavior: 'smooth' });
    }));
    $$('[data-jdel]', el).forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.jdel;
      const n = state.payments.filter((p) => p.jobId === id).length;
      if (n && !confirm(`このバイト先の記録${n}件も消えます。よろしいですか？`)) return;
      state.jobs = state.jobs.filter((x) => x.id !== id);
      state.payments = state.payments.filter((p) => p.jobId !== id);
      save(); renderAll(); toast('削除しました', 'ok');
    }));
  }

  // ---------- 設定 ----------
  const sf = $('#settingsForm');
  function fillSettings() {
    const s = state.settings, f = sf.elements;
    f.birthDate.value = s.birthDate || ''; f.dependentType.value = s.dependentType; f.juminKyuchi.value = String(s.juminKyuchi || 1);
    f.otherIncome.value = s.otherIncome || ''; f.contractAnnual.value = s.contractAnnual || '';
    f.isStudent.checked = !!s.isStudent; f.isSenior.checked = !!s.isSenior;
    f.useManualProjection.checked = !!s.useManualProjection; f.plannedExtra.value = s.plannedExtra || '';
    f.plannedExtra.disabled = !s.useManualProjection;
  }
  sf.addEventListener('input', () => {
    const f = sf.elements;
    Object.assign(state.settings, {
      birthDate: f.birthDate.value, dependentType: f.dependentType.value, juminKyuchi: Number(f.juminKyuchi.value),
      otherIncome: Number(f.otherIncome.value) || 0, contractAnnual: f.contractAnnual.value ? Number(f.contractAnnual.value) : '',
      isStudent: f.isStudent.checked, isSenior: f.isSenior.checked,
      useManualProjection: f.useManualProjection.checked, plannedExtra: f.plannedExtra.value ? Number(f.plannedExtra.value) : '',
    });
    f.plannedExtra.disabled = !f.useManualProjection.checked;
    if (save()) setStatus('settingsStatus', '保存しました');
    else setStatus('settingsStatus', '保存できませんでした', 'error');
    renderAll(true);
  });

  function download(text, filename, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('#exportJson').addEventListener('click', () => download(JSON.stringify(state, null, 2), `fuyou-checker-backup-${todayStr}.json`, 'application/json'));
  $('#importJson').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (window.FuyouCrypto && FuyouCrypto.isEncryptedBackup(data)) throw new Error('暗号化バックアップです。下の「暗号化バックアップを読み込む」から読み込んでください');
      if (!data || !Array.isArray(data.jobs) || !Array.isArray(data.payments)) throw new Error('形式が違います');
      const d = defaultState();
      state = { ...d, ...data, settings: { ...d.settings, ...(data.settings || {}) } };
      save(); renderAll(); toast('バックアップを読み込みました', 'ok');
    } catch (err) { toast('読み込めませんでした：' + err.message, 'error'); }
    e.target.value = '';
  });
  $('#resetAll').addEventListener('click', () => {
    if (!confirm('すべての記録と設定を消します。よろしいですか？（先にバックアップがおすすめ）')) return;
    suppressAutoSync = true; state = defaultState(); save(); suppressAutoSync = false; renderAll();
    toast(sync ? 'この端末のデータを消しました（サーバーのデータは残っています）' : 'リセットしました', 'ok');
  });
  $('#loadSample').addEventListener('click', loadSample);

  function loadSample() {
    if ((state.payments.length || state.jobs.length) && !confirm('今のデータをサンプルで上書きします。よろしいですか？')) return;
    const y = state.settings.year;
    const jobs = [
      { id: 'cafe', name: 'カフェ', taxColumn: 'kou', weeklyHours: 14, contractMonthly: 75000, companyLarge: true, fullTimeLike: false, active: true, payDay: 25, payShift: 'before' },
      { id: 'juku', name: '塾講師', taxColumn: 'otsu', weeklyHours: 5, contractMonthly: 35000, companyLarge: false, fullTimeLike: false, active: true, payDay: 10, payShift: 'after' },
    ];
    const cafe = [68000, 72000, 95000, 74000, 70000, 76000, 81000, 99000, 88000, 79000];
    const juku = [30000, 28000, 26000, 36000, 34000, 38000, 45000, 52000, 30000, 36000];
    const payments = [];
    cafe.forEach((g, i) => payments.push({ id: uid(), jobId: 'cafe', payDate: HD.payDate(jobs[0], y, i + 1).date, gross: g, commute: 6000, withholding: 0, shaho: 0, memo: i === 2 ? '春休み' : i === 7 ? '夏休み' : '' }));
    juku.forEach((g, i) => payments.push({ id: uid(), jobId: 'juku', payDate: HD.payDate(jobs[1], y, i + 1).date, gross: g, commute: 0, withholding: Math.floor(g * 0.03063), shaho: 0, memo: '' }));
    state = { version: 1, settings: { ...state.settings, birthDate: `${y - 20}-06-15`, dependentType: 'parent', isStudent: true }, jobs, payments };
    save(); renderAll(); showTab('dashboard'); toast('サンプルを入れました（20歳の大学生・掛け持ち）', 'ok');
  }

  // ---------- 解説 ----------
  function renderGuide(s) {
    const r = s.rules;
    const f = (inc) => man(C.incomeToSalary(inc, r));
    $('#guide').innerHTML = `
      <h2>${esc(r.label)}の「年収の壁」まとめ</h2>
      <p class="muted small">ルールの状態：${esc(r.status)}。金額は給料（給与収入）だけの場合です。</p>
      <h3>まず大事な3つの違い</h3>
      <table class="mini wide">
        <tr><th></th><th>税金の壁（所得税・住民税・親の控除）</th><th>社会保険の壁（130万円など）</th></tr>
        <tr><th>期間</th><td>1月1日〜12月31日に<strong>支給された</strong>分</td><td><strong>これから1年間</strong>の見込み</td></tr>
        <tr><th>通勤手当</th><td>含めない（非課税分）</td><td><strong>含める</strong></td></tr>
        <tr><th>判定方法</th><td>実際にもらった額</td><td>2026年4月〜は労働契約（労働条件通知書）の賃金で判定が原則</td></tr>
      </table>
      <h3>税金の壁（${esc(r.label)}）</h3>
      <ul>
        <li><strong>${f(r.juminNonTaxIncome[1])}</strong>（1級地）を超えると、自分に住民税（${esc(r.juminFiscalLabel)}）がかかる。自治体によって少し低い。</li>
        <li><strong>${f(r.fuyouIncome)}</strong>を超えると、親の「扶養控除」の対象外（16〜18歳・23歳以上）。</li>
        <li>19〜22歳は特別で、<strong>${f(r.tokuteiShinzoku[0][0])}</strong>までは親の控除が満額（63万円）のまま。そこから段階的に減り、<strong>${f(r.tokuteiShinzoku[r.tokuteiShinzoku.length - 1][0])}</strong>を超えるとゼロ。</li>
        <li><strong>${man(C.incomeTaxFreeLimit(r))}</strong>を超えると、自分に所得税がかかる（超えた分の約5%なので、いきなり手取りが大きく減るわけではない）。</li>
      </ul>
      <h3>社会保険の壁</h3>
      <ul>
        <li>家族の健康保険の扶養に入れるのは年収<strong>130万円未満</strong>（19〜22歳は<strong>150万円未満</strong>、配偶者は130万円のまま。60歳以上・障害者は180万円未満）。</li>
        <li>超えると自分で国民健康保険・国民年金に入るか、勤務先の社会保険に入ることになり、手取りが年20万円前後減ることも。<strong>いちばん影響が大きい壁</strong>です。</li>
        <li>勤務先の社会保険：<strong>週20時間以上</strong>＋従業員51人以上の会社＋学生でない、などを満たすと加入（2026年10月に月8.8万円＝106万円の条件は撤廃）。</li>
      </ul>
      <h3>掛け持ちと源泉徴収</h3>
      <ul>
        <li>「扶養控除等申告書」を出したバイト先は<strong>甲欄</strong>。出せるのは<strong>1か所だけ</strong>。社保控除後の月給が${yen(r.kouZeroBelow)}未満なら所得税はほぼ引かれません。</li>
        <li>それ以外は<strong>乙欄</strong>。少額でも約3%引かれます。</li>
        <li>年末調整は甲欄のバイト先の分だけ。乙欄で引かれた税金は<strong>確定申告（還付申告）</strong>で取り戻せます（翌年1月から5年以内）。</li>
        <li>乙欄の給料が20万円を超えて、しかも所得税がかかる年収なら<strong>確定申告が必要</strong>。</li>
        <li>年末までに辞めたバイト先の源泉徴収票は必ずもらっておきましょう。</li>
      </ul>
      <h3>よくある勘違い</h3>
      <ul>
        <li>「12月分の給料」が1月に振り込まれたら、それは<strong>翌年</strong>の収入。</li>
        <li>「手取り」ではなく「総支給額」で判定。</li>
        <li>壁を少し超えても、所得税は少しずつ増えるだけ。<strong>親の控除・社会保険の扶養</strong>の方が影響は大きいので、家族と相談を。</li>
      </ul>`;
  }

  // ---------- 全体描画 ----------
  function renderAll(skipSettingsFill) {
    yearSelect.value = String(state.settings.year);
    if (!skipSettingsFill) fillSettings();
    fillJobSelect();
    if (!pf.elements.id.value && payDateAuto) autoFillPayDate(); else renderPayDateHint();
    let s;
    try { s = C.summarize(state, todayStr); } catch (e) { toast(e.message); return; }
    renderDashboard(s);
    renderPayments();
    renderJobs();
    renderGuide(s);
    $('#rulesInfo').textContent = `使用中のルール：${s.rules.label}（${s.rules.status}）／ js/rules.js で更新できます`;
  }

  // ---------- 暗号化バックアップ ----------
  const FC = window.FuyouCrypto;
  $('#exportEnc').addEventListener('click', async () => {
    try {
      setStatus('backupStatus', '暗号化しています…', 'ok');
      const env = await FC.encryptBackup(state, $('#backupPass').value);
      download(JSON.stringify(env, null, 2), `fuyou-checker-encrypted-${todayStr}.json`, 'application/json');
      setStatus('backupStatus', '暗号化バックアップを書き出しました');
      toast('暗号化バックアップを書き出しました', 'ok');
    } catch (e) { setStatus('backupStatus', e.message, 'error'); toast(e.message, 'error'); }
  });
  $('#importEnc').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const env = JSON.parse(await file.text());
      setStatus('backupStatus', '復号しています…', 'ok');
      const data = await FC.decryptBackup(env, $('#backupPass').value);
      if (!data || !Array.isArray(data.jobs) || !Array.isArray(data.payments)) throw new Error('中身の形式が違います');
      if (!confirm(`記録${data.payments.length}件を読み込み、今のデータを置き換えます。よろしいですか？`)) { setStatus('backupStatus', '読み込みをやめました', 'error'); return; }
      replaceState(data);
      setStatus('backupStatus', '暗号化バックアップを読み込みました');
      toast('暗号化バックアップを読み込みました', 'ok');
    } catch (err) { setStatus('backupStatus', err.message, 'error'); toast(err.message, 'error'); }
  });

  function replaceState(data, { fromSync = false } = {}) {
    const d = defaultState();
    state = { ...d, ...data, settings: { ...d.settings, ...(data.settings || {}) } };
    suppressAutoSync = fromSync;
    save();
    suppressAutoSync = false;
    renderAll();
  }

  // ---------- サーバー同期 ----------
  const SYNC_KEY = 'fuyou-checker:sync';
  const SYNC_URL = 'api/sync.php';
  let sync = (() => { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch (e) { return null; } })();
  let syncMem = null; // パスワードを記憶しない場合の鍵（このタブの間だけ）
  let suppressAutoSync = false;
  let autoTimer = null;

  const saveSync = () => { try { if (sync) localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); else localStorage.removeItem(SYNC_KEY); } catch (e) { /* noop */ } };
  const syncKeys = () => (sync && sync.keyRaw ? { keyRaw: sync.keyRaw, token: sync.token } : syncMem);

  async function api(body) {
    let res;
    try {
      res = await fetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    } catch (e) { throw Object.assign(new Error('サーバーにつながりません（オフライン？）'), { status: 0 }); }
    let json = null;
    try { json = await res.json(); } catch (e) { /* PHPが動いていない等 */ }
    if (!json) throw Object.assign(new Error(`サーバーの応答が不正です（${res.status}）。api/sync.php でPHPが動いているか確認してください`), { status: res.status });
    if (!res.ok || !json.ok) throw Object.assign(new Error(json.error || 'エラー'), { status: res.status, body: json });
    return json;
  }
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '-' : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function renderSync() {
    const unavailable = location.protocol === 'file:' ? 'ファイルを直接開いている（file://）ため、サーバー同期は使えません。サーバーにアップロードして https:// で開いてください。'
      : !FC.available() ? 'https:// で開いていないため暗号化が使えません。サーバーをHTTPSにしてください。' : '';
    $('#syncUnavailable').hidden = !unavailable;
    $('#syncUnavailable').textContent = unavailable;
    const connected = !!(sync && sync.id && syncKeys());
    $('#syncSetup').hidden = connected || !!unavailable;
    $('#syncConnected').hidden = !connected;
    if (sync && sync.id && !syncKeys()) $('#syncId').value = sync.id; // 記憶なし：パスワードだけ再入力
    if (connected) {
      $('#syncIdShow').textContent = sync.id;
      $('#syncAuto').checked = !!sync.auto;
      $('#syncInfo').textContent = sync.updatedAt ? `rev ${sync.rev}（${fmtTime(sync.updatedAt)} に同期）` : '未同期';
    }
  }

  $('#syncNewId').addEventListener('click', () => { $('#syncId').value = FC.newSyncId(); toast('同期IDを作りました。他の端末でもこのIDを使います', 'ok'); });

  $('#syncConnect').addEventListener('click', async () => {
    const id = $('#syncId').value.trim().toLowerCase();
    const pass = $('#syncPass').value;
    if (!/^[0-9a-f]{32}$/.test(id)) { toast('同期IDは32文字の英数字です。「IDを作る」で作れます', 'error'); return; }
    const btn = $('#syncConnect');
    btn.disabled = true; btn.textContent = '鍵を作成中…';
    try {
      const keys = await FC.deriveSync(pass, id);
      let remote = null;
      try { remote = await api({ action: 'get', id, token: keys.token }); }
      catch (e) { if (e.status !== 404) throw e; }
      const remember = $('#syncRemember').checked;
      sync = { id, rev: 0, auto: true, updatedAt: null, ...(remember ? keys : {}) };
      syncMem = remember ? null : keys;
      if (remote) {
        const data = await FC.decryptFromSync(remote.payload, keys.keyRaw);
        sync.rev = remote.rev; sync.updatedAt = remote.updatedAt;
        const localEmpty = !state.payments.length && !state.jobs.length;
        if (localEmpty || confirm(`サーバーにデータがあります（記録${data.payments?.length ?? 0}件・${fmtTime(remote.updatedAt)}更新）。\nサーバーのデータを読み込みますか？\n\nOK：読み込む（この端末のデータは置き換え）\nキャンセル：読み込まない（あとで「サーバーに保存」で上書きできます）`)) {
          replaceState(data, { fromSync: true });
          toast('サーバーのデータを読み込みました', 'ok');
        } else {
          sync.auto = false;
          toast('接続しました（自動保存はオフにしています）', 'ok');
        }
      } else {
        const r = await api({ action: 'put', id, token: keys.token, baseRev: 0, payload: await FC.encryptForSync(state, keys.keyRaw) });
        sync.rev = r.rev; sync.updatedAt = r.updatedAt;
        toast('サーバーに暗号化して保存しました', 'ok');
      }
      saveSync();
      $('#syncPass').value = '';
      renderSync();
      setStatus('syncStatus', '接続しました');
    } catch (e) {
      toast(e.status === 403 ? 'このIDのパスワードが違います' : e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '接続する';
    }
  });

  async function push({ force = false, auto = false } = {}) {
    const keys = syncKeys();
    if (!sync || !keys) return;
    try {
      setStatus('syncStatus', 'サーバーに保存中…', 'ok');
      const r = await api({ action: 'put', id: sync.id, token: keys.token, baseRev: sync.rev, force, payload: await FC.encryptForSync(state, keys.keyRaw) });
      sync.rev = r.rev; sync.updatedAt = r.updatedAt; saveSync(); renderSync();
      setStatus('syncStatus', 'サーバーに保存しました');
      if (!auto) toast('サーバーに保存しました', 'ok');
    } catch (e) {
      if (e.status === 409) {
        if (!auto && confirm(`別の端末が先にサーバーを更新しています（${fmtTime(e.body.updatedAt)}）。\nこの端末のデータでサーバーを上書きしますか？\n\nキャンセルして「サーバーから読み込む」を押すと、向こうのデータを取り込めます。`)) return push({ force: true });
        setStatus('syncStatus', '別の端末で更新されています。「サーバーから読み込む」か「サーバーに保存」で解決してください', 'error');
        toast('サーバーと食い違いがあります（同期の画面を確認）', 'error');
      } else {
        setStatus('syncStatus', 'サーバー保存に失敗：' + e.message + '（この端末には保存済み）', 'error');
        toast('サーバー保存に失敗しました（この端末には保存済み）', 'error');
      }
    }
  }
  function scheduleAutoSync() {
    if (suppressAutoSync || !sync || !sync.auto || !syncKeys()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => push({ auto: true }), 1500);
  }

  $('#syncPush').addEventListener('click', () => push());
  $('#syncPull').addEventListener('click', async () => {
    const keys = syncKeys();
    try {
      const r = await api({ action: 'get', id: sync.id, token: keys.token });
      const data = await FC.decryptFromSync(r.payload, keys.keyRaw);
      if (!confirm(`サーバーのデータ（記録${data.payments?.length ?? 0}件・${fmtTime(r.updatedAt)}更新）で、この端末のデータを置き換えます。よろしいですか？`)) return;
      sync.rev = r.rev; sync.updatedAt = r.updatedAt; saveSync();
      replaceState(data, { fromSync: true });
      setStatus('syncStatus', 'サーバーから読み込みました');
      toast('サーバーから読み込みました', 'ok');
    } catch (e) { setStatus('syncStatus', e.message, 'error'); toast(e.message, 'error'); }
  });
  $('#syncAuto').addEventListener('change', (e) => { sync.auto = e.target.checked; saveSync(); if (sync.auto) push({ auto: true }); });
  $('#syncCopyId').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(sync.id); toast('同期IDをコピーしました', 'ok'); } catch (e) { toast('コピーできませんでした。手で選択してコピーしてください', 'error'); }
  });
  $('#syncDisconnect').addEventListener('click', () => {
    if (!confirm('この端末の同期設定を解除します（サーバーのデータとこの端末の記録は残ります）。')) return;
    sync = null; syncMem = null; saveSync(); closeHandoff(); renderSync(); toast('接続を解除しました', 'ok');
  });
  $('#syncDelete').addEventListener('click', async () => {
    if (!confirm('サーバー上の暗号化データを削除します。他の端末も同期できなくなります。よろしいですか？')) return;
    try {
      await api({ action: 'delete', id: sync.id, token: syncKeys().token });
      sync = null; syncMem = null; saveSync(); renderSync(); toast('サーバーのデータを削除しました', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  });

  // ---------- スマホ用の使い捨てリンク（QRコード） ----------
  let handoffUrl = '', handoffTimer = null;
  function closeHandoff() {
    clearInterval(handoffTimer);
    handoffUrl = '';
    $('#handoffBox').hidden = true;
    $('#handoffQr').innerHTML = '';
  }
  $('#handoffMake').addEventListener('click', async () => {
    const keys = syncKeys();
    if (!sync || !keys) return;
    const btn = $('#handoffMake');
    btn.disabled = true;
    try {
      await push({ auto: true }); // スマホが最新のデータを受け取れるよう、先にサーバーへ保存
      const h = await FC.makeHandoff({ id: sync.id, keyRaw: keys.keyRaw, token: keys.token });
      const r = await api({ action: 'handoff_put', id: sync.id, token: keys.token, hid: h.hid, blob: h.blob });
      handoffUrl = `${location.origin}${location.pathname}#h=${h.hid}.${h.k}`;
      const qr = window.qrcode(0, 'M');
      qr.addData(handoffUrl);
      qr.make();
      $('#handoffQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      $('#handoffBox').hidden = false;
      const until = new Date(r.expires).getTime();
      const tick = () => {
        const left = Math.max(0, Math.round((until - Date.now()) / 1000));
        $('#handoffTimer').textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`;
        if (left <= 0) { closeHandoff(); toast('スマホ用のリンクの期限が切れました', 'info'); }
      };
      tick();
      clearInterval(handoffTimer);
      handoffTimer = setInterval(tick, 1000);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  $('#handoffCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(handoffUrl); toast('リンクをコピーしました（10分以内に、自分のスマホで開いてください）', 'ok'); }
    catch (e) { toast('コピーできませんでした', 'error'); }
  });
  $('#handoffClose').addEventListener('click', closeHandoff);

  /** リンク（#h=...）で開かれたときの受け取り処理 */
  async function receiveHandoff() {
    const m = location.hash.match(/^#h=([0-9a-f]{32})\.([A-Za-z0-9_-]{20,})$/);
    if (!m) return;
    // 鍵が履歴やブックマークに残らないよう、すぐにURLから消す
    history.replaceState(null, '', location.pathname + location.search);
    showTab('settings');
    toast('PCとつないでいます…', 'info');
    try {
      const r = await api({ action: 'handoff_take', hid: m[1] });
      const info = await FC.openHandoff(r.blob, m[2]);
      const remote = await api({ action: 'get', id: info.id, token: info.token });
      const data = await FC.decryptFromSync(remote.payload, info.keyRaw);
      const localEmpty = !state.payments.length && !state.jobs.length;
      if (!localEmpty && !confirm(`PCのデータ（記録${data.payments?.length ?? 0}件）で、このスマホのデータを置き換えます。よろしいですか？`)) {
        toast('つなぐのをやめました', 'info');
        return;
      }
      sync = { id: info.id, keyRaw: info.keyRaw, token: info.token, rev: remote.rev, updatedAt: remote.updatedAt, auto: true };
      syncMem = null;
      saveSync();
      replaceState(data, { fromSync: true });
      renderSync();
      setStatus('syncStatus', 'PCとつながりました');
      toast(`PCとつながりました（記録${data.payments?.length ?? 0}件を読み込み）`, 'ok');
      showTab('dashboard');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // HTMLとJSのバージョンが違う＝ブラウザが古いファイルを使っている
  $('#appVersion').textContent = APP_VERSION;
  const htmlVersion = document.documentElement.dataset.appVersion;
  if (htmlVersion !== APP_VERSION) {
    const b = $('#versionBanner');
    b.hidden = false;
    b.innerHTML = `古いファイルが読み込まれています（画面 ${esc(htmlVersion || '不明')} / プログラム ${APP_VERSION}）。<strong>Ctrl+Shift+R</strong>（Mac は <strong>Cmd+Shift+R</strong>、スマホはタブを閉じて開き直す）で再読み込みしてください。`;
  }

  resetPaymentForm();
  resetJobForm();
  renderAll();
  renderSync();
  receiveHandoff();
  window.addEventListener('hashchange', receiveHandoff);
})();
