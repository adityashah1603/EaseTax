// Recalculation: redo small computations the engine made, from the source values and the
// engine's own parameters and rule text.
//
//  recalc.fx_year     foreign amounts converted at a rate for another year
//  recalc.sep_limit   SEP deduction vs the limit in the engine rule; excess contributions
//  recalc.iso_spread  AMT ISO adjustment vs Form 3921 (FMV − exercise price) × shares

import { registerCheck, type CheckIssue } from './registry.ts';
import { E, L, fmt, issue, lineNum, lines, moneySources, num, r2, suggest, taxYear } from './util.ts';

registerCheck({
  id: 'recalc.fx_year',
  title: 'Foreign currency converted at the tax year\'s rate',
  family: 'recalc',
  run(ctx) {
    const out: CheckIssue[] = [];
    const fx = ctx.b.packet.engine_reference.parameters.fx ?? {};
    const ty = taxYear(ctx);
    for (const l of lines(ctx)) {
      for (const s of l.sources) {
        const m = /^ref:fx\.([A-Z]{3})\.(\d{4})_(\w+)$/.exec(s);
        if (!m || Number(m[2]) === ty) continue;
        const [, ccy, year, kind] = m;
        const used = num(fx[ccy!]?.[`${year}_${kind}`]);
        const right = num(fx[ccy!]?.[`${ty}_${kind}`]);
        const foreign = moneySources(ctx, l)[0];
        const amount = num(foreign?.value);
        const cur = lineNum(ctx, l.key);
        if (!used || !right || amount === undefined || cur === undefined || !foreign) continue;
        if (Math.abs(amount / used - cur) > 1) continue; // not a simple conversion we can redo
        const corrected = Math.round(amount / right);
        out.push(
          issue('recalc.fx_year', l.key, {
            code: 'FX_RATE_WRONG_YEAR',
            severity: 'error',
            title: `${l.form} ${l.line}: ${ccy} ${fmt(amount)} converted at the ${year} rate ${used}; ${ty} rate is ${right}`,
            detail:
              `${l.label}. ${ccy} ${fmt(amount)} / ${used} = ${fmt(cur)}; at the ${ty} ${kind!.replace('_', ' ')} rate ${right} it is ${fmt(corrected)} (${corrected > cur ? 'understated' : 'overstated'} by ${fmt(Math.abs(corrected - cur))}). ` +
              `Income is translated at the rate for the year it is received. (§8 E23)`,
            nodeIds: [L(ctx, l.key), s, `ref:fx.${ccy}.${ty}_${kind}`, E(foreign.id), `doc:${foreign.document_id}`],
            ...suggest(ctx, l.key, corrected, `${ccy} ${fmt(amount)} at ${ty} ${kind} rate ${right}`),
          }),
        );
      }
    }
    return out;
  },
});

registerCheck({
  id: 'recalc.sep_limit',
  title: 'SEP deduction within the limit; excess contribution',
  family: 'recalc',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx).filter((x) => x.rule === 'R-SEP-LIMIT')) {
      const rule = ctx.b.packet.engine_reference.rules[l.rule] ?? '';
      const pct = /(\d+(?:\.\d+)?)%/.exec(rule);
      const [aKey, bKey] = l.inputs;
      const a = aKey && lineNum(ctx, aKey);
      const b = bKey && lineNum(ctx, bKey);
      const contribEv = moneySources(ctx, l)[0];
      const contrib = num(contribEv?.value);
      const cur = lineNum(ctx, l.key);
      if (!pct || a === undefined || b === undefined || !a || contrib === undefined || cur === undefined || !contribEv) continue;
      const limit = r2((Number(pct[1]) / 100) * (a - (b || 0)));
      const allowed = Math.round(Math.min(contrib, limit));
      const excess = r2(contrib - limit);
      const wrong = Math.abs(cur - allowed) > 1;
      if (!wrong && excess <= 0) continue;
      out.push(
        issue('recalc.sep_limit', l.key, {
          code: wrong ? 'SEP_OVER_LIMIT' : 'SEP_EXCESS_CONTRIBUTION',
          severity: wrong ? 'error' : 'warning',
          title: wrong
            ? `${l.form} ${l.line} ${fmt(cur)} vs recomputed limit ${fmt(allowed)}`
            : `SEP contribution ${fmt(contrib)} exceeds the ${fmt(Math.round(limit))} limit by ${fmt(Math.round(excess))}`,
          detail:
            `Limit = ${pct[1]}% × (${aKey} ${fmt(a)} − ${bKey} ${fmt(b || 0)}) = ${fmt(limit)} (${l.rule}). Contribution ${fmt(contrib)} (${contribEv.id}). ` +
            (wrong ? `The deduction should be ${fmt(allowed)}. ` : `The deduction is already limited to ${fmt(cur)}; `) +
            (excess > 0
              ? `the ${fmt(Math.round(excess))} excess is subject to the 6% excise tax on excess contributions (IRC 4973, Form 5329) unless withdrawn with earnings before the due date. The limit also moves with any Schedule C correction. `
              : '') +
            '(§8 E6)',
          nodeIds: [L(ctx, l.key), E(contribEv.id), `doc:${contribEv.document_id}`, L(ctx, aKey!), L(ctx, bKey!)],
          ...(wrong ? suggest(ctx, l.key, allowed, `${pct[1]}% limit recomputed`) : {}),
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'recalc.iso_spread',
  title: 'AMT ISO adjustment agrees with Form 3921',
  family: 'recalc',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx).filter((x) => x.rule === 'R-AMT-ISO')) {
      const evs = l.sources.map((s) => ctx.b.evs.get(s)).filter((e) => e);
      const by = (re: RegExp) => num(evs.find((e) => re.test(e!.label))?.value);
      const fmv = by(/FMV/i);
      const price = by(/exercise price/i);
      const shares = by(/shares/i);
      const cur = lineNum(ctx, l.key);
      if (fmv === undefined || price === undefined || shares === undefined || cur === undefined) continue;
      const spread = Math.round((fmv - price) * shares);
      if (Math.abs(spread - cur) <= 1) continue;
      out.push(
        issue('recalc.iso_spread', l.key, {
          code: 'ISO_SPREAD',
          severity: 'error',
          title: `${l.form} ${l.line} ${fmt(cur)} vs Form 3921 spread ${fmt(spread)}`,
          detail: `(${fmv} − ${price}) × ${fmt(shares)} = ${fmt(spread)}.`,
          nodeIds: [L(ctx, l.key), ...evs.map((e) => E(e!.id))],
          ...suggest(ctx, l.key, spread, 'Form 3921 spread'),
        }),
      );
    }
    return out;
  },
});

