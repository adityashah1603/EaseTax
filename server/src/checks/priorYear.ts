// Prior-year agreement: opening balances that come from prior_years must agree with it,
// and roll-forwards we can recompute must give the engine's number.
//
//  py.carryovers     lines citing py:/carryovers_into_2025/* equal the carried amounts
//  py.scorp_basis    S corporation stock basis rolled forward from the last known basis
//                    through every K-1 in file (and prior-year records) to 2025
//  py.area_change    square footage stated on a line vs the prior-year return

import { registerCheck, type CheckIssue } from './registry.ts';
import { E, L, evsOfDoc, fmt, issue, lineNum, lines, nameWords, num, suggest, taxYear } from './util.ts';

registerCheck({
  id: 'py.carryovers',
  title: 'Carryovers agree with the prior year',
  family: 'prior_year',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx)) {
      const ptrs = l.sources.filter((s) => s.startsWith('py:/carryovers_into_2025/'));
      if (!ptrs.length || l.inputs.length) continue;
      const expected = ptrs.reduce((s, p) => s + Math.abs(num(ctx.b.pointer('py', p.slice(3))) ?? 0), 0);
      const cur = lineNum(ctx, l.key);
      if (cur === undefined || Math.abs(Math.abs(cur) - expected) < 1) continue;
      const signed = cur < 0 ? -expected : expected;
      out.push(
        issue('py.carryovers', l.key, {
          code: 'CARRYOVER_DISAGREES',
          severity: 'error',
          title: `${l.form} ${l.line} ${fmt(cur)} does not agree with the prior-year carryover ${fmt(signed)}`,
          detail: `${l.label}: ${ptrs.join(' + ')} = ${fmt(expected)}.`,
          nodeIds: [L(ctx, l.key), ...ptrs],
          ...suggest(ctx, l.key, signed, 'Prior-year carryover'),
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'py.scorp_basis',
  title: 'S corporation basis rolled forward from the prior years',
  family: 'prior_year',
  run(ctx) {
    const out: CheckIssue[] = [];
    const basisRecords: Record<string, any[]> = ctx.b.packet.prior_years.basis_records ?? {};
    const ty = taxYear(ctx);
    for (const [key, recs] of Object.entries(basisRecords)) {
      if (!key.startsWith('scorp_')) continue;
      const begin = lines(ctx).find((l) => l.sources.some((s) => s.startsWith(`py:/basis_records/${key}`)));
      const cur = begin && lineNum(ctx, begin.key);
      if (!begin || cur === undefined) continue;
      const sorted = recs.map((r, i) => ({ r, i })).sort((a, b) => a.r.year - b.r.year);
      const anchor = [...sorted].reverse().find(({ r }) => num(r.ending_stock_basis) !== undefined);
      if (!anchor) continue;
      const entity = nameWords(key.replace(/^scorp_/, '').replace(/_/g, ' '));
      const k1s = ctx.b.packet.documents.filter(
        (d) => d.document_type === 'K-1-1120S' && entity.every((w) => nameWords(d.issuer).includes(w)),
      );
      let basis = anchor.r.ending_stock_basis as number;
      const steps = [`${anchor.r.year} ending basis ${fmt(basis)} (${anchor.r.source})`];
      const nodes: string[] = [`py:/basis_records/${key}/${anchor.i}`];
      let gap = false;
      for (let y = anchor.r.year + 1; y < ty; y++) {
        const doc = k1s.find((d) => d.tax_year === y);
        const rec = sorted.find(({ r }) => r.year === y);
        let inc: number | undefined;
        let dist: number | undefined;
        let from = '';
        if (doc) {
          const evs = evsOfDoc(ctx, doc.id);
          const pick = (re: RegExp) => evs.find((e) => re.test(e.field));
          const incEvs = [pick(/^box1$/), pick(/^box4$/)].filter((e) => e);
          inc = incEvs.reduce((s, e) => s + (num(e!.value) ?? 0), 0);
          const d = pick(/^box16d$/i);
          dist = num(d?.value);
          from = `${doc.id} K-1 (received ${doc.received_at.slice(0, 10)})`;
          nodes.push(`doc:${doc.id}`, ...incEvs.map((e) => E(e!.id)), ...(d ? [E(d.id)] : []));
        } else if (rec) {
          inc = num(rec.r.k1_income);
          dist = num(rec.r.distributions);
          from = `prior-year record (${rec.r.source})`;
          nodes.push(`py:/basis_records/${key}/${rec.i}`);
        }
        if (inc === undefined || dist === undefined) {
          gap = true;
          steps.push(`${y}: no K-1 or record`);
          continue;
        }
        const before = basis + inc;
        basis = Math.max(0, before - dist);
        steps.push(`${y}: + ${fmt(inc)} − ${fmt(dist)} distributions = ${fmt(basis)} (${from})${dist > before ? `; ${fmt(dist - before)} excess distribution` : ''}`);
      }
      if (gap) continue; // completeness reports missing years
      // Current year: distributions in excess of basis are capital gain.
      const excessLine = lines(ctx).find((l) => l.form === begin.form && /excess/i.test(l.line));
      const distLine = lines(ctx).find((l) => l.form === begin.form && /distribution/i.test(l.label) && !l.inputs.length);
      const before = lines(ctx).find((l) => l.form === begin.form && /before distributions/i.test(l.label));
      const dist = distLine && lineNum(ctx, distLine.key);
      const basisBefore = before && lineNum(ctx, before.key);
      const curK1 = k1s.find((d) => d.tax_year === ty);
      const composite = curK1 && evsOfDoc(ctx, curK1.id).find((e) => /composite|tax paid/i.test(e.label));
      if (Math.abs(basis - cur) >= 1) {
        out.push(
          issue('py.scorp_basis', key, {
            code: 'SCORP_BASIS_ROLLFORWARD',
            severity: 'error',
            title: `${begin.form} ${begin.line}: beginning basis ${fmt(cur)} vs ${fmt(basis)} rolled forward`,
            detail: `${steps.join('; ')}. (§8 E25)`,
            nodeIds: [L(ctx, begin.key), ...nodes],
            ...suggest(ctx, begin.key, basis, 'Basis roll-forward from prior years and K-1s in file'),
          }),
        );
        continue;
      }
      out.push(
        issue('py.scorp_basis', key, {
          code: 'SCORP_BASIS_ROLLFORWARD',
          severity: 'warning',
          title: `${begin.form} basis ${fmt(cur)} rests on a client worksheet and a late K-1; ${excessLine ? `${fmt(lineNum(ctx, excessLine.key) ?? 0)} gain recognized` : ''}`,
          detail:
            `Recomputed: ${steps.join('; ')} — agrees with ${begin.key}. ` +
            (dist !== undefined && basisBefore !== undefined
              ? `${ty}: basis before distributions ${fmt(basisBefore)}, distributions ${fmt(dist)}${composite ? ` (include ${fmt(num(composite.value) ?? 0)} ${composite.label.toLowerCase()})` : ''} → ${fmt(Math.max(0, dist - basisBefore))} taxed as capital gain. `
              : '') +
            'The anchor basis is the client\'s own worksheet; obtain support (or the corporation\'s basis schedule) and document the authority before sign-off. (§8 E25)',
          nodeIds: [L(ctx, begin.key), excessLine && L(ctx, excessLine.key), distLine && L(ctx, distLine.key), ...nodes, composite && E(composite.id), curK1 && `doc:${curK1.id}`],
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'py.area_change',
  title: 'Square footage differs from the prior year',
  family: 'prior_year',
  run(ctx) {
    const out: CheckIssue[] = [];
    const py = ctx.b.packet.prior_years.return_2024 ?? {};
    const ppw = ctx.b.packet.prior_years.prior_preparer_workpaper ?? {};
    for (const l of lines(ctx)) {
      const now = /(\d[\d,]*)\s*sq ft/i.exec(l.label);
      if (!now) continue;
      const pyText = `${py.line_labels?.[l.key] ?? ''} ${py.notes?.[l.key] ?? ''}`;
      const then = /(\d[\d,]*)\s*sq ft/i.exec(pyText);
      if (!then || then[1] === now[1]) continue;
      const measures = ctx.b.packet.extracted_values.filter((e) => /sq_?ft/i.test(e.field));
      const ppwNotes: string[] = ppw.notes ?? [];
      const noteIdx = ppwNotes.findIndex((n) => /sq ft/i.test(n));
      out.push(
        issue('py.area_change', l.key, {
          code: 'AREA_CHANGE_VS_PRIOR_YEAR',
          severity: 'warning',
          title: `${l.form} ${l.line}: ${now[1]} sq ft this year vs ${then[1]} sq ft on the 2024 return`,
          detail:
            `${l.label}. 2024: "${pyText.trim()}". ` +
            (measures.length ? `Client measurements: ${measures.map((e) => `${e.label} ${String(e.value)}`).join('; ')}. ` : '') +
            (noteIdx >= 0 ? `Prior preparer: "${ppwNotes[noteIdx]}" ` : '') +
            'Explain the change (move, different room) and whether the 2024 figure was overstated. (§8 E29)',
          nodeIds: [
            L(ctx, l.key),
            `py:/return_2024/lines/${l.key}`,
            ...measures.flatMap((e) => [E(e.id), `doc:${e.document_id}`]),
            noteIdx >= 0 && `py:/prior_preparer_workpaper/notes/${noteIdx}`,
          ],
        }),
      );
    }
    return out;
  },
});

