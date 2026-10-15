// State split (design §7.7): residency periods, Schedule CA (540NR) columns A–E per item with
// its sourcing method, and our own column math (A − B + C = D; |E| ≤ |D|) plus a
// residency-days proration as an independent yardstick for column E.

import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { daysBetween, fmt, money, n, text, type ViewCtx } from './ctx.ts';

/** Sourcing method per Schedule CA line, as the engine's rule names it and as a reviewer reads it. */
const SOURCING: Record<string, { method: string; prorate: boolean }> = {
  '1': { method: 'Wages: sourced by work location and date (California while working from Sacramento, to 7/14)', prorate: false },
  '2': { method: 'Interest: prorated by days of California residency; U.S. Treasury interest excluded (column B)', prorate: true },
  '3': { method: 'Dividends: prorated by days of California residency', prorate: true },
  '4': { method: 'IRA distribution: California-source when received while a resident', prorate: false },
  '7': { method: 'Capital gains: securities by residency at sale date; real property by location (Austin condo not California-source)', prorate: false },
  '12': { method: 'Business income: by where the work was performed; California depreciation differences in column C', prorate: false },
  '17': { method: 'Rental and K-1 income: Sacramento rental 100% California-source; Austin condo none; Ridgeline by its California share', prorate: false },
  '26': { method: 'Adjustments: follow the income they relate to', prorate: false },
};

export function stateSplit(ctx: ViewCtx): ViewDto {
  const residency = ctx.packet.household.residency;
  const year = ctx.packet.household.tax_year;
  const yearDays = daysBetween(`${year}-01-01`, `${year}-12-31`);
  const caPeriods = residency.filter((r) => r.state === 'CA');
  const caDays = caPeriods.reduce((s, r) => s + daysBetween(r.from, r.to), 0);
  const ratio = caDays / yearDays;
  const findings: ViewFlag[] = [];

  const resRows: ViewRow[] = residency.map((r, i) => ({
    id: `res-${i}`,
    label: `${r.state} ${r.status}`,
    sublabel: `${r.from} → ${r.to}`,
    cells: { days: { value: daysBetween(r.from, r.to) }, share: { value: Math.round((daysBetween(r.from, r.to) / yearDays) * 10000) / 100 } },
  }));
  const engineDays = ctx.wp.rawValue('ref:param.ca_resident_days');
  if (typeof engineDays === 'number' && engineDays !== caDays)
    findings.push({ code: 'RESIDENCY_DAYS', severity: 'warning', text: `Residency periods give ${caDays} California days; engine parameter ca_resident_days is ${engineDays}`, nodeIds: ['ref:param.ca_resident_days'] });

  const lines = ctx.wp.b.version(ctx.v)!.lines.filter((l) => l.form === 'SchCA540NR');
  const nums = [...new Set(lines.map((l) => l.line.split('.')[0]!))].filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(a) - Number(b));
  const rows: ViewRow[] = [];
  for (const ln of nums) {
    const col = (c: string) => ctx.cell(`SchCA540NR.${ln}.${c}`);
    const A = col('A');
    const B = col('B');
    const C = col('C');
    const D = col('D');
    const E = col('E');
    const first = lines.find((l) => l.line.startsWith(`${ln}.`))!;
    const label = first.label.replace(/ - (federal|CA subtractions|CA additions|total using CA law|California amount|Total.*)$/i, '');
    const flags: ViewFlag[] = [];
    let expectedD: number | null = null;
    if (A) {
      expectedD = n(A.value) - n(B?.value) + n(C?.value);
      if (D && Math.abs(expectedD - n(D.value)) > 1)
        flags.push({ code: 'COLUMN_MATH', severity: 'error', text: `A − B + C = ${fmt(expectedD)} but column D is ${fmt(n(D.value))}`, nodeIds: [D.nodeId!] });
    }
    if (D && E && Math.abs(n(E.value)) > Math.abs(n(D.value)) + 1)
      flags.push({ code: 'E_EXCEEDS_D', severity: 'info', text: `California amount ${fmt(n(E.value))} exceeds the total ${fmt(n(D.value))} (California-source losses larger than the net total)`, nodeIds: [E.nodeId!, D.nodeId!] });
    const src = SOURCING[ln];
    const prorated = D ? Math.round(n(D.value) * ratio) : null;
    if (src && !src.prorate && D && E && n(D.value) > 0 && n(E.value) === n(D.value) && ln === '1')
      flags.push({ code: 'FULL_YEAR_CA_SOURCE', severity: 'warning', text: `All ${fmt(n(D.value))} treated as California-source although California residency ended ${caPeriods.at(-1)?.to}; check work location after the move`, nodeIds: [E.nodeId!] });
    if (src?.prorate && E && prorated !== null && Math.abs(prorated - n(E.value)) > 2)
      flags.push({ code: 'PRORATION', severity: 'warning', text: `Days proration gives ${fmt(prorated)}; column E is ${fmt(n(E.value))}`, nodeIds: [E.nodeId!] });
    findings.push(...flags.filter((f) => f.severity !== 'info'));
    rows.push({
      id: `line-${ln}`,
      label: `Line ${ln}: ${label}`,
      sublabel: src?.method ?? (E ? `Engine rule ${ctx.line(`SchCA540NR.${ln}.E`)!.rule}` : undefined),
      nodeId: (E ?? D)?.nodeId,
      cells: { A, B, C, D, E, recalcD: { value: expectedD }, prorated: { value: prorated }, method: { value: src?.method ?? '' } },
      flags: flags.length ? flags : undefined,
    });
  }

  // Wage sourcing evidence: state wages on W-2s and paystubs dated around the move.
  const wageRows: ViewRow[] = [];
  for (const d of ctx.packet.documents.filter((x) => ['W-2', 'paystub'].includes(x.document_type))) {
    for (const e of ctx.docEvs(d.id).filter((x) => /box16|box15_state|ca_wages/i.test(x.field))) {
      wageRows.push({ id: e.id, label: `${d.issuer}: ${e.label}`, sublabel: d.id, nodeId: `ev:${e.id}`, cells: { amount: ctx.ev(e.id) } });
    }
  }

  // California AGI check: line 22 E − line 26 E = F540NR.32.
  const totals: ViewRow[] = [];
  const e22 = ctx.cell('SchCA540NR.22.E');
  const e26 = ctx.cell('SchCA540NR.26.E');
  const caAgi = ctx.cell('F540NR.32');
  if (e22 && e26 && caAgi) {
    const calc = n(e22.value) - n(e26.value);
    totals.push({
      id: 'ca-agi',
      label: 'California AGI (22E − 26E)',
      nodeId: caAgi.nodeId,
      cells: { E: caAgi, recalcD: { value: calc } },
      flags: Math.abs(calc - n(caAgi.value)) > 1 ? [{ code: 'CA_AGI_MATH', severity: 'error', text: `22E − 26E = ${fmt(calc)}; F540NR.32 = ${fmt(n(caAgi.value))}` }] : undefined,
    });
  }

  return ctx.view(
    'state-split',
    'State split (California 540NR)',
    'Residency periods and Schedule CA (540NR) columns A–E for each item with its sourcing method, independently re-footed.',
    [
      { id: 'residency', title: 'Residency', columns: [{ key: 'days', label: 'Days', kind: 'number' }, { key: 'share', label: '% of year', kind: 'percent' }], rows: resRows },
      {
        id: 'schca',
        title: 'Schedule CA (540NR)',
        note: `California residency ${caDays} of ${yearDays} days (${(ratio * 100).toFixed(2)}%).`,
        columns: [
          money('A', 'A Federal'),
          money('B', 'B Subtractions'),
          money('C', 'C Additions'),
          money('D', 'D Total (CA law)'),
          money('E', 'E California'),
          money('recalcD', 'A − B + C'),
          money('prorated', 'D × CA days'),
          text('method', 'Sourcing'),
        ],
        rows,
        totals,
      },
      { id: 'wage-evidence', title: 'Wage sourcing evidence', columns: [money('amount', 'Amount')], rows: wageRows },
    ],
    findings,
    { caDays, yearDays, ratio },
  );
}
