import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const A = (id: string) => wp.actor(id);
const EIN_ISSUE = 'chk:read.printed:ev-1045';
const open = (id: string) => wp.issues().find((i) => i.id === id && i.status === 'open');

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

describe('correct the read (D-38)', () => {
  it('the EIN misread offers the printed value as the correction', () => {
    const i = open(EIN_ISSUE)!;
    expect(i.severity).toBe('error');
    expect(i.suggestion).toEqual({ nodeId: 'ev:ev-1045', value: '74-3829156', why: 'The page prints 74-3829156' });
  });

  it('correcting the read clears the issue, keeps the original and flows to the line', () => {
    wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'D62 prints 74-3829156; digits 5 and 1 swapped in the read');
    expect(open(EIN_ISSUE)).toBeUndefined();
    // The packet is untouched; the correction records the original.
    expect(baseline.evs.get('ev-1045')!.value).toBe('74-3829516');
    const d = wp.nodeDetail('ev:ev-1045', A('st-01'));
    expect(d.node.value).toBe('74-3829516');
    expect(d.node.effectiveValue).toBe('74-3829156');
    expect(d.corrections).toHaveLength(1);
    expect(d.corrections[0]).toMatchObject({ originalValue: '74-3829516', correctedValue: '74-3829156', by: 'st-01', status: 'in_force' });
    // The line that carried the misread now shows the corrected EIN.
    expect(wp.summarize('line:v3:F2441.1b').label).toContain('74-3829156');
    expect(wp.nodeDetail('line:v3:F2441.1b', A('st-01')).corrections).toHaveLength(1);
    // Earlier engine versions stay as computed.
    expect(wp.summarize('line:v2:F2441.1b').label).toContain('74-3829516');
    // The document page shows the correction against the field.
    const anchor = wp.documentDetail('D62').pages[0]!.anchors.find((a) => a.evId === 'ev-1045')!;
    expect(anchor.correctedValue).toBe('74-3829156');
  });

  it('reverting or undoing the correction brings the issue back', () => {
    const [ev] = wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'per page');
    const id = (ev!.payload as { correctionId: string }).correctionId;
    wp.revertCorrection(A('st-01'), id, 'wrong document');
    expect(open(EIN_ISSUE)).toBeDefined();
    expect(wp.summarize('line:v3:F2441.1b').label).toContain('74-3829516');

    const [ev2] = wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'per page');
    expect(open(EIN_ISSUE)).toBeUndefined();
    wp.undo(A('st-01'), { eventId: ev2!.id });
    expect(open(EIN_ISSUE)).toBeDefined();
  });

  it('a wrong correction does not clear the issue', () => {
    wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829165', 'typo while correcting');
    expect(open(EIN_ISSUE)).toBeDefined();
  });

  it('requires a reason and a value of the right type', () => {
    expect(() => wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', ' ')).toThrow(/Say why/);
    expect(() => wp.correctRead(A('st-01'), 'ev:ev-1045', '743829156', 'x')).toThrow(/EIN as NN-NNNNNNN/);
    expect(() => wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829516', 'x')).toThrow(/already reads/);
    expect(() => wp.correctRead(A('cu-01'), 'ev:ev-1045', '74-3829156', 'x')).toThrow(/cannot/);
  });

  it('reopens sign-offs over lines fed by the corrected value', () => {
    wp.signoff(A('st-02'), 'area:deductions_and_credits', 'reviewer');
    wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'per page');
    expect([...wp.state.signoffs.values()][0]!.status).toBe('reopened');
  });

  it('a correction settles a low-confidence read', () => {
    expect(open('chk:read.low_confidence:ev-1049')).toBeDefined();
    wp.correctRead(A('st-01'), 'ev:ev-1049', '1500.5', 'checked the receipt');
    expect(open('chk:read.low_confidence:ev-1049')).toBeUndefined();
  });

  it('keeps corrected SSNs masked and needs clearance', () => {
    expect(() => wp.correctRead(A('st-04'), 'ev:ev-1080', '666-74-3309', 'x')).toThrow(/clearance/);
    const [ev] = wp.correctRead(A('st-01'), 'ev:ev-1080', '666-74-3309', 'test');
    const out = JSON.stringify([wp.publicEvent(ev!), wp.nodeDetail('ev:ev-1080', A('st-02')), wp.documentDetail('D71')]);
    expect(out).not.toContain('666-74-3309');
    expect(out).not.toContain('666-74-3390');
  });
});

describe('history and landings around a correction', () => {
  it('the correction shows in the history of the line it feeds', () => {
    wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'per page');
    expect(wp.nodeDetail('line:v3:F2441.1b', A('st-01')).history.map((e) => e.type)).toContain('read.corrected');
  });
});

describe('where a source landed (W2)', () => {
  const lineIds = (t: { node: { id: string }; children: any[] }): string[] => [t.node.id, ...t.children.flatMap(lineIds)].filter((id) => id.startsWith('line:'));

  it('shows only current-version lines when the current return uses the value', () => {
    const ids = lineIds(wp.trace('ev:ev-1045', 'up', 4));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith('line:v3:'))).toBe(true);
  });

  it('falls back to labelled older versions when only they used it (superseded 1099)', () => {
    const ev = baseline.evsByDoc.get('D30')!.find((e) => wp.g.parents(`ev:${e.id}`).some((p) => p.to.startsWith('line:')))!;
    const t = wp.trace(`ev:${ev.id}`, 'up', 1);
    expect(t.children.length).toBeGreaterThan(0);
    expect(t.children.every((c) => c.node.id.startsWith('line:v1:'))).toBe(true);
    expect(t.children[0]!.node.sublabel).toContain('engine v1');
  });
});

describe('household corrections (D-47)', () => {
  it("accepts the client's own message as confirmation and clears the identity issue", () => {
    expect(wp.issues().some((i) => i.code === 'DEPENDENT_SSN_MISMATCH')).toBe(true);
    wp.correctHousehold(A('st-01'), 'theo', 'ssn', '666-74-3390', 'msg:msg-10', 'Client message msg-10 acknowledges the typo; SS card D71 shows 3390');
    expect(wp.issues().some((i) => i.code === 'DEPENDENT_SSN_MISMATCH')).toBe(false);
    expect(baseline.packet.household.people.find((p) => p.id === 'theo')!.ssn).toBe('666-74-3309');
  });

  it('refuses a staff message or an unrelated question as confirmation', () => {
    wp.commit(A('st-01'), [{ type: 'question.asked', payload: { questionId: 'q-ada', to: 'client', nodeIds: ['household:ada'], text: 'Ada?' } }]);
    wp.commit(A('cu-01'), [{ type: 'question.answered', payload: { questionId: 'q-ada', text: 'yes' } }]);
    expect(() => wp.correctHousehold(A('st-01'), 'theo', 'ssn', '666-74-3390', 'question:q-ada', 'x')).toThrow(/isn't about Theo/);
    expect(() => wp.correctHousehold(A('st-01'), 'theo', 'nickname', 'T', 'msg:msg-10', 'x')).toThrow(/Only ssn, name, dob/);
  });

  it('keeps household SSN corrections masked everywhere they leave the server', () => {
    const [ev] = wp.correctHousehold(A('st-01'), 'theo', 'ssn', '666-74-3390', 'msg:msg-10', 'typo');
    const out = JSON.stringify([wp.publicEvent(ev!), wp.nodeDetail('household:theo', A('st-02'))]);
    expect(out).not.toContain('666-74-3390');
    expect(out).not.toContain('666-74-3309');
  });
});

describe('corrections and filing snapshots', () => {
  it('freezes the corrected description, and a later correction shows in the amendment', async () => {
    const { freezeContent } = await import('../src/filing/snapshot.ts');
    wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'per page');
    const frozen = freezeContent(wp);
    expect(frozen.lines.find((l) => l.key === 'F2441.1b')!.label).toContain('74-3829156');
    expect((frozen.state.readCorrections ?? []).length).toBe(1);
  });
});

describe('a judgment closes the issues it answers (D-53)', () => {
  it('resolves, cites the judgment, and undo reopens', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/api/routes.ts');
    const app = Fastify();
    registerRoutes(app, wp);
    const dd = 'eng:v3:DUE_DILIGENCE_REQUIRED';
    expect(open(dd)).toBeDefined();
    const bad = await app.inject({ method: 'POST', url: '/api/judgments', headers: { 'x-actor': 'st-01' }, payload: { kind: 'due_diligence', topic: 'x', decision: 'y', authority: 'IRC 6695(g)', issueIds: ['nope'] } });
    expect(bad.statusCode).toBe(400);
    const r = await app.inject({
      method: 'POST',
      url: '/api/judgments',
      headers: { 'x-actor': 'st-01' },
      payload: { kind: 'due_diligence', topic: 'Form 8867', decision: 'Due diligence completed; documents on file', authority: 'IRC 6695(g); Treas. Reg. 1.6695-2', nodeIds: ['line:v3:F8867.status'], issueIds: [dd] },
    });
    expect(r.statusCode).toBe(200);
    const closed = wp.issues().find((i) => i.id === dd)!;
    expect(closed.status).toBe('resolved');
    expect(closed.resolution).toMatch(/Decided by judgment: Due diligence completed/);
    expect(closed.resolvedByJudgment).toBeDefined();
    wp.undo(A('st-01'), { eventId: r.json().eventIds[0] });
    expect(open(dd)).toBeDefined();
  });
});

describe('walkthrough bug fixes', () => {
  it('W4: budget lines include engagement phases and total the firm budget (22 h)', () => {
    const lines = wp.budgetLines();
    const total = lines.reduce((t, l) => t + (l.budgetHours ?? 0), 0);
    expect(total).toBe(Object.values(baseline.packet.firm.budget_hours).reduce((a, b) => a + b, 0));
    expect(total).toBe(22);
    expect(lines.find((l) => l.area === 'partner_review')).toMatchObject({ isArea: false, budgetHours: 1 });
  });

  it('variance check follows the firm standards as edited', () => {
    const count = () => wp.issues().filter((i) => i.id.startsWith('chk:var.')).length;
    const before = count();
    const std = baseline.packet.firm.starter_standards;
    wp.commit(A('st-05'), [{ type: 'firm.standards_updated', payload: { standards: { ...std, variance_review: { ...std.variance_review, flag_if_change_over_percent: 1000, and_over_amount: 1_000_000 } } } }]);
    expect(count()).toBeLessThan(before);
  });
});
