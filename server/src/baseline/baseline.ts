// Loads the packet exactly as delivered (D-05) and indexes it. Never mutated after load.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  ExtractedValue,
  Packet,
  PacketDocument,
  ReturnLine,
  ReturnVersion,
  Staff,
  TimelineEvent,
} from '@easetax/shared';

export interface Baseline {
  packet: Packet;
  hash: string;
  currentVersion: string;
  versions: ReturnVersion[];
  version(v: string): ReturnVersion | undefined;
  docs: Map<string, PacketDocument>;
  evs: Map<string, ExtractedValue>;
  evsByDoc: Map<string, ExtractedValue[]>;
  /** version -> line key -> line */
  lines: Map<string, Map<string, ReturnLine>>;
  line(version: string, key: string): ReturnLine | undefined;
  staff: Map<string, Staff>;
  qa: Map<string, Packet['client']['questionnaire'][number]>;
  msgs: Map<string, Packet['client']['messages'][number]>;
  calls: Map<string, Packet['client']['call_notes'][number]>;
  timeline: TimelineEvent[];
  /** 2024 filed return lines by key. */
  priorLines: Record<string, number | string>;
  pointer(root: 'py' | 'agency', ptr: string): unknown;
}

/** RFC 6901 JSON Pointer lookup. */
export function jsonPointer(obj: unknown, ptr: string): unknown {
  if (ptr === '' || ptr === '/') return obj;
  const parts = ptr
    .replace(/^\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : cur[p];
  }
  return cur;
}

export function loadBaseline(path: string): Baseline {
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const packet = JSON.parse(bytes.toString('utf-8')) as Packet;
  return indexPacket(packet, hash);
}

export function indexPacket(packet: Packet, hash: string): Baseline {
  const docs = new Map(packet.documents.map((d) => [d.id, d]));
  const evs = new Map(packet.extracted_values.map((e) => [e.id, e]));
  const evsByDoc = new Map<string, ExtractedValue[]>();
  for (const e of packet.extracted_values) {
    const list = evsByDoc.get(e.document_id) ?? [];
    list.push(e);
    evsByDoc.set(e.document_id, list);
  }
  const lines = new Map<string, Map<string, ReturnLine>>();
  for (const v of packet.return_versions) lines.set(v.version, new Map(v.lines.map((l) => [l.key, l])));
  const versions = [...packet.return_versions].sort((a, b) => a.computed_at.localeCompare(b.computed_at));
  const currentVersion = versions[versions.length - 1]!.version;

  return {
    packet,
    hash,
    currentVersion,
    versions,
    version: (v) => versions.find((x) => x.version === v),
    docs,
    evs,
    evsByDoc,
    lines,
    line: (v, k) => lines.get(v)?.get(k),
    staff: new Map(packet.firm.staff.map((s) => [s.id, s])),
    qa: new Map(packet.client.questionnaire.map((q) => [q.id, q])),
    msgs: new Map(packet.client.messages.map((m) => [m.id, m])),
    calls: new Map(packet.client.call_notes.map((c) => [c.id, c])),
    timeline: packet.timeline,
    priorLines: packet.prior_years.return_2024?.lines ?? {},
    pointer: (root, ptr) => jsonPointer(root === 'py' ? packet.prior_years : packet.tax_agency_records, ptr),
  };
}
