// Rentals and passive losses (Schedule E, Form 8582, Form 4797) and K-1 landings.

import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import { compact, fmt, lineRow, money, n, text, type ViewCtx } from './ctx.ts';

const EXPENSE_LINES = ['5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'];

export function rentals(ctx: ViewCtx): ViewDto {
  const ver = ctx.wp.b.version(ctx.v)!;
  const carryIn = (ctx.packet.prior_years.carryovers_into_2025 ?? {}) as Record<string, unknown>;
  const carryOut = ((ver.carryovers_out as any)?.federal ?? {}) as Record<string, number>;
  const props = ver.lines.filter((l) => l.form === 'SchE' && /^1[A-Z]$/.test(l.line)).map((l) => l.line.slice(1));
  const findings: ViewFlag[] = [];
  const sections = [];

  for (const p of props) {
    const address = String(ctx.line(`SchE.1${p}`)!.value);
    const streetNo = /^\d+/.exec(address)?.[0] ?? '';
    const passiveKey = Object.keys(carryIn).find((k) => k.startsWith('passive_') && k.includes(streetNo));
    const rows: ViewRow[] = compact([lineRow(ctx, `SchE.2${p}`, {}, 'amount'), lineRow(ctx, `SchE.3${p}`)]);
    for (const ln of EXPENSE_LINES) {
      const r = lineRow(ctx, `SchE.${ln}${p}`);
      if (!r) continue;
      const l = ctx.line(`SchE.${ln}${p}`)!;
      const flags: ViewFlag[] = [];
      if (l.sources.length && l.sources.every((s) => /^(qa|msg|call)-/.test(s)))
        flags.push({ code: 'UNSOURCED_AMOUNT', severity: 'warning', text: `Supported only by the client's answer (${l.sources.join(', ')}); no document`, nodeIds: [r.nodeId!, ...l.sources.map((s) => `${s.slice(0, s.indexOf('-'))}:${s}`)] });
      if (ln === '14') {
        // Repairs: any single invoice for this property above the de minimis safe harbor may be an improvement.
        for (const inv of ctx.docsOfType('invoice').filter((d) => streetNo && d.title.includes(streetNo))) {
          const tot = ctx.docEv(inv.id, 'total');
          if (tot && n(tot.value) > 2500) {
            const alt = ctx.packet.what_if.alternatives.find((a: any) => /improvement/i.test(a.id) || /improvement/i.test(a.description));
            flags.push({
              code: 'REPAIR_VS_IMPROVEMENT',
              severity: 'warning',
              text: `Repairs include ${inv.issuer} invoice ${fmt(n(tot.value))}; over the 2,500 de minimis safe harbor, may be a capital improvement${alt ? ` (what-if ${alt.id}: federal tax ${fmt(n(alt.federal?.total_tax_change))}, California ${fmt(n(alt.california?.total_tax_change))})` : ''}`,
              nodeIds: [r.nodeId!, `ev:${tot.id}`, `doc:${inv.id}`],
            });
          }
        }
      }
      if (flags.length) {
        r.flags = flags;
        findings.push(...flags);
      }
      rows.push(r);
    }
    rows.push(...compact([lineRow(ctx, `SchE.20${p}`), lineRow(ctx, `SchE.21${p}`)]));
    const current = ctx.num(`SchE.21${p}`);
    const allowed = ctx.cell(`SchE.22${p}`);
    const inAmt = passiveKey ? n(carryIn[passiveKey]) : 0;
    const outAmt = passiveKey ? n(carryOut[passiveKey]) : 0;
    const expectedOut = Math.max(0, inAmt - current + n(allowed?.value)); // suspended = prior + current loss − allowed
    const passive: ViewRow[] = [
      { id: `in:${p}`, label: 'Suspended passive loss from 2024', nodeId: passiveKey && `py:/carryovers_into_2025/${passiveKey}`, cells: { amount: passiveKey ? ctx.py(`/carryovers_into_2025/${passiveKey}`) : { value: 0 } } },
      { id: `cur:${p}`, label: '2025 income (loss)', nodeId: lineId(ctx.v, `SchE.21${p}`), cells: { amount: ctx.cell(`SchE.21${p}`) } },
      { id: `allowed:${p}`, label: 'Allowed after Form 8582', nodeId: allowed?.nodeId, cells: { amount: allowed } },
      {
        id: `out:${p}`,
        label: 'Suspended passive loss to 2026',
        cells: { amount: { value: outAmt, note: 'return_versions[].carryovers_out.federal' }, check: { value: expectedOut } },
        flags: Math.abs(expectedOut - outAmt) > 1 ? [{ code: 'PASSIVE_ROLL', severity: 'warning', text: `Prior ${fmt(inAmt)} + loss ${fmt(-current)} − allowed ${fmt(-n(allowed?.value))} = ${fmt(expectedOut)}, carryover out ${fmt(outAmt)}` }] : undefined,
      },
    ];
    sections.push({ id: `property-${p}`, title: `Property ${p}: ${address}`, columns: [money('amount', 'Amount'), money('check', 'Recomputed')], rows: [...rows, ...passive] });
  }

  const f8582 = compact(['F8582.1a', 'F8582.1b', 'F8582.1c', 'F8582.3a', 'F8582.4', 'SchE.26', 'SchE.32', 'SchE.41'].map((k) => lineRow(ctx, k)));
  const sale = compact(['F4797.20', 'F4797.21', 'F4797.22', 'F4797.23', 'F4797.24', 'F4797.25', 'F4797.26g', 'F4797.7', 'F4797.8', 'F4797.9', 'SchD.11', 'SchD.19'].map((k) => lineRow(ctx, k)));
  sections.push({ id: 'passive', title: 'Passive activity loss limitation (Form 8582)', columns: [money('amount', 'Amount')], rows: f8582 });
  if (sale.length) sections.push({ id: 'sale', title: 'Sale of rental property (Form 4797)', columns: [money('amount', 'Amount')], rows: sale });

  return ctx.view('rentals', 'Rentals and passive losses', 'Per property income and expenses, passive losses suspended in and out (Form 8582), and the sale of the Austin condo (Form 4797).', sections, findings);
}

export function k1(ctx: ViewCtx): ViewDto {
  const taxYear = ctx.packet.household.tax_year;
  const docs = ctx.docsOfType('K-1-1065', 'K-1-1120S', 'K-1-state-supplement');
  const entities = new Map<string, typeof docs>();
  for (const d of docs) entities.set(d.issuer, [...(entities.get(d.issuer) ?? []), d]);
  const findings: ViewFlag[] = [];
  const prior = ctx.packet.prior_years.return_2024 ?? {};
  const sections = [];
  for (const [entity, ds] of entities) {
    const rows: ViewRow[] = [];
    for (const d of ds.sort((a, b) => b.tax_year - a.tax_year)) {
      for (const e of ctx.docEvs(d.id)) {
        const landed = ctx.linesCiting(`ev:${e.id}`);
        const flags: ViewFlag[] = [];
        if (d.tax_year !== taxYear && landed.length)
          flags.push({ code: 'OUT_OF_YEAR_SOURCE', severity: 'info', text: `${d.tax_year} K-1 value used on 2025 lines (${landed.join(', ')})`, nodeIds: [`ev:${e.id}`, ...landed.map((k) => lineId(ctx.v, k))] });
        if (d.tax_year === taxYear && !landed.length && typeof e.value === 'number' && e.value !== 0)
          flags.push({ code: 'K1_NOT_LANDED', severity: 'info', text: 'Not carried to any return line (may be informational or used only in a computation)', nodeIds: [`ev:${e.id}`] });
        rows.push({
          id: e.id,
          label: e.label,
          sublabel: `${d.id} (${d.tax_year}) · ${e.field}`,
          nodeId: `ev:${e.id}`,
          cells: { amount: { value: e.value, nodeId: `ev:${e.id}` }, landed: { value: landed.join(', ') || '—' }, landedValue: landed[0] ? ctx.cell(landed[0]) : undefined },
          flags: flags.length ? flags : undefined,
          links: landed.map((k) => lineId(ctx.v, k)),
        });
      }
    }
    // Prior-year comparison where the 2024 return kept the K-1.
    const pk = /1120-?S|Inc\./i.test(entity) && prior.K1_1120S ? ['K1_1120S', prior.K1_1120S] : /LP|1065/.test(entity) && prior.K1_1065 ? ['K1_1065', prior.K1_1065] : null;
    if (pk) {
      for (const [k, v] of Object.entries(pk[1] as Record<string, unknown>)) {
        if (typeof v !== 'number') continue;
        rows.push({ id: `py:${pk[0]}:${k}`, label: `2024 ${k}`, sublabel: '2024 return as filed', nodeId: `py:/return_2024/${pk[0]}/${k}`, cells: { amount: { value: v, nodeId: `py:/return_2024/${pk[0]}/${k}` } } });
      }
    }
    findings.push(...rows.flatMap((r) => r.flags ?? []).filter((f) => f.code === 'OUT_OF_YEAR_SOURCE'));
    sections.push({ id: entity, title: entity, columns: [money('amount', 'K-1 amount'), text('landed', 'Landed on'), money('landedValue', 'Line value (effective)')], rows });
  }
  return ctx.view('k1', 'K-1 lines', 'Each K-1 value from each entity and the return line it landed on.', sections, findings);
}
