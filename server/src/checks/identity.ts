// Identity: names and SSNs in the household record against every document that prints them.
//
// The household record is what the client typed into the organizer; documents (SS cards,
// W-2s, 1099s, 1098-Ts) and the filed prior-year return are independent evidence. A
// mismatch on a dependent is exactly what the IRS e-file database rejects (name control /
// TIN mismatch), so this check runs before filing rather than after the rejection.
//
// Issue text is never given full SSNs: issues are not masked by the API serializer, so
// we mask here with the same rule the policy uses.

import { maskText } from '../policy/policy.ts';
import { registerCheck, type CheckIssue } from './registry.ts';
import { E, L, SSN_RE, editDistance, issue, linesCiting, personOfDoc, uniq } from './util.ts';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const last4 = (ssn: string) => ssn.slice(-4);

registerCheck({
  id: 'id.ssn',
  title: 'SSN in the household record matches the documents',
  family: 'identity',
  run(ctx) {
    const out: CheckIssue[] = [];
    const pkt = ctx.b.packet;
    for (const p of pkt.household.people) {
      const seen: { ssn: string; nodes: string[]; where: string }[] = [];
      // Extracted SSNs on the person's own documents.
      for (const e of pkt.extracted_values) {
        if (e.value_type !== 'ssn' || typeof e.value !== 'string') continue;
        const d = ctx.b.docs.get(e.document_id)!;
        if (personOfDoc(ctx, d) !== p.id) continue;
        seen.push({ ssn: e.value, nodes: [E(e.id), `doc:${d.id}`], where: `${d.id} (${d.title}, ${e.id})` });
      }
      // SSNs printed next to the person's name on any document.
      const nameRe = new RegExp(`${escapeRe(p.name)}[^.;]{0,60}?(${SSN_RE.source})`, 'g');
      for (const d of pkt.documents) {
        for (const pg of d.pages) {
          for (const m of pg.printed_content.matchAll(nameRe)) {
            if (!seen.some((s) => s.ssn === m[1] && s.nodes.includes(`doc:${d.id}`))) {
              seen.push({ ssn: m[1]!, nodes: [`doc:${d.id}#page${pg.page}`, `doc:${d.id}`], where: `${d.id} (${d.title})` });
            }
          }
        }
      }
      // The filed prior-year return.
      const pyDeps: any[] = pkt.prior_years.return_2024?.dependents ?? [];
      pyDeps.forEach((dep, i) => {
        if (dep.name === p.name && dep.ssn) seen.push({ ssn: dep.ssn, nodes: [`py:/return_2024/dependents/${i}`], where: '2024 return as filed' });
      });

      const conflicts = seen.filter((s) => s.ssn !== p.ssn);
      if (!conflicts.length) continue;
      const agreeing = seen.filter((s) => s.ssn === p.ssn);
      const other = conflicts[0]!.ssn;
      const transposed = editDistance(p.ssn, other) === 1;
      const efile: string[] = [];
      const rejections: string[] = [];
      ((pkt.tax_agency_records.efile as any[]) ?? []).forEach((s, i) => {
        for (const err of s.errors ?? []) {
          if (String(err.message).includes(p.name)) {
            efile.push(`agency:/efile/${i}`);
            rejections.push(`${s.jurisdiction} ${s.status} ${s.date.slice(0, 10)}: ${err.code}`);
          }
        }
      });
      const first = p.name.split(' ')[0]!;
      const msgs = pkt.client.messages.filter((m) => m.text.includes(first) && /social security|ssn/i.test(m.text));
      const lineKeys = linesCiting(ctx, `household:${p.id}`);
      const text = (s: string) => maskText(s);
      out.push(
        issue('id.ssn', p.id, {
          code: p.role === 'dependent' ? 'DEPENDENT_SSN_MISMATCH' : 'SSN_MISMATCH',
          severity: 'error',
          title: text(`${p.name}: SSN in the household record ends ${last4(p.ssn)}; ${conflicts.length} source(s) show ${last4(other)}`),
          detail: text(
            `Household record (client organizer) has ${p.ssn}. ` +
              `${uniq(conflicts.map((c) => c.where)).join('; ')} show ${other}` +
              (transposed ? ' (two digits transposed)' : '') +
              '. ' +
              (agreeing.length ? `Agreeing: ${uniq(agreeing.map((c) => c.where)).join('; ')}. ` : 'No document agrees with the household record. ') +
              (rejections.length ? `E-file: ${rejections.join('; ')}. ` : 'A dependent TIN/name mismatch is rejected by e-file (R0000-504-02). ') +
              (msgs.length ? `Client message ${msgs.map((m) => m.id).join(', ')} acknowledges a typo. ` : '') +
              'Correct the household record from the Social Security card before filing. (§8 E1)',
          ),
          nodeIds: [
            `household:${p.id}`,
            ...conflicts.flatMap((c) => c.nodes),
            ...efile,
            ...msgs.map((m) => `msg:${m.id}`),
            ...lineKeys.map((k) => L(ctx, k)),
          ],
        }),
      );
    }
    return out;
  },
});
