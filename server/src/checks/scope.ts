// Scope / outside filings: facts in the file that imply a filing outside this return.
// The engagement letter's exclusions are quoted so the firm can tell the client in writing.
//
//  scope.fbar                 foreign accounts over the FinCEN 114 threshold
//  scope.information_returns  contractor payments requiring Forms 1099-NEC
//  scope.prior_open_items     prior preparer's open items with nothing in file resolving them

import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';
import { E, L, docsInUse, evsOfDoc, fmt, issue, line, linesCiting, nameWords, num, taxYear } from './util.ts';

/** FinCEN Form 114: aggregate maximum value of foreign financial accounts over USD 10,000 (31 CFR 1010.350). */
const FBAR_THRESHOLD_USD = 10_000;
/** Form 1099-NEC: payments of 600 or more for services in the course of a trade or business (IRC 6041A). */
const NEC_THRESHOLD = 600;

function engagementExclusion(ctx: CheckContext, re: RegExp): { node?: string; text?: string } {
  const d = ctx.b.packet.documents.find((x) => x.document_type === 'engagement_letter');
  const p = d?.pages.find((pg) => re.test(pg.printed_content));
  if (!d || !p) return {};
  const sentence = p.printed_content.split(/(?<=\.)\s/).find((s) => re.test(s));
  return { node: `doc:${d.id}#page${p.page}`, text: sentence };
}

registerCheck({
  id: 'scope.fbar',
  title: 'Foreign account requires FBAR (FinCEN 114)',
  family: 'scope',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const id of docsInUse(ctx)) {
      const d = ctx.b.docs.get(id)!;
      if (d.document_type !== 'foreign_bank_statement') continue;
      const maxEv = evsOfDoc(ctx, id).find((e) => /highest|max/i.test(e.label));
      const max = num(maxEv?.value);
      if (!maxEv || max === undefined) continue;
      // The currency rate the return itself uses for this account.
      const usingKey = linesCiting(ctx, maxEv.id)[0];
      const fx = usingKey && line(ctx, usingKey)!.sources.find((s) => s.startsWith('ref:fx.'));
      const rate = fx ? num(ctx.b.packet.engine_reference.parameters.fx?.[fx.split('.')[1]!]?.[fx.split('.')[2]!]) : undefined;
      const usd = rate ? Math.round(max / rate) : undefined;
      if (usd === undefined || usd <= FBAR_THRESHOLD_USD) continue;
      const excl = engagementExclusion(ctx, /FinCEN|FBAR/);
      const ppwNote = (ctx.b.packet.prior_years.prior_preparer_workpaper?.notes ?? []).findIndex((n: string) => /FBAR/i.test(n));
      out.push(
        issue('scope.fbar', id, {
          code: 'FBAR_REQUIRED',
          severity: 'warning',
          title: `${d.issuer}: maximum ${fmt(max)} ≈ USD ${fmt(usd)}; FinCEN 114 (FBAR) is due separately`,
          detail:
            `${d.title}: ${maxEv.label} ${fmt(max)} at ${fx} ${rate} ≈ USD ${fmt(usd)}, over the USD ${fmt(FBAR_THRESHOLD_USD)} FBAR threshold. ` +
            (excl.text ? `Engagement letter: "${excl.text}" ` : '') +
            (ppwNote >= 0 ? `Prior preparer: "${ctx.b.packet.prior_years.prior_preparer_workpaper.notes[ppwNote]}" ` : '') +
            'Tell the client in writing that the FBAR is due (April 15, automatic extension to October 15) and is outside this engagement. (§8 E28)',
          nodeIds: [E(maxEv.id), `doc:${id}`, usingKey && L(ctx, usingKey), fx, excl.node, ppwNote >= 0 && `py:/prior_preparer_workpaper/notes/${ppwNote}`],
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'scope.information_returns',
  title: 'Forms 1099-NEC the business must issue',
  family: 'scope',
  run(ctx) {
    const filed = line(ctx, 'SchC.J');
    if (!filed || String(ctx.lineValue('SchC.J')).toLowerCase() !== 'no') return [];
    const reportDoc = [...docsInUse(ctx)].find((id) => {
      const d = ctx.b.docs.get(id)!;
      return /^books/.test(d.document_type) && /contractor/i.test(d.title);
    });
    if (!reportDoc) return [];
    const payees = evsOfDoc(ctx, reportDoc).filter((e) => e.value_type === 'money' && (num(e.value) ?? 0) >= NEC_THRESHOLD);
    if (!payees.length) return [];
    const excl = engagementExclusion(ctx, /information returns|Forms? 1099/i);
    const qa = filed.sources.filter((s) => /^qa-/.test(s));
    return [
      issue('scope.information_returns', reportDoc, {
        code: 'FORMS_1099_NOT_FILED',
        severity: 'warning',
        title: `${payees.length} contractor(s) paid ${fmt(NEC_THRESHOLD)} or more without Forms 1099-NEC`,
        detail:
          `${ctx.b.docs.get(reportDoc)!.title}: ${payees.map((e) => `${e.label} ${fmt(num(e.value)!)}`).join('; ')}. ` +
          `Schedule C line J answers "No" (${qa.join(', ')}). The forms are late (due January 31); late-filing penalties apply per form. ` +
          (excl.text ? `Engagement letter: "${excl.text}" ` : '') +
          'Advise the client in writing; do not answer line J "Yes" unless they are filed. (§8 E28)',
        nodeIds: [L(ctx, 'SchC.J'), L(ctx, 'SchC.I'), `doc:${reportDoc}`, ...payees.map((e) => E(e.id)), ...qa.map((q) => `qa:${q}`), excl.node],
      }),
    ];
  },
});

const isYear = (t: string) => /^(19|20)\d{2}$/.test(t);

registerCheck({
  id: 'scope.prior_open_items',
  title: 'Prior preparer open item with nothing in file resolving it',
  family: 'scope',
  run(ctx) {
    const out: CheckIssue[] = [];
    const items: string[] = ctx.b.packet.prior_years.prior_preparer_workpaper?.open_items_left_by_prior_preparer ?? [];
    items.forEach((item, i) => {
      const forms = [...item.matchAll(/\b(K-1|\d{4}(?:-[A-Z]+)?)\b/g)].map((m) => m[1]!).filter((t) => !isYear(t));
      const years = [...item.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => m[1]!);
      const words = nameWords(item).filter((w) => w.length > 3);
      const resolving = ctx.b.packet.documents.find((d) => {
        if (forms.length) return forms.every((f) => d.title.includes(f)) && years.every((y) => d.title.includes(y));
        const tw = nameWords(d.title);
        return words.filter((w) => tw.includes(w)).length >= 2;
      });
      if (resolving) return;
      // Client statements that bear on the item (e.g. an inheritance behind a Form 3520 question).
      // Distinctive words only (7+ letters); documents need a rarer word (9+) to avoid
      // matching every statement that mentions e.g. "foreign tax".
      const keywords = words.filter((w) => w.length >= 7 && !['discussed', 'resolution', 'confirm'].includes(w) && !/^\d/.test(w));
      const related = ctx.b.packet.client.questionnaire.filter((q) => keywords.some((k) => normalizedIncludes(`${q.question} ${q.answer}`, k.slice(0, 7))));
      const relatedDocs = ctx.b.packet.documents.filter(
        (d) =>
          d.tax_year === taxYear(ctx) &&
          keywords.filter((k) => k.length >= 9).some((k) => normalizedIncludes(d.pages.map((p) => p.printed_content).join(' '), k.slice(0, 7))),
      );
      out.push(
        issue('scope.prior_open_items', `ppw-${i}`, {
          code: 'PRIOR_OPEN_ITEM',
          severity: 'warning',
          title: `Prior preparer open item unresolved: ${item}`,
          detail:
            `Left open in the 2024 workpaper (D07). No document in file resolves it` +
            (forms.length ? ` (no ${forms.join('/')}${years.length ? ` for ${years.join('/')}` : ''})` : '') +
            '. ' +
            (related.length ? `Client answers: ${related.map((q) => `${q.id} "${q.answer}"`).join('; ')}. ` : '') +
            'Raise it with the client; a missed prior-year filing is outside this return but must be documented. (§8 E28)',
          nodeIds: [`py:/prior_preparer_workpaper/open_items_left_by_prior_preparer/${i}`, ...related.map((q) => `qa:${q.id}`), ...relatedDocs.map((d) => `doc:${d.id}`)],
        }),
      );
    });
    return out;
  },
});

const normalizedIncludes = (text: string, word: string) => text.toLowerCase().includes(word.toLowerCase());
