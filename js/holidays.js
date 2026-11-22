/**
 * 日本の祝日・銀行休業日と、給料日の計算
 *
 * 祝日は「国民の祝日に関する法律」に沿って計算します（2019年以降・2099年まで対応）。
 *  - 固定の祝日 / ハッピーマンデー / 春分・秋分（近似式） / 振替休日 / 国民の休日
 *  - 銀行休業日として 12/31・1/2・1/3 も休みに含めます
 * 2020・2021年の東京五輪による特例の移動には対応していません。
 */
(function (root) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const nthMonday = (y, m, n) => {
    const first = new Date(y, m - 1, 1).getDay(); // 0=日
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  const shunbun = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const shubun = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

  const cache = {};
  /** その年の祝日 { 'YYYY-MM-DD': '名前' } */
  function holidays(y) {
    if (cache[y]) return cache[y];
    const h = {};
    const add = (m, d, name) => { h[`${y}-${pad(m)}-${pad(d)}`] = name; };
    add(1, 1, '元日');
    add(1, nthMonday(y, 1, 2), '成人の日');
    add(2, 11, '建国記念の日');
    if (y >= 2020) add(2, 23, '天皇誕生日');
    add(3, shunbun(y), '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    add(7, nthMonday(y, 7, 3), '海の日');
    add(8, 11, '山の日');
    add(9, nthMonday(y, 9, 3), '敬老の日');
    add(9, shubun(y), '秋分の日');
    add(10, nthMonday(y, 10, 2), 'スポーツの日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');

    // 国民の休日：祝日に挟まれた平日
    for (const key of Object.keys(h)) {
      const d = new Date(key + 'T00:00:00');
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const next2 = new Date(d); next2.setDate(d.getDate() + 2);
      if (!h[ymd(next)] && h[ymd(next2)] && next.getDay() !== 0 && next.getFullYear() === y) h[ymd(next)] = '国民の休日';
    }
    // 振替休日：日曜の祝日の後、最初の祝日でない日
    for (const key of Object.keys(h).sort()) {
      const d = new Date(key + 'T00:00:00');
      if (d.getDay() !== 0) continue;
      const s = new Date(d);
      do { s.setDate(s.getDate() + 1); } while (h[ymd(s)]);
      if (s.getFullYear() === y) h[ymd(s)] = '振替休日';
    }
    cache[y] = h;
    return h;
  }

  function holidayName(dateStr) {
    return holidays(Number(dateStr.slice(0, 4)))[dateStr] || null;
  }
  /** 銀行が休みか（土日・祝日・12/31・1/2・1/3） */
  function isBankHoliday(date) {
    const day = date.getDay();
    if (day === 0 || day === 6) return true;
    const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    if (md === '12-31' || md === '01-02' || md === '01-03') return true;
    return !!holidays(date.getFullYear())[ymd(date)];
  }
  function whyHoliday(date) {
    const day = date.getDay();
    const name = holidays(date.getFullYear())[ymd(date)];
    if (name) return name;
    if (day === 0) return '日曜';
    if (day === 6) return '土曜';
    const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    if (md === '12-31' || md === '01-02' || md === '01-03') return '年末年始';
    return null;
  }

  /**
   * ある月の実際の支給日
   * @param job { payDay: 1〜31 | 'end', payShift: 'before' | 'after' | 'none' }
   * @returns { date: 'YYYY-MM-DD', nominal: 'YYYY-MM-DD', shifted: bool, reason } | null
   */
  function payDate(job, y, m) {
    if (!job || !job.payDay) return null;
    const last = new Date(y, m, 0).getDate();
    const day = job.payDay === 'end' ? last : Math.min(Number(job.payDay), last);
    const nominal = new Date(y, m - 1, day);
    const d = new Date(nominal);
    const shift = job.payShift || 'before';
    let reason = null;
    if (shift !== 'none' && isBankHoliday(d)) {
      reason = whyHoliday(d);
      const step = shift === 'after' ? 1 : -1;
      do { d.setDate(d.getDate() + step); } while (isBankHoliday(d));
    }
    return { date: ymd(d), nominal: ymd(nominal), shifted: ymd(d) !== ymd(nominal), reason };
  }

  /** dateStr 以前で一番近い支給日 */
  function lastPayDateOnOrBefore(job, dateStr) {
    let y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
    for (let i = 0; i < 3; i++) {
      const p = payDate(job, y, m);
      if (p && p.date <= dateStr) return p;
      m -= 1; if (m === 0) { m = 12; y -= 1; }
    }
    return null;
  }
  /** 支給日 dateStr を基準に、前後の月の支給日 */
  function addMonth(y, m, delta) {
    const t = y * 12 + (m - 1) + delta;
    return [Math.floor(t / 12), (t % 12) + 1];
  }
  function stepPayDate(job, dateStr, delta) {
    let y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
    // ずれて月をまたいだ支給日（例：1日支給が前月末に前倒し）も、本来の月を探して扱う
    for (const k of [0, 1, -1]) {
      const [yy, mm] = addMonth(y, m, k);
      const p = payDate(job, yy, mm);
      if (p && p.date === dateStr) { y = yy; m = mm; break; }
    }
    const [ny, nm] = addMonth(y, m, delta);
    return payDate(job, ny, nm);
  }

  function describe(job) {
    if (!job || !job.payDay) return '';
    const d = job.payDay === 'end' ? '末日' : `${job.payDay}日`;
    const s = { before: '土日祝は前の営業日', after: '土日祝は次の営業日', none: '土日祝でもずらさない' }[job.payShift || 'before'];
    return `毎月${d}（${s}）`;
  }

  const api = { holidays, holidayName, isBankHoliday, payDate, lastPayDateOnOrBefore, stepPayDate, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FuyouHolidays = api;
})(typeof window !== 'undefined' ? window : globalThis);
