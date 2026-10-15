// Third-party agreement: what the return claims versus what agencies and other payers report.
//
//  tp.estimates_irs         Form 1040 line 26 vs IRS account transcript (code 670 estimates)
//  tp.estimates_ftb         Form 540NR line 72 vs the FTB account's payments for the tax year
//  tp.gross_receipts_1099k  Schedule C receipts adding a 1099-K whose deposits are already in books
//  tp.vehicle_donation_cap  vehicle donation above the 1098-C gross proceeds
//  tp.seller_tax_credit     home real estate tax that ignores the seller's proration credit

import { estimateEffect } from '@easetax/shared';
import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';
import {
  E,
  L,
  P,
  docsInUse,
  evsOfDoc,
  fmt,
  issue,
  line,
  lineNum,
  lines,
  linesCiting,
  moneySources,
  nameWords,
  normText,
  num,
  parseMoney,
  suggest,
  taxYear,
  uniq,
} from './util.ts';

/** "2025-04-15 3,000.00; 2026-01-14 4,000.00" from an engine line note. */
function claimedPayments(note: string | undefined): { date: string; amount: number }[] {
  return [...(note ?? '').matchAll(/(\d{4}-\d{2}-\d{2})\s+([\d,]+(?:\.\d{2})?)/g)].map((m) => ({ date: m[1]!, amount: parseMoney(m[2]!) }));
}

function agencyNotices(ctx: CheckContext, re: RegExp): string[] {
  const notices: any[] = ctx.b.packet.tax_agency_records.notices ?? [];
  return notices
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => re.test(JSON.stringify(n.items_under_examination ?? n.summary ?? '')))
    .map(({ i }) => `agency:/notices/${i}`);
}

const docOfType = (ctx: CheckContext, type: string) => ctx.b.packet.documents.find((d) => d.document_type === type);

registerCheck({
  id: 'tp.estimates_irs',
  title: 'Federal estimated payments agree with the IRS transcript',
  family: 'third_party',
  run(ctx) {
    const key = 'F1040.26';
    const l = line(ctx, key);
    const cur = lineNum(ctx, key);
    const recs = ctx.b.packet.tax_agency_records;
    const tKey = Object.keys(recs).find((k) => k.startsWith('irs_account_transcript'));
    if (!l || cur === undefined || !tKey) return [];
    const snaps: any[] = recs[tKey];
    // The latest transcript pulled before this version was computed (what the preparer could
    // have known); fall back to the latest one.
    const asOf = ctx.b.version(ctx.version)!.computed_at.slice(0, 10);
    const known = snaps.map((s, i) => ({ s, i })).filter(({ s }) => s.as_of <= asOf);
    const pool = known.length ? known : snaps.map((s, i) => ({ s, i }));
    const si = pool.reduce((best, cur) => (cur.s.as_of > best.s.as_of ? cur : best)).i;
    const ty = taxYear(ctx);
    const txs = (snaps[si].transactions as any[])
      .map((t, i) => ({ ...t, ptr: `agency:/${tKey}/${si}/transactions/${i}` }))
      .filter((t) => t.code === '670' && /estimated/i.test(t.description) && t.date >= `${ty}-01-01` && t.date <= `${ty + 1}-01-31`);
    const agency = txs.reduce((s, t) => s + (num(t.amount) ?? 0), 0);
    if (Math.abs(agency - cur) < 1) return [];
    const claimed = claimedPayments(l.note);
    const unmatched = claimed.filter((c) => !txs.some((t) => t.date === c.date && t.amount === c.amount));
    const diffs = unmatched.map((c) => {
      const near = txs.find((t) => Math.abs(Date.parse(t.date) - Date.parse(c.date)) <= 7 * 864e5);
      return `${c.date} ${fmt(c.amount)} claimed vs IRS ${near ? `${near.date} ${fmt(near.amount)}` : 'no payment'}`;
    });
    const nearPtrs = txs.filter((t) => unmatched.some((c) => Math.abs(Date.parse(t.date) - Date.parse(c.date)) <= 7 * 864e5)).map((t) => t.ptr);
    const clientRefs = l.sources.filter((s) => /^(qa|msg|call)-/.test(s));
    const transcriptDoc = docOfType(ctx, 'irs_transcript');
    return [
      issue('tp.estimates_irs', key, {
        code: 'ESTIMATES_VS_IRS',
        severity: 'error',
        title: `Federal estimates ${fmt(cur)} vs ${fmt(agency)} on the IRS transcript`,
        detail:
          `IRS account transcript as of ${snaps[si].as_of} shows ${txs.length} estimated payments totalling ${fmt(agency)}. ` +
          `${diffs.join('; ')}.` +
          (clientRefs.length ? ` The unmatched amount comes from the client's answer (${clientRefs.join(', ')}), not a payment record.` : '') +
          ' (§8 E20)',
        nodeIds: [L(ctx, key), ...nearPtrs, `agency:/${tKey}/${si}`, transcriptDoc && `doc:${transcriptDoc.id}`, ...clientRefs.map((r) => `${r.split('-')[0]}:${r}`)],
        ...suggest(ctx, key, agency, `IRS transcript ${snaps[si].as_of}: code 670 estimated payments`),
      }),
    ];
  },
});

registerCheck({
  id: 'tp.estimates_ftb',
  title: 'California estimated payments agree with the FTB account',
  family: 'third_party',
  run(ctx) {
    const key = 'F540NR.72';
    const l = line(ctx, key);
    const cur = lineNum(ctx, key);
    const ftb = ctx.b.packet.tax_agency_records.ftb_account;
    const ty = taxYear(ctx);
    const field = `tax_year_${ty}_payments`;
    if (!l || cur === undefined || !ftb?.[field]) return [];
    const pays: any[] = ftb[field];
    const agency = pays.reduce((s, p) => s + (num(p.amount) ?? 0), 0);
    if (Math.abs(agency - cur) < 1) return [];
    // Payments the return counts that the FTB applied to a different year.
    const claimed = claimedPayments(l.note);
    const elsewhere: string[] = [];
    const why: string[] = [];
    for (const [k, list] of Object.entries(ftb)) {
      const m = /^tax_year_(\d{4})_/.exec(k);
      if (!m || Number(m[1]) === ty || !Array.isArray(list)) continue;
      list.forEach((p: any, i: number) => {
        if (claimed.some((c) => c.date === p.date && c.amount === p.amount)) {
          elsewhere.push(`agency:/ftb_account/${k}/${i}`);
          why.push(`${p.date} ${fmt(p.amount)} applied to tax year ${m[1]}${p.note ? ` (${p.note})` : ''}`);
        }
      });
    }
    // The payment confirmation itself may say which year the payment was designated for.
    const yearEvs = l.sources
      .map((s) => ctx.b.evs.get(s))
      .filter((e) => e && /_year$/.test(e.field) && String(e.value) !== String(ty));
    return [
      issue('tp.estimates_ftb', key, {
        code: 'ESTIMATES_VS_FTB',
        severity: 'error',
        title: `California estimates ${fmt(cur)} vs ${fmt(agency)} in the FTB account for ${ty}`,
        detail:
          `FTB account (as of ${ftb.as_of}) shows ${pays.length} payments for ${ty} totalling ${fmt(agency)}. ` +
          (why.length ? `${why.join('; ')}. ` : '') +
          (yearEvs.length ? `The Web Pay confirmation also designates ${yearEvs.map((e) => `${e!.id} = ${String(e!.value)}`).join(', ')}. ` : '') +
          'Payments applied to another year cannot be claimed on this return. (§8 E21)',
        nodeIds: [L(ctx, key), `agency:/ftb_account/${field}`, ...elsewhere, ...yearEvs.map((e) => E(e!.id))],
        ...suggest(ctx, key, agency, `FTB account: payments applied to tax year ${ty}`),
      }),
    ];
  },
});

registerCheck({
  id: 'tp.gross_receipts_1099k',
  title: 'Form 1099-K receipts already inside the books',
  family: 'third_party',
  run(ctx) {
    const out: CheckIssue[] = [];
    const inUse = docsInUse(ctx);
    for (const l of lines(ctx)) {
      const srcs = moneySources(ctx, l);
      const kEvs = srcs.filter((e) => ctx.b.docs.get(e.document_id)?.document_type === '1099-K');
      if (!kEvs.length) continue;
      const cur = lineNum(ctx, l.key);
      if (cur === undefined) continue;
      for (const k of kEvs) {
        const kAmt = num(k.value);
        if (!kAmt) continue;
        const filer = ctx.b.docs.get(k.document_id)!;
        const filerWord = nameWords(filer.issuer)[0] ?? '';
        // A books document that traces the same amount to the same processor.
        const inBooks = [...inUse]
          .filter((id) => /^books/.test(ctx.b.docs.get(id)!.document_type))
          .flatMap((id) => evsOfDoc(ctx, id))
          .find((e) => num(e.value) === kAmt && normText(`${e.label} ${ctx.b.docs.get(e.document_id)!.pages.find((p) => p.page === e.page)?.printed_content ?? ''}`).includes(filerWord));
        if (!inBooks) continue;
        const booksTotal = srcs.find((e) => /^books/.test(ctx.b.docs.get(e.document_id)!.document_type));
        const page = ctx.b.docs.get(inBooks.document_id)!.pages.find((p) => p.page === inBooks.page)!.printed_content;
        const sentence = page.split(/(?<=\.)\s/).find((s) => s.includes(fmt(kAmt))) ?? '';
        const necs = srcs.filter((e) => ctx.b.docs.get(e.document_id)?.document_type === '1099-NEC');
        const necTotal = necs.reduce((s, e) => s + (num(e.value) ?? 0), 0);
        const related = srcs.filter((e) => e.document_id === inBooks.document_id || e === booksTotal);
        out.push(
          issue('tp.gross_receipts_1099k', `${l.key}:${k.document_id}`, {
            code: 'GROSS_RECEIPTS_1099K_DOUBLE',
            severity: 'error',
            title: `${l.form} ${l.line} adds ${filer.issuer} 1099-K ${fmt(kAmt)} that is already in book revenue`,
            detail:
              `${l.key} = ${fmt(cur)}${booksTotal ? ` = books ${fmt(num(booksTotal.value) ?? 0)} + 1099-K ${fmt(kAmt)}` : ''}. ` +
              `${ctx.b.docs.get(inBooks.document_id)!.title}, page ${inBooks.page}: "${sentence.trim()}" ` +
              `The card receipts were deposited gross and booked as sales, so they are counted twice. ` +
              (necs.length ? `Forms 1099-NEC total ${fmt(necTotal)}, inside book revenue. ` : '') +
              `Corrected receipts ${fmt(cur - kAmt)}. Third parties reported these amounts to the IRS: keep the reconciliation in the file. (§8 E3)`,
            nodeIds: [
              L(ctx, l.key),
              E(k.id),
              `doc:${k.document_id}`,
              E(inBooks.id),
              P(inBooks.document_id, inBooks.page),
              ...related.map((e) => E(e.id)),
              ...agencyNotices(ctx, /1099-K/i),
            ],
            ...suggest(ctx, l.key, cur - kAmt, `${filer.issuer} 1099-K deposits are already in book revenue (${inBooks.id})`),
          }),
        );
      }
    }
    return out;
  },
});

registerCheck({
  id: 'tp.vehicle_donation_cap',
  title: 'Vehicle donation limited to the 1098-C gross proceeds',
  family: 'third_party',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const d of ctx.b.packet.documents.filter((x) => x.document_type === '1098-C')) {
      const text = d.pages.map((p) => p.printed_content).join(' ');
      const evs = evsOfDoc(ctx, d.id);
      const proceedsEv = evs.find((e) => /gross proceeds/i.test(e.label));
      const proceeds = num(proceedsEv?.value);
      if (!proceedsEv || proceeds === undefined || !/sold/i.test(text)) continue;
      const keys = uniq(evs.flatMap((e) => linesCiting(ctx, e.id)));
      for (const key of keys) {
        const cur = lineNum(ctx, key);
        if (cur === undefined || cur <= proceeds) continue;
        const l = line(ctx, key)!;
        const clientRefs = l.sources.filter((s) => /^(qa|msg|call)-/.test(s));
        out.push(
          issue('tp.vehicle_donation_cap', key, {
            code: 'VEHICLE_DONATION_OVER_1098C',
            severity: 'error',
            title: `Vehicle donation claimed at ${fmt(cur)}; Form 1098-C caps it at ${fmt(proceeds)}`,
            detail:
              `${d.title}: the charity sold the vehicle in an arm's-length sale for ${fmt(proceeds)} (box 4c). ` +
              `When box 4a is checked the deduction cannot exceed the gross proceeds, whatever the fair market value (IRC 170(f)(12)). ` +
              `The claimed ${fmt(cur)} is the client's estimate${clientRefs.length ? ` (${clientRefs.join(', ')})` : ''}. ` +
              `This item is examined in the later Letter 566. (§8 E19)`,
            nodeIds: [L(ctx, key), E(proceedsEv.id), P(d.id, proceedsEv.page), `doc:${d.id}`, ...clientRefs.map((r) => `${r.split('-')[0]}:${r}`), ...agencyNotices(ctx, /noncash/i)],
            ...suggest(ctx, key, proceeds, `Form 1098-C box 4c gross proceeds (${d.id})`),
          }),
        );
      }
    }
    return out;
  },
});

registerCheck({
  id: 'tp.seller_tax_credit',
  title: 'Home real estate tax reduced by the seller proration credit',
  family: 'third_party',
  run(ctx) {
    const out: CheckIssue[] = [];
    const ty = taxYear(ctx);
    for (const d of ctx.b.packet.documents.filter((x) => x.document_type === 'closing_statement_buyer' && x.tax_year === ty)) {
      const credit = evsOfDoc(ctx, d.id).find((e) => /seller credit/i.test(e.label) && /tax/i.test(e.label));
      const amt = num(credit?.value);
      if (!credit || !amt) continue;
      const period = /taxes?\s+(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/i.exec(d.pages.map((p) => p.printed_content).join(' '));
      for (const l of lines(ctx).filter((x) => x.rule === 'R-SALT-PROPERTY')) {
        if (l.sources.includes(credit.id)) continue; // already netted
        const cur = lineNum(ctx, l.key);
        if (cur === undefined || cur < amt) continue;
        const corrected = cur - amt;
        const base = suggest(ctx, l.key, corrected, `Seller paid ${fmt(amt)} of the ${ty} tax through the closing credit (${d.id})`);
        // Federal: Schedule A taxes are capped; only the part that drops below the cap counts.
        const total = lines(ctx).find((x) => x.rule === 'R-SUM' && x.inputs.includes(l.key) && x.form === l.form);
        const capped = total && lines(ctx).find((x) => x.inputs.includes(total.key) && /CAP/.test(x.rule));
        const tot = total && lineNum(ctx, total.key);
        const cap = capped && lineNum(ctx, capped.key);
        let warnings = base.effect!.warnings;
        if (tot !== undefined && cap !== undefined && capped) {
          const newCapped = Math.min(cap, tot - amt);
          const allowedDrop = cap - newCapped;
          const v = ctx.b.version(ctx.version)!;
          const itemTotal = lines(ctx).find((x) => x.form === l.form && x.rule === 'R-SUM' && /total itemized/i.test(x.label));
          if (itemTotal && allowedDrop > 0) {
            const fed = estimateEffect(itemTotal.key, 0, -allowedDrop, v.tax_effect_rates, ctx.version);
            base.effect = { ...base.effect!, federalTax: fed.federalTax, basis: `${base.effect!.basis}; federal: ${capped.key} cap ${fmt(cap)} → ${fmt(newCapped)} × itemized rate` };
            warnings = [...warnings, `${capped.key} falls below the cap; federal effect uses the ${fmt(allowedDrop)} drop in allowed taxes.`];
          }
        }
        base.effect = { ...base.effect!, warnings };
        out.push(
          issue('tp.seller_tax_credit', l.key, {
            code: 'PROPERTY_TAX_SELLER_CREDIT',
            severity: 'error',
            title: `${l.form} ${l.line} deducts the full-year ${fmt(cur)}; the seller credited ${fmt(amt)} at closing`,
            detail:
              `${d.title}: "${credit.label}" ${fmt(amt)}${period ? ` for ${period[1]}-${period[2]}` : ''}. ` +
              `The buyer may deduct only the tax for the part of the year they owned the home, so the deductible share is ${fmt(cur)} − ${fmt(amt)} = ${fmt(corrected)}. (§8 E18)`,
            nodeIds: [L(ctx, l.key), E(credit.id), P(d.id, credit.page), `doc:${d.id}`, ...l.sources.filter((s) => /^ev-/.test(s)).map(E), total && L(ctx, total.key), capped && L(ctx, capped.key)],
            ...base,
          }),
        );
      }
    }
    return out;
  },
});
