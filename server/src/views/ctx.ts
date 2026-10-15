// Shared helpers for the generated views. A view never stores anything: it reads the
// baseline, the graph and the projected workpaper state, and labels every number with the
// node it came from.

import type { ReturnLine, ViewCell, ViewColumn, ViewDto, ViewFlag, ViewRow, ViewSection } from '@easetax/shared';
import { lineId, parseLineId } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { maskValue, SENSITIVE_VALUE_TYPES } from '../policy/policy.ts';

export class ViewCtx {
  readonly v: string;

  constructor(readonly wp: Workpaper) {
    this.v = wp.version;
  }

  get packet() {
    return this.wp.b.packet;
  }

  line(key: string, version = this.v): ReturnLine | undefined {
    return this.wp.b.line(version, key);
  }

  has(key: string) {
    return !!this.line(key);
  }

  /** A line as a cell: effective value plus the engine value it overrides. */
  cell(key: string, version = this.v): ViewCell | undefined {
    const l = this.line(key, version);
    if (!l) return undefined;
    const id = lineId(version, key);
    const adj = version === this.v ? this.wp.state.effectiveAdjustment(id) : undefined;
    return { nodeId: id, value: adj ? adj.newValue : l.value, engineValue: l.value, adjusted: !!adj };
  }

  /** Effective numeric value of a line (0 when absent or non-numeric). */
  num(key: string, version = this.v): number {
    const c = this.cell(key, version);
    return typeof c?.value === 'number' ? c.value : 0;
  }

  engineNum(key: string, version = this.v): number {
    const v = this.line(key, version)?.value;
    return typeof v === 'number' ? v : 0;
  }

  ev(id: string): ViewCell | undefined {
    const e = this.wp.b.evs.get(id);
    if (!e) return undefined;
    return { nodeId: `ev:${id}`, value: SENSITIVE_VALUE_TYPES.has(e.value_type) ? maskValue(e.value) : e.value };
  }

  evNum(id: string): number {
    const v = this.wp.b.evs.get(id)?.value;
    return typeof v === 'number' ? v : 0;
  }

  py(ptr: string): ViewCell {
    return { nodeId: `py:${ptr}`, value: this.wp.b.pointer('py', ptr) };
  }

  agency(ptr: string): ViewCell {
    return { nodeId: `agency:${ptr}`, value: this.wp.b.pointer('agency', ptr) };
  }

  ref(path: string): ViewCell {
    return { nodeId: `ref:${path}`, value: this.wp.rawValue(`ref:${path}`) };
  }

  /** Current-version lines that cite `nodeId` directly as a source. */
  linesCiting(nodeId: string): string[] {
    return this.wp.g
      .parents(nodeId)
      .filter((e) => e.type === 'sourced_from' && e.to.startsWith(`line:${this.v}:`))
      .map((e) => parseLineId(e.to)!.key);
  }

  /** Extracted values of a document by field name. */
  docEvs(docId: string) {
    return this.wp.b.evsByDoc.get(docId) ?? [];
  }

  docEv(docId: string, field: string) {
    return this.docEvs(docId).find((e) => e.field === field);
  }

  /** Documents of a type, in id order. */
  docsOfType(...types: string[]) {
    return this.packet.documents.filter((d) => types.includes(d.document_type));
  }

  verifiedNodes(): Set<string> {
    return new Set([...this.wp.state.verifications.values()].map((v) => v.nodeId));
  }

  judgmentsOn(nodeIds: string[]) {
    const set = new Set(nodeIds);
    return [...this.wp.state.judgments.values()].filter((j) => j.nodeIds.some((n) => set.has(n)));
  }

  adjustmentsOn(nodeIds: string[]) {
    const set = new Set(nodeIds);
    return [...this.wp.state.adjustments.values()].filter((a) => set.has(a.nodeId));
  }

  view(id: string, title: string, description: string, sections: ViewSection[], findings: ViewFlag[] = [], meta?: Record<string, unknown>): ViewDto {
    return { id, title, description, version: this.v, seq: this.wp.state.seq, findings, sections, meta };
  }
}

// ---------------------------------------------------------------- small utilities

export const money = (key: string, label: string): ViewColumn => ({ key, label, kind: 'money' });
export const text = (key: string, label: string): ViewColumn => ({ key, label, kind: 'text' });
export const pct = (key: string, label: string): ViewColumn => ({ key, label, kind: 'percent' });
export const date = (key: string, label: string): ViewColumn => ({ key, label, kind: 'date' });
export const status = (key: string, label: string): ViewColumn => ({ key, label, kind: 'status' });

export const val = (value: unknown, nodeId?: string, note?: string): ViewCell => ({ value, nodeId, note });

export function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export const round2 = (x: number) => Math.round(x * 100) / 100;

export function cellNum(c: ViewCell | undefined): number {
  return n(c?.value);
}

/** A row from a line key; returns undefined when the line does not exist in this version. */
export function lineRow(ctx: ViewCtx, key: string, extra: Partial<ViewRow> = {}, col = 'amount'): ViewRow | undefined {
  const c = ctx.cell(key);
  if (!c) return undefined;
  const l = ctx.line(key)!;
  return { id: key, label: l.label, sublabel: `${l.form} ${l.line}`, nodeId: c.nodeId, cells: { [col]: c }, ...extra };
}

export function compact<T>(xs: (T | undefined | null | false)[]): T[] {
  return xs.filter(Boolean) as T[];
}

export function fmt(x: number): string {
  return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}
