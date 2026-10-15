// Judgment calls the reviewer must make and document.
//
//  judgment.repair_vs_improvement  a rental "repair" component above the de minimis safe
//                                  harbor that the invoice describes as a new system; shows
//                                  the engine's exact what_if result for the alternative

import type { EstimatedEffect } from '@easetax/shared';
import { registerCheck, type CheckIssue } from './registry.ts';
import { E, L, evsOfDoc, fmt, issue, lineNum, lines, nameWords, normText, num } from './util.ts';

/** De minimis safe harbor for taxpayers without an applicable financial statement: 2,500 per invoice/item (Reg. 1.263(a)-1(f)). */
const DE_MINIMIS = 2_500;

registerCheck({
  id: 'judgment.repair_vs_improvement',
  title: 'Large repair may be a capital improvement',
  family: 'judgment',
  run(ctx) {
    const out: CheckIssue[] = [];
    const alts: any[] = ctx.b.packet.what_if?.alternatives ?? [];
    for (const l of lines(ctx).filter((x) => x.form === 'SchE' && /^repairs/i.test(x.label))) {
      const cur = lineNum(ctx, l.key);
      if (!cur) continue;
      const srcDocs = [...new Set(l.sources.map((s) => ctx.b.evs.get(s)?.document_id).filter((x): x is string => !!x))];
      const components = srcDocs.flatMap((d) => evsOfDoc(ctx, d)).filter((e) => /^repairs\s*-/i.test(e.label) && (num(e.value) ?? 0) > DE_MINIMIS);
      for (const c of components) {
        const amount = num(c.value)!;
        // The vendor's invoice, found by the vendor name in the component label.
        const vendor = /\(([^)]+)\)/.exec(c.label)?.[1];
        const invoice = vendor && ctx.b.packet.documents.find((d) => d.document_type === 'invoice' && nameWords(d.issuer).slice(0, 2).join(' ') === nameWords(vendor).slice(0, 2).join(' '));
        const invText = invoice ? invoice.pages.map((p) => p.printed_content).join(' ') : '';
        const sentence = invText.split(/(?<=\.)\s/).find((s) => /install|replac|new/i.test(s));
        const alt = alts.find((a) => (a.changed_lines ?? []).some((cl: any) => cl.key === l.key));
        const changed = alt?.changed_lines.find((cl: any) => cl.key === l.key);
        const effect: EstimatedEffect | undefined = alt
          ? {
              estimable: true,
              federalTax: alt.federal?.total_tax_change ?? 0,
              californiaTax: alt.california?.total_tax_change ?? 0,
              federalBalance: 0,
              californiaBalance: 0,
              basis: `Engine what_if "${alt.id}" (exact, base ${alt.base_version ?? ctx.version})`,
              warnings: [],
            }
          : undefined;
        // Call notes that talk about the same item (a word of the component's name) and a replacement.
        const itemWords = nameWords(c.label.replace(/^repairs\s*-\s*/i, '').replace(/\([^)]*\)/g, ''));
        const calls = ctx.b.packet.client.call_notes.filter((cn) =>
          cn.notes.some((n) => itemWords.some((w) => normText(n).split(' ').includes(w)) && /replac|new/i.test(n)),
        );
        out.push(
          issue('judgment.repair_vs_improvement', `${l.key}:${c.id}`, {
            code: 'REPAIR_OR_IMPROVEMENT',
            severity: 'warning',
            title: `${l.form} ${l.line}: ${fmt(amount)} ${c.label.replace(/^repairs\s*-\s*/i, '')} expensed as a repair`,
            detail:
              `${l.label} = ${fmt(cur)} includes ${c.label} ${fmt(amount)} (${c.id}), above the ${fmt(DE_MINIMIS)} de minimis safe harbor. ` +
              (sentence && invoice ? `Invoice ${invoice.id}: "${sentence.trim()}" ` : '') +
              'Replacing a building system is generally a restoration/betterment to be capitalized (Reg. 1.263(a)-3) and depreciated over 27.5 years. ' +
              (alt ? `Engine what_if "${alt.id}": ${l.key} ${fmt(changed.old)} → ${fmt(changed.new)}; federal tax ${alt.federal.total_tax_change >= 0 ? '+' : ''}${fmt(alt.federal.total_tax_change)}, California ${alt.california.total_tax_change >= 0 ? '+' : ''}${fmt(alt.california.total_tax_change)}. ` : '') +
              'Record the judgment and the authority relied on. (§8 E15)',
            nodeIds: [L(ctx, l.key), E(c.id), `doc:${c.document_id}`, invoice && `doc:${invoice.id}`, ...calls.map((cn) => `call:${cn.id}`)],
            ...(changed && effect ? { suggestion: { nodeId: L(ctx, l.key), value: changed.new, why: `Capitalize ${c.label} (what_if ${alt.id})` }, effect } : {}),
          }),
        );
      }
    }
    return out;
  },
});
