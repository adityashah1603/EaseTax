// Depreciation by asset: federal / California / AMT, method, life, bonus or §179,
// accumulated, disposals and recapture. Independently re-adds the prior preparer's
// year-by-year schedule and ties each activity's assets to the return line they feed.

import type { AssetRow, ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { assetId, resolveRef } from '@easetax/shared';
import { fmt, money, n, round2, text, type ViewCtx } from './ctx.ts';

const sumYears = (o: Record<string, number> | undefined) => round2(Object.values(o ?? {}).reduce((s, x) => s + n(x), 0));

export function depreciation(ctx: ViewCtx): ViewDto {
  const ver = ctx.wp.b.version(ctx.v)!;
  const prior = (ctx.packet.prior_years.asset_records ?? []) as any[];
  const findings: ViewFlag[] = [];
  const rows: ViewRow[] = [];

  for (const a of ver.assets as AssetRow[]) {
    const id = assetId(ctx.v, a.asset_id);
    const py = prior.find((p) => p.asset_id === a.asset_id);
    const pyIdx = prior.indexOf(py);
    const flags: ViewFlag[] = [];
    const fed = a.federal as Record<string, number>;
    const ca = a.california as Record<string, number>;
    const amt = a.amt as Record<string, number>;
    if (py) {
      const fedPrior = sumYears(py.federal);
      const caPrior = sumYears(py.california);
      if (Math.abs(fedPrior - n(fed.prior_accumulated)) > 0.05)
        flags.push({ code: 'PRIOR_ACCUM_FED', severity: 'warning', text: `Prior schedule adds to ${fmt(fedPrior)} federal; engine opening accumulated ${fmt(n(fed.prior_accumulated))}`, nodeIds: [id, `py:/asset_records/${pyIdx}`] });
      if (Math.abs(caPrior - n(ca.prior_accumulated)) > 0.05)
        flags.push({ code: 'PRIOR_ACCUM_CA', severity: 'warning', text: `Prior schedule adds to ${fmt(caPrior)} California; engine opening accumulated ${fmt(n(ca.prior_accumulated))}`, nodeIds: [id, `py:/asset_records/${pyIdx}`] });
    }
    const method = String(a.method);
    const placed2025 = a.placed_in_service.startsWith(String(ctx.packet.household.tax_year));
    const bonus = /special|bonus/i.test(method) && placed2025 ? n(fed.depreciation_2025) : 0;
    const s179 = /179/.test(method) && placed2025 ? n(fed.depreciation_2025) : 0;
    const disp = (a as any).disposition as { date: string; unrecaptured_1250_depreciation?: number; section_1250_ordinary_recapture?: number } | undefined;
    const caLine = ctx.cell(`FTB3885A.${a.asset_id}`);
    if (caLine && Math.abs(n(caLine.value) - round2(n(ca.depreciation_2025))) > 1)
      flags.push({ code: 'CA_LINE_MISMATCH', severity: 'warning', text: `FTB 3885A shows ${fmt(n(caLine.value))}; asset register ${fmt(n(ca.depreciation_2025))}`, nodeIds: [id, caLine.nodeId!] });
    if (n(ca.depreciation_2025) !== n(fed.depreciation_2025))
      flags.push({ code: 'FED_CA_DIFFERENCE', severity: 'info', text: `Federal ${fmt(n(fed.depreciation_2025))} vs California ${fmt(n(ca.depreciation_2025))} (California does not conform to bonus depreciation)`, nodeIds: [id] });
    rows.push({
      id: a.asset_id,
      label: a.description,
      sublabel: `${a.activity} · placed ${a.placed_in_service} · ${method} · ${a.life_years} yr`,
      nodeId: id,
      status: a.disposed ? `disposed ${a.disposed}` : 'in service',
      cells: {
        cost: { value: a.cost, nodeId: id },
        land: { value: a.land_value_not_depreciated ?? null, nodeId: id },
        method: { value: method },
        life: { value: a.life_years },
        bonus: { value: bonus },
        s179: { value: s179 },
        fedPrior: { value: n(fed.prior_accumulated), nodeId: py ? `py:/asset_records/${pyIdx}/federal` : id },
        fed2025: { value: n(fed.depreciation_2025), nodeId: id },
        fedEnd: { value: n(fed.accumulated_end), nodeId: id },
        caPrior: { value: n(ca.prior_accumulated), nodeId: py ? `py:/asset_records/${pyIdx}/california` : id },
        ca2025: caLine ?? { value: n(ca.depreciation_2025), nodeId: id },
        caEnd: { value: n(ca.accumulated_end), nodeId: id },
        amt2025: { value: n(amt.depreciation_2025), nodeId: id },
        amtDiff: { value: n(amt.difference_from_regular), nodeId: id },
        recapture1250: { value: disp?.unrecaptured_1250_depreciation ?? null, nodeId: disp ? id : undefined },
        ordinaryRecapture: { value: disp?.section_1250_ordinary_recapture ?? null, nodeId: disp ? id : undefined },
      },
      flags: flags.length ? flags : undefined,
      links: (a.sources ?? []).map((s) => resolveRef(s, ctx.v)),
    });
    findings.push(...flags.filter((f) => f.severity !== 'info'));
  }

  // Tie each activity's 2025 federal depreciation to the line that carries it.
  const ties: ViewRow[] = [];
  const byActivity = new Map<string, AssetRow[]>();
  for (const a of ver.assets) byActivity.set(a.activity, [...(byActivity.get(a.activity) ?? []), a]);
  for (const [activity, assets] of byActivity) {
    const citing = new Set<string>();
    for (const a of assets) for (const k of ctx.linesCiting(assetId(ctx.v, a.asset_id))) if (/^F4562/.test(k)) citing.add(k);
    let key = [...citing][0];
    if (!key && activity.startsWith('Business')) key = ctx.has('F4562-C.22') ? 'F4562-C.22' : undefined;
    const reg = round2(assets.reduce((s, a) => s + n((a.federal as any).depreciation_2025), 0));
    const c = key ? ctx.cell(key) : undefined;
    const diff = c ? round2(n(c.value) - reg) : null;
    const flags: ViewFlag[] = [];
    if (c && Math.abs(diff!) > 1) flags.push({ code: 'REGISTER_VS_LINE', severity: 'warning', text: `Register ${fmt(reg)} vs ${key} ${fmt(n(c.value))}`, nodeIds: [c.nodeId!] });
    ties.push({ id: activity, label: activity, nodeId: c?.nodeId, cells: { register: { value: reg }, line: c, difference: { value: diff } }, flags: flags.length ? flags : undefined, links: assets.map((a) => assetId(ctx.v, a.asset_id)) });
    findings.push(...flags);
  }

  // Disposals: 4797 depreciation allowed and unrecaptured §1250 gain vs the register.
  const disposed = ver.assets.filter((a) => a.disposed);
  const dispRows: ViewRow[] = [];
  if (disposed.length) {
    const accum = round2(disposed.reduce((s, a) => s + n((a.federal as any).accumulated_end), 0));
    const unrec = round2(disposed.reduce((s, a) => s + n((a as any).disposition?.unrecaptured_1250_depreciation), 0));
    for (const [key, reg, what] of [
      ['F4797.23', accum, 'Depreciation allowed (accumulated at disposal)'],
      ['SchD.19', unrec, 'Unrecaptured §1250 gain'],
      ['F4797.26g', round2(disposed.reduce((s, a) => s + n((a as any).disposition?.section_1250_ordinary_recapture), 0)), '§1250 ordinary recapture'],
    ] as const) {
      const c = ctx.cell(key);
      if (!c) continue;
      const diff = round2(n(c.value) - reg);
      const flags: ViewFlag[] = Math.abs(diff) > 1 ? [{ code: 'RECAPTURE_TIE', severity: 'warning', text: `${what}: register ${fmt(reg)} vs ${key} ${fmt(n(c.value))}`, nodeIds: [c.nodeId!] }] : [];
      dispRows.push({ id: key, label: what, nodeId: c.nodeId, cells: { register: { value: reg }, line: c, difference: { value: diff } }, flags: flags.length ? flags : undefined, links: disposed.map((a) => assetId(ctx.v, a.asset_id)) });
    }
  }

  // California basis differences carried out.
  const caDiffs = ((ver.carryovers_out as any)?.california?.depreciation_basis_differences ?? {}) as Record<string, number>;
  const caRows: ViewRow[] = Object.entries(caDiffs).map(([aid, amt]) => ({
    id: aid,
    label: `${aid} federal/California basis difference to 2026`,
    nodeId: assetId(ctx.v, aid),
    cells: { amount: { value: amt, nodeId: assetId(ctx.v, aid) } },
  }));

  const regCols = [money('register', 'Asset register'), money('line', 'Return line'), money('difference', 'Difference')];
  return ctx.view(
    'depreciation',
    'Depreciation by asset',
    'Every asset with federal, California and AMT depreciation, method, life, bonus or §179, accumulated depreciation, disposals and recapture, cross-checked against the prior preparer schedule and the return lines.',
    [
      {
        id: 'assets',
        title: 'Asset register',
        columns: [
          money('cost', 'Cost'),
          money('land', 'Land'),
          text('method', 'Method'),
          { key: 'life', label: 'Life', kind: 'number' },
          money('bonus', 'Bonus'),
          money('s179', '§179'),
          money('fedPrior', 'Fed accumulated 1/1'),
          money('fed2025', 'Fed 2025'),
          money('fedEnd', 'Fed accumulated 12/31'),
          money('caPrior', 'CA accumulated 1/1'),
          money('ca2025', 'CA 2025'),
          money('caEnd', 'CA accumulated 12/31'),
          money('amt2025', 'AMT 2025'),
          money('amtDiff', 'AMT adjustment'),
          money('recapture1250', 'Unrecaptured §1250'),
          money('ordinaryRecapture', 'Ordinary recapture'),
        ],
        rows,
      },
      { id: 'lines', title: 'Register vs return lines', columns: regCols, rows: ties },
      { id: 'disposals', title: 'Disposals and recapture', columns: regCols, rows: dispRows },
      { id: 'ca-basis', title: 'California basis differences carried to 2026', columns: [money('amount', 'Difference')], rows: caRows },
    ],
    findings,
  );
}

