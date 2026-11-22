/**
 * 扶養チェッカー 計算ロジック（画面に依存しない純粋関数）
 * ブラウザでは window.FuyouCalc、Node では require('./calc.js') で使えます。
 */
(function (root) {
  'use strict';

  const R = typeof module !== 'undefined' && module.exports ? require('./rules.js') : root.FuyouRules;

  // ---------- 基本ユーティリティ ----------
  const floorTo = (v, unit) => Math.floor(v / unit) * unit;

  function getRules(year) {
    const r = R.RULES[year];
    if (!r) throw new Error(`${year}年のルールがありません（js/rules.js に追加してください）`);
    return r;
  }

  /** その年の12月31日時点の年齢（税・社保の判定はこの年齢で行う） */
  function ageAtYearEnd(birthDate, year) {
    if (!birthDate) return null;
    const by = Number(String(birthDate).slice(0, 4));
    if (!by) return null;
    return year - by; // 12/31時点なので誕生日を過ぎた年齢＝年の差
  }

  // ---------- 所得税まわり ----------
  /** 給与所得控除額 */
  function kyuyoKojo(salary, rules) {
    let std;
    if (salary <= 1625000) std = 550000;
    else if (salary <= 1800000) std = salary * 0.4 - 100000;
    else if (salary <= 3600000) std = salary * 0.3 + 80000;
    else if (salary <= 6600000) std = salary * 0.2 + 440000;
    else if (salary <= 8500000) std = salary * 0.1 + 1100000;
    else std = 1950000;
    return Math.min(salary, Math.max(rules.kyuyoMin, Math.floor(std)));
  }

  /** 給与所得（＝合計所得金額。給与だけの人の場合） */
  function kyuyoShotoku(salary, rules) {
    return Math.max(0, salary - kyuyoKojo(salary, rules));
  }

  function kisoKojo(income, rules) {
    for (const [limit, amount] of rules.kiso) if (income <= limit) return amount;
    return 0;
  }

  function progressiveTax(taxable) {
    const b = [
      [1949000, 0.05, 0],
      [3299000, 0.1, 97500],
      [6949000, 0.2, 427500],
      [8999000, 0.23, 636000],
      [17999000, 0.33, 1536000],
      [39999000, 0.4, 2796000],
      [Infinity, 0.45, 4796000],
    ];
    for (const [lim, rate, sub] of b) if (taxable <= lim) return Math.max(0, taxable * rate - sub);
    return 0;
  }

  /**
   * 年間の所得税（復興特別所得税込み）の概算
   * @param salary 年間の給与収入（非課税の通勤手当は除く）
   * @param shaho 年間の社会保険料（天引き分）
   * @param otherIncome 給与以外の所得（雑所得など）
   */
  function incomeTax(salary, shaho, rules, otherIncome = 0) {
    const kyuyo = kyuyoShotoku(salary, rules);
    const total = kyuyo + otherIncome;
    const kiso = kisoKojo(total, rules);
    const taxable = floorTo(Math.max(0, total - kiso - shaho), 1000);
    const tax = floorTo(progressiveTax(taxable) * 1.021, 100);
    return { kyuyoShotoku: kyuyo, totalIncome: total, kiso, taxable, tax };
  }

  /** 給与だけの人が所得税ゼロでいられる年収の上限 */
  function incomeTaxFreeLimit(rules) {
    return rules.kiso[0][1] + rules.kyuyoMin;
  }

  /** 合計所得から給与収入に換算（壁を「年収」で表示するため） */
  function incomeToSalary(income, rules) {
    return income + rules.kyuyoMin; // 壁はすべて最低保障額の範囲内（〜220万）なのでこれで正確
  }

  // ---------- 親（扶養者）が受ける控除 ----------
  function tokuteiShinzokuDeduction(income, rules) {
    if (income <= rules.fuyouIncome) return 0; // この範囲は「特定扶養控除」
    for (const [limit, amount] of rules.tokuteiShinzoku) if (income <= limit) return amount;
    return 0;
  }

  /** 親が受けられる控除（所得税）を年齢と所得から判定 */
  function parentDeduction(income, age, rules) {
    if (age == null) return { name: '不明', amount: 0 };
    if (age < 16) return { name: '扶養控除の対象外（16歳未満）', amount: 0 };
    if (age >= 19 && age <= 22) {
      if (income <= rules.fuyouIncome) return { name: '特定扶養控除', amount: 630000 };
      const a = tokuteiShinzokuDeduction(income, rules);
      return a > 0 ? { name: '特定親族特別控除', amount: a } : { name: 'なし', amount: 0 };
    }
    if (income <= rules.fuyouIncome) {
      if (age >= 70) return { name: '老人扶養控除', amount: 480000 };
      return { name: '一般の扶養控除', amount: 380000 };
    }
    return { name: 'なし', amount: 0 };
  }

  // ---------- 社会保険 ----------
  function shahoDependentLimit(age, relation, isSenior) {
    if (isSenior || (age != null && age >= 60)) return R.SHAHO_DEPENDENT.senior;
    if (relation !== 'spouse' && age != null && age >= 19 && age <= 22) return R.SHAHO_DEPENDENT.age19to22;
    return R.SHAHO_DEPENDENT.normal;
  }

  /** ある日付時点で有効な、勤務先社保の賃金要件（月額）。撤廃後は null */
  function shahoWageRequirement(rules, dateStr) {
    for (const w of rules.shahoWageReq || []) if (dateStr <= w.until) return w.amount;
    return null;
  }

  /** 勤務先の社会保険に加入対象か（短時間労働者の適用拡大） */
  function jobShahoCheck(job, settings, rules, todayStr, avgMonthly) {
    const reasons = [];
    const hours = Number(job.weeklyHours) || 0;
    if (job.fullTimeLike) return { covered: true, reasons: ['フルタイム相当（所定労働時間が正社員の3/4以上）'] };
    if (hours < 20) reasons.push(`週の所定労働時間が${hours}時間（20時間未満）`);
    if (!job.companyLarge) reasons.push('勤務先が適用拡大の対象規模ではない');
    if (settings.isStudent) reasons.push('昼間の学生（原則対象外）');
    const wage = shahoWageRequirement(rules, todayStr);
    if (wage && avgMonthly < wage) reasons.push(`月の賃金が${wage.toLocaleString()}円未満`);
    if (reasons.length === 0) {
      return { covered: true, reasons: ['週20時間以上・対象規模・学生でない → 勤務先の社会保険に加入'] };
    }
    return { covered: false, reasons };
  }

  // ---------- 源泉徴収チェック ----------
  function withholdingCheck(payment, job, rules) {
    const base = (payment.gross || 0) - (payment.shaho || 0);
    const w = payment.withholding || 0;
    if (!job) return null;
    if (job.taxColumn === 'kou') {
      if (base < rules.kouZeroBelow && w > 0) {
        return {
          level: 'warn',
          msg: `甲欄なら社保控除後${rules.kouZeroBelow.toLocaleString()}円未満は源泉0円のはずです。扶養控除等申告書を出しているか確認しましょう（年末調整か確定申告で戻ります）`,
        };
      }
    } else if (job.taxColumn === 'otsu') {
      const expected = Math.floor(base * 0.03063);
      if (base < rules.kouZeroBelow && w === 0 && base > 0) {
        return { level: 'info', msg: `乙欄なら約${expected.toLocaleString()}円（3.063%）引かれるのが普通です。実は甲欄かも？給与明細を確認してください` };
      }
    }
    return null;
  }

  // ---------- 集計 ----------
  function yearOf(dateStr) {
    return Number(String(dateStr || '').slice(0, 4));
  }
  function monthOf(dateStr) {
    return Number(String(dateStr || '').slice(5, 7));
  }

  /**
   * ダッシュボードに必要なものを全部計算する
   * @param data { settings, jobs, payments }
   * @param todayStr 'YYYY-MM-DD'
   */
  function summarize(data, todayStr) {
    const settings = data.settings || {};
    const year = Number(settings.year);
    const rules = getRules(year);
    const age = ageAtYearEnd(settings.birthDate, year);
    const jobs = data.jobs || [];
    const jobById = Object.fromEntries(jobs.map((j) => [j.id, j]));

    // その年に「支給された」給料だけ（税金は支給日ベース）
    const pays = (data.payments || []).filter((p) => yearOf(p.payDate) === year);

    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, gross: 0, commute: 0, withholding: 0, shaho: 0, byJob: {} }));
    const byJob = Object.fromEntries(jobs.map((j) => [j.id, { gross: 0, commute: 0, withholding: 0, shaho: 0, count: 0, months: new Set() }]));
    const paymentWarnings = [];

    for (const p of pays) {
      const m = months[monthOf(p.payDate) - 1];
      if (!m) continue;
      const g = Number(p.gross) || 0, c = Number(p.commute) || 0, w = Number(p.withholding) || 0, s = Number(p.shaho) || 0;
      m.gross += g; m.commute += c; m.withholding += w; m.shaho += s;
      m.byJob[p.jobId] = (m.byJob[p.jobId] || 0) + g;
      const bj = byJob[p.jobId];
      if (bj) { bj.gross += g; bj.commute += c; bj.withholding += w; bj.shaho += s; bj.count++; bj.months.add(m.month); }
      const chk = withholdingCheck({ gross: g, shaho: s, withholding: w }, jobById[p.jobId], rules);
      if (chk) paymentWarnings.push({ ...chk, paymentId: p.id, payDate: p.payDate, jobName: jobById[p.jobId]?.name || '?' });
    }

    const ytd = months.reduce((a, m) => ({ gross: a.gross + m.gross, commute: a.commute + m.commute, withholding: a.withholding + m.withholding, shaho: a.shaho + m.shaho }), { gross: 0, commute: 0, withholding: 0, shaho: 0 });

    // 年末までの見込み
    const todayY = yearOf(todayStr), todayM = monthOf(todayStr);
    const paidMonths = months.filter((m) => m.gross > 0).map((m) => m.month);
    const lastPaid = paidMonths.length ? Math.max(...paidMonths) : 0;
    let remainingMonths;
    if (year < todayY) remainingMonths = 0;
    else if (year > todayY) remainingMonths = 12 - lastPaid;
    else remainingMonths = 12 - Math.max(lastPaid, todayM - 1);
    remainingMonths = Math.max(0, remainingMonths);

    const recent = paidMonths.slice(-3);
    const avgMonthly = recent.length ? Math.round(recent.reduce((a, mm) => a + months[mm - 1].gross, 0) / recent.length) : 0;
    const avgMonthlyWithCommute = recent.length ? Math.round(recent.reduce((a, mm) => a + months[mm - 1].gross + months[mm - 1].commute, 0) / recent.length) : 0;
    const avgShaho = recent.length ? Math.round(recent.reduce((a, mm) => a + months[mm - 1].shaho, 0) / recent.length) : 0;

    const plannedExtra = Number(settings.plannedExtra) || 0; // 年末までの予定（シフト確定分など）を手入力した場合
    const projected = settings.useManualProjection ? ytd.gross + plannedExtra : ytd.gross + avgMonthly * remainingMonths;
    const projectedShaho = ytd.shaho + avgShaho * remainingMonths;

    // ---------- 壁 ----------
    const walls = [];
    const relation = settings.dependentType || 'parent'; // parent | spouse | none
    const kyu = settings.juminKyuchi || 1;
    const juminLimit = incomeToSalary(rules.juminNonTaxIncome[kyu], rules);

    walls.push({
      id: 'jumin', kind: 'tax', label: '住民税がかかり始める（自分）', limit: juminLimit, inclusive: true,
      over: `${rules.juminFiscalLabel}が自分にかかります（年数千円〜。自治体で基準が少し違います）`,
      who: '自分',
    });

    if (relation === 'parent') {
      const fuyouSalary = incomeToSalary(rules.fuyouIncome, rules);
      if (age != null && age >= 19 && age <= 22) {
        const fullSalary = incomeToSalary(rules.tokuteiShinzoku[0][0], rules);
        const endSalary = incomeToSalary(rules.tokuteiShinzoku[rules.tokuteiShinzoku.length - 1][0], rules);
        walls.push({ id: 'fuyou-name', kind: 'tax', label: '親の控除の名前が変わる（減らない）', limit: fuyouSalary, inclusive: true, info: true,
          over: '親の控除は「特定親族特別控除」に切り替わります（63万円のまま）。親の年末調整で申告書の提出が必要です', who: '親' });
        walls.push({ id: 'tokutei-full', kind: 'tax', label: '親の控除が減り始める', limit: fullSalary, inclusive: true,
          over: '親の特定親族特別控除が段階的に減ります（親の税金が少し増える）', who: '親' });
        walls.push({ id: 'tokutei-end', kind: 'tax', label: '親の控除がゼロになる', limit: endSalary, inclusive: true,
          over: '親は控除を受けられなくなります', who: '親' });
      } else if (age != null && age < 16) {
        // 16歳未満は扶養控除自体がない
      } else {
        walls.push({ id: 'fuyou', kind: 'tax', label: '親の扶養控除がなくなる', limit: fuyouSalary, inclusive: true,
          over: '親が扶養控除（38万円など）を受けられなくなり、親の税金が増えます', who: '親' });
      }
    } else if (relation === 'spouse') {
      const fuyouSalary = incomeToSalary(rules.fuyouIncome, rules);
      const fullSalary = incomeToSalary(rules.haigushaFullIncome, rules);
      walls.push({ id: 'haigusha', kind: 'tax', label: '配偶者控除 → 配偶者特別控除', limit: fuyouSalary, inclusive: true, info: true,
        over: '配偶者控除から配偶者特別控除に切り替わります（控除額はほぼ同じ）', who: '配偶者' });
      walls.push({ id: 'haigusha-full', kind: 'tax', label: '配偶者特別控除が減り始める', limit: fullSalary, inclusive: true,
        over: '配偶者特別控除が段階的に減ります', who: '配偶者' });
    }

    walls.push({ id: 'shotoku', kind: 'tax', label: '所得税がかかり始める（自分）', limit: incomeTaxFreeLimit(rules), inclusive: true,
      over: '自分に所得税がかかります（超えた分の約5%）', who: '自分' });

    // 社会保険（扶養）
    const jobChecks = jobs.filter((j) => j.active !== false).map((j) => {
      const bj = byJob[j.id];
      const avg = Number(j.contractMonthly) || (bj && bj.months.size ? bj.gross / bj.months.size : 0);
      return { job: j, ...jobShahoCheck(j, settings, rules, todayStr, avg) };
    });
    const ownShaho = jobChecks.some((c) => c.covered);
    let shaho = null;
    if (relation !== 'none') {
      const limit = shahoDependentLimit(age, relation, settings.isSenior);
      const contract = Number(settings.contractAnnual) ||
        jobs.filter((j) => j.active !== false).reduce((a, j) => a + (Number(j.contractMonthly) || 0), 0) * 12;
      const pace = avgMonthlyWithCommute * 12;
      shaho = {
        limit, monthlyLimit: Math.ceil(limit / 12), contractAnnual: contract, paceAnnual: pace,
        ownShaho,
        statusContract: contract ? (contract >= limit ? 'over' : 'ok') : 'unknown',
        statusPace: pace >= limit ? 'over' : pace >= limit * 0.9 ? 'near' : 'ok',
        overMonths: months.filter((m) => m.gross + m.commute >= Math.ceil(limit / 12)).map((m) => m.month),
      };
    }

    walls.sort((a, b) => a.limit - b.limit);

    // 各壁の状態
    for (const w of walls) {
      const cmpOver = (v) => (w.inclusive ? v > w.limit : v >= w.limit);
      w.current = ytd.gross;
      w.projected = projected;
      w.remaining = w.limit - ytd.gross;
      w.perMonth = remainingMonths > 0 ? Math.floor(Math.max(0, w.remaining) / remainingMonths) : null;
      if (cmpOver(ytd.gross)) w.status = 'over';
      else if (cmpOver(projected)) w.status = 'warn';
      else if (projected > w.limit * 0.92) w.status = 'near';
      else w.status = 'ok';
    }

    // ---------- 税金・源泉徴収・確定申告 ----------
    const annualBase = year < todayY ? ytd.gross : projected;
    const taxNow = incomeTax(ytd.gross, ytd.shaho, rules, Number(settings.otherIncome) || 0);
    const taxProjected = incomeTax(annualBase, year < todayY ? ytd.shaho : projectedShaho, rules, Number(settings.otherIncome) || 0);
    const parentNow = relation === 'parent' ? parentDeduction(taxProjected.kyuyoShotoku, age, rules) : null;

    const kouJobs = jobs.filter((j) => j.taxColumn === 'kou' && j.active !== false);
    const otsuJobs = jobs.filter((j) => j.taxColumn === 'otsu');
    const otsuGross = otsuJobs.reduce((a, j) => a + (byJob[j.id]?.gross || 0), 0);
    const advice = [];

    if (kouJobs.length > 1) {
      advice.push({ level: 'danger', title: '甲欄が2か所以上あります',
        body: `「扶養控除等申告書」を出せるのは1か所だけです（${kouJobs.map((j) => j.name).join('・')}）。メインのバイト先以外には出さず、乙欄にしてもらいましょう。2か所に出したままだと、後で確定申告をして税金を払う必要が出ることがあります。` });
    }
    if (jobs.length > 0 && kouJobs.length === 0) {
      advice.push({ level: 'warn', title: '甲欄のバイト先がありません',
        body: '一番長く続けるバイト先に「扶養控除等申告書」を出すと、源泉徴収が少なくなり、年末調整もしてもらえます。' });
    }

    const refund = ytd.withholding - taxNow.tax;
    const needKakutei = taxProjected.tax > 0 && otsuGross > 200000;
    if (needKakutei) {
      advice.push({ level: 'danger', title: '確定申告が必要になりそうです',
        body: `年末調整されないバイト（乙欄）の給料が20万円を超え、所得税もかかる見込みです。翌年2/16〜3/15に確定申告をしましょう。` });
    } else if (ytd.withholding > 0 && refund > 0) {
      const why = otsuJobs.length ? '乙欄のバイト先や辞めたバイト先で引かれた税金は、年末調整では戻りません。' : '年末調整を受けられなかった場合も同じです。';
      advice.push({ level: 'good', title: `確定申告（還付申告）で約${refund.toLocaleString()}円戻るかも`,
        body: `今年の所得税は${taxNow.tax.toLocaleString()}円の見込みなのに、${ytd.withholding.toLocaleString()}円引かれています。${why}還付申告は翌年1月から5年間できます（スマホのe-Taxで可）。` });
    }
    if (otsuJobs.length && !needKakutei) {
      advice.push({ level: 'info', title: '掛け持ちのポイント',
        body: '年末調整はメイン（甲欄）のバイト先の分しか計算されません。他のバイト先からも「源泉徴収票」を必ずもらっておきましょう（確定申告で使います）。' });
    }

    // 社保のアドバイス
    if (shaho) {
      if (ownShaho) {
        advice.push({ level: 'warn', title: '勤務先の社会保険に入る条件を満たしています',
          body: 'この場合は親・配偶者の扶養（健康保険）から外れ、自分で健康保険・厚生年金に入ります。130万円の壁は関係なくなります。' });
      } else if (shaho.statusContract === 'over') {
        advice.push({ level: 'danger', title: '契約上の見込み年収が社会保険の扶養ラインを超えています',
          body: `労働条件通知書ベースの年収が${shaho.limit.toLocaleString()}円以上です。扶養者の勤務先（健康保険）に早めに確認しましょう。` });
      } else if (shaho.statusPace !== 'ok') {
        advice.push({ level: 'warn', title: '最近のペースだと社会保険の扶養ラインに近い／超えています',
          body: `直近の月収（通勤手当込み）×12 ＝ 約${shaho.paceAnnual.toLocaleString()}円。2026年4月からは原則「労働契約上の見込み年収」で判定されるので、残業などの一時的な増加ならすぐ外れるとは限りません。ただ、シフトが恒常的に増えているなら外れる可能性があります。` });
      }
    }

    return {
      year, rules, age, settings,
      months, byJob, ytd, avgMonthly, remainingMonths, projected,
      walls, shaho, jobChecks,
      tax: { now: taxNow, projected: taxProjected, refund },
      parentDeduction: parentNow,
      advice, paymentWarnings,
    };
  }

  const api = {
    getRules, ageAtYearEnd, kyuyoKojo, kyuyoShotoku, kisoKojo, incomeTax, incomeTaxFreeLimit,
    incomeToSalary, tokuteiShinzokuDeduction, parentDeduction, shahoDependentLimit,
    shahoWageRequirement, jobShahoCheck, withholdingCheck, summarize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FuyouCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
