// 実行: npm test  （Node.js 18以上）
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');

const r25 = C.getRules(2025);
const r26 = C.getRules(2026);

test('所得税がかからない年収: 2025=160万, 2026=178万', () => {
  assert.equal(C.incomeTaxFreeLimit(r25), 1600000);
  assert.equal(C.incomeTaxFreeLimit(r26), 1780000);
  assert.equal(C.incomeTax(1780000, 0, r26).tax, 0);
  assert.ok(C.incomeTax(1800000, 0, r26).tax > 0);
  assert.equal(C.incomeTax(1600000, 0, r25).tax, 0);
});

test('2026年 179万円 → 課税所得1万円 → 約500円', () => {
  const t = C.incomeTax(1790000, 0, r26);
  assert.equal(t.kyuyoShotoku, 1050000);
  assert.equal(t.taxable, 10000);
  assert.equal(t.tax, 500);
});

test('給与所得控除: 2026は220万円まで74万円', () => {
  assert.equal(C.kyuyoKojo(2000000, r26), 740000);
  assert.equal(C.kyuyoKojo(2200000, r26), 740000);
  assert.equal(C.kyuyoKojo(3000000, r26), 980000);
  assert.equal(C.kyuyoKojo(500000, r26), 500000); // 収入より大きくはならない
});

test('親の扶養: 2026は136万円まで', () => {
  const inc = (s) => C.kyuyoShotoku(s, r26);
  assert.equal(C.parentDeduction(inc(1360000), 17, r26).amount, 380000);
  assert.equal(C.parentDeduction(inc(1370000), 17, r26).amount, 0);
});

test('19〜22歳: 159万まで満額63万、197万でゼロ', () => {
  const inc = (s) => C.kyuyoShotoku(s, r26);
  assert.equal(C.parentDeduction(inc(1360000), 20, r26).name, '特定扶養控除');
  assert.equal(C.parentDeduction(inc(1500000), 20, r26).name, '特定親族特別控除');
  assert.equal(C.parentDeduction(inc(1590000), 20, r26).amount, 630000);
  assert.equal(C.parentDeduction(inc(1600000), 20, r26).amount, 610000);
  assert.equal(C.parentDeduction(inc(1970000), 20, r26).amount, 30000);
  assert.equal(C.parentDeduction(inc(1980000), 20, r26).amount, 0);
});

test('2025年の19〜22歳: 150万まで満額、188万でゼロ', () => {
  const inc = (s) => C.kyuyoShotoku(s, r25);
  assert.equal(C.parentDeduction(inc(1500000), 20, r25).amount, 630000);
  assert.equal(C.parentDeduction(inc(1880000), 20, r25).amount, 30000);
  assert.equal(C.parentDeduction(inc(1890000), 20, r25).amount, 0);
});

test('社保の扶養ライン', () => {
  assert.equal(C.shahoDependentLimit(20, 'parent'), 1500000);
  assert.equal(C.shahoDependentLimit(20, 'spouse'), 1300000);
  assert.equal(C.shahoDependentLimit(17, 'parent'), 1300000);
  assert.equal(C.shahoDependentLimit(62, 'spouse'), 1800000);
});

test('106万円の壁は2026年10月に撤廃', () => {
  assert.equal(C.shahoWageRequirement(r26, '2026-09-30'), 88000);
  assert.equal(C.shahoWageRequirement(r26, '2026-10-01'), null);
});

test('掛け持ち: 乙欄の源泉が還付見込みとして出る', () => {
  const data = {
    settings: { year: 2025, birthDate: '2005-05-01', isStudent: true, dependentType: 'parent' },
    jobs: [
      { id: 'a', name: 'カフェ', taxColumn: 'kou', weeklyHours: 15 },
      { id: 'b', name: '塾', taxColumn: 'otsu', weeklyHours: 6 },
    ],
    payments: [],
  };
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    data.payments.push({ id: 'a' + m, jobId: 'a', payDate: `2025-${mm}-25`, gross: 70000, withholding: 0 });
    data.payments.push({ id: 'b' + m, jobId: 'b', payDate: `2025-${mm}-10`, gross: 30000, withholding: 918 });
  }
  const s = C.summarize(data, '2026-02-01');
  assert.equal(s.ytd.gross, 1200000);
  assert.equal(s.age, 20);
  assert.equal(s.tax.now.tax, 0);
  assert.equal(s.tax.refund, 918 * 12);
  assert.ok(s.advice.some((a) => a.title.includes('還付')));
  const shotoku = s.walls.find((w) => w.id === 'shotoku');
  assert.equal(shotoku.status, 'ok');
});

test('甲欄が2か所なら警告', () => {
  const s = C.summarize({
    settings: { year: 2026, birthDate: '2000-01-01', dependentType: 'none' },
    jobs: [{ id: 'a', name: 'A', taxColumn: 'kou' }, { id: 'b', name: 'B', taxColumn: 'kou' }],
    payments: [],
  }, '2026-06-01');
  assert.ok(s.advice.some((a) => a.title.includes('甲欄が2か所')));
});

test('支給日ベースで年をまたぐ（12月分が1月支給なら翌年）', () => {
  const s = C.summarize({
    settings: { year: 2026, birthDate: '2008-01-01', dependentType: 'parent' },
    jobs: [{ id: 'a', name: 'A', taxColumn: 'kou' }],
    payments: [
      { id: '1', jobId: 'a', payDate: '2025-12-25', gross: 50000 },
      { id: '2', jobId: 'a', payDate: '2026-01-25', gross: 60000 },
    ],
  }, '2026-01-30');
  assert.equal(s.ytd.gross, 60000);
});
