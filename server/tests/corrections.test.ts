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
