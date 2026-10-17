// Notice response (design §7.11): for each item under examination, the subgraph closure of the
// lines it names, read from the frozen filing snapshot: filed values, the full trace to source
// documents, evidence, verifications, adjustments, judgments and sign-offs. The bundle is itself
// frozen (snapshot kind 'notice_case') and exports as self-contained JSON or HTML.

import { randomUUID } from 'node:crypto';
import type { Actor, FrozenLine } from '@easetax/shared';
import { parseLineId, parsePageId } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, maskDeep, maskFreeDeep, maskText, maskValue, PolicyError, SENSITIVE_VALUE_TYPES } from '../policy/policy.ts';
import { filedSnapshotId, filingState } from './state.ts';
import { loadSnapshot, putFrozen, type FilingSnapshotContent } from './snapshot.ts';

/** How an examination item's wording maps to return lines and related third-party documents. */
const ITEM_RULES: { re: RegExp; keys: (m: RegExpExecArray) => string[]; relatedDocTypes: string[] }[] = [
  { re: /Schedule A line (\d+[a-z]?)/i, keys: (m) => [`SchA.${m[1]}`], relatedDocTypes: ['donation_receipt', '1098-C'] },
  { re: /Schedule C gross receipts/i, keys: () => ['SchC.1'], relatedDocTypes: ['1099-NEC', '1099-K', 'books_profit_loss', 'books_transaction_detail'] },
  { re: /Schedule C line (\d+[a-z]?)/i, keys: (m) => [`SchC.${m[1]}`], relatedDocTypes: ['books_profit_loss', 'books_transaction_detail'] },
  { re: /Schedule (B|D|E) line (\d+[a-z]?)/i, keys: (m) => [`Sch${m[1]!.toUpperCase()}.${m[2]}`], relatedDocTypes: [] },
  { re: /Form 1040 line (\d+[a-z]?)/i, keys: (m) => [`F1040.${m[1]}`], relatedDocTypes: [] },
];

interface TraceOut {
  id: string;
  kind: string;
  label: string;
  edge?: string;
  value?: unknown;
  engineValue?: unknown;
  adjusted?: boolean;
  confidence?: number;
  children: TraceOut[];
  repeated?: boolean;
}

export function buildNoticeCase(wp: Workpaper, actor: Actor, noticeId: string, body: { snapshotId?: string } = {}) {
  assertCan(actor, 'verify'); // any staff member working the file may assemble the response
  const notice = ((wp.b.packet.tax_agency_records.notices ?? []) as any[]).find((n) => n.id === noticeId);
  if (!notice) throw new PolicyError(`No notice ${noticeId}`, 'not_found');
  const items: string[] = notice.items_under_examination ?? (notice.summary ? [notice.summary] : []);
  const snapshotId = body.snapshotId ?? filedSnapshotId(wp);
  if (!snapshotId) throw new PolicyError('The return has not been filed: there is no frozen snapshot to answer from', 'conflict');
  const snap = loadSnapshot<FilingSnapshotContent>(wp, snapshotId);
  const s = snap.content;
  const frozen = new Map<string, FrozenLine>(s.lines.map((l) => [l.key, l]));
  const g = wp.g;

  const summarize = (id: string): Omit<TraceOut, 'children'> => {
    const pl = parseLineId(id);
    if (pl) {
      const f = frozen.get(pl.key);
      return { id, kind: 'line', label: f ? `${f.form} ${f.line} · ${f.label}` : id, value: f?.value, engineValue: f?.engineValue, adjusted: f?.adjusted };
    }
    if (id.startsWith('ev:')) {
      const e = wp.b.evs.get(id.slice(3));
      if (!e) return { id, kind: 'ev', label: id };
      const d = wp.b.docs.get(e.document_id);
      return { id, kind: 'ev', label: `${e.label} (${e.document_id} p${e.page}, ${d?.title ?? ''})`, value: SENSITIVE_VALUE_TYPES.has(e.value_type) ? maskValue(e.value) : e.value, confidence: e.confidence };
    }
    const pg = parsePageId(id);
    if (pg) return { id, kind: 'page', label: `${pg.doc} page ${pg.page}` };
    if (id.startsWith('doc:')) {
      const d = wp.b.docs.get(id.slice(4));
      return { id, kind: 'doc', label: d ? `${d.id} ${d.title} (${d.issuer})` : id };
    }
    const sum = wp.summarize(id);
    return { id, kind: sum.kind, label: sum.label + (sum.sublabel ? ` (${sum.sublabel})` : ''), value: maskDeep(sum.value) };
  };

  const traceOf = (root: string): { tree: TraceOut; nodes: Set<string> } => {
    const nodes = new Set<string>();
    const walk = (id: string, edge?: string): TraceOut => {
      const base = { ...summarize(id), edge };
      if (nodes.has(id)) return { ...base, children: [], repeated: true };
      nodes.add(id);
      const kids = g.children(id).filter((e) => e.type !== 'refers_to' && e.type !== 'related' && (!e.to.startsWith('line:') || e.to.startsWith(`line:${s.version}:`)));
      return { ...base, children: kids.map((e) => walk(e.to, e.type)) };
    };
    return { tree: walk(root), nodes };
  };

  const pick = <T extends Record<string, any>>(xs: unknown[], hit: (x: T) => boolean) => (xs as T[]).filter(hit);
  const out = items.map((text, idx) => {
    const rule = ITEM_RULES.find((r) => r.re.test(text));
    const m = rule ? rule.re.exec(text)! : null;
    const keys = rule && m ? rule.keys(m).filter((k) => frozen.has(k)) : [];
    const traces = keys.map((k) => traceOf(`line:${s.version}:${k}`));
    const nodes = new Set<string>(traces.flatMap((t) => [...t.nodes]));
    const docIds = new Set<string>([...nodes].filter((n) => n.startsWith('doc:') && !n.includes('#')).map((n) => n.slice(4)));
    const related = wp.b.packet.documents.filter((d) => rule?.relatedDocTypes.includes(d.document_type));
    for (const d of related) {
      docIds.add(d.id);
      nodes.add(`doc:${d.id}`);
      for (const e of wp.b.evsByDoc.get(d.id) ?? []) nodes.add(`ev:${e.id}`);
    }
    const documents = [...docIds].sort().map((id) => {
      const d = wp.b.docs.get(id)!;
      return {
        id,
        title: d.title,
        issuer: d.issuer,
        documentType: d.document_type,
        taxYear: d.tax_year,
        receivedAt: d.received_at,
        inTrace: traces.some((t) => t.nodes.has(`doc:${id}`)),
        values: (wp.b.evsByDoc.get(id) ?? []).map((e) => ({ id: e.id, field: e.field, label: e.label, value: SENSITIVE_VALUE_TYPES.has(e.value_type) ? maskValue(e.value) : e.value, page: e.page, confidence: e.confidence })),
        pages: d.pages.map((p) => ({ page: p.page, printedContent: maskText(p.printed_content) })),
      };
    });
    // Third-party reconciliation for receipts items: information returns vs the filed line.
    let reconciliation: unknown;
    if (keys.includes('SchC.1')) {
      const sumBox = (type: string, field: string) => wp.b.packet.documents.filter((d) => d.document_type === type).reduce((t, d) => t + Number((wp.b.evsByDoc.get(d.id) ?? []).find((e) => e.field === field)?.value ?? 0), 0);
      const nec = sumBox('1099-NEC', 'box1');
      const k = sumBox('1099-K', 'box1a');
      const books = Number((wp.b.packet.documents.filter((d) => d.document_type === 'books_profit_loss').flatMap((d) => wp.b.evsByDoc.get(d.id) ?? []).find((e) => e.field === 'total_income')?.value) ?? 0);
      const filed = Number(frozen.get('SchC.1')?.value ?? 0);
      reconciliation = { forms1099NEC: nec, form1099K: k, booksGrossReceipts: books, filedGrossReceipts: filed, receiptsNotOn1099: books - nec, filedMinusBooks: filed - books };
    }
    const inScope = (ids: string[]) => ids.some((id) => nodes.has(id));
    return {
      item: idx + 1,
      text,
      lines: keys.map((k) => frozen.get(k)),
      traces: traces.map((t) => t.tree),
      documents,
      reconciliation,
      workpaper: {
        verifications: pick(s.state.verifications, (v) => nodes.has(v.nodeId)),
        adjustments: pick(s.state.adjustments, (a) => nodes.has(a.nodeId)),
        judgments: pick(s.state.judgments, (j) => inScope(j.nodeIds ?? [])),
        notes: maskFreeDeep(pick(s.state.notes, (n) => inScope(n.nodeIds ?? []))),
        questions: maskFreeDeep(pick(s.state.questions, (q) => inScope(q.nodeIds ?? []))),
        evidence: pick(s.state.evidence, (e) => nodes.has(e.nodeId)),
        issues: pick(s.state.issues, (i) => inScope(i.nodeIds ?? [])),
        varianceExplanations: pick(s.state.varianceExplanations, (v) => nodes.has(v.nodeId)),
      },
    };
  });

  const areas = new Set(out.flatMap((o) => o.lines.filter(Boolean).map((l) => l!.form)));
  const signoffs = pick<any>(s.state.signoffs, (so) => so.scope === 'return' || so.scope.startsWith('area:'));
  const st = filingState(wp);
  const caseId = `case-${noticeId}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schema: 'easetax.notice-case/1',
    caseId,
    notice: { id: notice.id, agency: notice.agency, type: notice.type, taxYear: notice.tax_year, dated: notice.dated, responseDue: notice.response_due, document: notice.document, itemsUnderExamination: items },
    client: { id: s.clientId, name: wp.b.packet.packet.name, taxYear: s.taxYear },
    preparer: { firm: wp.b.packet.firm.name },
    filedReturn: {
      snapshotId,
      contentHash: snap.contentHash,
      seq: s.seq,
      engineVersion: s.version,
      packetHash: s.packetHash,
      submissions: st.submissions.filter((x) => x.snapshotId === snapshotId).map((x) => ({ id: x.id, jurisdiction: x.jurisdiction, status: x.status, agencySubmissionId: x.agencySubmissionId })),
      summary: s.summary,
    },
    items: out,
    signoffs,
    formsInScope: [...areas],
    assembledBy: actor.id,
  };
  const frozenCase = putFrozen(wp, 'notice_case', bundle, caseId);
  const events = wp.commit(actor, [{ type: 'filing.step', payload: { step: 'notice_case', data: { caseId, noticeId, snapshotId, contentHash: frozenCase.contentHash } } }]);
  return { events, data: { caseId, contentHash: frozenCase.contentHash, bundle } };
}

export function exportNoticeCase(wp: Workpaper, caseId: string, format: 'json' | 'html') {
  const { content, contentHash } = loadSnapshot<any>(wp, caseId);
  if (format === 'json') return { contentType: 'application/json', body: JSON.stringify({ contentHash, ...content }, null, 2) };
  return { contentType: 'text/html; charset=utf-8', body: renderHtml(content, contentHash) };
}

// ---------------------------------------------------------------- HTML (self-contained)

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const fmtV = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : esc(v));

function traceHtml(t: TraceOut): string {
  const val = t.value !== undefined ? ` <b>${fmtV(t.value)}</b>${t.adjusted ? ` <span class="adj">(engine ${fmtV(t.engineValue)})</span>` : ''}` : '';
  const conf = t.confidence !== undefined && t.confidence < 0.9 ? ` <span class="warn">confidence ${t.confidence}</span>` : '';
  const kids = t.children.length ? `<ul>${t.children.map(traceHtml).join('')}</ul>` : '';
  return `<li><span class="k">${esc(t.kind)}</span> ${esc(t.label)}${val}${conf}${t.repeated ? ' <i>(see above)</i>' : ''}${kids}</li>`;
}

function table(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return '<p class="muted">None recorded.</p>';
  return `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${typeof r[c] === 'object' ? esc(JSON.stringify(r[c])) : fmtV(r[c])}</td>`).join('')}</tr>`).join('')}</table>`;
}

function renderHtml(b: any, hash: string): string {
  const items = (b.items as any[])
    .map(
      (it) => `
<section>
<h2>Item ${it.item}</h2>
<p class="q">${esc(it.text)}</p>
<h3>Lines as filed</h3>
${table(it.lines.filter(Boolean).map((l: FrozenLine) => ({ line: `${l.form} ${l.line}`, label: l.label, filed: l.value, engine: l.engineValue, adjusted: l.adjusted ? 'yes' : '' })), ['line', 'label', 'filed', 'engine', 'adjusted'])}
${it.reconciliation ? `<h3>Reconciliation to information returns</h3>${table([it.reconciliation], Object.keys(it.reconciliation))}` : ''}
<h3>Trace to sources</h3>
<ul class="trace">${it.traces.map(traceHtml).join('')}</ul>
<h3>Verifications</h3>${table(it.workpaper.verifications, ['nodeId', 'type', 'by', 'at', 'note'])}
<h3>Adjustments</h3>${table(it.workpaper.adjustments, ['nodeId', 'originalValue', 'newValue', 'status', 'reason', 'authority', 'by', 'decidedBy'])}
<h3>Judgments</h3>${table(it.workpaper.judgments, ['kind', 'topic', 'decision', 'authority', 'by', 'at'])}
<h3>Evidence</h3>${table(it.workpaper.evidence, ['nodeId', 'evidenceId', 'note', 'by', 'at'])}
<h3>Review notes and questions</h3>${table([...it.workpaper.notes, ...it.workpaper.questions].map((n: any) => ({ status: n.status, thread: n.thread.map((t: any) => `${t.by}: ${t.text}`).join(' / ') })), ['status', 'thread'])}
<h3>Documents</h3>
${it.documents
  .map(
    (d: any) => `<details><summary>${esc(d.id)} ${esc(d.title)} (${esc(d.issuer)}, ${esc(d.taxYear)})${d.inTrace ? '' : ' <span class="muted">related</span>'}</summary>
${table(d.values, ['field', 'label', 'value', 'page', 'confidence'])}
${d.pages.map((p: any) => `<pre>Page ${p.page}: ${esc(p.printedContent)}</pre>`).join('')}</details>`,
  )
  .join('')}
</section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(b.notice.type)} response bundle</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1b1b1b;background:#fff}h1{font-size:22px}h2{border-top:2px solid #333;padding-top:12px}h3{font-size:15px;margin-top:18px}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top;font-size:13px}th{background:#f2f2f2}.trace ul{border-left:1px dotted #999;margin-left:6px;padding-left:14px}.k{font:11px monospace;background:#eef;padding:0 4px;border-radius:3px}.adj{color:#a35a00}.warn{color:#b00}.muted{color:#777}.q{font-style:italic}pre{white-space:pre-wrap;background:#fafafa;border:1px solid #eee;padding:6px;font-size:12px}</style></head><body>
<h1>${esc(b.notice.agency)} ${esc(b.notice.type)} — tax year ${esc(b.notice.taxYear)}</h1>
<p>${esc(b.client.name)} (${esc(b.client.id)}) · prepared by ${esc(b.preparer.firm)} · notice dated ${esc(b.notice.dated)}, response due ${esc(b.notice.responseDue)}</p>
<p>Answered from the return as filed: snapshot <code>${esc(b.filedReturn.snapshotId)}</code>, content hash <code>${esc(b.filedReturn.contentHash)}</code> (event ${esc(b.filedReturn.seq)}, engine ${esc(b.filedReturn.engineVersion)}). Bundle hash <code>${esc(hash)}</code>.</p>
${table(b.filedReturn.submissions, ['id', 'jurisdiction', 'status', 'agencySubmissionId'])}
<h2>Items under examination</h2><ol>${b.notice.itemsUnderExamination.map((t: string) => `<li>${esc(t)}</li>`).join('')}</ol>
${items}
<section><h2>Sign-offs at filing</h2>${table(b.signoffs, ['scope', 'level', 'by', 'at', 'status'])}</section>
</body></html>`;
}
