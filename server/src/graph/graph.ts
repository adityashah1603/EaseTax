// Provenance graph (D-06). "Down" points from a result toward its sources:
//   line -> input lines, line -> sources (ev, qa, py, ...), ev -> page, page -> doc.
// "Up" is the inverse and answers "where did this land?".

import type { EdgeType } from '@easetax/shared';
import { assetId, diagId, evId, lineId, pageId, docId, resolveRef } from '@easetax/shared';
import type { Baseline } from '../baseline/baseline.ts';

export interface Edge {
  to: string;
  type: EdgeType;
}

export class Graph {
  private down = new Map<string, Edge[]>();
  private up = new Map<string, Edge[]>();
  readonly nodes = new Set<string>();

  addEdge(from: string, to: string, type: EdgeType) {
    this.nodes.add(from);
    this.nodes.add(to);
    push(this.down, from, { to, type });
    push(this.up, to, { to: from, type });
  }

  removeEdge(from: string, to: string, type: EdgeType) {
    const d = this.down.get(from);
    if (d) this.down.set(from, d.filter((e) => !(e.to === to && e.type === type)));
    const u = this.up.get(to);
    if (u) this.up.set(to, u.filter((e) => !(e.to === from && e.type === type)));
  }

  /** Drop edges created by users (evidence, links); used before a projection rebuild. */
  clearUserEdges() {
    for (const m of [this.down, this.up]) {
      for (const [k, list] of m) m.set(k, list.filter((e) => e.type !== 'evidences' && e.type !== 'related'));
    }
  }

  children(id: string): Edge[] {
    return this.down.get(id) ?? [];
  }

  parents(id: string): Edge[] {
    return this.up.get(id) ?? [];
  }

  /** Every node reachable upward (all results that depend on `id`), excluding itself. */
  dependents(id: string, filter?: (id: string) => boolean): Set<string> {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.parents(cur)) {
        if (e.type === 'evidences' || e.type === 'related' || e.type === 'refers_to') continue;
        if (out.has(e.to)) continue;
        if (filter && !filter(e.to)) continue;
        out.add(e.to);
        stack.push(e.to);
      }
    }
    return out;
  }

  /** Every node reachable downward (everything `id` was built from), excluding itself. */
  closure(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.children(cur)) {
        if (e.type === 'refers_to' || e.type === 'related') continue;
        if (out.has(e.to)) continue;
        out.add(e.to);
        stack.push(e.to);
      }
    }
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function buildGraph(b: Baseline): Graph {
  const g = new Graph();

  for (const d of b.packet.documents) {
    g.nodes.add(docId(d.id));
    for (const p of d.pages) g.addEdge(pageId(d.id, p.page), docId(d.id), 'page_of');
  }
  for (const e of b.packet.extracted_values) g.addEdge(evId(e.id), pageId(e.document_id, e.page), 'read_from');

  for (const v of b.versions) {
    for (const l of v.lines) {
      const id = lineId(v.version, l.key);
      g.nodes.add(id);
      for (const i of l.inputs) g.addEdge(id, lineId(v.version, i), 'input_of');
      for (const s of l.sources) g.addEdge(id, resolveRef(s, v.version), 'sourced_from');
    }
    for (const a of v.assets) {
      const id = assetId(v.version, a.asset_id);
      g.nodes.add(id);
      for (const s of a.sources ?? []) g.addEdge(id, resolveRef(s, v.version), 'sourced_from');
    }
    for (const dg of v.diagnostics) {
      const id = diagId(v.version, dg.code);
      g.nodes.add(id);
      for (const r of dg.refs ?? []) g.addEdge(id, resolveRef(r, v.version), 'refers_to');
    }
    // Corrected documents replace originals for this version.
    for (const sup of v.documents_superseded as string[]) {
      const replacement = b.packet.documents.find(
        (d) => d.marked_corrected && d.id !== sup && d.issuer === b.docs.get(sup)?.issuer,
      );
      if (replacement && !g.children(docId(replacement.id)).some((e) => e.type === 'supersedes')) {
        g.addEdge(docId(replacement.id), docId(sup), 'supersedes');
      }
    }
  }

  for (const t of b.timeline) {
    const id = `timeline:${t.id}`;
    g.nodes.add(id);
    for (const r of t.refs ?? []) g.addEdge(id, resolveRef(r, null), 'refers_to');
  }

  return g;
}
