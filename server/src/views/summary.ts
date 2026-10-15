// Return summary vs last year, and the tax computation chain.

import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import { compact, fmt, money, n, pct, text, type ViewCtx } from './ctx.ts';

/** 2024 was a resident CA 540; 2025 is a 540NR. Same line numbers for the comparable items. */
const CA_PRIOR: Record<string, string> = {
  'F540NR.13': 'CA540.13',
  'F540NR.17': 'CA540.17',
  'F540NR.18': 'CA540.18',
  'F540NR.19': 'CA540.19',
  'F540NR.31': 'CA540.31',
  'F540NR.64': 'CA540.64',
  'F540NR.71': 'CA540.71',
  'F540NR.72': 'CA540.72',
};

const KEY_LINES = [
  'F1040.1z',
  'F1040.2b',
  'F1040.3b',
  'F1040.7',
  'F1040.8',
  'F1040.9',
  'F1040.10',
  'F1040.11',
  'F1040.12',
  'F1040.13',
  'F1040.15',
  'F1040.16',
  'F1040.19',
  'F1040.23',
  'F1040.24',
  'F1040.25a',
  'F1040.26',
  'F1040.33',
  'SchC.1',
  'SchC.31',
  'SchE.26',
  'SchE.32',
  'F540NR.17',
  'F540NR.19',
  'F540NR.64',
  'F540NR.71',
  'F540NR.72',
];

export interface Variance {
  key: string;
  priorKey: string;
  label: string;
  nodeId: string;
  priorNodeId: string;
  current: number;
  engine: number;
  adjusted: boolean;
  prior: number;
  delta: number;
  deltaPct: number | null;
  flagged: boolean;
  explanation?: { explanation: string; by: string; at: string };
}

/** Every current line with a numeric 2024 counterpart, with the firm's variance rule applied. */
export function variances(ctx: ViewCtx): Variance[] {
  const rule = ctx.wp.standards().variance_review;
  const prior = ctx.wp.b.priorLines;
  const out: Variance[] = [];
  for (const l of ctx.wp.b.version(ctx.v)!.lines) {
    const priorKey = CA_PRIOR[l.key] ?? l.key;
    const pv = prior[priorKey];
    if (typeof pv !== 'number' || typeof l.value !== 'number') continue;
    const c = ctx.cell(l.key)!;
    const current = n(c.value);
    const delta = current - pv;
    const deltaPct = pv === 0 ? null : (delta / Math.abs(pv)) * 100;
    const overPct = deltaPct === null ? delta !== 0 : Math.abs(deltaPct) > rule.flag_if_change_over_percent;
    const flagged = overPct && Math.abs(delta) > rule.and_over_amount;
    out.push({
      key: l.key,
      priorKey,
      label: l.label,
      nodeId: c.nodeId!,
      priorNodeId: `py:/return_2024/lines/${priorKey}`,
      current,
      engine: n(l.value),
      adjusted: !!c.adjusted,
      prior: pv,
      delta,
      deltaPct,
      flagged,
      explanation: ctx.wp.state.varianceExplanations.get(c.nodeId!),
    });
  }
  return out;
}

function varianceRow(x: Variance): ViewRow {
  const st = !x.flagged ? 'within threshold' : x.explanation ? 'explained' : 'needs explanation';
  return {
    id: x.key,
    label: x.label,
    sublabel: x.key,
    nodeId: x.nodeId,
    status: st,
    cells: {
      current: { value: x.current, engineValue: x.engine, nodeId: x.nodeId, adjusted: x.adjusted },
      prior: { value: x.prior, nodeId: x.priorNodeId },
      delta: { value: x.delta },
      deltaPct: { value: x.deltaPct === null ? null : Math.round(x.deltaPct * 10) / 10 },
      explanation: { value: x.explanation?.explanation ?? null, note: x.explanation ? `${x.explanation.by} ${x.explanation.at.slice(0, 10)}` : undefined },
    },
    flags: x.flagged && !x.explanation ? [{ code: 'VARIANCE_UNEXPLAINED', severity: 'warning', text: `Changed ${fmt(x.delta)} vs 2024`, nodeIds: [x.nodeId] }] : undefined,
  };
}

export function summaryVsPrior(ctx: ViewCtx): ViewDto {
  const rule = ctx.wp.standards().variance_review;
  const all = variances(ctx);
  const byKey = new Map(all.map((x) => [x.key, x]));
  const cols = [money('current', '2025 (effective)'), money('prior', '2024'), money('delta', 'Δ'), pct('deltaPct', 'Δ%'), text('explanation', 'Explanation')];
  const unexplained = all.filter((x) => x.flagged && !x.explanation);
  const findings: ViewFlag[] = [];
  if (unexplained.length)
    findings.push({
      code: 'VARIANCES_UNEXPLAINED',
      severity: 'warning',
      text: `${unexplained.length} line(s) moved more than ${rule.flag_if_change_over_percent}% and ${fmt(rule.and_over_amount)} vs 2024 without an explanation`,
      nodeIds: unexplained.map((x) => x.nodeId),
    });
  return ctx.view(
    'summary-vs-prior',
    'Return summary vs 2024',
    `Key lines of the 2025 return (after approved adjustments) against the 2024 return as filed. Flag rule: change over ${rule.flag_if_change_over_percent}% and over ${fmt(rule.and_over_amount)}.`,
    [
      { id: 'key', title: 'Key lines', columns: cols, rows: compact(KEY_LINES.map((k) => byKey.get(k))).map(varianceRow) },
      {
        id: 'all',
        title: 'Every line with a 2024 counterpart',
        note: '2024 California figures are from the resident Form 540; 2025 is a part-year Form 540NR.',
        columns: cols,
        rows: all.map(varianceRow),
      },
    ],
    findings,
    { rule, flagged: all.filter((x) => x.flagged).length, explained: all.filter((x) => x.flagged && x.explanation).length },
  );
}

// ---------------------------------------------------------------- tax computation

const FED_CHAIN: [string, string[]][] = [
  ['Income', ['F1040.1z', 'F1040.2b', 'F1040.3b', 'F1040.4b', 'F1040.7', 'F1040.8', 'F1040.9']],
  ['Adjusted gross income', ['F1040.10', 'F1040.11']],
  ['Deductions', ['F1040.12', 'F1040.13', 'F1040.14']],
  ['Taxable income', ['F1040.15']],
  ['Tax', ['F1040.16', 'F1040.17', 'F1040.18']],
  ['Credits', ['F1040.19', 'F1040.20', 'F1040.21', 'F1040.22']],
  ['Other taxes', ['Sch2.4', 'Sch2.11', 'Sch2.12', 'F1040.23', 'F1040.24']],
  ['Payments', ['F1040.25d', 'F1040.26', 'Sch3.10', 'Sch3.11', 'F1040.31', 'F1040.33']],
  ['Balance / refund', ['F1040.34', 'F1040.35a', 'F1040.37']],
  ['Penalty', ['F1040.38']],
];

const CA_CHAIN: [string, string[]][] = [
  ['Income', ['F540NR.13', 'SchCA540NR.22.D', 'SchCA540NR.26.D', 'F540NR.17']],
  ['Deductions', ['F540NR.18']],
  ['Taxable income', ['F540NR.19']],
  ['Tax', ['F540NR.31', 'F540NR.32', 'F540NR.34', 'F540NR.35', 'F540NR.36', 'F540NR.37']],
  ['Credits', ['F540NR.39', 'F540NR.40', 'ScheduleS.credit']],
  ['Other taxes', ['F540NR.61', 'F540NR.64']],
  ['Payments', ['F540NR.71', 'F540NR.72', 'F540NR.73', 'F540NR.78']],
  ['Balance / refund', ['F540NR.91', 'F540NR.97']],
  ['Penalty', ['FTB5805.penalty']],
];

function chainRows(ctx: ViewCtx, chain: [string, string[]][]): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const [stage, keys] of chain) {
    for (const k of keys) {
      const c = ctx.cell(k);
      if (!c) continue;
      const l = ctx.line(k)!;
      const kind = typeof c.value === 'number' && Math.abs(c.value) < 1 && c.value !== 0 ? 'ratio' : 'amount';
      rows.push({
        id: k,
        label: l.label,
        sublabel: `${stage} · ${l.form} ${l.line}`,
        nodeId: c.nodeId,
        status: stage,
        cells: { [kind === 'ratio' ? 'ratio' : 'amount']: c, rule: { value: l.rule } },
        links: l.inputs.map((i) => lineId(ctx.v, i)),
      });
    }
  }
  return rows;
}

export function taxComputation(ctx: ViewCtx): ViewDto {
  const s = ctx.wp.summary();
  const eff = s.adjustmentEffect;
  const cols = [money('amount', 'Amount'), { key: 'ratio', label: 'Ratio', kind: 'ratio' as const }, text('rule', 'Engine rule')];
  const findings: ViewFlag[] = [];
  if (ctx.wp.state.activeAdjustment.size) {
    findings.push({
      code: 'ADJUSTMENTS_IN_FORCE',
      severity: 'info',
      text: `${ctx.wp.state.activeAdjustment.size} adjustment(s) in force. Downstream engine totals are not recomputed (D-19); estimated effect ≈ federal tax ${fmt(eff.federalTax)}, federal balance ${fmt(eff.federalBalance)}, California tax ${fmt(eff.californiaTax)}, California balance ${fmt(eff.californiaBalance)}.`,
      nodeIds: [...ctx.wp.state.activeAdjustment.keys()],
    });
  }
  const est = (label: string, key: string, base: number, delta: number): ViewRow => ({
    id: `est:${label}`,
    label: `${label} ≈ after workpaper adjustments`,
    nodeId: lineId(ctx.v, key),
    cells: { amount: { value: Math.round(base + delta), engineValue: base, nodeId: lineId(ctx.v, key), adjusted: delta !== 0, note: `≈ ${fmt(delta)} estimated from tax_effect_rates` } },
  });
  return ctx.view(
    'tax-computation',
    'Tax computation',
    'Federal and California computation chain, from income through AGI, deductions, taxable income, tax, credits, other taxes and payments to the balance, refund and penalty.',
    [
      {
        id: 'federal',
        title: 'Federal (Form 1040)',
        columns: cols,
        rows: chainRows(ctx, FED_CHAIN),
        totals: [est('Total tax', 'F1040.24', ctx.engineNum('F1040.24'), eff.federalTax), est('Amount owed', 'F1040.37', ctx.engineNum('F1040.37'), eff.federalBalance)],
      },
      {
        id: 'california',
        title: 'California (Form 540NR)',
        columns: cols,
        rows: chainRows(ctx, CA_CHAIN),
        totals: [est('Total tax', 'F540NR.64', ctx.engineNum('F540NR.64'), eff.californiaTax), est('Overpaid (−) / owed', 'F540NR.97', -ctx.engineNum('F540NR.97'), eff.californiaBalance)],
      },
    ],
    findings,
    { adjustmentEffect: eff },
  );
}

