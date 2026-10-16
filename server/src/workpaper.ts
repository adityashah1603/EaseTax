// The workpaper service: one instance per return. Owns the baseline, the graph, the event
// store and the projected state, and exposes read models and commands to the API.

import { createHash, randomUUID } from 'node:crypto';
import type {
  Actor,
  AreaDto,
  DocumentDetailDto,
  DocumentDto,
  ExtractedValue,
  HouseholdCorrectionDto,
  IssueDto,
  PacketPerson,
  ReadCorrectionDto,
  LineRow,
  MyActionDto,
  NodeDetail,
  NodeSummary,
  ReturnSummaryDto,
  SignoffLevel,
  TraceNode,
  WorkEvent,
} from '@easetax/shared';
import { effectMagnitude, estimateEffect, lineId, nodeKind, pageId, parseLineId, parsePageId } from '@easetax/shared';
import type { Baseline } from './baseline/baseline.ts';
import { jsonPointer } from './baseline/baseline.ts';
import { AREAS, areaOfKey } from './baseline/areas.ts';
import { buildGraph, type Graph } from './graph/graph.ts';
import type { AppendInput, EventStore } from './events/store.ts';
import { WorkState } from './state/state.ts';
import { runChecks, type CheckContext } from './checks/index.ts';
import { relatedConsistency } from './checks/related.ts';
import { relatedReturns } from './baseline/related.ts';
import { assertCan, canSignLevel, maskDeep, maskText, maskValue, PolicyError, RULES, SENSITIVE_VALUE_TYPES, actorsFrom } from './policy/policy.ts';

export type Listener = (events: WorkEvent[]) => void;

/** D-65: actions that stay on the record; Undo would hide them. */
const NOT_UNDOABLE: Partial<Record<WorkEvent['type'], string>> = {
  'sensitive.unmasked': 'viewing a sensitive field stays in the access log.',
  'filing.step': 'filing steps are records of what was sent and received; record a fix or open an amendment instead.',
  'events.undone': 'an undo is itself kept in the history.',
  'signoff.reopened': 'the system reopened this sign-off because its content changed.',
};
/** Bookkeeping events that aren't actions a person would want to take back. */
const HIDDEN_FROM_MY_ACTIONS = new Set<WorkEvent['type']>(['seen.marked', 'notification.read', 'events.undone']);

export class Workpaper {
  readonly g: Graph;
  readonly state: WorkState;
  readonly actors: Actor[];
  private issuesCache: IssueDto[] | null = null;
  private issuesByNode = new Map<string, IssueDto[]>();
  private listeners = new Set<Listener>();

  constructor(
    readonly b: Baseline,
    readonly store: EventStore,
  ) {
    this.g = buildGraph(b);
    this.state = new WorkState(this.g);
    this.state.rebuild(store.all());
    this.actors = actorsFrom(b);
  }

  get version() {
    return this.b.currentVersion;
  }

  actor(id: string | undefined): Actor {
    const a = this.actors.find((x) => x.id === id);
    if (!a) throw new PolicyError(`Unknown actor ${id}`, 'forbidden');
    return a;
  }

  onEvents(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---------------------------------------------------------------- writes

  commit(actor: Actor, inputs: Omit<AppendInput, 'actor' | 'role'>[]): WorkEvent[] {
    const events = this.store.append(inputs.map((i) => ({ ...i, actor: actor.id, role: actor.role })));
    if (events.some((e) => e.type === 'events.undone')) this.state.rebuild(this.store.all());
    else for (const e of events) this.state.apply(e);
    this.issuesCache = null;
    for (const l of this.listeners) l(events);
    return events;
  }

  // ---------------------------------------------------------------- values

  lineValue(key: string, version = this.version): unknown {
    const id = lineId(version, key);
    const adj = version === this.version ? this.state.effectiveAdjustment(id) : undefined;
    return adj ? adj.newValue : this.b.line(version, key)?.value;
  }

  rawValue(nodeId: string): unknown {
    const kind = nodeKind(nodeId);
    switch (kind) {
      case 'line': {
        const p = parseLineId(nodeId)!;
        return this.b.line(p.version, p.key)?.value;
      }
      case 'ev':
        return this.b.evs.get(nodeId.slice(3))?.value;
      case 'py':
        return this.b.pointer('py', nodeId.slice(3));
      case 'agency':
        return this.b.pointer('agency', nodeId.slice(7));
      case 'qa':
        return this.b.qa.get(nodeId.slice(3))?.answer;
      case 'ref':
        return this.refValue(nodeId);
      default:
        return undefined;
    }
  }

  private refValue(nodeId: string): unknown {
    const path = nodeId.slice(4);
    const params = this.b.packet.engine_reference.parameters;
    if (path.startsWith('param.')) return params[path.slice(6)];
    return jsonPointer(params, '/' + path.split('.').join('/'));
  }

  // ---------------------------------------------------------------- issues

  checkContext(): CheckContext {
    return {
      b: this.b,
      g: this.g,
      state: this.state,
      version: this.version,
      lineValue: (k) => this.lineValue(k),
      effectivePerson: (p) => this.effectivePerson(p),
      effectiveEv: (e) => {
        const c = this.state.correctionFor(e.id);
        return c ? { ...e, value: c.correctedValue as ExtractedValue['value'], text_as_read: String(c.correctedValue) } : e;
      },
    };
  }

  issues(): IssueDto[] {
    if (this.issuesCache) return this.issuesCache;
    const ctx = this.checkContext();
    // Check text may quote document content; mask it like any other outbound text (D-10).
    const found = runChecks(ctx).map((i) => ({
      ...i,
      title: maskText(i.title),
      detail: i.detail ? maskText(i.detail) : i.detail,
      suggestion: i.suggestion && typeof i.suggestion.value === 'string' ? { ...i.suggestion, value: maskValue(i.suggestion.value), why: maskText(i.suggestion.why) } : i.suggestion,
    }));
    const all: IssueDto[] = [];
    for (const i of found) {
      const area = i.area ?? this.areaOfNodes(i.nodeIds);
      const source = i.source ?? 'check';
      all.push({ ...i, source, area, ...this.closureOf(i.id, source === 'check' || source === 'engine' ? i.severity : undefined) });
    }
    for (const h of this.state.humanIssues.values()) all.push({ ...h, area: this.areaOfNodes(h.nodeIds), ...this.closureOf(h.id) });
    this.issuesByNode.clear();
    for (const i of all) {
      for (const n of i.nodeIds) {
        const list = this.issuesByNode.get(n) ?? [];
        list.push(i);
        this.issuesByNode.set(n, list);
      }
    }
    this.issuesCache = all;
    return all;
  }

  /**
   * Status fields for an issue. D-65: closing an error found by a check or the engine by hand
   * needs a reviewer or partner other than the closer to confirm; until then it stays open.
   * A judgment's closure (D-53) carries its own authority and needs no second confirmation.
   */
  private closureOf(id: string, severity?: IssueDto['severity']): Pick<IssueDto, 'status' | 'resolution' | 'resolvedByJudgment' | 'closedBy' | 'closedAt' | 'confirmedBy' | 'confirmedAt' | 'awaitingConfirmation'> {
    const st = this.state.issueStatus.get(id);
    if (!st || st.status === 'open') return { status: 'open' };
    if (st.judgmentId) return { status: st.status, resolution: st.resolution, resolvedByJudgment: st.judgmentId, closedBy: st.by, closedAt: st.at };
    if (severity === 'error' && !st.confirmedBy) return { status: 'open', awaitingConfirmation: { status: st.status, resolution: st.resolution ?? '', by: st.by, at: st.at } };
    return { status: st.status, resolution: st.resolution, closedBy: st.by, closedAt: st.at, confirmedBy: st.confirmedBy, confirmedAt: st.confirmedAt };
  }

  /** D-65: a reviewer or partner other than the closer confirms closing an error. */
  confirmIssueClosure(actor: Actor, issueId: string) {
    assertCan(actor, 'confirm_closure');
    const issue = this.issues().find((i) => i.id === issueId);
    if (!issue) throw new PolicyError('No such issue', 'not_found');
    const w = issue.awaitingConfirmation;
    if (!w) throw new PolicyError('This issue is not waiting for a confirmation', 'conflict');
    if (w.by === actor.id) throw new PolicyError(RULES.noSelfReview, 'policy', RULES.noSelfReview);
    return this.commit(actor, [{ type: 'issue.closure_confirmed', payload: { issueId } }]);
  }

  issuesFor(nodeId: string): IssueDto[] {
    this.issues();
    return this.issuesByNode.get(nodeId) ?? [];
  }

  /** Area of the first line among `ids`, else of the first current-version line fed by one of them. */
  private areaOfNodes(ids: string[]): string | undefined {
    for (const id of ids) {
      const l = parseLineId(id);
      if (l) return areaOfKey(l.key);
    }
    const prefix = `line:${this.version}:`;
    for (const id of ids) {
      const ev = id.startsWith('doc:') && !id.includes('#') ? (this.b.evsByDoc.get(id.slice(4)) ?? []).map((e) => `ev:${e.id}`) : [id];
      for (const n of ev) {
        for (const p of this.g.parents(n)) {
          if (p.to.startsWith(prefix)) return areaOfKey(p.to.slice(prefix.length));
        }
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- summaries

  summarize(id: string, masked = true): NodeSummary {
    const kind = nodeKind(id) ?? 'unknown';
    const s: NodeSummary = { id, kind, label: id };
    const mask = (v: unknown) => (masked ? maskValue(v) : v);
    switch (kind) {
      case 'line': {
        const p = parseLineId(id)!;
        const l = this.b.line(p.version, p.key);
        if (!l) break;
        s.label = this.lineLabel(p.version, l);
        s.sublabel = `${l.form} ${l.line}${l.jurisdiction === 'california' ? ' · CA' : ''}`;
        if (p.version !== this.version) s.sublabel += ` · engine ${p.version}`;
        s.rule = l.rule;
        s.note = l.note;
        s.area = areaOfKey(l.key);
        s.version = p.version;
        s.value = l.value;
        const adj = p.version === this.version ? this.state.effectiveAdjustment(id) : undefined;
        s.effectiveValue = adj ? adj.newValue : l.value;
        s.adjusted = !!adj;
        s.verified = [...this.state.verifications.values()].some((v) => v.nodeId === id);
        s.openIssues = this.issuesFor(id).filter((i) => i.status === 'open').length;
        break;
      }
      case 'ev': {
        const e = this.b.evs.get(id.slice(3));
        if (!e) break;
        const d = this.b.docs.get(e.document_id);
        s.label = e.label;
        s.sublabel = `${e.document_id} p${e.page} · ${e.field}${d ? ' · ' + d.title : ''}`;
        s.value = SENSITIVE_VALUE_TYPES.has(e.value_type) ? mask(e.value) : e.value;
        const corr = this.state.correctionFor(e.id);
        s.effectiveValue = corr ? (SENSITIVE_VALUE_TYPES.has(e.value_type) ? mask(corr.correctedValue) : corr.correctedValue) : s.value;
        s.adjusted = !!corr;
        s.confidence = e.confidence;
        s.verified = [...this.state.verifications.values()].some((v) => v.nodeId === id);
        s.openIssues = this.issuesFor(id).filter((i) => i.status === 'open').length;
        break;
      }
      case 'page': {
        const p = parsePageId(id)!;
        const d = this.b.docs.get(p.doc);
        s.label = `${p.doc} page ${p.page}`;
        s.sublabel = d?.title;
        break;
      }
      case 'doc': {
        const d = this.b.docs.get(id.slice(4));
        if (!d) break;
        s.label = d.title;
        s.sublabel = `${d.id} · ${d.document_type} · ${d.issuer}`;
        s.openIssues = this.issuesFor(id).filter((i) => i.status === 'open').length;
        break;
      }
      case 'py':
      case 'agency': {
        const v = this.rawValue(id);
        s.label = kind === 'py' ? `Prior years ${id.slice(3)}` : `Agency record ${id.slice(7)}`;
        s.sublabel = kind === 'py' ? 'prior_years' : 'tax_agency_records';
        const prior = /^py:\/return_2024\/lines\/(.+)$/.exec(id);
        if (prior) {
          const key = prior[1]!;
          s.label = this.b.packet.prior_years.return_2024?.line_labels?.[key] ?? key;
          s.sublabel = `2024 return as filed · ${key.replace('.', ' ')}`;
          s.version = '2024';
        }
        if (v === null || typeof v !== 'object') s.value = mask(v);
        break;
      }
      case 'asset': {
        const [, ver, aid] = id.split(':');
        const a = this.b.version(ver!)?.assets.find((x) => x.asset_id === aid);
        s.label = a?.description ?? aid!;
        s.sublabel = a ? `${a.method} · ${a.life_years} yr · placed ${a.placed_in_service}` : undefined;
        s.version = ver;
        s.value = a ? (a.federal as any).depreciation_2025 : undefined;
        break;
      }
      case 'household': {
        const p = this.person(id.slice(10));
        s.label = p ? p.name : id;
        s.sublabel = p ? `${p.role}${p.relationship ? ' · ' + p.relationship : ''}` : undefined;
        break;
      }
      case 'qa': {
        const q = this.b.qa.get(id.slice(3));
        s.label = q?.question ?? id;
        s.sublabel = q ? `Questionnaire · ${q.answered_by}` : undefined;
        s.value = q?.answer;
        break;
      }
      case 'msg': {
        const m = this.b.msgs.get(id.slice(4));
        s.label = m ? `${m.from}: ${m.text}` : id;
        s.sublabel = m ? `Message · ${m.sent_at.slice(0, 10)}` : undefined;
        break;
      }
      case 'call': {
        const c = this.b.calls.get(id.slice(5));
        s.label = c ? `Call ${c.date.slice(0, 10)} · ${c.participants.join(', ')}` : id;
        s.sublabel = 'Call notes';
        break;
      }
      case 'ref':
        s.label = id.slice(4);
        s.sublabel = 'Engine reference';
        s.value = this.refValue(id);
        break;
      case 'timeline': {
        const t = this.b.timeline.find((x) => `timeline:${x.id}` === id);
        s.label = t ? `${t.event.replace(/_/g, ' ')}` : id;
        s.sublabel = t?.at.slice(0, 10);
        break;
      }
      case 'diag': {
        const [, ver, code] = id.split(':');
        const d = this.b.version(ver!)?.diagnostics.find((x) => x.code === code);
        s.label = d?.message ?? code!;
        s.sublabel = `Engine diagnostic ${code} (${ver})`;
        break;
      }
      case 'att': {
        const a = this.state.attachments.get(id.slice(4));
        s.label = a?.name ?? id;
        s.sublabel = a ? `${a.kind} · ${a.by}` : undefined;
        break;
      }
    }
    if (kind === 'related') {
      const r = relatedReturns(this.b).find((x) => x.id === id);
      if (r) {
        s.label = `${r.who}: ${r.form.replace(/\s*\(.*$/, '')}`;
        s.sublabel = `Related return · prepared by ${r.preparedBy}${r.docIds.length ? ` · in packet: ${r.docIds.join(', ')}` : ' · not in packet'}`;
      }
    }
    s.revision = this.revision(id);
    if (id.startsWith('note:')) {
      const n = this.state.notes.get(id.slice(5));
      s.kind = 'note';
      s.label = n ? n.thread[0]!.text : id;
      s.sublabel = n ? `${n.blocking ? 'Blocking review note' : 'Review note'} · ${n.status}` : undefined;
    }
    if (id.startsWith('question:')) {
      const q = this.state.questions.get(id.slice(9));
      s.kind = 'question';
      s.label = q ? q.thread[0]!.text : id;
      s.sublabel = q ? `Question to ${q.to}` : undefined;
    }
    return s;
  }

  // ---------------------------------------------------------------- trace

  trace(id: string, dir: 'down' | 'up', depth = 3): TraceNode {
    const seen = new Set<string>();
    const walk = (nid: string, d: number, edge?: TraceNode['edge']): TraceNode => {
      const node = this.summarize(nid);
      if (seen.has(nid)) return { node, edge, children: [], repeated: true };
      seen.add(nid);
      const edges = dir === 'down' ? this.g.children(nid) : this.g.parents(nid);
      let filtered = edges.filter((e) => e.type !== 'refers_to' || dir === 'down');
      // Up from a source (value, document, person, answer), every engine version cites it.
      // Show where it lands in the current return; fall back to older versions (labelled with
      // their version) only when the current one no longer uses it, e.g. a superseded 1099.
      if (dir === 'up' && !nid.startsWith('line:')) {
        const cur = filtered.filter((e) => !e.to.startsWith('line:') || e.to.startsWith(`line:${this.version}:`));
        if (cur.some((e) => e.to.startsWith('line:'))) filtered = cur;
      }
      if (d <= 0 && filtered.length) return { node, edge, children: [], truncated: true };
      return { node, edge, children: filtered.map((e) => walk(e.to, d - 1, e.type)) };
    };
    return walk(id, depth);
  }

  // ---------------------------------------------------------------- read models

  nodeDetail(id: string, actor: Actor): NodeDetail {
    const node = this.summarize(id);
    const verifications = [...this.state.verifications.values()]
      .filter((v) => v.nodeId === id)
      .map((v) => ({ ...v, stale: id.startsWith('line:') && JSON.stringify(v.valueAtVerification) !== JSON.stringify(node.effectiveValue ?? node.value) }));
    const detail: NodeDetail = {
      node,
      raw: this.rawPayload(id),
      verifications,
      adjustments: [...this.state.adjustments.values()].filter((a) => a.nodeId === id),
      corrections: this.correctionsFor(id),
      consistency: id.startsWith('related:') ? relatedConsistency(this.checkContext()).get(id) ?? [] : undefined,
      recordCorrections: id.startsWith('household:')
        ? [...this.state.householdCorrections.values()].filter((c) => c.personId === id.slice(10)).map((c) => this.maskHousehold(c))
        : [],
      issues: this.issuesFor(id),
      notes: [...this.state.notes.values()].filter((n) => n.nodeIds.includes(id)),
      questions: [...this.state.questions.values()].filter((q) => q.nodeIds.includes(id)),
      evidence: this.state.evidence.filter((e) => e.nodeId === id).map((e) => ({ id: e.id, node: this.summarize(e.evidenceId), note: e.note, by: e.by, at: e.at })),
      links: this.state.links
        .filter((l) => l.from === id || l.to === id)
        .map((l) => ({ id: l.id, other: this.summarize(l.from === id ? l.to : l.from), linkType: l.linkType, note: l.note })),
      history: (this.state.history.get(id) ?? []).map((e) => this.publicEvent(e)),
    };
    const p = parseLineId(id);
    if (p) {
      detail.versions = [
        ...this.b.versions.map((v) => ({ version: v.version, value: this.b.line(v.version, p.key)?.value })),
        { version: '2024', value: this.b.priorLines[p.key] },
      ];
    }
    return detail;
  }

  private rawPayload(id: string): unknown {
    const kind = nodeKind(id);
    let raw: unknown;
    switch (kind) {
      case 'line': {
        const p = parseLineId(id)!;
        raw = this.b.line(p.version, p.key);
        break;
      }
      case 'ev':
        raw = this.b.evs.get(id.slice(3));
        break;
      case 'household':
        raw = this.person(id.slice(10));
        break;
      case 'call':
        raw = this.b.calls.get(id.slice(5));
        break;
      case 'msg':
        raw = this.b.msgs.get(id.slice(4));
        break;
      case 'timeline':
        raw = this.b.timeline.find((x) => `timeline:${x.id}` === id);
        break;
      case 'related':
        raw = relatedReturns(this.b).find((x) => x.id === id);
        break;
      default:
        raw = this.rawValue(id);
    }
    return maskDeep(raw);
  }

  lines(opts: { version?: string; area?: string; form?: string }): LineRow[] {
    const version = opts.version ?? this.version;
    const v = this.b.version(version);
    if (!v) return [];
    const rows: LineRow[] = [];
    for (const l of v.lines) {
      if (opts.form && l.form !== opts.form) continue;
      if (opts.area && areaOfKey(l.key) !== opts.area) continue;
      const id = lineId(version, l.key);
      const adj = version === this.version ? this.state.effectiveAdjustment(id) : undefined;
      const direct = this.issuesFor(id).filter((i) => i.status === 'open').length;
      rows.push({
        id,
        key: l.key,
        form: l.form,
        line: l.line,
        label: this.lineLabel(version, l),
        jurisdiction: l.jurisdiction,
        value: l.value,
        effectiveValue: adj ? adj.newValue : l.value,
        priorYear: this.b.priorLines[l.key],
        rule: l.rule,
        area: areaOfKey(l.key),
        revision: this.revision(id),
        openIssues: direct,
        verified: [...this.state.verifications.values()].some((x) => x.nodeId === id),
        adjusted: !!adj,
        notes: [...this.state.notes.values()].filter((n) => n.status === 'open' && n.nodeIds.includes(id)).length,
      });
    }
    return rows;
  }

  areas(): AreaDto[] {
    const rows = this.lines({});
    const budget = this.b.packet.firm.budget_hours;
    return AREAS.map((a) => {
      const mine = rows.filter((r) => areaOfKey(r.key) === a.id);
      return {
        id: a.id,
        title: a.title,
        forms: a.forms,
        lineCount: mine.length,
        openIssues: this.issues().filter((i) => i.status === 'open' && i.area === a.id).length,
        verifiedLines: mine.filter((r) => r.verified).length,
        adjustedLines: mine.filter((r) => r.adjusted).length,
        signoffs: [...this.state.signoffs.values()].filter((s) => s.scope === `area:${a.id}` && s.status !== 'withdrawn'),
        considered: this.state.areaConsidered.has(a.id),
        consideredBy: this.state.areaConsidered.get(a.id)?.by,
        consideredAt: this.state.areaConsidered.get(a.id)?.at,
        consideredNote: this.state.areaConsidered.get(a.id)?.note,
        budgetHours: budget[a.id],
        loggedHours: this.state.time.filter((t) => t.area === a.id).reduce((s, t) => s + t.hours, 0),
      };
    });
  }

  /**
   * Time budget lines: the review areas plus engagement phases the firm budgets that aren't
   * areas of the return (e.g. intake & engagement, partner review). Order: areas, then phases.
   */
  budgetLines(): { area: string; title: string; isArea: boolean; budgetHours: number | null; loggedHours: number }[] {
    const budget = this.b.packet.firm.budget_hours;
    const logged = (id: string) => this.state.time.filter((t) => t.area === id).reduce((s, t) => s + t.hours, 0);
    const areaIds = new Set(AREAS.map((a) => a.id));
    const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/ and /g, ' & ');
    return [
      ...AREAS.map((a) => ({ area: a.id, title: a.title, isArea: true, budgetHours: budget[a.id] ?? null, loggedHours: logged(a.id) })),
      ...Object.keys(budget)
        .filter((k) => !areaIds.has(k))
        .map((k) => ({ area: k, title: humanize(k), isArea: false, budgetHours: budget[k]!, loggedHours: logged(k) })),
    ];
  }

  /** Lines in a version that cite any extracted value from the document. */
  private landingsOf(docIdRaw: string, version = this.version) {
    const evs = this.b.evsByDoc.get(docIdRaw) ?? [];
    return evs.map((e) => ({
      evId: e.id,
      field: e.field,
      label: e.label,
      value: this.correctedValueOut(e) ?? (SENSITIVE_VALUE_TYPES.has(e.value_type) ? maskValue(e.value) : e.value),
      lines: this.g
        .parents(`ev:${e.id}`)
        .filter((p) => p.type === 'sourced_from' && p.to.startsWith(`line:${version}:`))
        .map((p) => this.summarize(p.to)),
    }));
  }

  documents(asOf?: string): DocumentDto[] {
    return this.b.packet.documents
      .filter((d) => !asOf || d.received_at <= asOf)
      .map((d) => this.documentDto(d.id));
  }

  private documentDto(id: string): DocumentDto {
    const d = this.b.docs.get(id)!;
    const landings = this.landingsOf(id);
    const linesFed = new Set(landings.flatMap((l) => l.lines.map((x) => x.id))).size;
    const docIssues = new Set<string>();
    for (const n of [`doc:${id}`, ...d.pages.map((p) => pageId(id, p.page)), ...(this.b.evsByDoc.get(id) ?? []).map((e) => `ev:${e.id}`)]) {
      for (const i of this.issuesFor(n)) if (i.status === 'open') docIssues.add(i.id);
    }
    return {
      id: d.id,
      title: d.title,
      documentType: d.document_type,
      issuer: d.issuer,
      belongsTo: d.belongs_to,
      taxYear: d.tax_year,
      receivedAt: d.received_at,
      uploadedBy: d.uploaded_by,
      fileName: d.file_name,
      pageCount: d.page_count,
      markedCorrected: !!d.marked_corrected,
      extraction: d.extraction,
      rendition: { kind: 'simulated' },
      disposition: this.state.dispositions.get(id) ?? this.derivedDisposition(id, linesFed),
      linesFed,
      openIssues: docIssues.size,
    };
  }

  /** Dispositions the packet itself implies; humans can override with disposition.set. */
  private derivedDisposition(id: string, linesFed: number): DocumentDto['disposition'] {
    const v = this.b.version(this.version)!;
    if ((v.documents_superseded as string[]).includes(id)) {
      const by = this.g.parents(`doc:${id}`).find((e) => e.type === 'supersedes')?.to;
      return { documentId: id, status: 'superseded', note: by ? `Replaced by ${by.slice(4)} (marked CORRECTED)` : 'Superseded per engine', by: 'system', at: v.computed_at, derived: true };
    }
    if (linesFed > 0) return { documentId: id, status: 'used', by: 'system', at: v.computed_at, derived: true };
    return null;
  }

  documentDetail(id: string): DocumentDetailDto {
    const d = this.b.docs.get(id);
    if (!d) throw new PolicyError(`No document ${id}`, 'not_found');
    const evs = this.b.evsByDoc.get(id) ?? [];
    const landings = this.landingsOf(id);
    return {
      ...this.documentDto(id),
      pages: d.pages.map((p) => ({
        page: p.page,
        printedContent: maskDeep(p.printed_content) as string,
        anchors: evs
          .filter((e) => e.page === p.page)
          .map((e) => ({
            evId: e.id,
            field: e.field,
            label: e.label,
            value: SENSITIVE_VALUE_TYPES.has(e.value_type) ? maskValue(e.value) : e.value,
            textAsRead: SENSITIVE_VALUE_TYPES.has(e.value_type) ? String(maskValue(e.text_as_read)) : e.text_as_read,
            anchor: e.position,
            confidence: e.confidence,
            correctedValue: this.correctedValueOut(e),
          })),
      })),
      landings,
      unusedValues: landings.filter((l) => l.lines.length === 0).length,
    };
  }

  summary(): ReturnSummaryDto {
    const issues = this.issues();
    const adjEffect = { federalTax: 0, californiaTax: 0, federalBalance: 0, californiaBalance: 0 };
    for (const adjId of this.state.activeAdjustment.values()) {
      const a = this.state.adjustments.get(adjId)!;
      adjEffect.federalTax += a.effect.federalTax;
      adjEffect.californiaTax += a.effect.californiaTax;
      adjEffect.federalBalance += a.effect.federalBalance;
      adjEffect.californiaBalance += a.effect.californiaBalance;
    }
    const docs = this.documents();
    return {
      clientId: this.b.packet.packet.client_id,
      name: this.b.packet.packet.name,
      taxYear: this.b.packet.household.tax_year,
      packetHash: this.b.hash,
      currentVersion: this.version,
      versions: this.b.versions.map((v) => ({ version: v.version, computedAt: v.computed_at, trigger: v.trigger, federal: v.summary.federal, california: v.summary.california })),
      priorYear: { agi: num(this.b.priorLines['F1040.11']), totalTax: num(this.b.priorLines['F1040.24']), lines: this.b.priorLines },
      status: {
        openIssues: issues.filter((i) => i.status === 'open').length,
        blockingNotes: [...this.state.notes.values()].filter((n) => n.blocking && n.status === 'open').length,
        openQuestions: [...this.state.questions.values()].filter((q) => q.status === 'open').length,
        pendingAdjustments: [...this.state.adjustments.values()].filter((a) => a.status === 'proposed').length,
        undispositionedDocs: docs.filter((d) => !d.disposition).length,
        signoffs: [...this.state.signoffs.values()].filter((s) => s.status !== 'withdrawn'),
      },
      adjustmentEffect: adjEffect,
    };
  }

  // ---------------------------------------------------------------- commands

  verify(actor: Actor, nodeIds: string[], type: string, note?: string, evidence: string[] = [], expected: Record<string, number> = {}) {
    assertCan(actor, 'verify');
    for (const id of nodeIds) this.assertFresh(id, expected[id]);
    const types = this.standards().verification_types;
    if (!types.includes(type)) throw new PolicyError(`Unknown verification type ${type}`, 'invalid');
    const batchId = nodeIds.length > 1 ? randomUUID() : undefined;
    return this.commit(
      actor,
      nodeIds.map((nodeId) => {
        this.assertNode(nodeId);
        const s = this.summarize(nodeId, false);
        return {
          type: 'verification.added' as const,
          payload: { verificationId: randomUUID(), nodeId, type, note, evidence, valueAtVerification: s.effectiveValue ?? s.value },
          batchId,
        };
      }),
    );
  }

  proposeAdjustment(actor: Actor, nodeId: string, newValue: unknown, reason: string, authority?: string, revision?: number) {
    assertCan(actor, 'adjust');
    this.assertFresh(nodeId, revision);
    if (!reason?.trim()) throw new PolicyError('An adjustment needs a reason', 'invalid');
    const p = parseLineId(nodeId);
    if (!p || p.version !== this.version) throw new PolicyError(`Adjust lines of the current version (${this.version}) only`, 'invalid');
    const line = this.b.line(p.version, p.key);
    if (!line) throw new PolicyError(`No line ${p.key}`, 'not_found');
    const current = this.lineValue(p.key);
    const v = this.b.version(this.version)!;
    const effect = estimateEffect(p.key, current, newValue, v.tax_effect_rates, this.version);
    // D-20: a partner's own adjustment carries their sign-off.
    const requiresPartner = effectMagnitude(effect) > 1000 && actor.role !== 'partner';
    return this.commit(actor, [
      {
        type: 'adjustment.proposed',
        payload: { adjustmentId: randomUUID(), nodeId, originalValue: line.value, newValue, authority, effect, requiresPartner },
        reason,
      },
    ]);
  }

  decideAdjustment(actor: Actor, adjustmentId: string, decision: 'approve' | 'reject' | 'revert', note?: string) {
    const adj = this.state.adjustments.get(adjustmentId);
    if (!adj) throw new PolicyError('No such adjustment', 'not_found');
    if (decision === 'revert') {
      assertCan(actor, 'adjust');
      if (adj.status !== 'approved') throw new PolicyError('Only an adjustment in force can be reverted', 'conflict');
      return this.commit(actor, [{ type: 'adjustment.reverted', payload: { adjustmentId }, reason: note }]);
    }
    assertCan(actor, 'approve_adjustment');
    if (adj.status !== 'proposed') throw new PolicyError(`Adjustment is ${adj.status}`, 'conflict');
    if (adj.by === actor.id) throw new PolicyError(RULES.noSelfReview, 'policy', RULES.noSelfReview);
    return this.commit(actor, [{ type: decision === 'approve' ? 'adjustment.approved' : 'adjustment.rejected', payload: { adjustmentId, note }, reason: note }]);
  }

  signoff(actor: Actor, scope: string, level: SignoffLevel) {
    assertCan(actor, 'signoff');
    if (!canSignLevel(actor.role, level)) throw new PolicyError(`${actor.role} cannot sign at ${level} level`, 'forbidden');
    const lines = this.scopeLines(scope);
    if (level !== 'preparer') {
      // No self-review: the signer must not have prepared (verified or adjusted) anything in scope.
      const ids = new Set(lines.map((l) => l.id));
      const prepared = this.state.events.some(
        (e) =>
          e.actor === actor.id &&
          !this.state.undone.has(e.id) &&
          (e.type === 'verification.added' || e.type === 'adjustment.proposed') &&
          ids.has((e.payload as any).nodeId),
      );
      if (prepared) throw new PolicyError(RULES.noSelfReview, 'policy', RULES.noSelfReview);
    }
    const scopeHash = this.scopeHash(scope);
    return this.commit(actor, [{ type: 'signoff.recorded', payload: { signoffId: randomUUID(), scope, level, scopeHash } }]);
  }

  scopeLines(scope: string): LineRow[] {
    if (scope === 'return') return this.lines({});
    if (scope.startsWith('area:')) return this.lines({ area: scope.slice(5) });
    throw new PolicyError(`Unknown scope ${scope}`, 'invalid');
  }

  scopeHash(scope: string): string {
    const h = createHash('sha256');
    for (const l of this.scopeLines(scope).sort((a, b) => a.key.localeCompare(b.key))) h.update(`${l.key}=${JSON.stringify(l.effectiveValue)}\n`);
    return h.digest('hex');
  }

  undo(actor: Actor, target: { batchId?: string; eventId?: string }) {
    assertCan(actor, 'undo');
    const ids = this.state.events
      .filter((e) => (target.batchId ? e.batchId === target.batchId : e.id === target.eventId))
      .filter((e) => !this.state.undone.has(e.id));
    if (!ids.length) throw new PolicyError('Nothing to undo', 'not_found');
    if (ids.some((e) => e.actor !== actor.id)) throw new PolicyError('You can only undo your own actions', 'forbidden');
    const kept = ids.find((e) => NOT_UNDOABLE[e.type]);
    if (kept) throw new PolicyError(`This can't be undone: ${NOT_UNDOABLE[kept.type]}`, 'conflict');
    return this.commit(actor, [{ type: 'events.undone', payload: { eventIds: ids.map((e) => e.id) } }]);
  }

  /** D-65: my own actions, newest first, one entry per command (its batch, else its event). */
  myActions(actor: Actor, limit = 100): MyActionDto[] {
    const groups = new Map<string, WorkEvent[]>();
    for (const e of this.state.events) {
      if (e.actor !== actor.id || HIDDEN_FROM_MY_ACTIONS.has(e.type)) continue;
      const k = e.batchId ? `b:${e.batchId}` : `e:${e.id}`;
      const g = groups.get(k) ?? [];
      g.push(e);
      groups.set(k, g);
    }
    return [...groups.values()]
      .sort((a, b) => b.at(-1)!.seq - a.at(-1)!.seq)
      .slice(0, limit)
      .map((g) => {
        const kept = g.find((e) => NOT_UNDOABLE[e.type]);
        return {
          target: g[0]!.batchId ? { batchId: g[0]!.batchId } : { eventId: g[0]!.id },
          events: g.map((e) => this.publicEvent(e)),
          undone: g.every((e) => this.state.undone.has(e.id)),
          undoable: !kept && (actor.role === 'preparer' || actor.role === 'reviewer' || actor.role === 'partner'),
          whyNot: kept ? NOT_UNDOABLE[kept.type] : undefined,
        };
      });
  }

  // ---------------------------------------------------------------- revisions (D-57)

  /**
   * A node's revision: the seq of the last event that changed its value or its verification
   * (adjustments, read and household corrections, verifications). Notes and questions don't count.
   */
  revision(nodeId: string): number {
    const h = this.state.history.get(nodeId) ?? [];
    let rev = 0;
    for (const e of h) if (REVISING.test(e.type) && e.seq > rev) rev = e.seq;
    return rev;
  }

  /**
   * Refuse a write made against a stale view (D-57). `expected` is the revision the caller saw;
   * undefined means the caller didn't say (API clients, scripts), which is allowed.
   */
  assertFresh(nodeId: string, expected: number | undefined) {
    if (expected === undefined || expected === null) return;
    const now = this.revision(nodeId);
    if (now <= expected) return;
    const changes = (this.state.history.get(nodeId) ?? []).filter((e) => e.seq > expected && REVISING.test(e.type)).map((e) => this.publicEvent(e));
    const last = changes.at(-1)!;
    const who = this.actors.find((a) => a.id === last.actor)?.name ?? last.actor;
    throw new PolicyError(
      `${who} changed this since you opened it (${last.type.replace(/\./g, ' ')}). Review the change and try again.`,
      'conflict',
      undefined,
      { nodeId, revision: now, changes },
    );
  }

  // ---------------------------------------------------------------- read corrections

  /**
   * A line's description with any corrected reads substituted, so a fixed EIN or name shows
   * wherever the line is shown. Only the current version: earlier engine runs stay as computed.
   */
  lineLabel(version: string, l: { label: string; sources: string[] }): string {
    if (version !== this.version) return l.label;
    let label = l.label;
    for (const src of l.sources) {
      const c = this.state.correctionFor(src);
      if (c && typeof c.originalValue !== 'object') label = label.split(String(c.originalValue)).join(String(c.correctedValue));
    }
    return label;
  }

  private correctedValueOut(e: ExtractedValue): unknown {
    const c = this.state.correctionFor(e.id);
    if (!c) return undefined;
    return SENSITIVE_VALUE_TYPES.has(e.value_type) ? maskValue(c.correctedValue) : c.correctedValue;
  }

  /** Corrections on an extracted value, or on the extracted values a line rests on. */
  private correctionsFor(id: string): ReadCorrectionDto[] {
    let evIds: string[] = [];
    if (id.startsWith('ev:')) evIds = [id.slice(3)];
    else {
      const p = parseLineId(id);
      if (p) evIds = (this.b.line(p.version, p.key)?.sources ?? []).filter((s) => /^ev-/.test(s));
    }
    return [...this.state.corrections.values()].filter((c) => evIds.includes(c.evId)).map((c) => this.maskCorrection(c));
  }

  private maskCorrection(c: ReadCorrectionDto): ReadCorrectionDto {
    return SENSITIVE_VALUE_TYPES.has(c.valueType) ? { ...c, originalValue: maskValue(c.originalValue), correctedValue: maskValue(c.correctedValue) } : c;
  }

  /** An event as it may leave the server: corrected SSNs and account numbers stay masked (D-10). */
  publicEvent(e: WorkEvent): WorkEvent {
    if (e.type === 'household.corrected') {
      const p = e.payload as WorkEvent<'household.corrected'>['payload'];
      if (!HOUSEHOLD_SENSITIVE.has(p.field)) return e;
      return { ...e, payload: { ...p, originalValue: maskValue(p.originalValue), correctedValue: maskValue(p.correctedValue) } } as WorkEvent;
    }
    if (e.type !== 'read.corrected') return e;
    const p = e.payload as WorkEvent<'read.corrected'>['payload'];
    if (!SENSITIVE_VALUE_TYPES.has(p.valueType)) return e;
    return { ...e, payload: { ...p, originalValue: maskValue(p.originalValue), correctedValue: maskValue(p.correctedValue) } } as WorkEvent;
  }

  correctRead(actor: Actor, evNodeId: string, rawValue: unknown, reason: string, revision?: number) {
    assertCan(actor, 'verify');
    this.assertFresh(evNodeId.startsWith('ev:') ? evNodeId : `ev:${evNodeId}`, revision);
    if (!reason?.trim()) throw new PolicyError('Say why the read is wrong (e.g. what the page prints)', 'invalid');
    const evId = evNodeId.replace(/^ev:/, '');
    const e = this.b.evs.get(evId);
    if (!e) throw new PolicyError(`No extracted value ${evId}`, 'not_found');
    if (SENSITIVE_VALUE_TYPES.has(e.value_type) && !actor.clearance) {
      throw new PolicyError('Correcting an SSN or account number needs sensitive-data clearance', 'forbidden', RULES.masking);
    }
    const value = coerceRead(e.value_type, rawValue);
    const current = this.state.correctionFor(evId)?.correctedValue ?? e.value;
    if (JSON.stringify(current) === JSON.stringify(value)) throw new PolicyError(`It already reads ${String(value)}`, 'conflict');
    return this.commit(actor, [
      {
        type: 'read.corrected',
        payload: { correctionId: randomUUID(), evId, originalValue: e.value, correctedValue: value, valueType: e.value_type },
        reason,
      },
    ]);
  }

  // ---------------------------------------------------------------- household corrections (D-47)

  /** A household person with any corrections in force applied. */
  effectivePerson(p: PacketPerson): PacketPerson {
    let out = p;
    for (const field of HOUSEHOLD_FIELDS) {
      const c = this.state.householdCorrectionFor(p.id, field);
      if (c) out = { ...out, [field]: c.correctedValue };
    }
    return out;
  }

  person(personId: string): PacketPerson | undefined {
    const p = this.b.packet.household.people.find((x) => x.id === personId);
    return p ? this.effectivePerson(p) : undefined;
  }

  /** A read correction as it may leave the server (masked if sensitive). */
  nodeDetailCorrection(c: ReadCorrectionDto): ReadCorrectionDto {
    return this.maskCorrection(c);
  }

  publicHousehold(c: HouseholdCorrectionDto): HouseholdCorrectionDto {
    return this.maskHousehold(c);
  }

  private maskHousehold(c: HouseholdCorrectionDto): HouseholdCorrectionDto {
    return HOUSEHOLD_SENSITIVE.has(c.field) ? { ...c, originalValue: maskValue(c.originalValue), correctedValue: maskValue(c.correctedValue) } : c;
  }

  /**
   * Correct client-entered household data. The record is the client's, so the correction must
   * cite the client's own confirmation: an answered question to the client about this person,
   * or a message from the client.
   */
  correctHousehold(actor: Actor, personId: string, field: string, rawValue: unknown, evidenceId: string, reason: string, revision?: number) {
    assertCan(actor, 'verify');
    this.assertFresh(`household:${personId}`, revision);
    const raw = this.b.packet.household.people.find((x) => x.id === personId);
    if (!raw) throw new PolicyError(`No household member ${personId}`, 'not_found');
    if (!HOUSEHOLD_FIELDS.includes(field as any)) throw new PolicyError(`Only ${HOUSEHOLD_FIELDS.join(', ')} can be corrected`, 'invalid');
    if (!reason?.trim()) throw new PolicyError('Say what is being corrected and from which source', 'invalid');
    if (HOUSEHOLD_SENSITIVE.has(field) && !actor.clearance) {
      throw new PolicyError('Correcting an SSN needs sensitive-data clearance', 'forbidden', RULES.masking);
    }
    this.assertClientConfirmation(personId, raw.name, evidenceId);
    const value = coerceRead(field === 'ssn' ? 'ssn' : field === 'dob' ? 'date' : 'text', rawValue);
    const current = this.state.householdCorrectionFor(personId, field)?.correctedValue ?? (raw as any)[field];
    if (JSON.stringify(current) === JSON.stringify(value)) throw new PolicyError('The record already has that value', 'conflict');
    return this.commit(actor, [
      {
        type: 'household.corrected',
        payload: { correctionId: randomUUID(), personId, field, originalValue: (raw as any)[field], correctedValue: value, evidenceId },
        reason,
      },
    ]);
  }

  private assertClientConfirmation(personId: string, name: string, evidenceId: string) {
    const need = `Cite the client's confirmation: an answered question to the client about ${name}, or a message from the client`;
    if (evidenceId?.startsWith('question:')) {
      const q = this.state.questions.get(evidenceId.slice(9));
      if (!q || q.to !== 'client') throw new PolicyError(`${need}. ${evidenceId} is not a question to the client.`, 'policy');
      if (q.thread.length < 2) throw new PolicyError(`${need}. The client hasn't answered ${evidenceId} yet.`, 'policy');
      if (!q.nodeIds.includes(`household:${personId}`)) throw new PolicyError(`${need}. That question isn't about ${name}.`, 'policy');
      return;
    }
    if (evidenceId?.startsWith('msg:')) {
      const m = this.b.msgs.get(evidenceId.slice(4));
      const clientNames = this.b.packet.firm.client_users.map((c) => c.name);
      if (!m || !clientNames.includes(m.from)) throw new PolicyError(`${need}. ${evidenceId} is not a message from the client.`, 'policy');
      return;
    }
    throw new PolicyError(need, 'policy');
  }

  revertHouseholdCorrection(actor: Actor, correctionId: string, reason?: string) {
    assertCan(actor, 'verify');
    const c = this.state.householdCorrections.get(correctionId);
    if (!c) throw new PolicyError('No such correction', 'not_found');
    if (c.status !== 'in_force') throw new PolicyError('That correction is no longer in force', 'conflict');
    return this.commit(actor, [{ type: 'household.correction_reverted', payload: { correctionId }, reason }]);
  }

  revertCorrection(actor: Actor, correctionId: string, reason?: string) {
    assertCan(actor, 'verify');
    const c = this.state.corrections.get(correctionId);
    if (!c) throw new PolicyError('No such correction', 'not_found');
    if (c.status !== 'in_force') throw new PolicyError('That correction is no longer in force', 'conflict');
    return this.commit(actor, [{ type: 'read.correction_reverted', payload: { correctionId }, reason }]);
  }

  standards() {
    return (this.state.standards as typeof this.b.packet.firm.starter_standards | null) ?? this.b.packet.firm.starter_standards;
  }

  assertNode(id: string) {
    if (!this.g.nodes.has(id) && !nodeKind(id)) throw new PolicyError(`Unknown node ${id}`, 'not_found');
  }
}

/** Event types that change a node's value or verification, and so move its revision (D-57). */
const REVISING = /^(adjustment\.|read\.|household\.|verification\.)/;

/** Household fields a preparer may correct (with the client's confirmation), and which are sensitive. */
const HOUSEHOLD_FIELDS = ['ssn', 'name', 'dob'] as const;
const HOUSEHOLD_SENSITIVE = new Set<string>(['ssn']);

/** Parse a corrected read into its value type, rejecting values that can't be that type. */
function coerceRead(type: string, v: unknown): unknown {
  const s = String(v ?? '').trim();
  const bad = (what: string) => new PolicyError(`Expected ${what}, got "${s}"`, 'invalid');
  switch (type) {
    case 'money':
    case 'integer':
    case 'quantity':
    case 'percent': {
      const n = Number(s.replace(/[$,]/g, ''));
      if (!s || !Number.isFinite(n)) throw bad('a number');
      if (type === 'integer' && !Number.isInteger(n)) throw bad('a whole number');
      return n;
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('a date as YYYY-MM-DD');
      return s;
    case 'ein':
      if (!/^\d{2}-\d{7}$/.test(s)) throw bad('an EIN as NN-NNNNNNN');
      return s;
    case 'ssn':
      if (!/^\d{3}-\d{2}-\d{4}$/.test(s)) throw bad('an SSN as NNN-NN-NNNN');
      return s;
    case 'boolean':
      if (!/^(true|false)$/i.test(s)) throw bad('true or false');
      return /^true$/i.test(s);
    default:
      if (!s) throw bad('a value');
      return s;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
