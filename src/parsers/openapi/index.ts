import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { closestMatch } from '../../utils/text';
import { jsonModule } from '../json';
import { SAMPLES } from '../samples';
import { yamlModule } from '../yaml';
import { detectSyntax, isObject, parseStructured, reporterFor, resolvePointer, walk, type PathSeg } from '../common/structured';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const TOP3 = ['openapi', 'info', 'jsonSchemaDialect', 'servers', 'paths', 'webhooks', 'components', 'security', 'tags', 'externalDocs'];
const TOP2 = ['swagger', 'info', 'host', 'basePath', 'schemes', 'consumes', 'produces', 'paths', 'definitions', 'parameters', 'responses', 'securityDefinitions', 'security', 'tags', 'externalDocs'];
const COMPONENT_KINDS = ['schemas', 'responses', 'parameters', 'examples', 'requestBodies', 'headers', 'securitySchemes', 'links', 'callbacks', 'pathItems'];
const PATH_ITEM_KEYS = [...METHODS, '$ref', 'summary', 'description', 'servers', 'parameters'];

function detectOpenApi(ctx: DetectContext): DetectScore | null {
  const h = ctx.head;
  if (/"openapi"\s*:\s*"3\.\d/.test(h) || /^openapi\s*:\s*["']?3\.\d/m.test(h)) return { score: 0.98, reasons: ['openapi: 3.x version field'] };
  if (/"swagger"\s*:\s*"2\.0"/.test(h) || /^swagger\s*:\s*["']?2\.0/m.test(h)) return { score: 0.97, reasons: ['swagger: "2.0" version field'] };
  return null;
}

function validateDocument(data: unknown, report: ReturnType<typeof reporterFor>): Record<string, string | number> {
  const facts: Record<string, string | number> = {};
  if (!isObject(data)) {
    report([], { code: 'openapi/root', type: 'Invalid document', message: 'An OpenAPI document must be an object.' });
    return facts;
  }
  const swagger2 = 'swagger' in data;
  const version = String(data.openapi ?? data.swagger ?? '');
  const v31 = /^3\.[1-9]/.test(version);
  facts.Specification = swagger2 ? `Swagger ${version}` : `OpenAPI ${version || '?'}`;
  if (swagger2) {
    if (data.swagger !== '2.0') report(['swagger'], { code: 'openapi/version', type: 'Invalid version', message: `swagger must be "2.0" (found ${JSON.stringify(data.swagger)}).` }, 'value');
  } else if (typeof data.openapi !== 'string') {
    report(data.openapi === undefined ? [] : ['openapi'], {
      code: 'openapi/version',
      type: data.openapi === undefined ? 'Missing field' : 'Invalid version',
      message: data.openapi === undefined ? 'Missing required field "openapi" (e.g. openapi: 3.0.3).' : 'The openapi version must be a string, e.g. "3.0.3" (quote it in YAML).',
    }, 'value');
  } else if (!/^3\.[0-2]\.\d+(-[\w.]+)?$/.test(data.openapi)) {
    report(['openapi'], { code: 'openapi/version', type: 'Invalid version', message: `"${data.openapi}" is not a supported OpenAPI version (3.0.x, 3.1.x or 3.2.x).` }, 'value');
  }

  // ---- top-level fields
  const allowed = swagger2 ? TOP2 : TOP3;
  for (const k of Object.keys(data)) {
    if (allowed.includes(k) || k.startsWith('x-')) continue;
    const near = closestMatch(k, allowed);
    report([k], { severity: 'warning', code: 'openapi/unknown-field', type: 'Unknown field', message: `Unknown top-level field "${k}".${near ? ` Did you mean "${near}"?` : ' Custom fields must start with "x-".'}` });
  }

  // ---- info
  if (!isObject(data.info)) report(data.info === undefined ? [] : ['info'], { code: 'openapi/info', type: 'Missing field', message: 'The "info" object (with title and version) is required.' });
  else {
    if (typeof data.info.title !== 'string' || !data.info.title.trim()) report(['info'], { code: 'openapi/info-title', type: 'Missing field', message: 'info.title is required.' });
    if (data.info.version === undefined) report(['info'], { code: 'openapi/info-version', type: 'Missing field', message: 'info.version (the API version) is required.' });
    else if (typeof data.info.version !== 'string') report(['info', 'version'], { code: 'openapi/info-version', type: 'Invalid type', message: 'info.version must be a string; quote it (e.g. "1.0").' }, 'value');
  }

  // ---- servers
  if (Array.isArray(data.servers)) {
    data.servers.forEach((s, i) => {
      if (!isObject(s) || typeof s.url !== 'string') report(['servers', i], { code: 'openapi/server-url', type: 'Missing field', message: 'Each server needs a "url".' }, 'value');
    });
  }

  // ---- tags
  const tagNames = new Set<string>();
  if (Array.isArray(data.tags)) {
    data.tags.forEach((t, i) => {
      const name = isObject(t) ? t.name : undefined;
      if (typeof name !== 'string') report(['tags', i], { code: 'openapi/tag-name', type: 'Missing field', message: 'Each tag needs a "name".' }, 'value');
      else if (tagNames.has(name)) report(['tags', i], { severity: 'warning', code: 'openapi/duplicate-tag', type: 'Duplicate tag', message: `Tag "${name}" is declared more than once.` }, 'value');
      else tagNames.add(name);
    });
  }

  // ---- security schemes
  const schemes = new Set(Object.keys((swagger2 ? data.securityDefinitions : isObject(data.components) ? data.components.securitySchemes : undefined) as object ?? {}));
  const checkSecurity = (sec: unknown, path: PathSeg[]) => {
    if (!Array.isArray(sec)) return;
    sec.forEach((req, i) => {
      if (!isObject(req)) return;
      for (const name of Object.keys(req)) {
        if (!schemes.has(name)) report([...path, i, name], { code: 'openapi/unknown-security-scheme', type: 'Unknown security scheme', message: `Security scheme "${name}" is not defined in ${swagger2 ? 'securityDefinitions' : 'components.securitySchemes'}.` });
      }
    });
  };
  checkSecurity(data.security, ['security']);

  // ---- components
  if (!swagger2 && isObject(data.components)) {
    for (const kind of Object.keys(data.components)) {
      const group = data.components[kind];
      if (!COMPONENT_KINDS.includes(kind) && !kind.startsWith('x-')) {
        const near = closestMatch(kind, COMPONENT_KINDS);
        report(['components', kind], { severity: 'warning', code: 'openapi/unknown-component-type', type: 'Unknown component type', message: `"${kind}" is not a component type.${near ? ` Did you mean "${near}"?` : ''}` });
        continue;
      }
      if (isObject(group)) {
        for (const name of Object.keys(group)) {
          if (!/^[a-zA-Z0-9.\-_]+$/.test(name)) report(['components', kind, name], { code: 'openapi/component-name', type: 'Invalid name', message: `Component name "${name}" may only contain letters, digits, '.', '-' and '_'.` });
        }
      }
    }
  }

  // ---- paths & operations
  const hasPaths = data.paths !== undefined;
  if (!hasPaths && (swagger2 || !v31)) report([], { code: 'openapi/paths', type: 'Missing field', message: 'The "paths" object is required.' });
  if (!swagger2 && v31 && !hasPaths && data.components === undefined && data.webhooks === undefined) {
    report([], { code: 'openapi/empty', type: 'Missing field', message: 'An OpenAPI 3.1 document needs at least one of paths, components or webhooks.' });
  }
  const operationIds = new Map<string, PathSeg[]>();
  let operations = 0;
  const normalized = new Map<string, string>();
  const resolve = (v: unknown): unknown => (isObject(v) && typeof v.$ref === 'string' ? resolvePointer(data, v.$ref).value ?? v : v);
  if (isObject(data.paths)) {
    for (const p of Object.keys(data.paths)) {
      if (p.startsWith('x-')) continue;
      const item = data.paths[p];
      const pathSeg: PathSeg[] = ['paths', p];
      if (!p.startsWith('/')) report(pathSeg, { code: 'openapi/path-format', type: 'Invalid path', message: `Path "${p}" must start with "/".` });
      const norm = p.replace(/\{[^}]+\}/g, '{}');
      const prev = normalized.get(norm);
      if (prev) report(pathSeg, { severity: 'warning', code: 'openapi/ambiguous-path', type: 'Ambiguous path', message: `"${p}" is equivalent to "${prev}" (only the parameter names differ).` });
      else normalized.set(norm, p);
      if (!isObject(item)) {
        report(pathSeg, { code: 'openapi/path-item', type: 'Invalid path item', message: `Path item for "${p}" must be an object.` });
        continue;
      }
      for (const k of Object.keys(item)) {
        if (!PATH_ITEM_KEYS.includes(k) && !k.startsWith('x-')) {
          const near = closestMatch(k, METHODS);
          report([...pathSeg, k], { severity: 'warning', code: 'openapi/unknown-field', type: 'Unknown field', message: `Unknown field "${k}" in path item.${near ? ` Did you mean "${near}"?` : ''}` });
        }
      }
      const templateParams = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const pathLevel = Array.isArray(item.parameters) ? item.parameters.map(resolve) : [];
      for (const method of METHODS) {
        const op = item[method];
        if (op === undefined) continue;
        operations++;
        const opSeg = [...pathSeg, method];
        if (!isObject(op)) {
          report(opSeg, { code: 'openapi/operation', type: 'Invalid operation', message: `${method.toUpperCase()} ${p} must be an object.` });
          continue;
        }
        if (typeof op.operationId === 'string') {
          const dup = operationIds.get(op.operationId);
          if (dup) report([...opSeg, 'operationId'], { code: 'openapi/duplicate-operation-id', type: 'Duplicate operationId', message: `operationId "${op.operationId}" is also used by ${String(dup[2]).toUpperCase()} ${String(dup[1])}; operationIds must be unique.` }, 'value');
          else operationIds.set(op.operationId, opSeg);
        }
        // responses
        if (op.responses === undefined) {
          if (swagger2 || !v31) report(opSeg, { code: 'openapi/responses', type: 'Missing field', message: `${method.toUpperCase()} ${p} has no "responses".` });
        } else if (!isObject(op.responses) || Object.keys(op.responses).length === 0) {
          report([...opSeg, 'responses'], { code: 'openapi/responses', type: 'Invalid responses', message: 'responses must contain at least one response.' });
        } else {
          for (const code of Object.keys(op.responses)) {
            if (code.startsWith('x-')) continue;
            if (!/^([1-5][0-9X]{2}|default)$/.test(code)) report([...opSeg, 'responses', code], { code: 'openapi/response-code', type: 'Invalid status code', message: `"${code}" is not a valid response code (use 200, 4XX, default...).` });
            const resp = op.responses[code];
            if (isObject(resp) && typeof resp.$ref !== 'string' && typeof resp.description !== 'string') {
              report([...opSeg, 'responses', code], { code: 'openapi/response-description', type: 'Missing field', message: `Response ${code} needs a "description".` });
            }
          }
        }
        // parameters
        const opParams = Array.isArray(op.parameters) ? op.parameters : [];
        const seen = new Set<string>();
        const declaredPath = new Set<string>();
        const allowedIn = swagger2 ? ['query', 'header', 'path', 'formData', 'body'] : ['query', 'header', 'path', 'cookie'];
        const checkParam = (raw: unknown, seg: PathSeg[], level: 'path' | 'operation') => {
          const prm = resolve(raw);
          if (!isObject(prm)) return;
          if (typeof prm.$ref === 'string') return; // unresolved; reported by the $ref check
          if (typeof prm.name !== 'string' || typeof prm.in !== 'string') {
            report(seg, { code: 'openapi/parameter', type: 'Invalid parameter', message: 'A parameter needs both "name" and "in".' }, 'value');
            return;
          }
          if (!allowedIn.includes(prm.in)) report([...seg, 'in'], { code: 'openapi/parameter-in', type: 'Invalid parameter location', message: `"in" must be one of ${allowedIn.join(', ')} (found "${prm.in}").` }, 'value');
          const key = `${prm.in}:${prm.name}`;
          if (level === 'operation') {
            if (seen.has(key)) report(seg, { code: 'openapi/duplicate-parameter', type: 'Duplicate parameter', message: `Parameter "${prm.name}" (in ${prm.in}) is declared twice.` }, 'value');
            seen.add(key);
          }
          if (prm.in === 'path') {
            declaredPath.add(prm.name);
            if (prm.required !== true) report(seg, { code: 'openapi/path-param-required', type: 'Path parameter not required', message: `Path parameter "${prm.name}" must have required: true.` }, 'value');
          }
          if (!swagger2 && prm.schema === undefined && prm.content === undefined) report(seg, { severity: 'warning', code: 'openapi/parameter-schema', type: 'Missing schema', message: `Parameter "${prm.name}" has neither "schema" nor "content".` }, 'value');
        };
        pathLevel.forEach((prm, i) => checkParam(prm, [...pathSeg, 'parameters', i], 'path'));
        opParams.forEach((prm, i) => checkParam(prm, [...opSeg, 'parameters', i], 'operation'));
        for (const t of templateParams) {
          if (!declaredPath.has(t)) report(opSeg, { code: 'openapi/missing-path-param', type: 'Undeclared path parameter', message: `${method.toUpperCase()} ${p}: path parameter "{${t}}" is not declared in "parameters".` });
        }
        for (const d of declaredPath) {
          if (!templateParams.includes(d)) report(opSeg, { code: 'openapi/unused-path-param', type: 'Unknown path parameter', message: `${method.toUpperCase()} ${p}: path parameter "${d}" does not appear in the path template.` });
        }
        if (!swagger2 && op.requestBody !== undefined) {
          const rb = resolve(op.requestBody);
          if (isObject(rb) && typeof rb.$ref !== 'string' && !isObject(rb.content)) report([...opSeg, 'requestBody'], { code: 'openapi/request-body', type: 'Missing field', message: 'requestBody needs a "content" map.' });
        }
        if (Array.isArray(op.tags) && tagNames.size) {
          op.tags.forEach((t, i) => {
            if (typeof t === 'string' && !tagNames.has(t)) report([...opSeg, 'tags', i], { severity: 'info', code: 'openapi/undeclared-tag', type: 'Undeclared tag', message: `Tag "${t}" is not listed in the top-level tags.` }, 'value');
          });
        }
        checkSecurity(op.security, [...opSeg, 'security']);
      }
    }
  }
  facts.Paths = isObject(data.paths) ? Object.keys(data.paths).filter((k) => !k.startsWith('x-')).length : 0;
  facts.Operations = operations;

  // ---- $ref resolution and unused schemas
  const referenced = new Set<string>();
  let refs = 0;
  walk(data, (v, path) => {
    if (!isObject(v) || typeof v.$ref !== 'string') return;
    refs++;
    const ref = v.$ref;
    if (ref.startsWith('#')) {
      referenced.add(ref);
      if (!resolvePointer(data, ref).found) report([...path, '$ref'], { code: 'openapi/unresolved-ref', type: 'Unresolved reference', message: `Reference "${ref}" does not point to anything in this document.` }, 'value');
    } else {
      report([...path, '$ref'], { severity: 'info', code: 'openapi/external-ref', type: 'External reference', message: `External reference "${ref}" is not resolved (only this document is checked).` }, 'value');
    }
  });
  facts.References = refs;
  const schemaRoot = swagger2 ? 'definitions' : 'components';
  const schemaGroup = swagger2 ? data.definitions : isObject(data.components) ? data.components.schemas : undefined;
  if (isObject(schemaGroup)) {
    facts.Schemas = Object.keys(schemaGroup).length;
    const prefix = swagger2 ? '#/definitions/' : '#/components/schemas/';
    const refText = [...referenced].join('\n');
    for (const name of Object.keys(schemaGroup)) {
      const enc = name.replace(/~/g, '~0').replace(/\//g, '~1');
      if (!refText.includes(prefix + enc)) {
        report(swagger2 ? [schemaRoot, name] : [schemaRoot, 'schemas', name], { severity: 'info', code: 'openapi/unused-schema', type: 'Unused schema', message: `Schema "${name}" is never referenced.` });
      }
    }
  }
  return facts;
}

async function validateOpenApi(input: string, ctx: ModuleContext) {
  const doc = await parseStructured(input, ctx);
  if (doc.syntaxDiagnostics.length) return { diagnostics: doc.syntaxDiagnostics, validator: `${doc.syntax.toUpperCase()} parser` };
  const diagnostics: Diagnostic[] = [];
  const facts = validateDocument(doc.data, reporterFor(doc, ctx, 'OpenAPI rules', diagnostics));
  facts.Syntax = doc.syntax.toUpperCase();
  return { diagnostics, facts, validator: 'FormatX OpenAPI rules' };
}

export const openapiModule: FormatModule = {
  descriptor: DESCRIPTORS.openapi,
  sample: SAMPLES.openapi,
  detect: detectOpenApi,
  validate: validateOpenApi,
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
