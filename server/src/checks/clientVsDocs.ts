// Client vs documents: what the client said (questionnaire, messages, call notes) against
// what the documents and records show.
//
//  cvd.questionnaire_sales   "no sales" answers vs the sales actually reported
//  cvd.sehi_eligibility      SE health insurance taken while eligible for a spouse's plan
//  cvd.ira_basis             "no prior basis" vs the filed Form 8606 basis
//  cvd.call_business_use     call-note business-use percentages vs 100% deducted
//  cvd.lot_basis_from_client zero-basis lot where the client has stated a cost and date

import type { ExtractedValue } from '@easetax/shared';
import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';
import {
  E,
  L,
  P,
  consumersOf,
  docsInUse,
  effectOf,
  evsOfDoc,
  fmt,
  isoFromUs,
  issue,
  line,
  lineNum,
  lines,
  linesCiting,
  nameWords,
  normText,
  num,
  parseMoney,
  r2,
  sumEffects,
  uniq,
} from './util.ts';

const qaNode = (id: string) => `qa:${id}`;

/** Form 8949 lot lines that cite values from documents of the given types. */
function lotsFromDocTypes(ctx: CheckContext, types: RegExp): { key: string; doc: string }[] {
  const inUse = docsInUse(ctx);
  const out: { key: string; doc: string }[] = [];
  for (const l of lines(ctx)) {
    if (l.form !== 'F8949' || l.line.endsWith('.total')) continue;
    const d = l.sources.map((s) => ctx.b.evs.get(s)?.document_id).find((x) => x && inUse.has(x) && types.test(ctx.b.docs.get(x)!.document_type));
    if (d) out.push({ key: l.key, doc: d });
  }
  return out;
}

const SALES_RULES = [
  { question: /sell any stocks|sell .*investments/i, negative: /^\s*no\b/i, docTypes: /^1099-(composite|B)$/i, what: 'brokerage sales' },
  { question: /crypto|digital asset/i, negative: /^\s*no\b|didn.t (really )?sell/i, docTypes: /^1099-DA$/i, what: 'digital asset dispositions' },
];

registerCheck({
  id: 'cvd.questionnaire_sales',
  title: 'Questionnaire says no sales; documents report sales',
  family: 'client_vs_documents',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const q of ctx.b.packet.client.questionnaire) {
      const rule = SALES_RULES.find((r) => r.question.test(q.question) && r.negative.test(q.answer));
      if (!rule) continue;
      const lots = lotsFromDocTypes(ctx, rule.docTypes);
      if (!lots.length) continue;
      const docs = uniq(lots.map((x) => x.doc));
      out.push(
        issue('cvd.questionnaire_sales', q.id, {
          code: 'QUESTIONNAIRE_SALES_CONFLICT',
          severity: 'warning',
          title: `${q.id} answer "${q.answer}" vs ${lots.length} ${rule.what} on the return`,
          detail:
            `Asked "${q.question}" the client answered "${q.answer}". ${docs.map((d) => `${d} (${lots.filter((x) => x.doc === d).length})`).join(', ')} report ${lots.length} ${rule.what}. ` +
            'Document the follow-up with the client (due diligence) and confirm nothing else was sold. (§8 E13)',
          nodeIds: [qaNode(q.id), ...docs.map((d) => `doc:${d}`)],
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'cvd.sehi_eligibility',
  title: 'SE health insurance not allowed while eligible for an employer plan',
  family: 'client_vs_documents',
  run(ctx) {
    const key = 'Sch1.17';
    const cur = lineNum(ctx, key);
    if (!cur) return [];
    const q = ctx.b.packet.client.questionnaire.find((x) => /eligible/i.test(x.question) && /health|coverage/i.test(x.question) && /^\s*yes/i.test(x.answer));
    if (!q) return [];
    const pyNote: string | undefined = ctx.b.packet.prior_years.return_2024?.notes?.[key];
    const l = line(ctx, key)!;
    return [
      issue('cvd.sehi_eligibility', key, {
        code: 'SEHI_ELIGIBLE_EMPLOYER_PLAN',
        severity: 'error',
        title: `Self-employed health insurance ${fmt(cur)} deducted, but the client says the spouse's employer plan was available`,
        detail:
          `${q.id}: "${q.answer}" No deduction is allowed for any month the self-employed person was eligible to participate in a subsidized plan of a spouse's employer (IRC 162(l)(2)(B)); eligibility, not enrollment, controls. ` +
          (pyNote ? `2024 return note: "${pyNote}" ` : '') +
          'The premiums also appear in the books as a business expense; keep them off Schedule C. (§8 E5)',
        nodeIds: [L(ctx, key), qaNode(q.id), ...l.sources.filter((s) => /^ev-/.test(s)).map(E), pyNote && `py:/return_2024/notes/${key}`],
        suggestion: { nodeId: L(ctx, key), value: 0, why: `Eligible for an employer-subsidized plan (${q.id})` },
        effect: effectOf(ctx, key, cur, 0),
      }),
    ];
  },
});

registerCheck({
  id: 'cvd.ira_basis',
  title: 'Client denies IRA basis that the prior-year Form 8606 shows',
  family: 'client_vs_documents',
  run(ctx) {
    const out: CheckIssue[] = [];
    const basisLine = lines(ctx).find((l) => l.form === 'F8606' && l.sources.some((s) => s.startsWith('py:')));
    const basis = basisLine && lineNum(ctx, basisLine.key);
    if (!basisLine || !basis) return [];
    for (const q of ctx.b.packet.client.questionnaire) {
      if (!/IRA/i.test(q.question) || !/basis:?\s*(none|no\b|zero)|no prior basis/i.test(q.answer)) continue;
      const evs = basisLine.sources.map((s) => ctx.b.evs.get(s)).filter((e): e is ExtractedValue => !!e);
      out.push(
        issue('cvd.ira_basis', q.id, {
          code: 'IRA_BASIS_CONFLICT',
          severity: 'warning',
          title: `${q.id} says no prior IRA basis; the 2024 Form 8606 carries ${fmt(basis)}`,
          detail:
            `Client: "${q.answer}" The engine uses ${basisLine.key} = ${fmt(basis)} from ${basisLine.sources.join(', ')}` +
            (evs.length ? ` (${evs.map((e) => `${ctx.b.docs.get(e.document_id)!.title}: ${e.label} ${fmt(num(e.value) ?? 0)}`).join('; ')})` : '') +
            '. The records agree with each other and contradict the answer; confirm with the client and keep the record-based basis. (§8 E24)',
          nodeIds: [qaNode(q.id), L(ctx, basisLine.key), ...basisLine.sources.filter((s) => s.startsWith('py:')), ...evs.flatMap((e) => [E(e.id), `doc:${e.document_id}`])],
        }),
      );
    }
    return out;
  },
});

const STOP = new Set(['month', 'per', 'lines', 'total', 'amount', 'paid']);
const words = (s: string) => nameWords(s).filter((w) => w.length > 2 && !STOP.has(w));

/** The books account a detail item rolls into: "Telephone 2,160.00: …" or "Software … 6,850.00 includes …". */
function accountFor(text: string, at: number): { account: string; amount: number } | undefined {
  let found: { account: string; amount: number } | undefined;
  for (const m of text.matchAll(/([A-Z][A-Za-z ]+?)\s([\d,]+\.\d{2})(?::|\s+includes)/g)) {
    if (m.index! > at) break;
    found = { account: m[1]!.trim(), amount: parseMoney(m[2]!) };
  }
  return found;
}

registerCheck({
  id: 'cvd.call_business_use',
  title: 'Business-use percentages from the client call applied',
  family: 'client_vs_documents',
  run(ctx) {
    const inUse = docsInUse(ctx);
    const books = [...inUse].filter((d) => /^books/.test(ctx.b.docs.get(d)!.document_type));
    const bookEvs = books.flatMap((d) => evsOfDoc(ctx, d)).filter((e) => e.value_type === 'money');
    // line key -> disallowed parts
    const perLine = new Map<string, { amount: number; text: string; nodes: string[] }[]>();
    for (const c of ctx.b.packet.client.call_notes) {
      for (const sentence of c.notes) {
        const pct = /(\d{1,3})%/.exec(sentence);
        const personal = /\bpersonal\b/i.test(sentence);
        if (!pct && !personal) continue;
        const sw = new Set(words(sentence));
        const item = bookEvs
          .map((e) => ({ e, hits: words(e.label).filter((w) => sw.has(w)).length }))
          .filter((x) => x.hits >= 2)
          .sort((a, b) => b.hits - a.hits)[0]?.e;
        if (!item) continue;
        const page = ctx.b.docs.get(item.document_id)!.pages.find((p) => p.page === item.page)!.printed_content;
        const lw = words(item.label).find((w) => page.toLowerCase().includes(w));
        if (!lw) continue;
        const acct = accountFor(page, page.toLowerCase().indexOf(lw));
        if (!acct) continue;
        const acctEv = bookEvs.find((e) => num(e.value) === acct.amount && normText(e.label).startsWith(normText(acct.account).split(' ')[0]!));
        if (!acctEv) continue;
        const key = linesCiting(ctx, acctEv.id)[0];
        if (!key) continue;
        const businessShare = personal ? 0 : Number(pct![1]) / 100;
        // Personal items are disallowed in full; shared accounts keep the business share.
        const base = personal ? (num(item.value) ?? 0) : acct.amount;
        const disallowed = r2(base * (1 - businessShare));
        if (!disallowed) continue;
        const list = perLine.get(key) ?? [];
        list.push({
          amount: disallowed,
          text: personal
            ? `${item.label} ${fmt(base)} inside ${acct.account} is personal ("${sentence}")`
            : `${acct.account} ${fmt(base)} at ${Math.round(businessShare * 100)}% business ("${sentence}") disallows ${fmt(disallowed)}`,
          nodes: [`call:${c.id}`, E(item.id), E(acctEv.id), P(item.document_id, item.page)],
        });
        perLine.set(key, list);
      }
    }
    const out: CheckIssue[] = [];
    for (const [key, parts] of perLine) {
      const cur = lineNum(ctx, key);
      if (cur === undefined) continue;
      const total = r2(parts.reduce((s, p) => s + p.amount, 0));
      const corrected = Math.round(cur - total);
      const l = line(ctx, key)!;
      out.push(
        issue('cvd.call_business_use', key, {
          code: 'BUSINESS_USE_NOT_APPLIED',
          severity: 'error',
          title: `${l.form} ${l.line} deducts ${fmt(cur)} at 100%; the client call limits it to ${fmt(corrected)}`,
          detail: `${parts.map((p) => p.text).join('; ')}. ${l.label}: ${fmt(cur)} → ${fmt(corrected)}. (§8 E7)`,
          nodeIds: [L(ctx, key), ...parts.flatMap((p) => p.nodes)],
          suggestion: { nodeId: L(ctx, key), value: corrected, why: 'Business-use percentages from the client call' },
          effect: effectOf(ctx, key, cur, corrected),
        }),
      );
    }
    return out;
  },
});

const LONG_BOX: Record<string, string> = { A: 'D', B: 'E', C: 'F', G: 'J', H: 'K', I: 'L' };

registerCheck({
  id: 'cvd.lot_basis_from_client',
  title: 'Zero-basis lot where the client stated a cost',
  family: 'client_vs_documents',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx)) {
      if (l.form !== 'F8949' || l.line.endsWith('.total')) continue;
      const evs = l.sources.map((s) => ctx.b.evs.get(s)).filter((e): e is ExtractedValue => !!e);
      const missing = evs.filter((e) => e.value === null);
      if (!missing.length) continue;
      const m = /^(\S+)\s.*\(acquired (\d{4}-\d{2}-\d{2}), sold (\d{4}-\d{2}-\d{2}); proceeds ([\d,.]+), basis ([\d,.]+)/.exec(l.label);
      if (!m || parseMoney(m[5]!) !== 0) continue;
      const [asset, , sold, proceedsRaw] = [m[1]!, m[2]!, m[3]!, m[4]!];
      const proceeds = parseMoney(proceedsRaw);
      const cur = lineNum(ctx, l.key);
      if (cur === undefined) continue;
      const msg = ctx.b.packet.client.messages.find((x) => x.text.includes(asset) && /\b(cost|bought|paid)\b/i.test(x.text));
      if (!msg) continue;
      const amt = /(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)/.exec(msg.text);
      const date = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/.exec(msg.text);
      if (!amt) continue;
      const cost = parseMoney(amt[1]!);
      const acquired = date ? isoFromUs(date[1]!) : undefined;
      const gain = r2(proceeds - cost);
      const box = l.line.split('.')[0]!;
      const longTerm = acquired ? Date.parse(sold) - Date.parse(acquired) > 365 * 864e5 : false;
      const newBox = longTerm ? LONG_BOX[box] : undefined;
      // Effect: the gain leaves this box and (if long-term) lands in the long-term box.
      const longCarry = newBox && consumersOf(ctx, `F8949.${newBox}.total`)[0];
      const effect = longCarry
        ? sumEffects(
            [effectOf(ctx, l.key, cur, 0), effectOf(ctx, longCarry, lineNum(ctx, longCarry) ?? 0, (lineNum(ctx, longCarry) ?? 0) + gain)],
            `Remove ${fmt(cur)} short-term; add ${fmt(gain)} long-term via ${longCarry} (${ctx.version} rates)`,
          )
        : effectOf(ctx, l.key, cur, gain);
      out.push(
        issue('cvd.lot_basis_from_client', l.key, {
          code: 'ZERO_BASIS_CLIENT_COST',
          severity: 'warning',
          title: `${l.form} ${l.line}: ${asset} taxed on ${fmt(cur)} with no basis; client states cost ${fmt(cost)}${acquired ? ` on ${acquired}` : ''}`,
          detail:
            `Basis not read (${missing.map((e) => `${e.id} conf ${e.confidence}`).join(', ')}). ${msg.id}: "${msg.text}" ` +
            `With that cost the gain is ${fmt(proceeds)} − ${fmt(cost)} = ${fmt(gain)}` +
            (longTerm ? `, long-term (held over one year), so the lot moves from box ${box} to box ${newBox}` : '') +
            '. The only evidence is a bank statement line; obtain it before relying on the client figure. (§8 E12)',
          nodeIds: [L(ctx, l.key), `msg:${msg.id}`, ...evs.map((e) => E(e.id)), ...uniq(evs.map((e) => `doc:${e.document_id}`)), longCarry && L(ctx, longCarry)],
          suggestion: { nodeId: L(ctx, l.key), value: gain, why: `Client-stated cost ${fmt(cost)} (${msg.id})${newBox ? `; report in box ${newBox}` : ''}` },
          effect,
        }),
      );
    }
    return out;
  },
});
