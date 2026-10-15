// Canonical node ids for the provenance graph.
//
// Every addressable thing in the workpaper has one id. Ids follow the packet README's
// reference grammar wherever it already defines one, with explicit prefixes so an id is
// self-describing in URLs and event payloads:
//
//   line:v3:F1040.11        a return line in a specific engine version
//   ev:ev-0016              an extracted value
//   doc:D09                 a document;   doc:D09#page1  one page of it
//   py:/carryovers_into_2025/capital_loss_short     prior_years JSON pointer
//   agency:/efile           tax_agency_records JSON pointer
//   asset:v3:SAC-BLDG       an asset row in a version
//   household:theo          a person
//   qa:qa-14 | msg:msg-04 | call:call-01            client answers
//   ref:fx.SEK.2024_average | ref:param.<name>      engine reference values
//   timeline:tl-07          a scripted timeline event
//   version:v3              an engine version
//   diag:v3:CODE            an engine diagnostic
//   att:<uuid>              a user attachment (file, note, message)
//   related:<slug>          a related return filed outside this engagement (Ada's 1040, a K-1 entity)

export type NodeKind =
  | 'line'
  | 'ev'
  | 'doc'
  | 'page'
  | 'py'
  | 'agency'
  | 'asset'
  | 'household'
  | 'qa'
  | 'msg'
  | 'call'
  | 'ref'
  | 'timeline'
  | 'version'
  | 'diag'
  | 'att'
  | 'related';

export const lineId = (version: string, key: string) => `line:${version}:${key}`;
export const evId = (id: string) => `ev:${id}`;
export const docId = (id: string) => `doc:${id}`;
export const pageId = (doc: string, page: number) => `doc:${doc}#page${page}`;
export const assetId = (version: string, id: string) => `asset:${version}:${id}`;
export const versionId = (v: string) => `version:${v}`;
export const diagId = (v: string, code: string) => `diag:${v}:${code}`;
export const attId = (id: string) => `att:${id}`;

export function nodeKind(id: string): NodeKind | null {
  if (id.startsWith('doc:')) return id.includes('#page') ? 'page' : 'doc';
  const prefix = id.slice(0, id.indexOf(':'));
  const kinds: NodeKind[] = ['line', 'ev', 'py', 'agency', 'asset', 'household', 'qa', 'msg', 'call', 'ref', 'timeline', 'version', 'diag', 'att', 'related'];
  return (kinds as string[]).includes(prefix) ? (prefix as NodeKind) : null;
}

export function parseLineId(id: string): { version: string; key: string } | null {
  const m = /^line:([^:]+):(.+)$/.exec(id);
  return m ? { version: m[1]!, key: m[2]! } : null;
}

export function parsePageId(id: string): { doc: string; page: number } | null {
  const m = /^doc:([^#]+)#page(\d+)$/.exec(id);
  return m ? { doc: m[1]!, page: Number(m[2]) } : null;
}

/**
 * Resolve a raw reference as written in the packet (sources, inputs, refs) to a node id.
 * `version` is the engine version the reference appears in; bare line keys and asset ids
 * resolve within it.
 */
export function resolveRef(raw: string, version: string | null): string {
  if (/^ev-\d+$/.test(raw)) return evId(raw);
  if (/^D\d{2}$/.test(raw)) return docId(raw);
  if (/^D\d{2}#page\d+$/.test(raw)) return `doc:${raw}`;
  if (/^(qa|msg|call)-\d+$/.test(raw)) return `${raw.slice(0, raw.indexOf('-'))}:${raw}`;
  if (/^tl-\d+$/.test(raw)) return `timeline:${raw}`;
  if (/^v\d+$/.test(raw)) return versionId(raw);
  if (raw.startsWith('doc:')) return raw;
  if (raw.startsWith('asset:')) return version ? assetId(version, raw.slice(6)) : raw;
  if (/^(py|agency|household|ref|timeline):/.test(raw)) return raw;
  // Anything else in a version context is a line key, e.g. "F6251.11" or "SchC.I".
  if (version && /^[A-Za-z0-9-]+\.[^\s]+$/.test(raw)) return lineId(version, raw);
  return raw;
}
