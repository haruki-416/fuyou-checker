/**
 * 給与所得者の扶養控除等（異動）申告書：記入ナビとPDFへの書き込み
 *
 * 国税庁の申告書PDF（入力できるPDF）の欄名に合わせて値を入れます。
 * 令和8年分・令和9年分は同じ欄名（Text7 = 氏名 など）であることを確認済み。
 *
 * マイナンバー（個人番号）は扱いません。保存も書き込みもせず、印刷後に手書きしてもらいます。
 */
(function (root) {
  'use strict';

  // 年分 → 和暦表示・勤労学生の所得要件
  const FORM_YEARS = {
    2026: { label: '令和8年分', reiwa: 8, kinroIncome: 890000, note: '2026年中に事情が変わった（新しく扶養に入った人がいる など）ときに出し直す分' },
    2027: { label: '令和9年分', reiwa: 9, kinroIncome: 890000, note: '2027年最初の給料日の前日までに、メインのバイト先に出す分' },
  };
  const KINRO_OTHER_LIMIT = 100000; // 勤労学生：給与など勤労による所得以外の所得は10万円以下

  // 欄名の対応（国税庁PDFのフォームフィールド名）
  const FIELDS = {
    taxOffice: 'Text1',      // 所轄税務署長（勤務先が書くことが多い）
    city: 'Text2',           // 市区町村長
    payerName: 'Text3',      // 給与の支払者の名称
    payerNumber: 'Text4',    // 給与の支払者の法人番号（勤務先が書く）
    payerAddress: 'Text5',   // 給与の支払者の所在地
    kana: 'Text6',
    name: 'Text7',
    myNumber: 'Text8',       // 個人番号：書き込まない
    zip1: 'Text9-1',
    zip2: 'Text9-2',
    address: 'Text10',
    era: 'Dropdown1',        // 明・大・昭・平・令
    birthY: 'Text11',
    birthM: 'Text12',
    birthD: 'Text13',
    householder: 'Text14',
    relation: 'Text15',
    spouse: 'Dropdown2',     // 有・無
    secondary: 'Dropdown3',  // 従たる給与についての扶養控除等申告書の提出（○）
    disabled: 'Check Box13',
    widow: 'Check Box14',
    singleParent: 'Check Box15',
    kinro: 'Check Box16',
    cDetail: 'Text68',       // 障害者又は勤労学生の内容
  };

  /** 西暦の日付 → 和暦（申告書の「明・大・昭・平・令」） */
  function toEra(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const v = y * 10000 + m * 100 + d;
    const eras = [
      [20190501, '令', 2018], [19890108, '平', 1988], [19261225, '昭', 1925], [19120730, '大', 1911], [18680125, '明', 1867],
    ];
    for (const [start, name, base] of eras) if (v >= start) return { era: name, y: y - base, m, d };
    return null;
  }

  /** 郵便番号 '1008978' / '100-8978' → ['100','8978'] */
  function splitZip(z) {
    const s = String(z || '').replace(/[^0-9]/g, '');
    return s.length === 7 ? [s.slice(0, 3), s.slice(3)] : ['', ''];
  }

  /**
   * 勤労学生に当たりそうか（申告書の年の見込みとして、今年の見込みを使う）
   * @param income { total, kyuyo, contract, other } 合計所得の内訳
   */
  function kinroCheck({ isStudent, income, formYear }) {
    const fy = FORM_YEARS[formYear];
    if (!isStudent) return { ok: false, reason: '学生ではない設定です' };
    if (!income) return { ok: false, reason: '所得の見込みがわかりません' };
    if (income.kyuyo <= 0 && income.contract <= 0) return { ok: false, reason: '給与など働いて得た所得がありません' };
    // 業務委託（事業・雑所得）も「勤労による所得」に当たる場合がありますが、判定が難しいので「それ以外」側に数えて厳しめに見る
    const nonWork = (income.contract || 0) + (income.other || 0);
    if (income.total > fy.kinroIncome) return { ok: false, reason: `合計所得の見込みが${fy.kinroIncome / 10000}万円を超えています` };
    if (nonWork > KINRO_OTHER_LIMIT) return { ok: false, reason: '給与以外の所得が10万円を超えています' };
    return { ok: true, reason: `学生で、合計所得の見込みが${fy.kinroIncome / 10000}万円以下（給与だけなら年収${(fy.kinroIncome + 740000) / 10000}万円以下）` };
  }

  /**
   * 記入内容の一覧を作る
   * @param p プロフィール（name, kana, zip, address, householder, relation, spouse, school, kinro, widow, singleParent, secondary, payerName, payerAddress, city, taxOffice）
   * @param ctx { birthDate, formYear }
   * @returns [{ section, label, field, value, kind: 'fill'|'check'|'select'|'hand'|'blank'|'employer', note }]
   */
  function buildEntries(p, ctx) {
    const e = [];
    const era = toEra(ctx.birthDate);
    const [z1, z2] = splitZip(p.zip);
    const add = (section, label, field, value, kind, note) => e.push({ section, label, field, value: value ?? '', kind, note: note || '' });

    const H = '上の欄（あなたと勤務先）';
    add(H, '給与の支払者の名称（氏名）', FIELDS.payerName, p.payerName, p.payerName ? 'fill' : 'hand', 'バイト先の会社名（店名ではなく会社名が分かればそちら）');
    add(H, '給与の支払者の法人（個人）番号', FIELDS.payerNumber, '', 'employer', '勤務先が書く欄。空欄でOK');
    add(H, '給与の支払者の所在地（住所）', FIELDS.payerAddress, p.payerAddress, p.payerAddress ? 'fill' : 'blank', '分からなければ空欄で出しても大丈夫なことが多い（勤務先に確認）');
    add(H, '所轄税務署長', FIELDS.taxOffice, p.taxOffice, p.taxOffice ? 'fill' : 'employer', '勤務先が書くことが多い。空欄でOK');
    add(H, '市区町村長', FIELDS.city, p.city, p.city ? 'fill' : 'blank', '住んでいる市区町村（例：千代田区、横浜市）');
    add(H, 'フリガナ', FIELDS.kana, p.kana, p.kana ? 'fill' : 'hand');
    add(H, 'あなたの氏名', FIELDS.name, p.name, p.name ? 'fill' : 'hand');
    add(H, 'あなたの個人番号', FIELDS.myNumber, '', 'hand', 'マイナンバー（12けた）。このツールでは扱わないので、印刷後に手書き。勤務先の指示で書かない場合もあります');
    add(H, 'あなたの生年月日', `${FIELDS.era} ${FIELDS.birthY} ${FIELDS.birthM} ${FIELDS.birthD}`, era ? `${era.era} ${era.y}年 ${era.m}月 ${era.d}日` : '', era ? 'fill' : 'hand');
    add(H, '郵便番号', `${FIELDS.zip1} ${FIELDS.zip2}`, z1 ? `${z1}-${z2}` : '', z1 ? 'fill' : 'hand');
    add(H, 'あなたの住所又は居所', FIELDS.address, p.address, p.address ? 'fill' : 'hand', '住民票の住所。一人暮らしで住民票を移していない場合は勤務先に相談');
    add(H, '世帯主の氏名', FIELDS.householder, p.householder, p.householder ? 'fill' : 'hand', '住民票の世帯主。実家で親が世帯主なら親の名前、一人暮らしで自分が世帯主なら自分の名前');
    add(H, 'あなたとの続柄', FIELDS.relation, p.relation, p.relation ? 'fill' : 'hand', '世帯主から見たあなたではなく「世帯主はあなたの何か」。父なら「父」、自分なら「本人」');
    add(H, '配偶者の有無', FIELDS.spouse, p.spouse ? '有' : '無', 'select');
    add(H, '従たる給与についての扶養控除等申告書の提出', FIELDS.secondary, p.secondary ? '○' : '', p.secondary ? 'select' : 'blank', 'ほとんどの人は空欄（2か所以上から給料をもらい、もう1か所にも別の申告書を出している場合だけ）');

    add('A 源泉控除対象配偶者', '（記入なし）', '', '', 'blank', p.spouse ? '配偶者を扶養している場合は手書きで記入（このツールは未対応）' : '空欄');
    add('B 源泉控除対象親族', '（記入なし）', '', '', 'blank', '扶養している家族がいなければ空欄。学生のバイトならほぼ空欄');

    const C = 'C 障害者、寡婦、ひとり親又は勤労学生';
    add(C, '勤労学生', FIELDS.kinro, p.kinro ? 'チェック' : '', p.kinro ? 'check' : 'blank', p.kinro ? '' : '学生でない、または所得が多い場合は空欄');
    add(C, '障害者又は勤労学生の内容', FIELDS.cDetail, p.kinro ? (p.school || '') : '', p.kinro ? (p.school ? 'fill' : 'hand') : 'blank', p.kinro ? '学校名・学年（例：○○大学 経済学部 2年）' : '');
    if (p.widow) add(C, '寡婦', FIELDS.widow, 'チェック', 'check');
    if (p.singleParent) add(C, 'ひとり親', FIELDS.singleParent, 'チェック', 'check');
    add(C, '障害者', FIELDS.disabled, '', 'blank', '該当する場合は手書き（区分ごとの人数の記入が必要。このツールは未対応）');

    add('D 他の所得者が控除を受ける扶養親族等', '（記入なし）', '', '', 'blank', '空欄');
    add('住民税に関する事項（16歳未満の扶養親族など）', '（記入なし）', '', '', 'blank', '空欄');
    return e;
  }

  /**
   * 国税庁のPDFに書き込む（ブラウザで PDFLib を使う）
   * @returns Uint8Array（元と同じ制限：印刷・フォーム入力のみ可、で再暗号化）
   */
  async function fillPdf(bytes, p, ctx, PDFLib) {
    const { PDFDocument, PDFName, PDFHexString, PDFBool } = PDFLib;
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { password: '' });
    } catch (e) {
      throw new Error('PDFを開けませんでした。国税庁からダウンロードした「入力用」のPDFか確認してください');
    }
    const form = doc.getForm();
    const has = (n) => { try { form.getField(n); return true; } catch (e) { return false; } };
    if (![FIELDS.name, FIELDS.address, FIELDS.kinro].every(has)) {
      throw new Error('このPDFは扶養控除等申告書の入力用PDFではないようです（入力欄が見つかりません）');
    }
    const setV = (name, val) => {
      if (!has(name)) return;
      const f = form.getField(name);
      f.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(String(val)));
      for (const w of f.acroField.getWidgets()) w.dict.delete(PDFName.of('AP')); // 見た目はビューアに作り直してもらう（日本語フォントのため）
    };
    const era = toEra(ctx.birthDate);
    const [z1, z2] = splitZip(p.zip);
    const text = {
      [FIELDS.payerName]: p.payerName, [FIELDS.payerAddress]: p.payerAddress, [FIELDS.taxOffice]: p.taxOffice, [FIELDS.city]: p.city,
      [FIELDS.kana]: p.kana, [FIELDS.name]: p.name, [FIELDS.zip1]: z1, [FIELDS.zip2]: z2, [FIELDS.address]: p.address,
      [FIELDS.householder]: p.householder, [FIELDS.relation]: p.relation,
      [FIELDS.cDetail]: p.kinro ? p.school : '',
    };
    if (era) Object.assign(text, { [FIELDS.era]: era.era, [FIELDS.birthY]: String(era.y), [FIELDS.birthM]: String(era.m), [FIELDS.birthD]: String(era.d) });
    for (const [k, v] of Object.entries(text)) if (v) setV(k, v);
    setV(FIELDS.spouse, p.spouse ? '有' : '無');
    if (p.secondary) setV(FIELDS.secondary, '○');
    const check = (name, on) => { if (has(name) && on) form.getCheckBox(name).check(); };
    check(FIELDS.kinro, p.kinro);
    check(FIELDS.widow, p.widow);
    check(FIELDS.singleParent, p.singleParent);
    doc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    // 元のPDFと同じく「印刷とフォーム入力だけ許可」で保存する
    doc.encrypt({
      userPassword: '',
      ownerPassword: 'fc-' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      permissions: { printing: 'highResolution', modifying: false, copying: true, annotating: false, fillingForms: true, contentAccessibility: true, documentAssembly: false },
    });
    return doc.save({ updateFieldAppearances: false });
  }

  const api = { FORM_YEARS, FIELDS, toEra, splitZip, kinroCheck, buildEntries, fillPdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FuyouShinkoku = api;
})(typeof window !== 'undefined' ? window : globalThis);
