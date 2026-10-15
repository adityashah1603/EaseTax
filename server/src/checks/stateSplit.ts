// State split: California-source wages for a part-year resident.
//
// A part-year resident's wages are California-source only for the resident period (and for
// work physically performed in California afterwards). Employers often keep the old work
// state in payroll, so W-2 box 16 is not the answer on its own. For each W-2 the check uses,
// in order: an employment end date before the move (whole box 16 is California), or a
// paystub from the same employer giving year-to-date California wages through the move.

import { registerCheck, type CheckIssue } from './registry.ts';
import { E, L, P, evsOfDoc, fmt, isoFromUs, issue, lineNum, lines, nameWords, num, personOfDoc, suggest } from './util.ts';

registerCheck({
  id: 'state.ca_wages',
  title: 'California-source wages follow the residency dates',
  family: 'state_split',
  run(ctx) {
    const out: CheckIssue[] = [];
    const res = ctx.b.packet.household.residency.find((r) => r.state === 'CA' && r.status === 'resident');
    if (!res) return out;
    const resEnd = res.to;
    for (const l of lines(ctx).filter((x) => x.rule === 'R-CA-WAGES-SOURCE')) {
      const cur = lineNum(ctx, l.key);
      if (cur === undefined) continue;
      const box16 = l.sources.map((s) => ctx.b.evs.get(s)).filter((e) => e && e.field === 'box16');
      let expected = 0;
      let unknown = false;
      const parts: string[] = [];
      const nodes: string[] = [];
      for (const b of box16) {
        const d = ctx.b.docs.get(b!.document_id)!;
        const text = d.pages.map((p) => p.printed_content).join(' ');
        const amount = num(b!.value) ?? 0;
        nodes.push(E(b!.id), `doc:${d.id}`);
        const ended = /Employment ended (\d{2}\/\d{2}\/\d{4})/i.exec(text);
        const endIso = ended && isoFromUs(ended[1]!);
        if (endIso && endIso <= resEnd) {
          expected += amount;
          parts.push(`${d.issuer} box 16 ${fmt(amount)} (employment ended ${endIso}, before the move)`);
          continue;
        }
        const issuerWord = nameWords(d.issuer)[0]!;
        const stub = ctx.b.packet.documents.find((x) => x.document_type === 'paystub' && nameWords(x.issuer)[0] === issuerWord);
        const ytd = stub && evsOfDoc(ctx, stub.id).find((e) => /california taxable wages through/i.test(e.label));
        const through = ytd && /through (\d{2}\/\d{2}\/\d{4})/i.exec(ytd.label);
        if (!stub || !ytd || !through) {
          unknown = true;
          parts.push(`${d.issuer} box 16 ${fmt(amount)}: no evidence of the California share`);
          continue;
        }
        const ca = num(ytd.value) ?? 0;
        expected += ca;
        const note = /\(([^)]*California[^)]*)\)/i.exec(text);
        parts.push(
          `${d.issuer} box 16 ${fmt(amount)} reports California for the whole year${note ? ` ("${note[1]}")` : ''}; ` +
            `paystub ${stub.id} shows California wages ${fmt(ca)} through ${isoFromUs(through[1]!)}`,
        );
        nodes.push(E(ytd.id), P(stub.id, ytd.page), `doc:${stub.id}`);
        const person = personOfDoc(ctx, d);
        if (person) nodes.push(`household:${person}`);
      }
      if (!box16.length || Math.abs(expected - cur) <= 1) continue;
      const qa = ctx.b.packet.client.questionnaire.filter((q) => /California/.test(q.answer) && /employer/i.test(q.answer) && /withh/i.test(q.answer));
      out.push(
        issue('state.ca_wages', l.key, {
          code: 'CA_WAGES_AFTER_MOVE',
          severity: unknown ? 'warning' : 'error',
          title: `${l.form} ${l.line}: California wages ${fmt(cur)} include pay earned after the move on ${resEnd}`,
          detail:
            `California residency ended ${resEnd}. ${parts.join('. ')}. ` +
            (unknown ? 'At least one employer\'s split is unknown; obtain a paystub or employer statement. ' : `California-source wages ≈ ${fmt(expected)}. `) +
            (qa.length ? `Client: ${qa.map((q) => `${q.id} "${q.answer}"`).join('; ')} ` : '') +
            'Withholding to California after the move is refundable, not evidence of California-source wages. (§8 E22)',
          nodeIds: [L(ctx, l.key), ...nodes, ...qa.map((q) => `qa:${q.id}`)],
          ...(unknown ? {} : suggest(ctx, l.key, expected, `California wages through ${resEnd} per W-2 and paystub`)),
        }),
      );
    }
    return out;
  },
});
