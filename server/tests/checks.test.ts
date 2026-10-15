import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { IssueDto } from '@easetax/shared';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { allChecks } from '../src/checks/index.ts';
import { comparePrinted } from '../src/checks/read.ts';
import { printedLots } from '../src/checks/summaryDetail.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
let checks: IssueDto[];

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
  checks = wp.issues().filter((i) => i.source === 'check');
});

const get = (id: string) => {
  const i = checks.find((x) => x.id === id);
  if (!i) throw new Error(`missing issue ${id}; have ${checks.map((x) => x.id).join(', ')}`);
  return i;
};
const expectNodes = (i: IssueDto, nodes: string[]) => expect(i.nodeIds).toEqual(expect.arrayContaining(nodes));

describe('check registry', () => {
  it('registers one check per id across the family modules', () => {
    const ids = allChecks().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(allChecks().map((c) => c.family)).size).toBeGreaterThanOrEqual(10);
  });

  it('no check crashes', () => {
    expect(checks.filter((i) => i.id.endsWith(':crashed'))).toEqual([]);
  });

  it('issue ids are stable, deterministic and unique', () => {
    const again = new Workpaper(baseline, new EventStore(':memory:')).issues().filter((i) => i.source === 'check');
    expect(again.map((i) => i.id)).toEqual(checks.map((i) => i.id));
    expect(new Set(checks.map((i) => i.id)).size).toBe(checks.length);
    for (const i of checks) expect(i.id).toMatch(/^chk:[a-z_]+\.[a-z_0-9]+:.+/);
  });

  it('does not flood the work queue', () => {
    const open = checks.filter((i) => i.status === 'open');
    expect(open.length).toBeLessThanOrEqual(70);
    // Errors are the "likely wrong number" findings; they must stay few and specific.
    expect(open.filter((i) => i.severity === 'error').length).toBeLessThanOrEqual(30);
    // Variance is informational and limited to source-level lines.
    expect(open.filter((i) => i.id.startsWith('chk:var.')).every((i) => i.severity === 'info')).toBe(true);
  });

  it('every node id is in the reference grammar', () => {
    for (const i of checks) {
      for (const n of i.nodeIds) expect(n).toMatch(/^(line:v\d+:|ev:ev-\d{4}$|doc:D\d{2}(#page\d+)?$|qa:qa-|msg:msg-|call:call-|py:\/|agency:\/|household:|ref:fx\.|ref:param\.)/);
    }
  });

  it('never puts a full SSN in issue text (issues are not masked by the API)', () => {
    for (const i of checks) expect(`${i.title} ${i.detail ?? ''}`).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });

  it('suggestions are line adjustments with an estimated effect, or read corrections', () => {
    for (const i of checks.filter((x) => x.suggestion)) {
      if (i.suggestion!.nodeId.startsWith('ev:')) {
        // Correct the read (D-38): fixes what the pipeline read; no tax effect of its own.
        expect(i.code).toMatch(/^READ_MISMATCH_/);
        continue;
      }
      expect(i.suggestion!.nodeId).toMatch(/^line:v3:/);
      expect(i.effect).toBeDefined();
    }
  });
});

describe('read checks', () => {
  it('normalizes values: dates, blank boxes, percents and money do not false-positive', () => {
    const page = 'Box 1 104,600.00; Date 02/15/2025; share 22%; 0.2 ownership';
    const ev = (value: unknown, value_type: string) => ({ value, value_type }) as any;
    expect(comparePrinted(ev(104600, 'money'), page).ok).toBe(true);
    expect(comparePrinted(ev('2025-02-15', 'date'), page).ok).toBe(true);
    expect(comparePrinted(ev(0, 'money'), page).ok).toBe(true); // blank box
    expect(comparePrinted(ev(0.22, 'percent'), page).ok).toBe(true);
    expect(comparePrinted(ev(104060, 'money'), page).ok).toBe(false);
  });

  it('E14: catches the high-confidence provider EIN misread', () => {
    const i = get('chk:read.printed:ev-1045');
    expect(i.severity).toBe('error');
    expect(i.title).toContain('74-3829156');
    expectNodes(i, ['ev:ev-1045', 'doc:D62#page1', 'doc:D62', 'line:v3:F2441.1b']);
    // The only confident misread in 3,012 values.
    expect(checks.filter((x) => x.id.startsWith('chk:read.printed:'))).toHaveLength(1);
  });

  it('E14: provider name on Form 2441 differs from the statement', () => {
    const i = get('chk:read.line_identity:F2441.1a');
    expect(i.detail).toContain('Bright Oak Kids Club');
    expectNodes(i, ['line:v3:F2441.1a', 'doc:D61']);
  });

  it('E30: low-confidence handwritten amount, corroborated by msg-08', () => {
    const i = get('chk:read.low_confidence:ev-1049');
    expectNodes(i, ['ev:ev-1049', 'doc:D64#page1', 'line:v3:SchA.11', 'msg:msg-08']);
  });
});

describe('duplicate checks', () => {
  it('E2: Northlake interest counted on two Schedule B lines', () => {
    const i = get('chk:dup.cross_line:SchB.1.1=SchB.1.2');
    expect(i.severity).toBe('error');
    expectNodes(i, ['line:v3:SchB.1.1', 'line:v3:SchB.1.2', 'ev:ev-0492', 'ev:ev-0538', 'doc:D28', 'doc:D29']);
    expect(i.suggestion).toMatchObject({ nodeId: 'line:v3:SchB.1.2', value: 0 });
    expect(i.effect!.federalTax).toBeLessThan(0);
  });

  it('E4: duplicate mileage page; standard mileage follows', () => {
    const i = get('chk:dup.page:D23#page3:SchC.44a');
    expect(i.detail).toContain('8,100');
    expectNodes(i, ['line:v3:SchC.44a', 'line:v3:SchC.9', 'doc:D23#page3', 'doc:D23#page2', 'ev:ev-0404']);
    expect(i.suggestion).toMatchObject({ nodeId: 'line:v3:SchC.9', value: 5670 });
  });

  it('E17: payoff interest already in the Form 1098', () => {
    const i = get('chk:dup.within_line:SchA.8a:D56');
    expectNodes(i, ['line:v3:SchA.8a', 'ev:ev-1032', 'doc:D56', 'doc:D55']);
    expect(i.suggestion!.value).toBe(19697);
  });

  it('E10: corrected Meridian 1099 lists the changed values (info, already used)', () => {
    const i = get('chk:dup.supersession:D31>D30');
    expect(i.severity).toBe('info');
    expectNodes(i, ['doc:D31', 'doc:D30', 'ev:ev-0755', 'ev:ev-0781', 'ev:ev-0823', 'line:v3:F8949.D.M14']);
  });

  it('D10 is reported as an unused duplicate of D09', () => {
    expect(get('chk:dup.document:D10~D09').severity).toBe('info');
  });
});

describe('summary vs detail', () => {
  it('parses every printed broker lot', () => {
    const ctx = { b: baseline, version: 'v3' } as any;
    expect(printedLots(ctx, 'D74')).toHaveLength(260);
    expect(printedLots(ctx, 'D31')).toHaveLength(18);
    expect(printedLots(ctx, 'D28')).toHaveLength(5);
  });

  it('E11: lot M18 on the unextracted page 32 is missing', () => {
    const i = get('chk:sd.broker_lots:D31:M18');
    expectNodes(i, ['doc:D31#page32', 'line:v3:F8949.B.total']);
    expect(i.suggestion!.value).toBe(37660);
    // All other printed lots agree with Form 8949.
    expect(checks.filter((x) => x.id.startsWith('chk:sd.broker_lots:'))).toHaveLength(1);
  });

  it('E8: RSU lots taxed on zero basis; E9 ESPP lot already adjusted', () => {
    const want = { 'F8949.B.N1': 140, 'F8949.B.N3': -620, 'F8949.E.N4': 5880 } as Record<string, number>;
    for (const [key, value] of Object.entries(want)) {
      const i = get(`chk:sd.supplemental_basis:${key}`);
      expectNodes(i, [`line:v3:${key}`, 'doc:D11']);
      expect(i.suggestion!.value).toBe(value);
    }
    expect(checks.some((x) => x.id === 'chk:sd.supplemental_basis:F8949.A.N2')).toBe(false);
  });

  it('estimates 8949 effects in dollars through Schedule D', () => {
    const i = get('chk:sd.supplemental_basis:F8949.B.N1');
    // 19,100 less short-term gain at the v3 stcg rate (0.348), not 1/100 of it.
    expect(i.effect!.federalTax).toBeCloseTo(-19100 * 0.348, 0);
  });
});

describe('third-party agreement', () => {
  it('E3: 1099-K receipts already inside book revenue', () => {
    const i = get('chk:tp.gross_receipts_1099k:SchC.1:D21');
    expectNodes(i, ['line:v3:SchC.1', 'ev:ev-0127', 'ev:ev-0109', 'doc:D15#page3', 'agency:/notices/1']);
    expect(i.suggestion!.value).toBe(151300);
  });

  it('E19: vehicle donation capped at 1098-C gross proceeds', () => {
    const i = get('chk:tp.vehicle_donation_cap:F8283.A1.vehicle');
    expectNodes(i, ['line:v3:F8283.A1.vehicle', 'ev:ev-1054', 'doc:D66', 'qa:qa-39', 'agency:/notices/1']);
    expect(i.suggestion!.value).toBe(2900);
    expect(i.effect!.estimable).toBe(true);
  });

  it('E20: federal Q4 estimate vs IRS transcript', () => {
    const i = get('chk:tp.estimates_irs:F1040.26');
    expectNodes(i, ['line:v3:F1040.26', 'qa:qa-41', 'doc:D69', 'agency:/irs_account_transcript_2025/0/transactions/3']);
    expect(i.suggestion!.value).toBe(12000);
    expect(i.effect!.federalBalance).toBe(1000);
  });

  it('E21: California payment applied to 2024', () => {
    const i = get('chk:tp.estimates_ftb:F540NR.72');
    expectNodes(i, ['line:v3:F540NR.72', 'agency:/ftb_account/tax_year_2024_payments_after_filing/0', 'ev:ev-1076']);
    expect(i.suggestion!.value).toBe(10500);
    expect(i.effect!.californiaBalance).toBe(3500);
  });

  it('E18: property tax ignores the seller credit; federal effect respects the SALT cap', () => {
    const i = get('chk:tp.seller_tax_credit:SchA.5b');
    expectNodes(i, ['line:v3:SchA.5b', 'ev:ev-1027', 'doc:D54']);
    expect(i.suggestion!.value).toBe(6508);
    expect(i.effect!.federalTax).toBeGreaterThan(0);
  });
});

describe('identity, client, prior year', () => {
  it("E1: Theo's SSN typo, tied to the SS card, 2024 return and e-file rejection", () => {
    const i = get('chk:id.ssn:theo');
    expect(i.severity).toBe('error');
    expectNodes(i, ['household:theo', 'ev:ev-1080', 'doc:D71', 'py:/return_2024/dependents/1', 'agency:/efile/0', 'msg:msg-10']);
    expect(checks.filter((x) => x.id.startsWith('chk:id.ssn:'))).toHaveLength(1);
  });

  it('E5: SE health insurance while eligible for the spouse plan', () => {
    const i = get('chk:cvd.sehi_eligibility:Sch1.17');
    expectNodes(i, ['line:v3:Sch1.17', 'qa:qa-25']);
    expect(i.suggestion!.value).toBe(0);
  });

  it('E7: phone/internet business share and personal Spotify', () => {
    expect(get('chk:cvd.call_business_use:SchC.25').suggestion!.value).toBe(2172);
    expect(get('chk:cvd.call_business_use:SchC.27a.1').suggestion!.value).toBe(6634);
    expectNodes(get('chk:cvd.call_business_use:SchC.25'), ['call:call-01', 'ev:ev-0101', 'ev:ev-0095']);
  });

  it('E12: zero-basis crypto lot with a client-stated cost becomes long-term', () => {
    const i = get('chk:cvd.lot_basis_from_client:F8949.H.C6');
    expectNodes(i, ['line:v3:F8949.H.C6', 'msg:msg-07', 'ev:ev-0919']);
    expect(i.suggestion!.value).toBe(2275);
    expect(i.severity).toBe('warning');
  });

  it('E13: "no sales" answers vs 282 brokerage and 12 crypto sales', () => {
    expect(get('chk:cvd.questionnaire_sales:qa-14').title).toContain('282');
    expect(get('chk:cvd.questionnaire_sales:qa-15').title).toContain('12');
  });

  it('E24: client denies IRA basis that the records show', () => {
    expectNodes(get('chk:cvd.ira_basis:qa-31'), ['qa:qa-31', 'line:v3:F8606.2', 'py:/return_2024/lines/F8606.14', 'doc:D42']);
  });

  it('E25: S corp basis roll-forward agrees and the excess distribution is flagged', () => {
    const i = get('chk:py.scorp_basis:scorp_lindqvist_family_woodworks');
    expect(i.severity).toBe('warning');
    expectNodes(i, ['line:v3:F7203.1', 'line:v3:F7203.excess', 'doc:D40', 'ev:ev-0982']);
  });

  it('E29: home office area vs prior year', () => {
    expectNodes(get('chk:py.area_change:SchC.30'), ['line:v3:SchC.30', 'py:/return_2024/lines/SchC.30', 'doc:D24']);
  });

  it('carryovers agree with the prior year (no issue)', () => {
    expect(checks.filter((x) => x.id.startsWith('chk:py.carryovers:'))).toEqual([]);
  });
});

describe('completeness, scope, recalc, state, judgment', () => {
  it('E16: rental insurance supported only by qa-36', () => {
    expectNodes(get('chk:comp.unsourced:SchE.9A'), ['line:v3:SchE.9A', 'qa:qa-36']);
  });

  it('E26: Ridgeline outside basis never computed', () => {
    expectNodes(get('chk:comp.basis_gap:partnership_ridgeline'), ['py:/basis_records/partnership_ridgeline/0', 'doc:D37']);
  });

  it('E27: out-of-year information returns', () => {
    for (const d of ['D13', 'D40', 'D42']) expect(get(`chk:comp.out_of_year:${d}`).nodeIds).toContain(`doc:${d}`);
  });

  it('E31: California AMT not computed', () => {
    expectNodes(get('chk:comp.not_computed:F540NR.61'), ['line:v3:F540NR.61', 'line:v3:F6251.2i']);
  });

  it('E28: FBAR, Forms 1099-NEC and the open 2023 Form 3520', () => {
    expectNodes(get('chk:scope.fbar:D36'), ['ev:ev-0962', 'doc:D36', 'doc:D01#page1']);
    expectNodes(get('chk:scope.information_returns:D27'), ['line:v3:SchC.J', 'ev:ev-0487', 'ev:ev-0488']);
    expect(get('chk:scope.prior_open_items:ppw-3').title).toContain('3520');
    expect(checks.filter((x) => x.id.startsWith('chk:scope.prior_open_items:'))).toHaveLength(1);
  });

  it('E23: SEK interest at the 2024 rate', () => {
    const i = get('chk:recalc.fx_year:SchB.1.6');
    expectNodes(i, ['line:v3:SchB.1.6', 'ref:fx.SEK.2024_average', 'ref:fx.SEK.2025_average', 'ev:ev-0960']);
    expect(i.suggestion!.value).toBe(1871);
  });

  it('E6: SEP excess contribution over the recomputed limit', () => {
    const i = get('chk:recalc.sep_limit:Sch1.16');
    expect(i.code).toBe('SEP_EXCESS_CONTRIBUTION');
    expect(i.title).toContain('2,786');
  });

  it('ISO spread agrees with Form 3921 (no issue)', () => {
    expect(checks.filter((x) => x.id.startsWith('chk:recalc.iso_spread:'))).toEqual([]);
  });

  it('E22: California wages after the move', () => {
    const i = get('chk:state.ca_wages:SchCA540NR.1.E');
    expectNodes(i, ['line:v3:SchCA540NR.1.E', 'ev:ev-0047', 'doc:D09', 'ev:ev-1081', 'doc:D73', 'qa:qa-45']);
    expect(i.suggestion!.value).toBe(107100 + 22469);
  });

  it('E15: HVAC repair vs improvement uses the engine what_if', () => {
    const i = get('chk:judgment.repair_vs_improvement:SchE.14A:ev-1001');
    expectNodes(i, ['line:v3:SchE.14A', 'ev:ev-1001', 'doc:D47']);
    expect(i.effect).toMatchObject({ federalTax: 3633, californiaTax: 896 });
  });
});

describe('issues follow the workpaper', () => {
  it('an approved adjustment to the suggested value clears the finding', () => {
    expect(checks.some((i) => i.id === 'chk:dup.cross_line:SchB.1.1=SchB.1.2')).toBe(true);
    wp.proposeAdjustment(wp.actor('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate of Northlake composite interest (D28)');
    expect(wp.issues().some((i) => i.id === 'chk:dup.cross_line:SchB.1.1=SchB.1.2')).toBe(false);
  });

  it('engine diagnostics stay separate from check issues', () => {
    const all = wp.issues();
    expect(all.filter((i) => i.source === 'engine').every((i) => i.id.startsWith('eng:'))).toBe(true);
    expect(checks.every((i) => i.id.startsWith('chk:'))).toBe(true);
  });
});
