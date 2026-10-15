// Types for the packet exactly as delivered (okafor_lindqvist_2025_packet.json).
// Field meanings follow packet.readme.sections.

export type Jurisdiction = 'federal' | 'california';
export type LineValue = number | string | null;

export interface PacketPerson {
  id: string;
  role: 'taxpayer' | 'spouse' | 'dependent';
  name: string;
  ssn: string;
  dob: string;
  occupation?: string;
  relationship?: string;
  months_lived_with_you?: number;
  full_time_student?: boolean;
  ip_pin?: string | null;
  phone?: string;
  email?: string;
  note?: string;
  own_income?: string;
}

export interface Household {
  filing_status: string;
  tax_year: number;
  entered_by: string;
  people: PacketPerson[];
  addresses: { from: string; to: string | null; address: string; type: string }[];
  residency: { state: string; from: string; to: string; status: string }[];
  bank_account_for_refund_or_payment: { routing: string; account: string; type: string; bank: string };
  prior_year_agi_for_esignature: number;
  related_returns: { who: string; return: string; prepared_by: string; in_this_packet: string | boolean }[];
}

export interface DocPage {
  page: number;
  printed_content: string;
}

export interface PacketDocument {
  id: string;
  title: string;
  document_type: string;
  issuer: string;
  belongs_to: string;
  tax_year: number;
  received_at: string;
  uploaded_by: 'client' | 'firm';
  file_name: string;
  page_count: number;
  pages: DocPage[];
  marked_corrected?: boolean;
  extraction: { status: 'extracted' | 'partial' | 'not_extracted'; values: number; reason: string | null };
}

export interface Anchor {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExtractedValue {
  id: string;
  document_id: string;
  page: number;
  field: string;
  label: string;
  value: number | string | boolean | null;
  value_type: string;
  text_as_read: string;
  position: Anchor;
  confidence: number;
}

export interface ReturnLine {
  key: string;
  jurisdiction: Jurisdiction;
  form: string;
  line: string;
  label: string;
  value: LineValue;
  rule: string;
  inputs: string[];
  sources: string[];
  note?: string;
}

export interface FedSummary {
  agi: number;
  taxable_income: number;
  total_tax: number;
  payments: number;
  balance_due: number;
  penalty: number;
}
export interface CaSummary {
  total_agi: number;
  ca_agi: number;
  total_tax: number;
  payments: number;
  balance_due: number;
  penalty: number;
}

export interface TaxEffectRate {
  federal_per_dollar: number;
  california_per_dollar: number;
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning';
  message: string;
  refs: string[];
}

export interface AssetRow {
  asset_id: string;
  description: string;
  activity: string;
  cost: number;
  land_value_not_depreciated?: number;
  placed_in_service: string;
  method: string;
  life_years: number;
  federal: Record<string, number>;
  california: Record<string, number>;
  amt: Record<string, number>;
  disposed: unknown;
  sources: string[];
  [k: string]: unknown;
}

export interface ReturnVersion {
  version: string;
  computed_at: string;
  trigger: string;
  documents_used: string[];
  documents_superseded: unknown[];
  summary: { federal: FedSummary; california: CaSummary };
  tax_effect_rates: Record<string, TaxEffectRate>;
  carryovers_out: unknown;
  assets: AssetRow[];
  diagnostics: Diagnostic[];
  changes_from_previous: { key: string; change: 'added' | 'changed' | 'removed'; old?: LineValue; new?: LineValue }[];
  lines: ReturnLine[];
}

export interface Staff {
  id: string;
  name: string;
  role: 'preparer' | 'reviewer' | 'partner' | 'firm_administrator' | 'quality_reviewer';
  credential: string | null;
  sensitive_data_clearance: boolean;
  active_from: string;
  note?: string;
}

export interface FirmStandards {
  note?: string;
  verification_types: string[];
  variance_review: { compare_to: string; flag_if_change_over_percent: number; and_over_amount: number };
  review_levels: string[];
  rules: string[];
  required_steps: string[];
}

export interface Firm {
  name: string;
  staff: Staff[];
  firm_identity: Record<string, unknown>;
  client_users: { id: string; name: string; role: 'client' }[];
  assignment_at_start: Record<string, string>;
  deadlines: { what: string; date: string }[];
  budget_hours: Record<string, number>;
  starter_standards: FirmStandards;
}

export interface TimelineEvent {
  id: string;
  at: string;
  event: string;
  actor: string | null;
  detail: string | null;
  refs: string[] | null;
}

export interface Packet {
  packet: { name: string; version: string; generated: string; client_id: string };
  readme: Record<string, unknown>;
  household: Household;
  documents: PacketDocument[];
  extracted_values: ExtractedValue[];
  client: {
    questionnaire: { id: string; question: string; answer: string; answered_by: string; answered_at: string }[];
    messages: { id: string; sent_at: string; from: string; to: string; text: string }[];
    call_notes: { id: string; date: string; participants: string[]; notes: string[] }[];
  };
  firm: Firm;
  prior_years: Record<string, any>;
  tax_agency_records: Record<string, any>;
  timeline: TimelineEvent[];
  engine_reference: { parameters: Record<string, any>; rules: Record<string, string> };
  return_versions: ReturnVersion[];
  what_if: { alternatives: any[]; extension: any };
  planning_reference_2026: Record<string, any>;
  post_filing_rates: Record<string, any>;
  fx_rates: Record<string, any>;
}
