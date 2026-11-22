import type { ConversionTarget } from '../../types/engine';
import type { FormatId } from '../../types/formats';
import { DESCRIPTORS, FORMAT_ORDER } from '../catalog';

/** Conversions that don't go through the neutral data model. UI-safe (no parser imports). */
export const SPECIAL_TARGETS: Partial<Record<FormatId, FormatId[]>> = {
  markdown: ['html'],
  protobuf: ['json'],
};

const TARGET_NOTES: Partial<Record<FormatId, string[]>> = {
  csv: ['Nested objects/arrays are flattened into dotted column names', 'All values become text'],
  tsv: ['Nested objects/arrays are flattened into dotted column names', 'All values become text'],
  xml: ['Attributes use the "@_" prefix, text content uses "#text"', 'null becomes an empty element; types become text'],
  toml: ['TOML has no null: null values are dropped', 'The root must be an object'],
  ini: ['Deeper nesting is written as dotted section names', 'Values become text'],
  env: ['Keys are flattened to UPPER_SNAKE_CASE', 'All values become strings'],
  properties: ['Keys are flattened with dots (lists use [index])', 'All values become strings'],
  bson: ['The root must be an object (an array becomes a sequence of documents)'],
  msgpack: [],
  json: [],
  jsonc: [],
  json5: [],
  yaml: [],
  html: ['Rendered with marked (GitHub Flavored Markdown)'],
};

/** Which conversions are offered for a source format, with honest loss notes. */
export function conversionTargets(from: FormatId): ConversionTarget[] {
  const src = DESCRIPTORS[from];
  const out: ConversionTarget[] = [];
  for (const id of SPECIAL_TARGETS[from] ?? []) {
    out.push({ formatId: id, notes: from === 'protobuf' ? ['Produces the protobufjs JSON descriptor of the schema'] : TARGET_NOTES[id] ?? [], lossy: false });
  }
  if (!src.capabilities.toData) return out;
  for (const id of FORMAT_ORDER) {
    if (id === from || out.some((t) => t.formatId === id)) continue;
    const d = DESCRIPTORS[id];
    if (!d.capabilities.fromData) continue;
    const notes = [...(TARGET_NOTES[id] ?? [])];
    if (src.comments && !(id === 'yaml' && from === 'yaml')) notes.unshift('Comments are not carried over');
    if ((from === 'csv' || from === 'tsv' || from === 'ini' || from === 'env' || from === 'properties' || from === 'xml') && !d.binary) {
      notes.push('Types are inferred conservatively from text');
    }
    if (from === 'yaml') notes.push('Anchors/aliases are expanded');
    if (from === 'toml' && !['yaml', 'toml'].includes(id)) notes.push('Dates become ISO 8601 strings');
    const lossy = notes.length > 0;
    out.push({ formatId: id, notes, lossy });
  }
  return out;
}
