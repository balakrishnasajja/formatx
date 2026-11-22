import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { closestMatch } from '../../utils/text';
import { jsonModule } from '../json';
import { SAMPLES } from '../samples';
import { yamlModule } from '../yaml';
import { detectSyntax, isObject, parseStructured, reporterFor, resolvePointer, type PathSeg } from '../common/structured';

type Draft = '04' | '06' | '07' | '2019-09' | '2020-12';

const DRAFT_URIS: [RegExp, Draft][] = [
  [/json-schema\.org\/draft-04\/schema/, '04'],
  [/json-schema\.org\/draft-06\/schema/, '06'],
  [/json-schema\.org\/draft-07\/schema/, '07'],
  [/json-schema\.org\/draft\/2019-09\/schema/, '2019-09'],
  [/json-schema\.org\/draft\/2020-12\/schema/, '2020-12'],
];

const KEYWORDS = new Set(
  (
    '$schema $id id $ref $anchor $dynamicRef $dynamicAnchor $recursiveRef $recursiveAnchor $vocabulary $comment $defs definitions ' +
    'allOf anyOf oneOf not if then else dependentSchemas dependencies prefixItems items additionalItems contains properties patternProperties additionalProperties propertyNames unevaluatedItems unevaluatedProperties ' +
    'type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern maxItems minItems uniqueItems maxContains minContains maxProperties minProperties required dependentRequired ' +
    'title description default deprecated readOnly writeOnly examples format contentEncoding contentMediaType contentSchema'
  ).split(' '),
);
const FORMATS = ['date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'uri-template', 'json-pointer', 'relative-json-pointer', 'regex'];
const MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SINGLE_KEYWORDS = ['not', 'if', 'then', 'else', 'contains', 'propertyNames', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'additionalItems', 'contentSchema'];

function detectJsonSchema(ctx: DetectContext): DetectScore | null {
  const h = ctx.head;
  if (/"\$schema"\s*:\s*"https?:\/\/json-schema\.org\//.test(h) || /^\$schema\s*:\s*["']?https?:\/\/json-schema\.org/m.test(h)) {
    return { score: 0.98, reasons: ['$schema points to a json-schema.org meta-schema'] };
  }
  if (ctx.firstChar === '{' && /"type"\s*:\s*"object"/.test(h) && /"properties"\s*:\s*\{/.test(h) && /"(\$id|\$defs|definitions|required)"\s*:/.test(h)) {
    return { score: 0.6, reasons: ['Looks like a JSON Schema (type/properties/required) without $schema'] };
  }
  return null;
}

interface AjvLike {
  validateSchema(schema: unknown): boolean | Promise<unknown>;
  errors?: { instancePath: string; keyword: string; params: Record<string, unknown>; message?: string }[] | null;
}

const ajvCache = new Map<Draft, Promise<AjvLike>>();
function getAjv(draft: Draft): Promise<AjvLike> {
  let p = ajvCache.get(draft);
  if (!p) {
    const opts = { allErrors: true, strict: false, validateFormats: false };
    p = (async (): Promise<AjvLike> => {
      switch (draft) {
        case '04': {
          const { default: Ajv4 } = await import('ajv-draft-04');
          return new Ajv4(opts) as unknown as AjvLike;
        }
        case '06': {
          const { default: Ajv } = await import('ajv');
          const meta = (await import('ajv/dist/refs/json-schema-draft-06.json')).default;
          const a = new Ajv(opts);
          a.addMetaSchema(meta);
          return a as unknown as AjvLike;
        }
        case '07': {
          const { default: Ajv } = await import('ajv');
          return new Ajv(opts) as unknown as AjvLike;
        }
        case '2019-09': {
          const { default: Ajv2019 } = await import('ajv/dist/2019');
          return new Ajv2019(opts) as unknown as AjvLike;
        }
        default: {
          const { default: Ajv2020 } = await import('ajv/dist/2020');
          return new Ajv2020(opts) as unknown as AjvLike;
        }
      }
    })();
    ajvCache.set(draft, p);
  }
  return p;
}

/** JSON pointer → path segments, turning indices into numbers where the parent is an array. */
function pointerToPath(pointer: string, root: unknown): PathSeg[] {
  if (!pointer) return [];
  const segs: PathSeg[] = [];
  let cur: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const s = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      const i = Number(s);
      segs.push(i);
      cur = cur[i];
    } else {
      segs.push(s);
      cur = isObject(cur) ? cur[s] : undefined;
    }
  }
  return segs;
}

function forEachSubschema(schema: unknown, path: PathSeg[], fn: (s: Record<string, unknown>, path: PathSeg[]) => void, depth = 0): void {
  if (!isObject(schema) || depth > 100) return;
  fn(schema, path);
  for (const k of MAP_KEYWORDS) {
    const m = schema[k];
    if (isObject(m)) for (const name of Object.keys(m)) forEachSubschema(m[name], [...path, k, name], fn, depth + 1);
  }
  if (isObject(schema.dependencies)) {
    for (const name of Object.keys(schema.dependencies)) forEachSubschema(schema.dependencies[name], [...path, 'dependencies', name], fn, depth + 1);
  }
  for (const k of ARRAY_KEYWORDS) {
    const a = schema[k];
    if (Array.isArray(a)) a.forEach((s, i) => forEachSubschema(s, [...path, k, i], fn, depth + 1));
  }
  if (Array.isArray(schema.items)) schema.items.forEach((s, i) => forEachSubschema(s, [...path, 'items', i], fn, depth + 1));
  else forEachSubschema(schema.items, [...path, 'items'], fn, depth + 1);
  for (const k of SINGLE_KEYWORDS) forEachSubschema(schema[k], [...path, k], fn, depth + 1);
}

async function validateSchemaDoc(input: string, ctx: ModuleContext) {
  const doc = await parseStructured(input, ctx);
  if (doc.syntaxDiagnostics.length) return { diagnostics: doc.syntaxDiagnostics, validator: `${doc.syntax.toUpperCase()} parser` };
  const data = doc.data;
  const diagnostics: Diagnostic[] = [];
  const report = reporterFor(doc, ctx, 'JSON Schema', diagnostics);
  if (typeof data === 'boolean') return { diagnostics, facts: { Schema: `boolean (${data})` } };
  if (!isObject(data)) {
    report([], { code: 'jsonschema/root', type: 'Invalid schema', message: 'A JSON Schema must be an object (or a boolean).' });
    return { diagnostics };
  }
  let draft: Draft = '2020-12';
  if (typeof data.$schema === 'string') {
    const hit = DRAFT_URIS.find(([re]) => re.test(data.$schema as string));
    if (hit) draft = hit[1];
    else report(['$schema'], { severity: 'warning', code: 'jsonschema/unknown-dialect', type: 'Unknown $schema', message: `"${data.$schema}" is not a known JSON Schema meta-schema; validated as draft 2020-12.` }, 'value');
  } else {
    report([], { severity: 'info', code: 'jsonschema/no-schema', type: 'No $schema', message: 'No $schema keyword: validated against draft 2020-12.', suggestion: 'Add "$schema": "https://json-schema.org/draft/2020-12/schema".' });
  }

  // 1. meta-schema validation (Ajv)
  const ajv = await getAjv(draft);
  const schemaForAjv = typeof data.$schema === 'string' && DRAFT_URIS.some(([re]) => re.test(data.$schema as string)) ? data : { ...data, $schema: undefined };
  if (schemaForAjv.$schema === undefined) delete schemaForAjv.$schema;
  let ok: boolean;
  try {
    ok = (await ajv.validateSchema(schemaForAjv)) === true;
  } catch (e) {
    report([], { code: 'jsonschema/meta-error', type: 'Meta-schema error', message: (e as Error).message });
    ok = true;
  }
  if (!ok && ajv.errors) {
    const groups = new Map<string, typeof ajv.errors>();
    for (const e of ajv.errors) {
      const g = groups.get(e.instancePath) ?? [];
      g.push(e);
      groups.set(e.instancePath, g);
    }
    const paths = [...groups.keys()];
    for (const [ptr, errs] of groups) {
      // drop generic anyOf/oneOf failures when a deeper, more specific error exists
      const specific = errs.filter((e) => !['anyOf', 'oneOf', 'allOf', 'if', '$ref'].includes(e.keyword));
      if (!specific.length && paths.some((p) => p !== ptr && p.startsWith(ptr + '/'))) continue;
      const list = specific.length ? specific : errs;
      const enumErr = list.find((e) => e.keyword === 'enum');
      const typeErrs = list.filter((e) => e.keyword === 'type');
      let message: string;
      if (enumErr) message = `must be one of: ${(enumErr.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`;
      else if (typeErrs.length) message = `must be of type ${[...new Set(typeErrs.map((e) => String(e.params.type)))].join(' or ')}`;
      else message = list.map((e) => e.message).filter(Boolean).join('; ');
      const path = pointerToPath(ptr, data);
      const keyword = path.length ? String(path[path.length - 1]) : '(root)';
      report(path, { code: 'jsonschema/meta-schema', type: 'Invalid keyword value', message: `"${keyword}" ${message}.` }, 'value');
    }
  }

  // 2. semantic checks over every subschema
  let subschemas = 0;
  const anchors = new Set<string>();
  forEachSubschema(data, [], (s) => {
    if (typeof s.$anchor === 'string') anchors.add(s.$anchor);
  });
  forEachSubschema(data, [], (s, path) => {
    subschemas++;
    for (const k of Object.keys(s)) {
      if (KEYWORDS.has(k) || k.startsWith('x-') || k.startsWith('$')) continue;
      const near = closestMatch(k, [...KEYWORDS], 2);
      report([...path, k], near
        ? { severity: 'warning', code: 'jsonschema/unknown-keyword', type: 'Unknown keyword', message: `Unknown keyword "${k}" — did you mean "${near}"? Unknown keywords are ignored by validators.` }
        : { severity: 'info', code: 'jsonschema/unknown-keyword', type: 'Unknown keyword', message: `"${k}" is not a JSON Schema keyword; validators will ignore it.` });
    }
    if (typeof s.$ref === 'string') {
      const ref = s.$ref;
      if (ref.startsWith('#/') || ref === '#') {
        if (!resolvePointer(data, ref).found) report([...path, '$ref'], { code: 'jsonschema/unresolved-ref', type: 'Unresolved reference', message: `Reference "${ref}" does not point to anything in this schema.` }, 'value');
      } else if (ref.startsWith('#')) {
        if (!anchors.has(ref.slice(1))) report([...path, '$ref'], { code: 'jsonschema/unresolved-anchor', type: 'Unresolved anchor', message: `No "$anchor": "${ref.slice(1)}" exists in this schema.` }, 'value');
      }
    }
    if (typeof s.pattern === 'string') {
      try {
        new RegExp(s.pattern, 'u');
      } catch (e) {
        report([...path, 'pattern'], { code: 'jsonschema/invalid-pattern', type: 'Invalid pattern', message: `pattern is not a valid ECMA-262 regular expression: ${(e as Error).message}` }, 'value');
      }
    }
    if (typeof s.format === 'string' && !FORMATS.includes(s.format)) {
      const near = closestMatch(s.format, FORMATS, 2);
      report([...path, 'format'], { severity: near ? 'warning' : 'info', code: 'jsonschema/unknown-format', type: 'Unknown format', message: `"${s.format}" is not a standard format${near ? ` — did you mean "${near}"?` : ' (custom formats are ignored unless your validator defines them)'}.` }, 'value');
    }
    if (Array.isArray(s.required) && isObject(s.properties)) {
      s.required.forEach((r, i) => {
        if (typeof r === 'string' && !Object.prototype.hasOwnProperty.call(s.properties, r) && s.additionalProperties === false) {
          report([...path, 'required', i], { severity: 'warning', code: 'jsonschema/required-not-defined', type: 'Impossible requirement', message: `"${r}" is required but not defined in properties, and additionalProperties is false — no instance can be valid.` }, 'value');
        } else if (typeof r === 'string' && !Object.prototype.hasOwnProperty.call(s.properties, r)) {
          report([...path, 'required', i], { severity: 'info', code: 'jsonschema/required-not-defined', type: 'Required property not described', message: `"${r}" is required but has no definition in properties.` }, 'value');
        }
      });
    }
    const pairs: [string, string][] = [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minProperties', 'maxProperties'], ['minContains', 'maxContains']];
    for (const [lo, hi] of pairs) {
      if (typeof s[lo] === 'number' && typeof s[hi] === 'number' && (s[lo] as number) > (s[hi] as number)) {
        report([...path, lo], { severity: 'warning', code: 'jsonschema/impossible-range', type: 'Impossible range', message: `${lo} (${s[lo]}) is greater than ${hi} (${s[hi]}).` }, 'value');
      }
    }
    if ((draft === '2019-09' || draft === '2020-12') && s.definitions !== undefined && path.length === 0) {
      report(['definitions'], { severity: 'info', code: 'jsonschema/definitions', type: 'Legacy keyword', message: 'Since draft 2019-09 the standard location for reusable schemas is "$defs".' });
    }
  });
  const facts: Record<string, string | number> = { Draft: draft === '04' || draft === '06' || draft === '07' ? `draft-${draft}` : draft, Subschemas: subschemas, Syntax: doc.syntax.toUpperCase() };
  if (isObject(data.properties)) facts['Top-level properties'] = Object.keys(data.properties).length;
  return { diagnostics, facts, validator: `Ajv (${facts.Draft} meta-schema) + FormatX checks` };
}

export const jsonschemaModule: FormatModule = {
  descriptor: DESCRIPTORS.jsonschema,
  sample: SAMPLES.jsonschema,
  detect: detectJsonSchema,
  validate: validateSchemaDoc,
  beautify(input, ctx) {
    const inner = detectSyntax(input) === 'json' ? jsonModule : yamlModule;
    return Promise.resolve(inner.beautify!(input, ctx)).then((r) => ({ ...r, language: inner.descriptor.monacoLanguage }));
  },
  minify(input, ctx) {
    const inner = detectSyntax(input) === 'json' ? jsonModule : yamlModule;
    return Promise.resolve(inner.minify!(input, ctx)).then((r) => ({ ...r, language: inner.descriptor.monacoLanguage }));
  },
  verifyTransform(original, output, ctx) {
    const inner = detectSyntax(original) === 'json' ? jsonModule : yamlModule;
    return inner.verifyTransform ? inner.verifyTransform(original, output, ctx) : null;
  },
  toData(input, ctx) {
    return (detectSyntax(input) === 'json' ? jsonModule : yamlModule).toData!(input, ctx);
  },
};
