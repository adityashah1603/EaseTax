// Roll forward to the next year (design §7.11): carryovers out, basis, the asset register,
// open items and estimate planning, each linked back to the node it came from
// (`from` = prior_year_of edge) so next year's trace crosses years.

import type { Actor, FrozenLine } from '@easetax/shared';
import { assetId, lineId } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan } from '../policy/policy.ts';
import { ViewCtx } from '../views/ctx.ts';
import { outsideFilings } from '../views/completeness.ts';
import { filedSnapshotId } from './state.ts';
import { loadSnapshot, putFrozen, type FilingSnapshotContent } from './snapshot.ts';

const r0 = (x: number) => Math.round(x);

export function rollForward(wp: Workpaper, actor: Actor, body: { toYear?: number } = {}) {
  assertCan(actor, 'verify'); // staff opening next year's file (tl-28: the preparer)
  const ctx = new ViewCtx(wp);
  const taxYear = wp.b.packet.household.tax_year;
  const toYear = body.toYear ?? taxYear + 1;
  const ver = wp.b.version(wp.version)!;
  const snapId = filedSnapshotId(wp);
  const snap = snapId ? loadSnapshot<FilingSnapshotContent>(wp, snapId) : undefined;
  const frozen = new Map<string, FrozenLine>((snap?.content.lines ?? []).map((l) => [l.key, l]));
  // Values come from the filed return when there is one, else the live effective return.
  const val = (key: string): number => {
    const v = snap ? frozen.get(key)?.value : ctx.cell(key)?.value;
    return typeof v === 'number' ? v : 0;
  };
  const from = (key: string) => lineId(wp.version, key);
  const co = (ver.carryovers_out ?? {}) as Record<string, any>;

  const carryovers = (['federal', 'california'] as const).flatMap((jur) =>
    Object.entries(co[jur] ?? {}).flatMap(([k, v]) =>
      typeof v === 'number'
        ? [{ jurisdiction: jur, key: k, amount: v, from: `version:${wp.version}`, note: `return_versions[${wp.version}].carryovers_out.${jur}.${k}` }]
        : Object.entries(v as Record<string, number>).map(([sub, amt]) => ({ jurisdiction: jur, key: `${k}.${sub}`, amount: amt, from: assetId(wp.version, sub), note: k })),
    ),
  );

  const k1065 = ctx.docsOfType('K-1-1065').find((d) => d.tax_year === taxYear);
  const capEnd = k1065 ? ctx.docEv(k1065.id, 'cap_end') : undefined;
  const homes = Object.entries((wp.b.packet.prior_years.basis_records ?? {}) as Record<string, any[]>).filter(([k]) => k.startsWith('home_'));
  const basis = [
    ctx.has('F7203.15') && { what: 'S corporation stock basis (end of year)', amount: val('F7203.15'), from: from('F7203.15'), note: val('F7203.excess') ? `Distributions exceeded basis by ${val('F7203.excess')} (taxed as gain)` : undefined },
    capEnd && { what: 'Partnership ending capital account (Ridgeline)', amount: Number(capEnd.value), from: `ev:${capEnd.id}`, note: 'Outside basis still to be computed (open since 2024)' },
    ctx.has('F8606.14') && { what: 'Traditional IRA nondeductible basis', amount: val('F8606.14'), from: from('F8606.14') },
    ...homes.flatMap(([k, list]) => list.map((h, i) => ({ what: `Home cost basis (${k.replace(/^home_/, '').replace(/_/g, ' ')})`, amount: h.price, from: `py:/basis_records/${k}/${i}`, note: h.event }))),
  ].filter(Boolean);

  const assets = ver.assets
    .filter((a) => !a.disposed)
    .map((a) => ({
      assetId: a.asset_id,
      description: a.description,
      activity: a.activity,
      cost: a.cost,
      placedInService: a.placed_in_service,
      method: a.method,
      lifeYears: a.life_years,
      federalAccumulated: (a.federal as any).accumulated_end,
      californiaAccumulated: (a.california as any).accumulated_end,
      from: assetId(wp.version, a.asset_id),
    }));
  const disposedAssets = ver.assets.filter((a) => a.disposed).map((a) => ({ assetId: a.asset_id, disposed: a.disposed, from: assetId(wp.version, a.asset_id) }));

  const openItems = [
    ...wp.issues().filter((i) => i.status === 'open' && i.severity !== 'info').map((i) => ({ kind: 'issue', text: i.title, nodeIds: i.nodeIds.slice(0, 3) })),
    ...[...wp.state.questions.values()].filter((q) => q.status === 'open').map((q) => ({ kind: 'question', text: q.thread[0]?.text ?? '', nodeIds: q.nodeIds })),
    ...[...wp.state.notes.values()].filter((n) => n.status === 'open').map((n) => ({ kind: 'note', text: n.thread[0]?.text ?? '', nodeIds: n.nodeIds })),
    ...outsideFilings(ctx).filter((o) => o.status === 'open').map((o) => ({ kind: 'outside_filing', text: `${o.title}: ${o.why}`, nodeIds: o.nodeIds })),
    ...ver.diagnostics.filter((d) => /NOT_COMPUTED|CARRYFORWARD/.test(d.code)).map((d) => ({ kind: 'engine_diagnostic', text: d.message, nodeIds: [`diag:${wp.version}:${d.code}`] })),
  ];

  // Estimate planning from planning_reference_<next year>.
  const plan = (wp.b.packet.planning_reference_2026 ?? {}) as Record<string, any>;
  const fedTax = val('F1040.24');
  const caTax = val('F540NR.64');
  const agi = val('F1040.11');
  const fedPct = agi > 150000 ? 1.1 : 1.0;
  const fedRequired = r0(fedTax * fedPct);
  const fedDates: string[] = plan.federal_estimate_due_dates ?? [];
  const caDates: string[] = plan.california_estimate_due_dates ?? [];
  const caPcts: number[] = plan.california_installment_percentages ?? [];
  const caRequired = r0(caTax * (agi > 150000 ? 1.1 : 1.0));
  const planning = {
    basis: snap ? `Filed return (snapshot ${snapId})` : 'Live workpaper (not yet filed)',
    federal: {
      safeHarbor: plan.federal_safe_harbor,
      priorYearTax: { amount: fedTax, from: from('F1040.24') },
      requiredAnnualPayment: fedRequired,
      installments: fedDates.map((d, i) => ({ due: d, amount: i < fedDates.length - 1 ? Math.floor(fedRequired / fedDates.length) : fedRequired - Math.floor(fedRequired / fedDates.length) * (fedDates.length - 1) })),
    },
    california: {
      safeHarbor: plan.california_safe_harbor,
      priorYearTax: { amount: caTax, from: from('F540NR.64') },
      requiredAnnualPayment: caRequired,
      installments: caDates.map((d, i) => ({ due: d, amount: r0(caRequired * (caPcts[i] ?? 0)) })),
    },
    minimumTaxCredit: co.federal?.minimum_tax_credit_from_2025_amt ? { amount: co.federal.minimum_tax_credit_from_2025_amt, from: from('F6251.11'), note: 'Form 8801 next year' } : undefined,
    knownChanges: plan.known_2026_changes_for_this_household ?? [],
    note: '90% of the next year\'s own tax is the other safe-harbor prong; it needs a projection the engine cannot make.',
  };

  const document = {
    schema: 'easetax.rollforward/1',
    fromYear: taxYear,
    toYear,
    clientId: wp.b.packet.packet.client_id,
    sourceSnapshot: snap ? { id: snapId, contentHash: snap.contentHash, seq: snap.content.seq } : null,
    engineVersion: wp.version,
    carryovers,
    basis,
    assets,
    disposedAssets,
    openItems,
    planning,
  };
  const frozen_ = putFrozen(wp, 'rollforward', document);
  const events = wp.commit(actor, [{ type: 'filing.step', payload: { step: 'rollforward', data: { snapshotId: frozen_.id, contentHash: frozen_.contentHash, toYear } } }]);
  return { events, data: { id: frozen_.id, contentHash: frozen_.contentHash, document } };
}
