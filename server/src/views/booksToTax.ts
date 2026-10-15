// Books to tax: Schedule C bridge from the client's books P&L, through each adjusting item,
// to net profit (SchC.31), and on to SE tax and QBI.

import type { ExtractedValue, ViewCell, ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { compact, fmt, lineRow, money, n, round2, text, type ViewCtx } from './ctx.ts';

/** Books account (P&L field) → tax line, and why they differ when they do. */
const EXPENSE_MAP: { fields: string[]; line: string | null; why: string }[] = [
  { fields: ['Advertising'], line: 'SchC.8', why: 'Advertising' },
  { fields: ['Bank and merchant fees'], line: 'SchC.27a.2', why: 'Bank and merchant fees' },
  { fields: ['Car and truck - fuel'], line: 'SchC.9', why: 'Actual fuel replaced by the standard mileage rate × business miles' },
  { fields: ['Contract labor'], line: 'SchC.11', why: 'Contract labor' },
  { fields: ['Depreciation'], line: 'SchC.13', why: 'Book straight-line replaced by tax depreciation (100% special depreciation election, Form 4562)' },
  { fields: ['Insurance - business liability'], line: 'SchC.15', why: 'Business insurance' },
  { fields: ['Insurance - health (Erik)'], line: null, why: 'Owner health insurance is not a Schedule C expense; claimed as the SE health insurance deduction (Schedule 1 line 17)' },
  { fields: ['Internet', 'Telephone'], line: 'SchC.25', why: 'Telephone and internet' },
  { fields: ['Legal and professional'], line: 'SchC.17', why: 'Legal and professional' },
  { fields: ['Meals'], line: 'SchC.24b', why: 'Meals limited to 50%' },
  { fields: ['Office expenses'], line: 'SchC.18', why: 'Office expense' },
  { fields: ['Software and subscriptions'], line: 'SchC.27a.1', why: 'Software and subscriptions' },
  { fields: ['Supplies'], line: 'SchC.22', why: 'Supplies' },
  { fields: ['Travel'], line: 'SchC.24a', why: 'Travel' },
];

export function booksToTax(ctx: ViewCtx): ViewDto {
  const books = ctx.docsOfType('books_profit_loss')[0];
  const findings: ViewFlag[] = [];
  if (!books) return ctx.view('books-to-tax', 'Books to tax', 'No books P&L document in the file.', [], [{ code: 'NO_BOOKS', severity: 'warning', text: 'No books profit and loss document' }]);
  const evs = ctx.docEvs(books.id);
  const byField = (f: string) => evs.find((e) => e.field === f);
  const evCell = (e: ExtractedValue | undefined): ViewCell | undefined => (e ? { value: e.value, nodeId: `ev:${e.id}` } : undefined);
  const incomeEv = byField('total_income');
  const netEv = byField('net_income');
  const expEv = byField('total_expenses');

  const bridge: ViewRow[] = [];
  const start = n(netEv?.value);
  bridge.push({ id: 'books-net', label: 'Net income per books', nodeId: netEv && `ev:${netEv.id}`, cells: { books: evCell(netEv), effect: { value: start } } });

  // Income
  const schc1 = ctx.cell('SchC.1');
  const incomeDiff = round2(n(schc1?.value) - n(incomeEv?.value));
  bridge.push({
    id: 'income',
    label: 'Gross receipts',
    sublabel: 'Books total income → Schedule C line 1',
    nodeId: schc1?.nodeId,
    cells: { books: evCell(incomeEv), tax: schc1, effect: { value: incomeDiff } },
    links: compact([incomeEv && `ev:${incomeEv.id}`]),
  });

  let total = start + incomeDiff;
  const mapped = new Set<string>(['total_income', 'total_expenses', 'net_income']);
  for (const m of EXPENSE_MAP) {
    const fe = m.fields.map((f) => byField(f)).filter((e): e is ExtractedValue => !!e);
    fe.forEach((e) => mapped.add(e.field));
    const bookAmt = round2(fe.reduce((s, e) => s + n(e.value), 0));
    const c = m.line ? ctx.cell(m.line) : undefined;
    const taxAmt = n(c?.value);
    const effect = round2(bookAmt - taxAmt);
    total += effect;
    bridge.push({
      id: m.line ?? m.fields.join('+'),
      label: m.fields.join(' + '),
      sublabel: m.line ? `→ ${m.line}` : '→ outside Schedule C',
      nodeId: c?.nodeId ?? (fe[0] && `ev:${fe[0].id}`),
      status: effect === 0 ? 'agrees' : 'adjusting item',
      cells: { books: { value: bookAmt, nodeId: fe[0] && `ev:${fe[0].id}` }, tax: c ?? { value: 0 }, effect: { value: effect }, why: { value: effect === 0 ? '' : m.why } },
      links: fe.map((e) => `ev:${e.id}`),
    });
  }
  // Tax-only deductions with no book counterpart (home office).
  for (const k of ['SchC.30']) {
    const c = ctx.cell(k);
    if (!c) continue;
    total -= n(c.value);
    bridge.push({ id: k, label: ctx.line(k)!.label, sublabel: 'Tax-only deduction', nodeId: c.nodeId, status: 'adjusting item', cells: { books: { value: 0 }, tax: c, effect: { value: -n(c.value) }, why: { value: 'Not in the books' } } });
  }
  // Books accounts we did not map are listed so nothing silently disappears.
  for (const e of evs.filter((x) => !mapped.has(x.field) && !/^Sales/.test(x.field))) {
    bridge.push({ id: `unmapped:${e.id}`, label: e.label, nodeId: `ev:${e.id}`, status: 'unmapped', cells: { books: evCell(e) }, flags: [{ code: 'UNMAPPED_BOOKS_ACCOUNT', severity: 'warning', text: 'Books account not mapped to a tax line' }] });
  }

  const schc31 = ctx.cell('SchC.31');
  const unexplained = round2(n(schc31?.value) - total);
  const totals: ViewRow[] = [
    { id: 'computed', label: 'Books net income + adjusting items', cells: { effect: { value: round2(total) } } },
    { id: 'SchC.31', label: 'Net profit (Schedule C line 31)', nodeId: schc31?.nodeId, cells: { tax: schc31, effect: { value: n(schc31?.value) } } },
    {
      id: 'unexplained',
      label: 'Unexplained difference',
      cells: { effect: { value: unexplained } },
      flags: Math.abs(unexplained) > 1 ? [{ code: 'BRIDGE_UNEXPLAINED', severity: 'error', text: `Bridge does not tie by ${fmt(unexplained)}` }] : undefined,
    },
  ];
  if (Math.abs(unexplained) > 1) findings.push(totals[2]!.flags![0]!);

  // Books internal footing.
  if (incomeEv && expEv && netEv && Math.abs(n(incomeEv.value) - n(expEv.value) - n(netEv.value)) > 0.5)
    findings.push({ code: 'BOOKS_FOOTING', severity: 'warning', text: 'Books total income − total expenses ≠ net income', nodeIds: [`ev:${incomeEv.id}`, `ev:${expEv.id}`, `ev:${netEv.id}`] });

  // Third-party agreement: 1099-NEC + 1099-K vs receipts, and overlap noted in the books detail.
  const necEvs = ctx.docsOfType('1099-NEC').map((d) => ctx.docEv(d.id, 'box1')).filter((e): e is ExtractedValue => !!e);
  const kDocs = ctx.docsOfType('1099-K');
  const kEvs = kDocs.map((d) => ctx.docEv(d.id, 'box1a')).filter((e): e is ExtractedValue => !!e);
  const necTotal = necEvs.reduce((s, e) => s + n(e.value), 0);
  const kTotal = kEvs.reduce((s, e) => s + n(e.value), 0);
  const thirdParty: ViewRow[] = [
    ...necEvs.map((e) => ({ id: e.id, label: `1099-NEC ${ctx.wp.b.docs.get(e.document_id)!.issuer}`, nodeId: `ev:${e.id}`, cells: { amount: { value: e.value, nodeId: `ev:${e.id}` } } })),
    ...kEvs.map((e) => ({ id: e.id, label: `1099-K ${ctx.wp.b.docs.get(e.document_id)!.issuer}`, nodeId: `ev:${e.id}`, cells: { amount: { value: e.value, nodeId: `ev:${e.id}` } } })),
  ];
  const thirdTotals: ViewRow[] = [
    { id: 'nec', label: 'Total 1099-NEC', cells: { amount: { value: necTotal } } },
    { id: 'k', label: 'Total 1099-K', cells: { amount: { value: kTotal } } },
    { id: 'books', label: 'Books gross receipts', nodeId: incomeEv && `ev:${incomeEv.id}`, cells: { amount: evCell(incomeEv) } },
    { id: 'SchC.1', label: 'Schedule C gross receipts', nodeId: schc1?.nodeId, cells: { amount: schc1 } },
  ];
  const detailDoc = ctx.docsOfType('books_transaction_detail')[0];
  const detailText = detailDoc?.pages.map((p) => p.printed_content).join(' ') ?? '';
  for (const kd of kDocs) {
    const issuerWord = kd.issuer.split(/[ ,]/)[0]!;
    if (kTotal && Math.abs(incomeDiff - kTotal) < 1 && detailText.includes(issuerWord)) {
      const page = detailDoc!.pages.find((p) => p.printed_content.includes(issuerWord))!;
      findings.push({
        code: 'RECEIPTS_1099K_OVERLAP',
        severity: 'error',
        text: `Schedule C receipts add the 1099-K (${fmt(kTotal)}) on top of books income, but the books deposit detail says ${kd.issuer} card receipts were already deposited gross inside book sales: receipts likely overstated ${fmt(kTotal)}`,
        nodeIds: compact([schc1?.nodeId, ...kEvs.map((e) => `ev:${e.id}`), `doc:${detailDoc!.id}#page${page.page}`]),
      });
    }
  }

  // Client statements about business-use percentages and personal items (call notes).
  const notes = ctx.packet.client.call_notes.flatMap((c) => c.notes.map((t) => ({ call: c.id, t })));
  const pctOf = (re: RegExp) => {
    const hit = notes.find((x) => re.test(x.t) && /\d+%/.test(x.t));
    return hit ? { call: hit.call, pct: Number(/(\d+)%/.exec(hit.t)![1]) / 100 } : undefined;
  };
  const phonePct = pctOf(/mobile|phone/i);
  const netPct = pctOf(/internet/i);
  const tel = byField('Telephone');
  const inet = byField('Internet');
  const sc25 = ctx.cell('SchC.25');
  if (sc25 && tel && inet && (phonePct || netPct)) {
    const expected = round2(n(tel.value) * (phonePct?.pct ?? 1) + n(inet.value) * (netPct?.pct ?? 1));
    if (n(sc25.value) - expected > 1)
      findings.push({
        code: 'BUSINESS_USE_PERCENT',
        severity: 'warning',
        text: `Telephone and internet deducted at 100% (${fmt(n(sc25.value))}); the client's stated business use (${phonePct ? phonePct.pct * 100 + '% phone' : ''}${netPct ? ', ' + netPct.pct * 100 + '% internet' : ''}) supports ≈ ${fmt(expected)}`,
        nodeIds: compact([sc25.nodeId, `ev:${tel.id}`, `ev:${inet.id}`, phonePct && `call:${phonePct.call}`]),
      });
  }
  const personal = notes.find((x) => /personal/i.test(x.t) && /software|subscription|Spotify/i.test(x.t));
  if (personal) {
    const word = /(Spotify\w*)/i.exec(personal.t)?.[1] ?? 'personal item';
    const amt = new RegExp(`${word}[^\\d]{0,20}([\\d,]+\\.\\d{2})`, 'i').exec(detailText)?.[1];
    findings.push({
      code: 'PERSONAL_EXPENSE',
      severity: 'warning',
      text: `Client says ${word} in software and subscriptions is personal${amt ? ` (${amt} per the books detail)` : ''}; it is still in Schedule C line 27a`,
      nodeIds: compact([ctx.cell('SchC.27a.1')?.nodeId, `call:${personal.call}`, detailDoc && `doc:${detailDoc.id}`]),
    });
  }

  const downstream = compact(['SchC.31', 'SchSE.2', 'SchSE.6', 'SchSE.12', 'SchSE.13', 'Sch1.16', 'Sch1.17', 'F8995.2.1', 'F8995.15.1'].map((k) => lineRow(ctx, k)));

  return ctx.view(
    'books-to-tax',
    'Books to tax (Schedule C)',
    `Bridge from the ${books.issuer} P&L (${books.id}) through each adjusting item to Schedule C net profit, then to SE tax and QBI.`,
    [
      { id: 'bridge', title: 'Bridge', columns: [money('books', 'Books'), money('tax', 'Tax return'), money('effect', 'Effect on profit'), text('why', 'Adjusting item')], rows: bridge, totals },
      { id: 'third-party', title: 'Receipts vs information returns', columns: [money('amount', 'Amount')], rows: thirdParty, totals: thirdTotals },
      { id: 'downstream', title: 'Net profit to SE tax and QBI', columns: [money('amount', 'Amount')], rows: downstream },
    ],
    findings,
  );
}
