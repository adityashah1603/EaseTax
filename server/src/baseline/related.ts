// Related returns filed outside this engagement (household.related_returns): Ada's own 1040,
// the S corporation's 1120-S, the partnership's 1065. Each becomes a traceable node (D-58).

import type { Baseline } from './baseline.ts';

export interface RelatedReturn {
  id: string; // related:<slug>
  who: string;
  form: string;
  preparedBy: string;
  inPacket: string | boolean;
  /** Documents of this return that are in the packet (e.g. its K-1s). */
  docIds: string[];
  /** The household member who files it, if any (Ada). */
  personId?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function relatedReturns(b: Baseline): RelatedReturn[] {
  return (b.packet.household.related_returns ?? []).map((r) => {
    const person = b.packet.household.people.find((p) => p.name === r.who);
    return {
      id: `related:${person ? `${person.id}-1040` : slug(r.who)}`,
      who: r.who,
      form: r.return,
      preparedBy: r.prepared_by,
      inPacket: r.in_this_packet,
      docIds: typeof r.in_this_packet === 'string' ? [...r.in_this_packet.matchAll(/D\d{2}/g)].map((m) => m[0]) : [],
      personId: person?.id,
    };
  });
}
