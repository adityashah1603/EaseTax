// Deductions and credits with limits applied; retirement and foreign.

import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import { compact, fmt, lineRow, money, n, round2, text, type ViewCtx } from './ctx.ts';

const param = (ctx: ViewCtx, name: string) => n(ctx.wp.rawValue(`ref:param.${name}`));

function limitRow(id: string, label: string, claimed: ViewRow['cells'][string], limit: number, limitNote: string, extra: Partial<ViewRow> = {}): ViewRow {
  const over = n(claimed?.value) - limit;
  return {
    id,
    label,
    nodeId: claimed?.nodeId,
    cells: { amount: claimed, limit: { value: round2(limit), note: limitNote }, over: { value: over > 0 ? round2(over) : 0 } },
    ...extra,
  };
}

export function deductionsCredits(ctx: ViewCtx): ViewDto {
  const findings: ViewFlag[] = [];
  const agi = ctx.num('F1040.11');

  // ---- Schedule A
  const schA = compact(['SchA.5a', 'SchA.5b', 'SchA.5d', 'SchA.5e', 'SchA.7', 'SchA.8a', 'SchA.8c', 'SchA.8e', 'SchA.10', 'SchA.11', 'SchA.12', 'SchA.14', 'SchA.17', 'F1040.12'].map((k) => lineRow(ctx, k)));
  const limits: ViewRow[] = [];

  // SALT cap, recomputed from the engine's parameters.
  const cap = Math.max(param(ctx, 'salt_cap_floor'), param(ctx, 'salt_cap') - param(ctx, 'salt_cap_phase_rate') * Math.max(0, agi - param(ctx, 'salt_cap_phase_start')));
  const d5 = ctx.cell('SchA.5d');
  const e5 = ctx.cell('SchA.5e');
  if (d5 && e5) {
    const r = limitRow('salt', 'State and local taxes (SALT cap)', d5, cap, `cap ${fmt(param(ctx, 'salt_cap'))} less ${param(ctx, 'salt_cap_phase_rate') * 100}% of MAGI over ${fmt(param(ctx, 'salt_cap_phase_start'))}, floor ${fmt(param(ctx, 'salt_cap_floor'))}`, { links: ['ref:param.salt_cap', lineId(ctx.v, 'F1040.11')] });
    const allowed = Math.min(n(d5.value), cap);
    r.cells.allowed = e5;
    if (Math.abs(allowed - n(e5.value)) > 1) r.flags = [{ code: 'SALT_CAP', severity: 'error', text: `Recomputed SALT allowed ${fmt(allowed)}; line 5e ${fmt(n(e5.value))}`, nodeIds: [e5.nodeId!] }];
    limits.push(r);
  }
  // Charitable limits.
  const cash = ctx.cell('SchA.11');
  if (cash) limits.push(limitRow('cash-60', 'Cash gifts (60% of AGI)', cash, agi * 0.6, '60% of AGI'));
  const noncash = ctx.cell('SchA.12');
  if (noncash) limits.push(limitRow('noncash-30', 'Gifts of appreciated property (30% of AGI)', noncash, agi * 0.3, '30% of AGI (capital gain property)'));
  // Vehicle donations: deduction limited to the charity's gross proceeds (Form 1098-C box 4c).
  for (const d of ctx.docsOfType('1098-C')) {
    const proceeds = ctx.docEv(d.id, 'box4c');
    const veh = ctx.wp.b.version(ctx.v)!.lines.find((l) => l.form === 'F8283' && (l.sources.some((s) => ctx.wp.b.evs.get(s)?.document_id === d.id) || /vehicle/i.test(l.line)));
    if (!proceeds || !veh) continue;
    const c = ctx.cell(veh.key)!;
    const r = limitRow(`vehicle-${d.id}`, `Vehicle donation (${d.issuer}): limited to gross proceeds`, c, n(proceeds.value), `Form 1098-C box 4c (${d.id})`, { links: [`ev:${proceeds.id}`, `doc:${d.id}`] });
    if (n(c.value) > n(proceeds.value)) {
      const f: ViewFlag = { code: 'VEHICLE_OVER_1098C', severity: 'error', text: `Vehicle donation claimed at ${fmt(n(c.value))}; the charity sold it for ${fmt(n(proceeds.value))} (1098-C box 4c), which caps the deduction: overstated ${fmt(n(c.value) - n(proceeds.value))}`, nodeIds: [c.nodeId!, `ev:${proceeds.id}`] };
      r.flags = [f];
      findings.push(f);
    }
    limits.push(r);
  }
  // Mortgage interest: payoff-statement interest that the same lender's 1098 already includes.
  const m8a = ctx.line('SchA.8a');
  if (m8a) {
    const srcDocs = m8a.sources.map((s) => ctx.wp.b.evs.get(s)).filter((e) => !!e).map((e) => ({ e, d: ctx.wp.b.docs.get(e.document_id)! }));
    for (const pay of srcDocs.filter((x) => x.d.document_type === 'payoff_statement')) {
      const f1098 = srcDocs.find((x) => x.d.document_type === '1098' && x.d.issuer === pay.d.issuer);
      if (f1098 && /includ\w* .*payoff|interest paid at payoff/i.test(f1098.d.pages.map((p) => p.printed_content).join(' '))) {
        const f: ViewFlag = { code: 'MORTGAGE_INTEREST_DUPLICATE', severity: 'error', text: `Payoff interest ${fmt(n(pay.e.value))} (${pay.d.id}) added on top of ${pay.d.issuer}'s Form 1098 (${f1098.d.id}), which says it already includes interest paid at payoff`, nodeIds: [lineId(ctx.v, 'SchA.8a'), `ev:${pay.e.id}`, `ev:${f1098.e.id}`] };
        findings.push(f);
        const row = schA.find((r) => r.id === 'SchA.8a');
        if (row) row.flags = [...(row.flags ?? []), f];
      }
    }
  }
  // Property tax on a home bought mid-year: the seller's share credited at closing is not the buyer's tax.
  const b5 = ctx.cell('SchA.5b');
  for (const d of ctx.docsOfType('closing_statement_buyer')) {
    const credit = ctx.docEv(d.id, 'tax_credit');
    if (b5 && credit && n(credit.value) > 0) {
      const f: ViewFlag = { code: 'PROPERTY_TAX_SELLER_SHARE', severity: 'warning', text: `Real estate taxes ${fmt(n(b5.value))} include the seller's share credited at closing (${fmt(n(credit.value))}, ${d.id}); buyer's deductible share ≈ ${fmt(n(b5.value) - n(credit.value))} (subject to the SALT cap)`, nodeIds: [b5.nodeId!, `ev:${credit.id}`] };
      findings.push(f);
      const row = schA.find((r) => r.id === 'SchA.5b');
      if (row) row.flags = [...(row.flags ?? []), f];
    }
  }
  const std = param(ctx, 'std_deduction_mfj');
  const itemized = ctx.cell('SchA.17');
  if (itemized) limits.push({ id: 'std-vs-itemized', label: 'Itemized vs standard deduction', nodeId: ctx.cell('F1040.12')?.nodeId, cells: { amount: itemized, limit: { value: std, nodeId: 'ref:param.std_deduction_mfj', note: 'standard deduction (MFJ)' }, allowed: ctx.cell('F1040.12') } });

  // ---- credits
  const credits = compact(
    ['F8812.1', 'F8812.4', 'F8812.6', 'F8812.8', 'F8812.11', 'F8812.12', 'F1040.19', 'F8863.27', 'F8863.30', 'F8863.7', 'F2441.1a', 'F2441.1b', 'F2441.2', 'F2441.12', 'F2441.26', 'F2441.31', 'Sch3.1', 'Sch3.8', 'F1040.20', 'Sch3.11'].map((k) => lineRow(ctx, k)),
  );
  // Foreign tax credit without Form 1116: all passive and at most 600 (MFJ).
  const ftc = ctx.line('Sch3.1');
  if (ftc) {
    const total = ftc.sources.reduce((s, x) => s + ctx.evNum(x), 0);
    limits.push(limitRow('ftc', 'Foreign tax credit without Form 1116', ctx.cell('Sch3.1'), 600, 'de minimis 600 (MFJ), passive only', { links: ftc.sources.map((s) => `ev:${s}`) }));
    if (total > 600) findings.push({ code: 'FTC_DE_MINIMIS', severity: 'warning', text: `Foreign taxes ${fmt(total)} exceed the 600 de minimis: Form 1116 required`, nodeIds: [lineId(ctx.v, 'Sch3.1')] });
  }
  // Due diligence (Form 8867).
  const dd = [...ctx.wp.state.judgments.values()].filter((j) => j.kind === 'due_diligence');
  const s8867 = ctx.cell('F8867.status');
  const ddRows: ViewRow[] = [
    ...(s8867 ? [{ id: 'F8867.status', label: ctx.line('F8867.status')!.label, nodeId: s8867.nodeId, status: dd.length ? 'documented in workpaper' : String(s8867.value), cells: { amount: s8867 } } as ViewRow] : []),
    ...dd.map((j) => ({ id: j.id, label: j.topic, sublabel: `${j.decision} · ${j.authority} · ${j.by} ${j.at.slice(0, 10)}`, status: 'due diligence', cells: {}, links: j.nodeIds })),
  ];
  if (ctx.num('F1040.19') > 0 && !dd.length)
    findings.push({ code: 'DUE_DILIGENCE_MISSING', severity: 'warning', text: 'Child tax credit / credit for other dependents claimed; Form 8867 due diligence not documented', nodeIds: compact([s8867?.nodeId, lineId(ctx.v, 'F1040.19')]) });

  return ctx.view(
    'deductions-credits',
    'Deductions and credits',
    'Schedule A and credits with the limits applied (SALT cap, charitable AGI limits, vehicle donation proceeds, FTC de minimis, CTC/AOTC phase-outs) and due diligence.',
    [
      { id: 'schedule-a', title: 'Schedule A', columns: [money('amount', 'Amount')], rows: schA },
      { id: 'limits', title: 'Limits applied', columns: [money('amount', 'Claimed / before limit'), money('limit', 'Limit'), money('allowed', 'Allowed on return'), money('over', 'Over limit')], rows: limits },
      { id: 'credits', title: 'Credits', columns: [money('amount', 'Amount')], rows: credits },
      { id: 'due-diligence', title: 'Due diligence (Form 8867)', columns: [text('amount', 'Status')], rows: ddRows },
    ],
    findings,
  );
}

export function retirementForeign(ctx: ViewCtx): ViewDto {
  const findings: ViewFlag[] = [];
  const year = ctx.packet.household.tax_year;

  const f8606 = compact(['F8606.1', 'F8606.2', 'F8606.3', 'F8606.5', 'F8606.6', 'F8606.8', 'F8606.9', 'F8606.10', 'F8606.11', 'F8606.13', 'F8606.14', 'F8606.16', 'F8606.17', 'F8606.18', 'F1040.4a', 'F1040.4b'].map((k) => lineRow(ctx, k)));
  // Backdoor Roth: contribution then conversion; the taxable part should be only the earnings.
  const conv = ctx.num('F8606.16');
  const basisUsed = ctx.num('F8606.17');
  if (conv && basisUsed && ctx.num('F8606.6') === 0) {
    f8606.push({ id: 'backdoor', label: 'Backdoor Roth: converted − basis = taxable earnings', cells: { amount: { value: conv - basisUsed } } });
  }
  const sep = ctx.cell('Sch1.16');
  const sepLine = ctx.line('Sch1.16');
  const retire: ViewRow[] = [];
  if (sep && sepLine) {
    const contrib = sepLine.sources.reduce((s, x) => s + ctx.evNum(x), 0);
    const excess = contrib - n(sep.value);
    const r: ViewRow = { id: 'sep', label: 'SEP contribution vs deduction limit', nodeId: sep.nodeId, cells: { contributed: { value: contrib, nodeId: sepLine.sources[0] && `ev:${sepLine.sources[0]}` }, amount: sep, excess: { value: excess } } };
    if (excess > 0) {
      const f: ViewFlag = { code: 'SEP_EXCESS', severity: 'warning', text: `SEP contribution ${fmt(contrib)} exceeds the deductible limit ${fmt(n(sep.value))} by ${fmt(excess)} (excess contribution; 6% excise tax unless withdrawn by the due date)`, nodeIds: compact([sep.nodeId, sepLine.sources[0] && `ev:${sepLine.sources[0]}`]) };
      r.flags = [f];
      findings.push(f);
    }
    retire.push(r);
  }
  retire.push(...compact(['Sch1.17', 'F8889.3', 'F8889.9', 'F8889.13', 'F8889.14a', 'F8889.15', 'F8889.16'].map((k) => lineRow(ctx, k))));
  const qa31 = ctx.packet.client.questionnaire.find((q) => /IRA/i.test(q.question) && /basis/i.test(q.question + q.answer));
  if (qa31 && /none|no prior/i.test(qa31.answer) && ctx.num('F8606.2') > 0)
    findings.push({ code: 'CLIENT_VS_RECORD', severity: 'warning', text: `Client says no prior IRA basis (${qa31.id}) but the 2024 Form 8606 shows ${fmt(ctx.num('F8606.2'))}`, nodeIds: [`qa:${qa31.id}`, lineId(ctx.v, 'F8606.2')] });

  // ---- foreign interest and FX
  const fx = (ctx.wp.rawValue('ref:fx') ?? ctx.packet.engine_reference.parameters.fx ?? {}) as Record<string, Record<string, number>>;
  const foreign: ViewRow[] = [];
  for (const l of ctx.wp.b.version(ctx.v)!.lines) {
    const fxRef = l.sources.find((s) => s.startsWith('ref:fx.'));
    if (!fxRef) continue;
    const [, cur, rateKey] = fxRef.split('.') as [string, string, string];
    const amountEv = l.sources.find((s) => s.startsWith('ev-'));
    const local = amountEv ? ctx.evNum(amountEv) : 0;
    const used = n(fx[cur]?.[rateKey]);
    const preferredKey = /max|ye\b|year.end|\.ye$/i.test(l.key) || /year-end|maximum/i.test(l.label) ? `${year}_year_end` : `${year}_average`;
    const preferred = n(fx[cur]?.[preferredKey]);
    const c = ctx.cell(l.key)!;
    const recomputed = preferred ? Math.round(local / preferred) : null;
    const r: ViewRow = {
      id: l.key,
      label: l.label,
      sublabel: `${fmt(local)} ${cur} at ${used} (${rateKey})`,
      nodeId: c.nodeId,
      cells: { local: { value: local, nodeId: amountEv && `ev:${amountEv}` }, rate: { value: used, nodeId: fxRef }, amount: c, preferredRate: { value: preferred || null, nodeId: preferred ? `ref:fx.${cur}.${preferredKey}` : undefined }, recomputed: { value: recomputed } },
    };
    if (rateKey !== preferredKey && recomputed !== null && recomputed !== n(c.value)) {
      const f: ViewFlag = { code: 'FX_RATE', severity: 'warning', text: `${l.label.split(' (')[0]} converted at the ${rateKey.replace('_', ' ')} rate ${used}; the ${preferredKey.replace('_', ' ')} rate ${preferred} gives ${fmt(recomputed)} (${fmt(recomputed - n(c.value))})`, nodeIds: [c.nodeId!, fxRef, `ref:fx.${cur}.${preferredKey}`] };
      r.flags = [f];
      findings.push(f);
    }
    foreign.push(r);
  }
  foreign.push(...compact(['F8938.req', 'SchB.7a', 'SchB.7b', 'SchB.8', 'Sch3.1'].map((k) => lineRow(ctx, k))));
  const maxUsd = ctx.num('F8938.1.max');
  if (maxUsd > 10000)
    findings.push({ code: 'FBAR_REQUIRED', severity: 'info', text: `Foreign account maximum ${fmt(maxUsd)} USD exceeds 10,000: FinCEN Form 114 (FBAR) due separately (outside the return)`, nodeIds: [lineId(ctx.v, 'F8938.1.max')] });
  const py8938 = ctx.wp.b.priorLines['F8938'];
  if (typeof py8938 === 'number') foreign.push({ id: 'py-8938', label: '2024 Form 8938 maximum value', nodeId: 'py:/return_2024/lines/F8938', cells: { amount: { value: py8938, nodeId: 'py:/return_2024/lines/F8938' } } });

  return ctx.view(
    'retirement-foreign',
    'Retirement and foreign',
    'Form 8606 backdoor Roth, SEP and HSA limits, foreign interest with the exchange rate used, and Form 8938 / FBAR.',
    [
      { id: '8606', title: 'Form 8606 (nondeductible IRA and Roth conversion)', columns: [money('amount', 'Amount')], rows: f8606 },
      { id: 'retirement', title: 'SEP, SE health insurance and HSA', columns: [money('contributed', 'Contributed'), money('amount', 'On return'), money('excess', 'Excess')], rows: retire },
      { id: 'foreign', title: 'Foreign accounts and currency', columns: [money('local', 'Local currency'), { key: 'rate', label: 'Rate used', kind: 'ratio' }, money('amount', 'USD on return'), { key: 'preferredRate', label: `${year} rate`, kind: 'ratio' }, money('recomputed', 'Recomputed USD')], rows: foreign },
    ],
    findings,
  );
}

