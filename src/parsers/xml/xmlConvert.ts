import { DataDate, type DataObject, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import { inferScalar, pathToString, type PathSegment } from '../../engines/converters/dataModel';
import { toBase64 } from '../../utils/bytes';
import { notice } from '../../utils/diag';
import { decodeXmlText, isValidXmlName, normalizeAttrValue, type XmlDocument, type XmlElement } from './xmlParser';

const SRC = 'XML converter';

export interface XmlToDataOptions {
  attributePrefix: string;
  inferTypes: boolean;
}

/** XML → data, using the "@_attr" / "#text" convention. */
export function xmlToData(doc: XmlDocument, opts: XmlToDataOptions): { data: DataValue; warnings: Diagnostic[] } {
  const warnings: Diagnostic[] = [];
  const counters = { comments: 0, pis: 0, mixed: 0, interleaved: 0, cdata: 0, unresolved: 0 };
  const scalar = (s: string): DataValue => (opts.inferTypes ? inferScalar(s) : s);

  const elementValue = (el: XmlElement): DataValue => {
    const obj: DataObject = new Map();
    for (const a of el.attrs) {
      const d = decodeXmlText(normalizeAttrValue(a.value), doc.entities);
      counters.unresolved += d.unresolved;
      obj.set(opts.attributePrefix + a.name, scalar(d.text));
    }
    const texts: string[] = [];
    const childEls: XmlElement[] = [];
    for (const c of el.children) {
      if (c.type === 'element') childEls.push(c);
      else if (c.type === 'text') {
        const d = decodeXmlText(c.raw, doc.entities);
        counters.unresolved += d.unresolved;
        texts.push(d.text);
      } else if (c.type === 'cdata') {
        counters.cdata++;
        texts.push(c.raw);
      } else if (c.type === 'comment') counters.comments++;
      else if (c.type === 'pi') counters.pis++;
    }
    let text = texts.join('');
    if (childEls.length > 0) {
      const significant = texts.map((t) => t.trim()).filter(Boolean);
      if (significant.length) counters.mixed++;
      text = significant.join(' ');
    }
    // group children by name, preserving first-appearance order
    const groups = new Map<string, XmlElement[]>();
    let lastName: string | null = null;
    const seen = new Set<string>();
    for (const c of childEls) {
      if (c.name !== lastName && seen.has(c.name)) counters.interleaved++;
      seen.add(c.name);
      lastName = c.name;
      const g = groups.get(c.name);
      if (g) g.push(c);
      else groups.set(c.name, [c]);
    }
    if (obj.size === 0 && groups.size === 0) return scalar(text);
    for (const [name, els] of groups) {
      const key = obj.has(name) ? `${name}` : name;
      obj.set(key, els.length === 1 ? elementValue(els[0]) : els.map(elementValue));
    }
    if (text.length) obj.set('#text', scalar(text));
    return obj;
  };

  for (const n of doc.children) {
    if (n.type === 'comment') counters.comments++;
    if (n.type === 'pi') counters.pis++;
  }
  const data: DataValue = doc.root ? new Map([[doc.root.name, elementValue(doc.root)]]) : null;
  if (counters.comments) warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: `${counters.comments} XML comment(s) were dropped.`, source: SRC }));
  if (counters.pis) warnings.push(notice({ code: 'convert/pi-dropped', type: 'Processing instructions dropped', message: `${counters.pis} processing instruction(s) were dropped.`, source: SRC }));
  if (counters.mixed) warnings.push(notice({ code: 'convert/mixed-content', type: 'Mixed content', message: `${counters.mixed} element(s) mix text and child elements; their text was collected into "#text" and its position relative to child elements is lost.`, source: SRC }));
  if (counters.interleaved) warnings.push(notice({ code: 'convert/element-order', type: 'Element order', message: 'Repeated child elements are interleaved with other elements; they were grouped into arrays, so the original sibling order is not preserved.', source: SRC }));
  if (counters.cdata) warnings.push(notice({ severity: 'info', code: 'convert/cdata', type: 'CDATA', message: `${counters.cdata} CDATA section(s) were converted to plain text.`, source: SRC }));
  if (counters.unresolved) warnings.push(notice({ code: 'convert/unresolved-entity', type: 'Unresolved entities', message: `${counters.unresolved} entity reference(s) could not be resolved and were kept as written.`, source: SRC }));
  if (opts.inferTypes) warnings.push(notice({ severity: 'info', code: 'convert/inferred-types', type: 'Types inferred', message: 'XML has no data types: numbers and booleans were inferred where the text round-trips exactly (disable "Infer types" to keep everything as strings).', source: SRC }));
  return { data, warnings };
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

export function sanitizeXmlName(name: string): string {
  if (isValidXmlName(name)) return name;
  let s = name.replace(/[^A-Za-z0-9._:\-\u{B7}\u{C0}-\u{FFFD}]/gu, '_');
  if (!s || !isValidXmlName(s)) s = '_' + s;
  return isValidXmlName(s) ? s : '_';
}

/** Data → XML (pretty printed). */
export function dataToXml(data: DataValue, opts: { indent: string; attributePrefix: string }): { text: string; warnings: Diagnostic[] } {
  const warnings: Diagnostic[] = [];
  const seen = new Set<string>();
  const warnOnce = (code: string, type: string, message: string, path: PathSegment[]) => {
    if (seen.has(code)) return;
    seen.add(code);
    warnings.push(notice({ code, type, message, source: 'XML writer', path: pathToString(path) }));
  };
  const renamed: string[] = [];
  const prefix = opts.attributePrefix;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  const scalarText = (v: DataValue, path: PathSegment[]): string => {
    if (v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
      warnOnce('convert/types-to-text', 'Types become text', 'XML has no data types: numbers and booleans are written as text.', path);
      return String(v);
    }
    if (v instanceof DataDate) return v.iso;
    if (v instanceof Uint8Array) {
      warnOnce('convert/binary-as-base64', 'Type changed', 'Binary data is written as base64 text.', path);
      return toBase64(v);
    }
    return '';
  };

  const nameFor = (key: string): string => {
    const s = sanitizeXmlName(key);
    if (s !== key && renamed.length < 10 && !renamed.includes(key)) renamed.push(key);
    return s;
  };

  const write = (rawName: string, v: DataValue, level: number, path: PathSegment[]) => {
    const name = nameFor(rawName);
    const pad = opts.indent.repeat(level);
    if (Array.isArray(v)) {
      // nested arrays: wrap each item
      warnOnce('convert/nested-array', 'Nested arrays', 'Arrays inside arrays have no XML equivalent; inner items are wrapped in <item> elements.', path);
      lines.push(`${pad}<${name}>`);
      v.forEach((item, i) => writeValue('item', item, level + 1, [...path, i]));
      lines.push(`${pad}</${name}>`);
      return;
    }
    if (v instanceof Map) {
      const attrs: string[] = [];
      let text: string | null = null;
      const children: [string, DataValue][] = [];
      for (const [k, child] of v) {
        if (k.startsWith(prefix) && k.length > prefix.length && !(child instanceof Map) && !Array.isArray(child)) {
          attrs.push(` ${sanitizeXmlName(k.slice(prefix.length))}="${escapeAttr(scalarText(child, [...path, k]))}"`);
        } else if (k === '#text') text = scalarText(child, [...path, k]);
        else children.push([k, child]);
      }
      const open = `<${name}${attrs.join('')}`;
      if (children.length === 0) {
        if (text === null || text === '') lines.push(`${pad}${open}/>`);
        else lines.push(`${pad}${open}>${escapeText(text)}</${name}>`);
        return;
      }
      lines.push(`${pad}${open}>`);
      if (text) lines.push(`${pad}${opts.indent}${escapeText(text)}`);
      for (const [k, child] of children) writeValue(k, child, level + 1, [...path, k]);
      lines.push(`${pad}</${name}>`);
      return;
    }
    if (v === null) {
      warnOnce('convert/null-as-empty', 'null values', 'null has no XML equivalent and is written as an empty element.', path);
      lines.push(`${pad}<${name}/>`);
      return;
    }
    const t = scalarText(v, path);
    lines.push(t === '' ? `${pad}<${name}></${name}>` : `${pad}<${name}>${escapeText(t)}</${name}>`);
  };

  /** Arrays as values become repeated elements with the same name. */
  const writeValue = (key: string, v: DataValue, level: number, path: PathSegment[]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        warnOnce('convert/empty-array', 'Empty arrays', 'Empty arrays have no XML representation and were omitted.', path);
        return;
      }
      v.forEach((item, i) => {
        if (Array.isArray(item)) write(key, item, level, [...path, i]);
        else write(key, item, level, [...path, i]);
      });
    } else write(key, v, level, path);
  };

  let rootName = 'root';
  let rootValue: DataValue = data;
  if (data instanceof Map && data.size === 1) {
    const [k, v] = [...data.entries()][0];
    if (!Array.isArray(v)) {
      rootName = k;
      rootValue = v;
    }
  }
  if (rootName === 'root') {
    warnings.push(notice({ severity: 'info', code: 'convert/root-wrapper', type: 'Root element added', message: 'XML needs exactly one root element, so the data was wrapped in <root>.', source: 'XML writer' }));
    if (data instanceof Map) {
      lines.push('<root>');
      for (const [k, v] of data) writeValue(k, v, 1, [k]);
      lines.push('</root>');
    } else if (Array.isArray(data)) {
      lines.push('<root>');
      data.forEach((item, i) => writeValue('item', item, 1, [i]));
      lines.push('</root>');
    } else write('root', data, 0, []);
  } else write(rootName, rootValue, 0, [rootName]);

  if (renamed.length) {
    warnings.push(notice({ code: 'convert/renamed-keys', type: 'Renamed keys', message: `Keys that are not valid XML names were renamed: ${renamed.map((r) => JSON.stringify(r)).join(', ')}.`, source: 'XML writer' }));
  }
  return { text: lines.join('\n'), warnings };
}
