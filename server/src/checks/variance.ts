// Reasonableness / variance: the firm's starter rule (starter_standards.variance_review),
// prior year vs this year.
//
// Only source-level lines (no inputs) are flagged: totals move because their inputs moved,
// and explaining the inputs explains the totals. Rows that the engine numbers by payer
// (e.g. SchB.1.2) are matched to the prior year by payer name, not by position, because the
// same row number holds a different payer each year.

import { registerCheck, type CheckIssue } from './registry.ts';
import { L, fmt, issue, lineNum, lines, nameWords } from './util.ts';

const payerOf = (label: string) => {
  const i = label.indexOf(' - ');
  return i < 0 ? '' : label.slice(i + 3);
};

registerCheck({
  id: 'var.prior_year',
  title: 'Prior-year variance over the firm threshold',
  family: 'variance',
  run(ctx) {
    const out: CheckIssue[] = [];
    const rule = ctx.b.packet.firm.starter_standards.variance_review;
    const py = ctx.b.packet.prior_years.return_2024;
    if (!rule || !py || rule.compare_to !== 'prior_year') return out;
    const pyLines: Record<string, unknown> = py.lines ?? {};
    const pyLabels: Record<string, string> = py.line_labels ?? {};
    for (const l of lines(ctx)) {
      if (l.inputs.length) continue;
      const cur = lineNum(ctx, l.key);
      if (cur === undefined) continue;
      let pyKey: string | undefined = l.key;
      const segs = l.key.split('.');
      if (segs.length >= 3 && payerOf(l.label)) {
        // Per-payer row: find last year's row for the same payer.
        const prefix = segs.slice(0, -1).join('.') + '.';
        const first = nameWords(payerOf(l.label))[0];
        pyKey = Object.keys(pyLines).find((k) => k.startsWith(prefix) && first !== undefined && nameWords(payerOf(pyLabels[k] ?? '')).includes(first));
      }
      const prior = pyKey ? pyLines[pyKey] : undefined;
      if (typeof prior !== 'number') continue;
      const delta = cur - prior;
      const pct = prior === 0 ? Infinity : (Math.abs(delta) / Math.abs(prior)) * 100;
      if (Math.abs(delta) <= rule.and_over_amount || pct <= rule.flag_if_change_over_percent) continue;
      out.push(
        issue('var.prior_year', l.key, {
          code: 'PRIOR_YEAR_VARIANCE',
          severity: 'info',
          title: `${l.form} ${l.line}: ${fmt(prior)} → ${fmt(cur)} (${delta > 0 ? '+' : ''}${fmt(delta)}${Number.isFinite(pct) ? `, ${Math.round(pct)}%` : ''})`,
          detail:
            `${l.label} vs 2024 ${pyKey} "${pyLabels[pyKey!] ?? ''}". Firm rule: explain changes over ${rule.flag_if_change_over_percent}% and over ${fmt(rule.and_over_amount)}. ` +
            'Record the explanation (e.g. new employer, sale, move) before reviewer sign-off.',
          nodeIds: [L(ctx, l.key), `py:/return_2024/lines/${pyKey}`],
        }),
      );
    }
    return out;
  },
});
