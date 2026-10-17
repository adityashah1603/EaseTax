// Roll forward to the next year (design §7.11): carryovers out, basis, the asset register,
// open items and estimate planning. Every item carries `sources` (the 2025 nodes, issues and
// judgments it came from), a `history` (2024 prior year → 2025 → next-year opening) and the
// 2025 workpaper `changes` (adjustments, corrections, judgments...) that touched what it rests
// on, so next year's trace crosses years. Built from the filed snapshot when the return is
// filed (D-28), else from the live workpaper; the document says which.

import type {
  Actor,
  AdjustmentDto,
  FrozenLine,
  IssueDto,
  JudgmentDto,
  QuestionDto,
  ReadCorrectionDto,
  ReviewNoteDto,
  RollAsset,
  RollBasis,
  RollCarryover,
  RollChange,
  RollDisposedAsset,
  RollHistoryPoint,
  RollOpenItem,
  RollPlanningItem,
  RollProvenance,
  RollforwardDocument,
} from '@easetax/shared';
import { assetId, diagId, lineId, nodeKind, resolveRef } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, maskFreeText } from '../policy/policy.ts';
import { ViewCtx } from '../views/ctx.ts';
import { outsideFilings } from '../views/completeness.ts';
import { filedSnapshotId, filingState } from './state.ts';
import { loadSnapshot, putFrozen, type FilingSnapshotContent } from './snapshot.ts';

const r0 = (x: number) => Math.round(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const uniq = <T>(xs: (T | undefined | null | false)[]) => [...new Set(xs.filter((x): x is T => x !== undefined && x !== null && x !== false))];
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const fmt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v ?? '—'));
const short = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** How one carryover / basis figure is traced: the lines and prior-year records it rests on, and its history. */
interface Spec {
  label?: string;
  lines: string[];
  py?: string[];
  extra?: string[];
  /** History points before the opening: `py` pointer (optionally one field of it), or a 2025 `line`. */
  hist: { year: number; label: string; py?: string; pick?: string; line?: string; sum?: string[] }[];
}

const CARRY: Record<string, Spec> = {
  'federal.capital_loss_short': {
    lines: ['SchD.16', 'SchD.7', 'SchD.6', 'SchD.21'],
    py: ['/carryovers_into_2025/capital_loss_short', '/return_2024/lines/SchD.7'],
    hist: [
      { year: 2024, label: 'Short-term loss carried out of 2024', py: '/carryovers_into_2025/capital_loss_short' },
      { year: 2025, label: 'Net short-term gain or (loss) after the carry-in', line: 'SchD.7' },
    ],
  },
  'federal.capital_loss_long': {
    lines: ['SchD.16', 'SchD.15', 'SchD.14', 'SchD.21'],
    py: ['/carryovers_into_2025/capital_loss_long', '/return_2024/lines/SchD.15'],
    hist: [
      { year: 2024, label: 'Long-term loss carried out of 2024', py: '/carryovers_into_2025/capital_loss_long' },
      { year: 2025, label: 'Net long-term gain or (loss) after the carry-in', line: 'SchD.15' },
    ],
  },
  'federal.passive_1450_fremont': {
    lines: ['SchE.22A', 'SchE.21A', 'F8582.1c', 'F8582.4'],
    py: ['/carryovers_into_2025/passive_1450_fremont', '/return_2024/lines/F8582.unallowed.A'],
    hist: [
      { year: 2024, label: 'Unallowed passive loss carried out of 2024', py: '/carryovers_into_2025/passive_1450_fremont' },
      { year: 2025, label: 'Deductible rental loss after limitation', line: 'SchE.22A' },
    ],
  },
  'federal.passive_1200_barton_hills': {
    lines: ['SchE.22B', 'SchE.21B', 'F8582.1c', 'F8582.4', 'F4797.9'],
    py: ['/carryovers_into_2025/passive_1200_barton_hills', '/return_2024/lines/F8582.unallowed.B'],
    hist: [
      { year: 2024, label: 'Unallowed passive loss carried out of 2024', py: '/carryovers_into_2025/passive_1200_barton_hills' },
      { year: 2025, label: 'Deductible rental loss after limitation (property sold)', line: 'SchE.22B' },
    ],
  },
  'federal.minimum_tax_credit_from_2025_amt': {
    label: 'Minimum tax credit (from the 2025 AMT)',
    lines: ['F6251.11', 'F6251.9', 'F6251.10', 'Sch2.1'],
    py: ['/carryovers_into_2025/amt_credit'],
    extra: ['diag:AMT_CREDIT_CARRYFORWARD'],
    hist: [
      { year: 2024, label: 'AMT credit carried into 2025', py: '/carryovers_into_2025/amt_credit' },
      { year: 2025, label: 'Alternative minimum tax (deferral item: ISO exercise)', line: 'F6251.11' },
    ],
  },
  'federal.charitable': {
    lines: ['SchA.14', 'SchA.11', 'SchA.12'],
    py: ['/carryovers_into_2025/charitable'],
    hist: [
      { year: 2024, label: 'Charitable carryover into 2025', py: '/carryovers_into_2025/charitable' },
      { year: 2025, label: 'Total gifts to charity', line: 'SchA.14' },
    ],
  },
  'federal.section_179': {
    lines: ['F4562-C.12'],
    hist: [{ year: 2025, label: 'Section 179 expense deduction', line: 'F4562-C.12' }],
  },
  'federal.ira_nondeductible_basis_ngozi': {
    label: 'Traditional IRA nondeductible basis (Ngozi)',
    lines: ['F8606.14', 'F8606.1', 'F8606.2', 'F8606.3', 'F8606.13'],
    py: ['/basis_records/ira_nondeductible_basis_ngozi/0', '/return_2024/lines/F8606.14'],
    hist: [
      { year: 2024, label: '2024 Form 8606 line 14', py: '/basis_records/ira_nondeductible_basis_ngozi/0', pick: 'form_8606_line_14' },
      { year: 2025, label: 'Contributions for 2025', line: 'F8606.1' },
      { year: 2025, label: 'Basis carried to 2026 (after the conversion)', line: 'F8606.14' },
    ],
  },
  'federal.scorp_stock_basis_end': {
    label: 'S corporation stock basis (Woodworks)',
    lines: ['F7203.15', 'F7203.1', 'F7203.4', 'F7203.5', 'F7203.6', 'F7203.7', 'F7203.excess'],
    py: ['/basis_records/scorp_lindqvist_family_woodworks/0', '/basis_records/scorp_lindqvist_family_woodworks/1', '/basis_records/scorp_lindqvist_family_woodworks/2', '/return_2024/K1_1120S'],
    hist: [
      { year: 2022, label: 'Ending stock basis per client worksheet', py: '/basis_records/scorp_lindqvist_family_woodworks/0', pick: 'ending_stock_basis' },
      { year: 2023, label: 'Ending stock basis (2023 K-1 missing)', py: '/basis_records/scorp_lindqvist_family_woodworks/1', pick: 'ending_stock_basis' },
      { year: 2024, label: 'Ending stock basis (never rolled forward)', py: '/basis_records/scorp_lindqvist_family_woodworks/2', pick: 'ending_stock_basis' },
      { year: 2025, label: 'Stock basis at beginning of year (reconstructed)', line: 'F7203.1' },
      { year: 2025, label: 'Ending stock basis', line: 'F7203.15' },
      { year: 2025, label: 'Distributions in excess of basis (taxed as gain)', line: 'F7203.excess' },
    ],
  },
  'federal.ridgeline_capital_account_end': {
    label: 'Ridgeline partnership capital account',
    lines: ['SchE.28B'],
    py: ['/basis_records/partnership_ridgeline/0', '/return_2024/K1_1065'],
    hist: [{ year: 2024, label: 'Ending capital account (outside basis never computed)', py: '/basis_records/partnership_ridgeline/0', pick: 'ending_capital_account' }],
  },
  'federal.sep_contribution_not_deductible_for_2025': {
    label: 'SEP contribution not deductible for 2025',
    lines: ['Sch1.16', 'SchC.31', 'SchSE.13'],
    hist: [{ year: 2025, label: 'SEP deduction allowed', line: 'Sch1.16' }],
  },
  'california.capital_loss': {
    lines: ['SchCA540NR.7.D', 'SchCA540NR.7.A', 'SchCA540NR.7.E', 'SchD.16'],
    py: ['/carryovers_into_2025/california/capital_loss_short', '/carryovers_into_2025/california/capital_loss_long'],
    hist: [
      { year: 2024, label: 'California capital loss carried out of 2024 (short + long)', sum: ['/carryovers_into_2025/california/capital_loss_short', '/carryovers_into_2025/california/capital_loss_long'] },
      { year: 2025, label: 'Capital gain or (loss), California law', line: 'SchCA540NR.7.D' },
    ],
  },
  'california.passive': {
    lines: ['SchE.22A', 'SchE.22B', 'F8582.4'],
    py: ['/carryovers_into_2025/california/passive_1450_fremont', '/carryovers_into_2025/california/passive_1200_barton_hills'],
    hist: [
      { year: 2024, label: 'California unallowed passive losses carried out of 2024', sum: ['/carryovers_into_2025/california/passive_1450_fremont', '/carryovers_into_2025/california/passive_1200_barton_hills'] },
      { year: 2025, label: 'Net passive income/(loss) (Form 8582 line 4)', line: 'F8582.4' },
    ],
  },
};

/** Prior-preparer open items and what in 2025 bears on them (matched on packet wording, cf. D-29). */
const PRIOR_OPEN: { re: RegExp; lines: string[]; py: string[] }[] = [
  { re: /Woodworks K-1/i, lines: ['F7203.1', 'F7203.15'], py: ['/basis_records/scorp_lindqvist_family_woodworks/1'] },
  { re: /5498|IRA basis/i, lines: ['F8606.2', 'F8606.14'], py: ['/basis_records/ira_nondeductible_basis_ngozi/0'] },
  { re: /home office/i, lines: ['SchC.30'], py: [] },
  { re: /3520/i, lines: [], py: [] },
];

export function buildRollForward(wp: Workpaper, body: { toYear?: number } = {}): RollforwardDocument {
  const ctx = new ViewCtx(wp);
  const taxYear = wp.b.packet.household.tax_year;
  const toYear = body.toYear ?? taxYear + 1;
  const v = wp.version;
  const ver = wp.b.version(v)!;
  const snapId = filedSnapshotId(wp);
  const snap = snapId ? loadSnapshot<FilingSnapshotContent>(wp, snapId) : undefined;
  const accepted = !!snapId && filingState(wp).submissions.some((s) => s.snapshotId === snapId && s.jurisdiction === 'federal' && s.status === 'accepted');
  const frozen = new Map<string, FrozenLine>((snap?.content.lines ?? []).map((l) => [l.key, l]));

  // ---- the 2025 record to read from: the filed snapshot's, else the live workpaper's.
  const st = snap?.content.state;
  const adjustments = (st ? st.adjustments : [...wp.state.adjustments.values()]) as AdjustmentDto[];
  const judgments = (st ? st.judgments : [...wp.state.judgments.values()]) as JudgmentDto[];
  const notes = (st ? st.notes : [...wp.state.notes.values()]) as ReviewNoteDto[];
  const questions = (st ? st.questions : [...wp.state.questions.values()]) as QuestionDto[];
  const corrections = (st ? (st.readCorrections ?? []) : [...wp.state.activeCorrection.values()].map((id) => wp.state.corrections.get(id)!)) as ReadCorrectionDto[];
  const variances = (st ? st.varianceExplanations : [...wp.state.varianceExplanations.entries()].map(([nodeId, x]) => ({ nodeId, ...x }))) as { nodeId: string; explanation: string; by?: string; at?: string }[];
  const issues = (st ? st.issues : wp.issues()) as IssueDto[];

  const has = (key: string) => !!wp.b.line(v, key);
  // Values come from the filed return when there is one, else the live effective return.
  const val = (key: string): number => {
    const x = snap ? frozen.get(key)?.value : ctx.cell(key)?.value;
    return typeof x === 'number' ? x : 0;
  };
  const rawVal = (key: string): unknown => (snap ? frozen.get(key)?.value : ctx.cell(key)?.value);
  const L = (key: string) => (has(key) ? lineId(v, key) : undefined);
  const pyVal = (ptr: string) => wp.b.pointer('py', ptr);
  const PY = (ptr: string) => (pyVal(ptr) !== undefined ? `py:${ptr}` : undefined);
  const diag = (code: string) => (ver.diagnostics.some((d) => d.code === code) ? diagId(v, code) : undefined);
  const label = (key: string) => {
    const l = wp.b.line(v, key);
    return l ? wp.lineLabel(v, l) : key;
  };
  const openable = (id: string) => !!nodeKind(id) && !id.startsWith('version:');

  /** 2025 workpaper events touching any of `ids` (and the direct inputs of lines among them). */
  const changesFor = (ids: string[]): RollChange[] => {
    const set = new Set(ids);
    for (const id of ids) {
      const k = id.startsWith(`line:${v}:`) ? id.slice(`line:${v}:`.length) : undefined;
      const l = k ? wp.b.line(v, k) : undefined;
      if (l) for (const i of l.inputs) set.add(lineId(v, i));
      if (l) for (const s of l.sources) set.add(resolveRef(s, v));
    }
    const hit = (xs: string[] | undefined) => (xs ?? []).some((x) => set.has(x));
    const out: RollChange[] = [];
    for (const a of adjustments)
      if (set.has(a.nodeId)) out.push({ id: a.id, kind: 'adjustment', nodeId: a.nodeId, status: a.status, by: a.decidedBy ?? a.by, at: a.decidedAt ?? a.at, summary: short(`${a.nodeId.replace(/^line:[^:]+:/, '')} ${fmt(a.originalValue)} → ${fmt(a.newValue)}: ${a.reason}`) });
    for (const c of corrections)
      if (set.has(`ev:${c.evId}`)) out.push({ id: c.id, kind: 'read_correction', nodeId: `ev:${c.evId}`, status: c.status, by: c.by, at: c.at, summary: short(`Read of ${c.evId} corrected ${fmt(c.originalValue)} → ${fmt(c.correctedValue)}: ${c.reason}`) });
    for (const j of judgments)
      if (hit(j.nodeIds) || hit(j.issueIds)) out.push({ id: j.id, kind: 'judgment', nodeId: j.nodeIds.find(openable), by: j.by, at: j.at, summary: short(`${j.topic}: ${j.decision}`) });
    for (const x of variances)
      if (set.has(x.nodeId)) out.push({ id: `variance:${x.nodeId}`, kind: 'variance_explanation', nodeId: x.nodeId, by: x.by, at: x.at, summary: short(`Change from 2024 explained: ${x.explanation}`) });
    for (const i of issues)
      if (i.status !== 'open' && hit(i.nodeIds)) out.push({ id: i.id, kind: 'issue', nodeId: i.nodeIds.find(openable), status: i.status, summary: short(`${i.title} — ${i.status}${i.resolution ? `: ${i.resolution}` : ''}`) });
    for (const n of notes) if (hit(n.nodeIds)) out.push({ id: n.id, kind: 'note', nodeId: n.nodeIds.find(openable), status: n.status, by: n.by, at: n.at, summary: short(`Review note: ${maskFreeText(n.thread[0]?.text ?? '')}`) });
    for (const q of questions) if (hit(q.nodeIds)) out.push({ id: q.id, kind: 'question', nodeId: q.nodeIds.find(openable), status: q.status, by: q.by, at: q.at, summary: short(`Question to ${q.to}: ${maskFreeText(q.thread[0]?.text ?? '')}`) });
    return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  };

  const prov = (sources: (string | undefined | false | null)[], history: RollHistoryPoint[], changeIds?: string[]): RollProvenance => {
    const s = uniq(sources);
    return { sources: s, primary: s.find(openable), history, changes: changesFor(changeIds ?? s) };
  };

  const histFrom = (spec: Spec): RollHistoryPoint[] =>
    spec.hist.flatMap((h): RollHistoryPoint[] => {
      if (h.line) return has(h.line) ? [{ year: h.year, label: h.label, value: rawVal(h.line), nodeId: L(h.line) }] : [];
      if (h.sum) {
        const vals = h.sum.map(pyVal);
        if (vals.every((x) => x === undefined)) return [];
        return [{ year: h.year, label: h.label, value: vals.reduce((t: number, x) => t + num(x), 0), nodeId: PY(h.sum[0]!) }];
      }
      const raw = pyVal(h.py!);
      if (raw === undefined) return [];
      const value = h.pick ? (raw as Record<string, unknown>)[h.pick] : raw;
      const src = h.pick ? ((raw as Record<string, unknown>).source as string | undefined) : undefined;
      return [{ year: h.year, label: h.label, value: value ?? null, nodeId: PY(h.py!), note: src }];
    });
  const opening = (amount: unknown, note?: string): RollHistoryPoint => ({ year: toYear, label: `Opening ${toYear}`, value: amount, note });

  // ---- carryovers out of 2025
  const co = (ver.carryovers_out ?? {}) as Record<string, any>;
  const k1065 = ctx.docsOfType('K-1-1065').find((d) => d.tax_year === taxYear);
  const capEnd = k1065 ? ctx.docEv(k1065.id, 'cap_end') : undefined;
  const pyAssets = (wp.b.packet.prior_years.asset_records ?? []) as any[];
  const pyAssetPtr = (aid: string) => {
    const i = pyAssets.findIndex((a) => a.asset_id === aid);
    return i >= 0 ? `/asset_records/${i}` : undefined;
  };
  const yearSum = (o: Record<string, number> | undefined, upTo: number) => Object.entries(o ?? {}).reduce((t, [y, x]) => (Number(y) <= upTo ? t + num(x) : t), 0);

  const carryovers: RollCarryover[] = (['federal', 'california'] as const).flatMap((jur) =>
    Object.entries(co[jur] ?? {}).flatMap(([k, val0]): RollCarryover[] => {
      if (typeof val0 === 'number') {
        const spec = CARRY[`${jur}.${k}`];
        const carryIn = jur === 'federal' ? PY(`/carryovers_into_2025/${k}`) : PY(`/carryovers_into_2025/california/${k}`);
        const extra = (spec?.extra ?? []).map((x) => (x.startsWith('diag:') ? diag(x.slice(5)) : x));
        const ev = k === 'ridgeline_capital_account_end' && capEnd ? `ev:${capEnd.id}` : undefined;
        const sources = [...(spec?.lines ?? []).map(L), ev, carryIn, ...(spec?.py ?? []).map(PY), ...extra];
        const history = spec ? histFrom(spec) : carryIn ? [{ year: taxYear - 1, label: 'Carried into 2025', value: pyVal(carryIn.slice(3)), nodeId: carryIn }] : [];
        if (ev && capEnd) history.push({ year: taxYear, label: 'Ending capital account per 2025 K-1', value: capEnd.value, nodeId: ev });
        history.push(opening(val0));
        const p = prov(sources, history);
        return [{ jurisdiction: jur, key: k, label: spec?.label ?? humanKey(k), amount: val0, from: p.primary ?? `version:${v}`, note: `return_versions[${v}].carryovers_out.${jur}.${k}`, ...p }];
      }
      // Per-asset amounts (California depreciation basis differences).
      return Object.entries(val0 as Record<string, number>).map(([aid, amt]) => {
        const a = ver.assets.find((x) => x.asset_id === aid) as any;
        const ptr = pyAssetPtr(aid);
        const pa = ptr ? (pyAssets.find((x) => x.asset_id === aid) as any) : undefined;
        const caLines = has(`FTB3885A.${aid}`) ? [L(`FTB3885A.${aid}`)] : [];
        const history: RollHistoryPoint[] = [];
        if (pa) history.push({ year: taxYear - 1, label: 'Federal less California accumulated depreciation, end of 2024', value: r2(yearSum(pa.federal, taxYear - 1) - yearSum(pa.california, taxYear - 1)), nodeId: PY(ptr!) });
        if (a) history.push({ year: taxYear, label: 'Federal less California accumulated depreciation, end of 2025', value: r2(num(a.federal?.accumulated_end) - num(a.california?.accumulated_end)), nodeId: assetId(v, aid) });
        history.push(opening(amt));
        const p = prov([a && assetId(v, aid), ...caLines, ptr && PY(ptr), PY('/carryovers_into_2025/california/note')], history);
        return { jurisdiction: jur, key: `${k}.${aid}`, label: `California depreciation basis difference — ${a?.description ?? aid}`, amount: amt, from: p.primary ?? assetId(v, aid), note: k, ...p };
      });
    }),
  );

  // ---- basis
  const homes = Object.entries((wp.b.packet.prior_years.basis_records ?? {}) as Record<string, any[]>).filter(([k]) => k.startsWith('home_'));
  const basis: RollBasis[] = [];
  if (has('F7203.15')) {
    const spec = CARRY['federal.scorp_stock_basis_end']!;
    const p = prov([...spec.lines.map(L), ...spec.py!.map(PY)], [...histFrom(spec), opening(val('F7203.15'))]);
    basis.push({ what: 'S corporation stock basis (end of year)', amount: val('F7203.15'), from: L('F7203.15')!, note: val('F7203.excess') ? `Distributions exceeded basis by ${val('F7203.excess')} (taxed as gain)` : undefined, ...p });
  }
  if (capEnd) {
    const spec = CARRY['federal.ridgeline_capital_account_end']!;
    const ev = `ev:${capEnd.id}`;
    const p = prov([ev, `doc:${k1065!.id}`, ...spec.lines.map(L), ...spec.py!.map(PY)], [...histFrom(spec), { year: taxYear, label: 'Ending capital account per 2025 K-1', value: capEnd.value, nodeId: ev }, opening(Number(capEnd.value), 'Capital account, not outside basis')]);
    basis.push({ what: 'Partnership ending capital account (Ridgeline)', amount: Number(capEnd.value), from: ev, note: 'Outside basis still to be computed (open since 2024)', ...p });
  }
  if (has('F8606.14')) {
    const spec = CARRY['federal.ira_nondeductible_basis_ngozi']!;
    const p = prov([...spec.lines.map(L), ...spec.py!.map(PY)], [...histFrom(spec), opening(val('F8606.14'))]);
    basis.push({ what: 'Traditional IRA nondeductible basis', amount: val('F8606.14'), from: L('F8606.14')!, ...p });
  }
  for (const [k, list] of homes)
    list.forEach((h, i) => {
      const ptr = `/basis_records/${k}/${i}`;
      const doc = typeof h.source === 'string' && /^D\d{2}$/.test(h.source) ? `doc:${h.source}` : undefined;
      const p = prov([PY(ptr), doc], [{ year: taxYear, label: `Cost basis (${h.event})`, value: h.price, nodeId: PY(ptr), note: h.source }, opening(h.price)]);
      basis.push({ what: `Home cost basis (${k.replace(/^home_/, '').replace(/_/g, ' ')})`, amount: h.price, from: PY(ptr)!, note: h.event, ...p });
    });

  // ---- asset register
  const assetHistory = (a: any): RollHistoryPoint[] => {
    const ptr = pyAssetPtr(a.asset_id);
    const pa = ptr ? pyAssets.find((x) => x.asset_id === a.asset_id) : undefined;
    const out: RollHistoryPoint[] = [];
    if (pa) out.push({ year: taxYear - 1, label: 'Federal accumulated depreciation, end of 2024', value: r2(yearSum(pa.federal, taxYear - 1)), nodeId: PY(ptr!), note: `California ${fmt(r2(yearSum(pa.california, taxYear - 1)))}` });
    else out.push({ year: taxYear, label: 'Placed in service', value: a.placed_in_service, nodeId: assetId(v, a.asset_id) });
    out.push({ year: taxYear, label: '2025 federal depreciation', value: a.federal?.depreciation_2025, nodeId: assetId(v, a.asset_id), note: `California ${fmt(a.california?.depreciation_2025)}` });
    return out;
  };
  /** Lines that cite the asset (e.g. California depreciation per asset) and its own sources. */
  const assetSources = (aid: string) => {
    const id = assetId(v, aid);
    const ptr = pyAssetPtr(aid);
    const citing = wp.g.parents(id).filter((e) => e.type === 'sourced_from' && e.to.startsWith(`line:${v}:`)).map((e) => e.to);
    const own = wp.g.children(id).filter((e) => e.type === 'sourced_from' && !/^py:\/asset_records$/.test(e.to)).map((e) => e.to);
    return [id, ...citing, ptr && PY(ptr), ...own];
  };
  const assets: RollAsset[] = (ver.assets as any[])
    .filter((a) => !a.disposed)
    .map((a) => {
      const p = prov(assetSources(a.asset_id), [...assetHistory(a), opening(a.federal?.accumulated_end, `Accumulated depreciation; California ${fmt(a.california?.accumulated_end)}`)]);
      return {
        assetId: a.asset_id,
        description: a.description,
        activity: a.activity,
        cost: a.cost,
        placedInService: a.placed_in_service,
        method: a.method,
        lifeYears: a.life_years,
        federalAccumulated: a.federal?.accumulated_end,
        californiaAccumulated: a.california?.accumulated_end,
        from: assetId(v, a.asset_id),
        ...p,
      };
    });
  const disposedAssets: RollDisposedAsset[] = (ver.assets as any[])
    .filter((a) => a.disposed)
    .map((a) => {
      const p = prov([...assetSources(a.asset_id), L('F4797.9'), L('F4797.24')], [...assetHistory(a), opening(null, `Disposed ${a.disposed}; leaves the register`)]);
      return { assetId: a.asset_id, description: a.description, disposed: a.disposed, from: assetId(v, a.asset_id), ...p };
    });

  // ---- open items
  const filedAt = snap?.meta.at;
  const after = (at: string | undefined) => !!filedAt && !!at && at > filedAt;
  const liveNotes = [...wp.state.notes.values()];
  const liveQuestions = [...wp.state.questions.values()];
  // Filed: what was open at filing, plus notes/questions raised since (marked).
  const openNotes = [...notes.filter((n) => n.status === 'open'), ...(snap ? liveNotes.filter((n) => n.status === 'open' && after(n.at)) : [])];
  const openQuestions = [...questions.filter((q) => q.status === 'open'), ...(snap ? liveQuestions.filter((q) => q.status === 'open' && after(q.at)) : [])];
  const issueHistory = (i: IssueDto): RollHistoryPoint[] => [{ year: taxYear, label: `Raised by ${i.source === 'engine' ? 'the engine' : i.source === 'human' ? 'a reviewer' : 'a workpaper check'} (${i.code})`, value: i.status, nodeId: i.nodeIds.find(openable) }, opening('open')];
  const openItems: RollOpenItem[] = [
    ...issues
      .filter((i) => i.status === 'open' && i.severity !== 'info')
      .map((i) => ({ kind: 'issue' as const, id: i.id, text: i.title, nodeIds: i.nodeIds.slice(0, 3), ...prov([i.id, ...i.nodeIds], issueHistory(i), i.nodeIds) })),
    ...openQuestions.map((q) => ({ kind: 'question' as const, id: q.id, text: (after(q.at) ? '(raised after filing) ' : '') + maskFreeText(q.thread[0]?.text ?? ''), nodeIds: q.nodeIds, ...prov([`question:${q.id}`, ...q.nodeIds], [{ year: taxYear, label: `Asked of ${q.to} by ${q.by}`, value: q.status, nodeId: q.nodeIds.find(openable) }, opening('open')], q.nodeIds) })),
    ...openNotes.map((n) => ({ kind: 'note' as const, id: n.id, text: (after(n.at) ? '(raised after filing) ' : '') + maskFreeText(n.thread[0]?.text ?? ''), nodeIds: n.nodeIds, ...prov([`note:${n.id}`, ...n.nodeIds], [{ year: taxYear, label: `Review note by ${n.by}${n.blocking ? ' (blocking)' : ''}`, value: n.status, nodeId: n.nodeIds.find(openable) }, opening('open')], n.nodeIds) })),
    ...outsideFilings(ctx)
      .filter((o) => o.status === 'open')
      .map((o) => ({ kind: 'outside_filing' as const, id: o.id, text: `${o.title}: ${o.why}`, nodeIds: o.nodeIds, ...prov(o.nodeIds, [{ year: taxYear, label: 'Outside the return, not yet addressed', value: o.status }, opening('open')]) })),
    ...ver.diagnostics
      .filter((d) => /NOT_COMPUTED|CARRYFORWARD/.test(d.code))
      .map((d) => {
        const id = diagId(v, d.code);
        return { kind: 'engine_diagnostic' as const, id, text: d.message, nodeIds: [id], ...prov([id, ...(d.refs ?? []).map((r) => resolveRef(r, v))], [{ year: taxYear, label: `Engine diagnostic ${d.code}`, value: d.severity, nodeId: id }, opening('open')]) };
      }),
    // Elections and judgment calls bind next year's return too (consistency); carry them as items to revisit.
    ...judgments
      .filter((j) => j.kind === 'election' || j.kind === 'judgment')
      .map((j) => ({
        kind: 'judgment' as const,
        id: j.id,
        text: `${j.kind === 'election' ? 'Election' : 'Judgment'} to carry forward: ${j.topic} — ${j.decision}`,
        nodeIds: j.nodeIds,
        ...prov([j.id, ...j.nodeIds, ...(j.issueIds ?? [])], [{ year: taxYear, label: `Recorded by ${j.by}${j.authority ? ` (${j.authority})` : ''}`, value: j.decision, nodeId: j.nodeIds.find(openable) }, opening('apply consistently / revisit')], j.nodeIds),
      })),
    ...((wp.b.packet.prior_years.prior_preparer_workpaper?.open_items_left_by_prior_preparer ?? []) as string[]).map((text, i) => {
      const ptr = `/prior_preparer_workpaper/open_items_left_by_prior_preparer/${i}`;
      const m = PRIOR_OPEN.find((x) => x.re.test(text));
      const lines = (m?.lines ?? []).map(L);
      const related = issues.filter((x) => x.nodeIds.some((n) => lines.includes(n)) || (/3520/.test(text) && /3520/.test(x.title)));
      const stillOpen = related.filter((x) => x.status === 'open');
      const sources = [PY(ptr), 'doc:D07', ...lines, ...(m?.py ?? []).map(PY), ...related.map((x) => x.id)];
      const history: RollHistoryPoint[] = [
        { year: taxYear - 1, label: 'Left open by the prior preparer', value: text, nodeId: PY(ptr) },
        { year: taxYear, label: stillOpen.length ? `Still open in 2025 (${stillOpen.length} open issue${stillOpen.length > 1 ? 's' : ''})` : related.length ? 'Addressed in 2025 (see changes)' : 'No 2025 work recorded against it', value: stillOpen.length ? 'open' : related.length ? 'addressed' : 'unknown', nodeId: lines.find(Boolean) },
        opening(stillOpen.length || !related.length ? 'confirm' : 'closed'),
      ];
      return { kind: 'prior_preparer' as const, id: `py:${ptr}`, text, nodeIds: uniq<string>([PY(ptr), ...lines]), ...prov(sources, history, uniq<string>([...lines, ...related.flatMap((x) => x.nodeIds)])) };
    }),
  ];

  // ---- estimate planning from planning_reference_<next year>
  const plan = (wp.b.packet[`planning_reference_${toYear}` as 'planning_reference_2026'] ?? wp.b.packet.planning_reference_2026 ?? {}) as Record<string, any>;
  const fedTax = val('F1040.24');
  const caTax = val('F540NR.64');
  const agi = val('F1040.11');
  const pct = agi > 150000 ? 1.1 : 1.0;
  const fedRequired = r0(fedTax * pct);
  const fedDates: string[] = plan.federal_estimate_due_dates ?? [];
  const caDates: string[] = plan.california_estimate_due_dates ?? [];
  const caPcts: number[] = plan.california_installment_percentages ?? [];
  const caRequired = r0(caTax * pct);
  const prior = wp.b.priorLines;
  const builtText = snap ? `Filed return (snapshot ${snapId}${accepted ? ', accepted' : ', not yet accepted'})` : 'Live workpaper (not yet filed)';
  const knownChanges: string[] = plan.known_2026_changes_for_this_household ?? [];
  const planItems: RollPlanningItem[] = [
    {
      key: 'federal.required_annual_payment',
      label: `Federal required annual payment (${Math.round(pct * 100)}% of ${taxYear} tax)`,
      amount: fedRequired,
      ...prov(
        [L('F1040.24'), L('F1040.11'), L('F1040.22'), L('F1040.23'), 'py:/return_2024/lines/F1040.24'],
        [
          { year: taxYear - 1, label: '2024 total tax', value: prior['F1040.24'], nodeId: 'py:/return_2024/lines/F1040.24' },
          { year: taxYear, label: `${taxYear} total tax (AGI ${fmt(agi)})`, value: fedTax, nodeId: L('F1040.24') },
          opening(fedRequired, `${fedDates.length} installments`),
        ],
      ),
    },
    {
      key: 'california.required_annual_payment',
      label: `California required annual payment (${Math.round(pct * 100)}% of ${taxYear} tax)`,
      amount: caRequired,
      ...prov(
        [L('F540NR.64'), L('F540NR.17'), L('F1040.11'), prior['CA540.64'] !== undefined ? 'py:/return_2024/lines/CA540.64' : undefined],
        [
          { year: taxYear - 1, label: '2024 California total tax (Form 540)', value: prior['CA540.64'], nodeId: 'py:/return_2024/lines/CA540.64' },
          { year: taxYear, label: `${taxYear} California total tax (540NR)`, value: caTax, nodeId: L('F540NR.64') },
          opening(caRequired, caPcts.map((x) => `${Math.round(x * 100)}%`).join(' / ')),
        ],
      ),
    },
  ];
  const mtc = co.federal?.minimum_tax_credit_from_2025_amt;
  if (mtc)
    planItems.push({
      key: 'federal.minimum_tax_credit',
      label: 'Minimum tax credit available (Form 8801)',
      amount: mtc,
      ...prov([L('F6251.11'), L('F6251.9'), diag('AMT_CREDIT_CARRYFORWARD'), PY('/carryovers_into_2025/amt_credit')], [
        { year: taxYear - 1, label: 'AMT credit carried into 2025', value: pyVal('/carryovers_into_2025/amt_credit'), nodeId: PY('/carryovers_into_2025/amt_credit') },
        { year: taxYear, label: 'Alternative minimum tax', value: rawVal('F6251.11'), nodeId: L('F6251.11') },
        opening(mtc),
      ]),
    });
  const residents = wp.b.packet.household.people.filter((p: any) => p.role === 'taxpayer' || p.role === 'spouse').map((p: any) => `household:${p.id}`);
  knownChanges.forEach((text, i) => {
    const src: (string | undefined)[] = [];
    if (/residen|California-source/i.test(text)) src.push(L('F540NR.13'), L('F540NR.17'), L('SchCA540NR.7.E'), ...residents);
    if (/minimum tax credit|8801/i.test(text)) src.push(L('F6251.11'), diag('AMT_CREDIT_CARRYFORWARD'));
    if (/SEP/i.test(text)) src.push(L('Sch1.16'), L('SchC.31'), L('SchSE.13'));
    if (/rental|Sacramento/i.test(text)) src.push(assetId(v, 'SAC-BLDG'), L('SchE.21A'));
    planItems.push({ key: `known_change.${i}`, label: 'Known change', text, ...prov(src, [{ year: toYear, label: 'Expected', value: text }]) });
  });

  const planning: RollforwardDocument['planning'] = {
    basis: builtText,
    federal: {
      safeHarbor: plan.federal_safe_harbor,
      priorYearTax: { amount: fedTax, from: lineId(v, 'F1040.24') },
      requiredAnnualPayment: fedRequired,
      installments: fedDates.map((d, i) => ({ due: d, amount: i < fedDates.length - 1 ? Math.floor(fedRequired / fedDates.length) : fedRequired - Math.floor(fedRequired / fedDates.length) * (fedDates.length - 1) })),
    },
    california: {
      safeHarbor: plan.california_safe_harbor,
      priorYearTax: { amount: caTax, from: lineId(v, 'F540NR.64') },
      requiredAnnualPayment: caRequired,
      installments: caDates.map((d, i) => ({ due: d, amount: r0(caRequired * (caPcts[i] ?? 0)) })),
    },
    minimumTaxCredit: mtc ? { amount: mtc, from: lineId(v, 'F6251.11'), note: 'Form 8801 next year' } : undefined,
    knownChanges,
    note: "90% of the next year's own tax is the other safe-harbor prong; it needs a projection the engine cannot make.",
    items: planItems,
  };

  return {
    schema: 'easetax.rollforward/1',
    fromYear: taxYear,
    toYear,
    clientId: wp.b.packet.packet.client_id,
    builtFrom: snap
      ? { kind: 'filed_snapshot', snapshotId: snapId, accepted, seq: snap.content.seq, text: builtText }
      : { kind: 'live_workpaper', seq: wp.state.seq, text: builtText },
    sourceSnapshot: snap ? { id: snapId!, contentHash: snap.contentHash, seq: snap.content.seq } : null,
    engineVersion: v,
    carryovers,
    basis,
    assets,
    disposedAssets,
    openItems,
    planning,
  };
}

function humanKey(k: string) {
  const s = k.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function rollForward(wp: Workpaper, actor: Actor, body: { toYear?: number } = {}) {
  assertCan(actor, 'verify'); // staff opening next year's file (tl-28: the preparer)
  const document = buildRollForward(wp, body);
  const frozen_ = putFrozen(wp, 'rollforward', document);
  const events = wp.commit(actor, [{ type: 'filing.step', payload: { step: 'rollforward', data: { snapshotId: frozen_.id, contentHash: frozen_.contentHash, toYear: document.toYear, builtFrom: document.builtFrom.kind } } }]);
  return { events, data: { id: frozen_.id, contentHash: frozen_.contentHash, document } };
}
