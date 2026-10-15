// Completeness: things the return depends on that are missing, not computed, or rest only
// on the client's word.
//
//  comp.not_computed   lines the engine says it did not compute
//  comp.basis_gap      basis records with gaps that no line resolves
//  comp.unsourced      dollar amounts whose only support is a client answer
//  comp.out_of_year    information returns for another tax year in the file

import { registerCheck, type CheckIssue } from './registry.ts';
import { E, L, fmt, issue, line, lineNum, lines, linesCiting, nameWords, nodeOfRef, taxYear, uniq } from './util.ts';

registerCheck({
  id: 'comp.not_computed',
  title: 'Line the engine did not compute',
  family: 'completeness',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx)) {
      if (!/NOT-COMPUTED/i.test(l.rule) && !/not computed/i.test(l.note ?? '')) continue;
      const inputs = l.inputs.map((k) => line(ctx, k)).filter((x) => x);
      const inputSources = inputs.flatMap((x) => x!.sources);
      out.push(
        issue('comp.not_computed', l.key, {
          code: 'NOT_COMPUTED',
          severity: 'warning',
          title: `${l.form} ${l.line} (${l.label}) is ${fmt(lineNum(ctx, l.key) ?? 0)} because the engine did not compute it`,
          detail:
            `Rule ${l.rule}: ${ctx.b.packet.engine_reference.rules[l.rule] ?? l.note ?? ''}. ` +
            (inputs.length ? `It depends on ${inputs.map((x) => `${x!.key} ${x!.label} = ${fmt(lineNum(ctx, x!.key) ?? 0)}`).join('; ')}. ` : '') +
            'Compute it outside the engine (or document why none is due) and record the result as an adjustment. (§8 E31)',
          nodeIds: [L(ctx, l.key), ...l.inputs.map((k) => L(ctx, k)), ...inputSources.map((s) => nodeOfRef(ctx, s))],
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'comp.basis_gap',
  title: 'Basis record never computed',
  family: 'completeness',
  run(ctx) {
    const out: CheckIssue[] = [];
    const records: Record<string, any[]> = ctx.b.packet.prior_years.basis_records ?? {};
    const cited = lines(ctx).flatMap((l) => l.sources).filter((s) => s.startsWith('py:/basis_records/'));
    for (const [key, recs] of Object.entries(records)) {
      if (cited.some((s) => s.startsWith(`py:/basis_records/${key}/`) || s === `py:/basis_records/${key}`)) continue;
      const i = recs.length - 1;
      const latest = recs[i];
      if (!latest) continue;
      const gaps = Object.entries(latest).filter(([k, v]) => v === null && /basis/i.test(k)).map(([k]) => k);
      if (!gaps.length) continue;
      const words = nameWords(key.replace(/^[a-z]+_/, '').replace(/_/g, ' '));
      const docs = ctx.b.packet.documents.filter((d) => d.tax_year === taxYear(ctx) && words.some((w) => nameWords(d.issuer).includes(w)));
      out.push(
        issue('comp.basis_gap', key, {
          code: 'BASIS_NOT_COMPUTED',
          severity: 'warning',
          title: `${key.replace(/_/g, ' ')}: ${gaps.join(', ')} never computed`,
          detail:
            `prior_years.basis_records.${key} ${latest.year}: ${gaps.join(', ')} is empty (${latest.source}). ` +
            (docs.length ? `${docs.map((d) => d.id).join(', ')} report ${taxYear(ctx)} activity. ` : '') +
            'Basis limits losses and determines gain on distributions or sale; build the basis schedule and keep it in the file. (§8 E26)',
          nodeIds: [`py:/basis_records/${key}/${i}`, ...docs.map((d) => `doc:${d.id}`)],
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'comp.unsourced',
  title: 'Amount supported only by the client\'s word',
  family: 'completeness',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx)) {
      const cur = lineNum(ctx, l.key);
      if (!cur || l.inputs.length || !l.sources.length) continue;
      const client = l.sources.filter((s) => /^(qa|msg|call)-/.test(s));
      if (!client.length || client.length !== l.sources.length) continue;
      const answers = client.map((c) => ctx.b.qa.get(c)?.answer ?? ctx.b.msgs.get(c)?.text).filter((x) => x);
      out.push(
        issue('comp.unsourced', l.key, {
          code: 'UNSOURCED_AMOUNT',
          severity: 'warning',
          title: `${l.form} ${l.line} ${fmt(cur)} rests only on the client's answer`,
          detail:
            `${l.label}: sourced from ${client.join(', ')} ("${answers.join('"; "')}"). No document in file supports it. ` +
            'Request the invoice or statement, or record a confirmed_with_client verification with the reason. (§8 E16)',
          nodeIds: [L(ctx, l.key), ...client.map((c) => nodeOfRef(ctx, c))],
        }),
      );
    }
    return out;
  },
});

const INFO_RETURN = /^(W-2|1099|1098|3921|3922|5498|K-1)/;

registerCheck({
  id: 'comp.out_of_year',
  title: 'Information return for another tax year',
  family: 'completeness',
  run(ctx) {
    const out: CheckIssue[] = [];
    const ty = taxYear(ctx);
    for (const d of ctx.b.packet.documents) {
      if (d.tax_year === ty || !INFO_RETURN.test(d.document_type)) continue;
      const evs = ctx.b.evsByDoc.get(d.id) ?? [];
      const used = uniq(evs.flatMap((e) => linesCiting(ctx, e.id)));
      const carryOnly = used.every((k) => /PRIOR-YEAR|BASIS/.test(line(ctx, k)!.rule));
      const usedEvs = evs.filter((e) => linesCiting(ctx, e.id).length);
      out.push(
        issue('comp.out_of_year', d.id, {
          code: 'OUT_OF_YEAR_DOCUMENT',
          severity: used.length && !carryOnly ? 'warning' : 'info',
          title: used.length
            ? `${d.id} is a ${d.tax_year} ${d.document_type}; it feeds ${used.join(', ')}`
            : `${d.id} is a ${d.tax_year} ${d.document_type}; not used by the ${ty} return`,
          detail:
            `${d.title} (tax year ${d.tax_year}). ` +
            (!used.length
              ? 'Disposition it as prior-year/reference so it cannot feed this return.'
              : carryOnly
                ? `Used only as evidence for a basis or carryover roll-forward (${used.map((k) => line(ctx, k)!.rule).join(', ')}), which is appropriate; it must not feed ${ty} income.`
                : `${ty} lines should not take values from a ${d.tax_year} form; confirm each use.`) +
            ' (§8 E27)',
          nodeIds: [`doc:${d.id}`, ...used.map((k) => L(ctx, k)), ...usedEvs.map((e) => E(e.id))],
        }),
      );
    }
    return out;
  },
});
