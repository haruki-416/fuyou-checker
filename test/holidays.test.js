const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../js/holidays.js');

test('2026年の祝日（シルバーウィーク・振替休日を含む）', () => {
  const h = H.holidays(2026);
  const expected = ['2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04',
    '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23'];
  assert.deepEqual(Object.keys(h).sort(), expected);
  assert.equal(h['2026-05-06'], '振替休日');
  assert.equal(h['2026-09-22'], '国民の休日');
});

test('2025年：振替休日', () => {
  const h = H.holidays(2025);
  assert.equal(h['2025-02-24'], '振替休日'); // 天皇誕生日が日曜
  assert.equal(h['2025-05-06'], '振替休日');
  assert.equal(h['2025-11-24'], '振替休日');
});

test('25日払い・前倒し：2026年1月25日(日)→23日(金)', () => {
  const job = { payDay: 25, payShift: 'before' };
  assert.equal(H.payDate(job, 2026, 1).date, '2026-01-23');
  assert.equal(H.payDate(job, 2026, 2).date, '2026-02-25');
  assert.equal(H.payDate({ payDay: 25, payShift: 'after' }, 2026, 1).date, '2026-01-26');
  assert.equal(H.payDate({ payDay: 25, payShift: 'none' }, 2026, 1).date, '2026-01-25');
});

test('祝日をまたいでずらす：2026/5/5払い・後ろ倒し→5/7', () => {
  assert.equal(H.payDate({ payDay: 5, payShift: 'after' }, 2026, 5).date, '2026-05-07');
  assert.equal(H.payDate({ payDay: 5, payShift: 'before' }, 2026, 5).date, '2026-05-01');
});

test('末日払い：2月は28日、年末は12/31が銀行休業', () => {
  assert.equal(H.payDate({ payDay: 'end', payShift: 'before' }, 2026, 2).date, '2026-02-27'); // 28日は土曜
  assert.equal(H.payDate({ payDay: 'end', payShift: 'before' }, 2026, 12).date, '2026-12-30');
  assert.equal(H.payDate({ payDay: 31, payShift: 'none' }, 2026, 4).date, '2026-04-30');
});

test('1/1払い・後ろ倒し：年始休みをこえて1/5', () => {
  assert.equal(H.payDate({ payDay: 1, payShift: 'after' }, 2027, 1).date, '2027-01-04');
  assert.equal(H.payDate({ payDay: 1, payShift: 'after' }, 2026, 1).date, '2026-01-05');
});

test('直近の支給日・前後の月へ移動（月をまたぐ前倒しも）', () => {
  const job = { payDay: 25, payShift: 'before' };
  assert.equal(H.lastPayDateOnOrBefore(job, '2026-11-22').date, '2026-10-23'); // 10/25は日曜
  assert.equal(H.stepPayDate(job, '2026-10-23', 1).date, '2026-11-25');
  const first = { payDay: 1, payShift: 'before' };
  const aug = H.payDate(first, 2026, 8); // 8/1(土)→7/31
  assert.equal(aug.date, '2026-07-31');
  assert.equal(H.stepPayDate(first, '2026-07-31', 1).date, '2026-09-01');
  assert.equal(H.stepPayDate(first, '2026-07-31', -1).date, '2026-07-01');
});
