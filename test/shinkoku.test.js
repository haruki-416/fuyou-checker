const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/shinkoku.js');

test('和暦への変換', () => {
  assert.deepEqual(S.toEra('2005-04-01'), { era: '平', y: 17, m: 4, d: 1 });
  assert.deepEqual(S.toEra('2019-04-30'), { era: '平', y: 31, m: 4, d: 30 });
  assert.deepEqual(S.toEra('2019-05-01'), { era: '令', y: 1, m: 5, d: 1 });
  assert.deepEqual(S.toEra('1989-01-07'), { era: '昭', y: 64, m: 1, d: 7 });
  assert.deepEqual(S.toEra('1989-01-08'), { era: '平', y: 1, m: 1, d: 8 });
});

test('郵便番号の分割', () => {
  assert.deepEqual(S.splitZip('100-8978'), ['100', '8978']);
  assert.deepEqual(S.splitZip('１００８９７８'.normalize('NFKC')), ['100', '8978']);
  assert.deepEqual(S.splitZip('12'), ['', '']);
});

test('勤労学生の判定（令和9年分：合計所得89万円以下・給与以外10万円以下）', () => {
  const inc = (kyuyo, contract = 0, other = 0) => ({ kyuyo, contract, other, total: kyuyo + contract + other });
  assert.equal(S.kinroCheck({ isStudent: true, income: inc(890000), formYear: 2027 }).ok, true);
  assert.equal(S.kinroCheck({ isStudent: true, income: inc(890001), formYear: 2027 }).ok, false);
  assert.equal(S.kinroCheck({ isStudent: false, income: inc(100000), formYear: 2027 }).ok, false);
  assert.equal(S.kinroCheck({ isStudent: true, income: inc(300000, 150000), formYear: 2027 }).ok, false);
  assert.equal(S.kinroCheck({ isStudent: true, income: inc(0), formYear: 2027 }).ok, false);
});

test('記入内容：マイナンバーは必ず手書き扱い、学生なら勤労学生欄', () => {
  const p = { name: '山田　太郎', kana: 'ヤマダ　タロウ', zip: '1008978', address: '東京都千代田区', householder: '山田　一郎', relation: '父', kinro: true, school: '○○大学 2年', payerName: '株式会社カフェ' };
  const e = S.buildEntries(p, { birthDate: '2005-04-01', formYear: 2027 });
  const by = (label) => e.find((x) => x.label === label);
  assert.equal(by('あなたの個人番号').kind, 'hand');
  assert.equal(by('あなたの個人番号').value, '');
  assert.equal(by('あなたの生年月日').value, '平 17年 4月 1日');
  assert.equal(by('配偶者の有無').value, '無');
  assert.equal(by('勤労学生').kind, 'check');
  assert.equal(by('障害者又は勤労学生の内容').value, '○○大学 2年');
  assert.equal(by('郵便番号').value, '100-8978');
});
