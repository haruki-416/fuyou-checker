const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');

const r26 = C.getRules(2026);
const r25 = C.getRules(2025);

test('家内労働者等の特例：2025=65万、2026=69万', () => {
  assert.equal(r25.kanaiMin, 650000);
  assert.equal(r26.kanaiMin, 690000);
});

test('業務委託の所得：収入−経費', () => {
  const o = { revenue: 1000000, expenses: 100000, kanaiRevenue: 0, kanaiExpenses: 0 };
  assert.equal(C.contractIncome(o, 0, r26).income, 900000);
});

test('家内労働者等の特例：経費が少なくても69万円まで', () => {
  const o = { revenue: 1000000, expenses: 50000, kanaiRevenue: 1000000, kanaiExpenses: 50000 };
  const r = C.contractIncome(o, 0, r26);
  assert.equal(r.income, 310000);
  assert.ok(r.kanaiApplied);
  // 給与が40万あれば 69万−40万=29万 と実経費の多いほう
  assert.equal(C.contractIncome(o, 400000, r26).income, 710000);
  // 給与が69万以上なら特例なし
  assert.equal(C.contractIncome(o, 700000, r26).income, 950000);
});

function data(payments, jobs, settings = {}) {
  return { settings: { year: 2026, birthDate: '2006-04-01', dependentType: 'parent', isStudent: true, ...settings }, jobs, payments };
}
const months = (jobId, n, gross, extra = {}) => Array.from({ length: n }, (_, i) =>
  ({ id: jobId + i, jobId, payDate: `2026-${String(i + 1).padStart(2, '0')}-25`, gross, ...extra }));

test('給与だけなら今までどおり年収で判定（壁は136万円など）', () => {
  const s = C.summarize(data(months('a', 12, 100000), [{ id: 'a', name: 'A', taxColumn: 'kou' }]), '2027-01-10');
  assert.equal(s.mixed, false);
  assert.equal(s.walls.find((w) => w.id === 'fuyou-name').limit, 1360000);
});

test('業務委託だけ：経費が少ないと所得で壁を超える（給与なら超えない額でも）', () => {
  // 20歳。報酬 月10万×12＝120万、経費 月5千
  const s = C.summarize(data(months('c', 12, 100000, { expenses: 5000, withholding: 10210 }),
    [{ id: 'c', name: '採点', kind: 'contract' }]), '2027-01-10');
  assert.equal(s.mixed, true);
  assert.equal(s.income.now.contract, 1140000);
  assert.equal(s.income.now.total, 1140000);
  // 親の控除が減り始める（合計所得85万）を超えている
  assert.equal(s.walls.find((w) => w.id === 'tokutei-full').status, 'over');
  // 所得税：114万−基礎控除104万＝10万 → 約5,100円。源泉は122,520円 → 還付
  assert.equal(s.tax.now.tax, 5100);
  assert.equal(s.tax.refund, 122520 - 5100);
  assert.ok(s.advice.some((a) => a.title.includes('確定申告')));
  // 勤務先の社保には入れない
  assert.equal(s.jobChecks[0].covered, false);
});

test('業務委託＋家内労働者等の特例なら所得が下がる', () => {
  const s = C.summarize(data(months('c', 12, 100000, { expenses: 5000 }),
    [{ id: 'c', name: '採点', kind: 'contract', kanai: true }]), '2027-01-10');
  assert.equal(s.income.now.contract, 1200000 - 690000);
  assert.equal(s.walls.find((w) => w.id === 'tokutei-full').status, 'ok');
  assert.ok(s.advice.some((a) => a.title.includes('家内労働者')));
});

test('給与＋業務委託の合算と社保の見込み', () => {
  const jobs = [{ id: 'a', name: 'カフェ', taxColumn: 'kou', contractMonthly: 80000 }, { id: 'c', name: 'ライター', kind: 'contract' }];
  const pays = [...months('a', 10, 80000), ...months('c', 10, 30000, { expenses: 2000 })];
  const s = C.summarize(data(pays, jobs, { birthDate: '2000-01-01' }), '2026-11-01');
  // 給与 80万 → 給与所得 6万、業務委託 28万
  assert.equal(s.income.now.kyuyo, 60000);
  assert.equal(s.income.now.contract, 280000);
  assert.equal(s.income.now.total, 340000);
  // 社保：契約96万 + 業務委託3万×12＝36万 → 132万 ≥ 130万
  assert.equal(s.shaho.contractAnnual, 1320000);
  assert.equal(s.shaho.statusContract, 'over');
  // 経費を引く設定なら 96万 + 2.8万×12 = 129.6万
  const s2 = C.summarize(data(pays, jobs, { birthDate: '2000-01-01', shahoDeductExpenses: true }), '2026-11-01');
  assert.equal(s2.shaho.contractAnnual, 1296000);
  assert.equal(s2.shaho.statusContract, 'ok');
});

test('「給与以外の所得」も壁の判定に入る（以前は所得税だけだった）', () => {
  const s = C.summarize(data(months('a', 12, 100000), [{ id: 'a', name: 'A', taxColumn: 'kou' }], { birthDate: '2000-01-01', otherIncome: 300000 }), '2027-01-10');
  assert.equal(s.mixed, true);
  // 給与所得 120万−74万=46万 + 30万 = 76万 > 62万
  assert.equal(s.income.now.total, 760000);
  assert.equal(s.walls.find((w) => w.id === 'fuyou').status, 'over');
});
