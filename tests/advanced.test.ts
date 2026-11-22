import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { setRuffLoader } from '../src/parsers/python';
import { applyFix, beautify, check, codesOf, convert, errorsOf, minify, ok } from './helpers';
import { SAMPLES } from '../src/parsers/samples';

beforeAll(() => {
  // In Node the Ruff WebAssembly module is loaded from disk instead of fetched.
  setRuffLoader(async () => {
    const ruff = await import('@astral-sh/ruff-wasm-web');
    const wasm = readFileSync(fileURLToPath(new URL('../node_modules/@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm', import.meta.url)));
    ruff.initSync({ module: wasm });
    return ruff;
  });
});

describe('Markdown', () => {
  it('only produces warnings and finds common mistakes', async () => {
    const r = await check('markdown', '# Title\n#Bad heading\n### Skipped\n![](img.png)\n[text][missing]\n```js\nconst a = 1;\n');
    expect(r.validation.counts.error).toBe(0);
    expect(r.validation.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['md/heading-space', 'md/heading-increment', 'md/image-alt', 'md/undefined-reference', 'md/unclosed-fence']));
  });

  it('beautifies with Prettier and converts to HTML', async () => {
    expect(ok(await beautify('markdown', '#  Title\n*  item\n*  item 2'))).toBe('# Title\n\n- item\n- item 2\n');
    const html = ok(await convert('markdown', 'html', '# Hi\n\n**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
  });
});

describe('GraphQL', () => {
  it('reports syntax errors with positions', async () => {
    const [err] = await errorsOf('graphql', 'query {\n  user(id: 1) {\n    name\n');
    expect(err.code).toBe('graphql/syntax-error');
    expect(err.message).toContain('Expected Name');
  });

  it('validates SDL and operations against the schema in the same document', async () => {
    const schema = 'type Query { user(id: ID!): User }\ntype User { id: ID! name: String }\n';
    expect((await check('graphql', schema + 'query { user(id: "1") { name } }')).validation.status).toBe('valid');
    const errs = await errorsOf('graphql', schema + 'query { user(id: "1") { email } }');
    expect(errs[0].message).toContain('Cannot query field "email"');
    expect((await errorsOf('graphql', 'type A { b: Unknown }'))[0].message).toContain('Unknown type "Unknown"');
  });

  it('applies schema-independent rules to operations without a schema', async () => {
    const errs = await errorsOf('graphql', 'query A($x: Int) { a }\nquery A { b }');
    expect(errs.map((e) => e.message).join(' ')).toMatch(/only one operation named "A"/);
  });

  it('formats and minifies', async () => {
    expect(ok(await beautify('graphql', 'query{user(id:1){name}}'))).toBe('query {\n  user(id: 1) {\n    name\n  }\n}\n');
    expect(ok(await minify('graphql', '# comment\nquery Q {\n  user { id\n name }\n}'))).toBe('query Q{user{id name}}');
  });
});

describe('OpenAPI', () => {
  it('accepts the sample and positions semantic errors', async () => {
    expect((await check('openapi', SAMPLES.openapi)).validation.counts.error).toBe(0);
    const broken = SAMPLES.openapi.replace('name: petId', 'name: id').replace('#/components/schemas/Pet', '#/components/schemas/Dog');
    const r = await check('openapi', broken);
    const codes = r.validation.diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['openapi/missing-path-param', 'openapi/unused-path-param', 'openapi/unresolved-ref']));
    const ref = r.validation.diagnostics.find((d) => d.code === 'openapi/unresolved-ref')!;
    expect(ref.range?.line).toBe(broken.split('\n').findIndex((l) => l.includes('#/components/schemas/Dog')) + 1);
  });

  it('checks required fields, versions and duplicate operationIds (JSON syntax)', async () => {
    const doc = JSON.stringify({ openapi: '3.0.3', info: { title: 'x' }, paths: { '/a': { get: { operationId: 'x', responses: { 200: { description: 'ok' } } } }, '/b': { get: { operationId: 'x', responses: { 999: {} } } } } }, null, 2);
    const codes = await codesOf('openapi', doc);
    expect(codes).toEqual(expect.arrayContaining(['openapi/info-version', 'openapi/duplicate-operation-id', 'openapi/response-code', 'openapi/response-description']));
  });

  it('suggests corrections for unknown top-level fields', async () => {
    const r = await check('openapi', 'openapi: 3.0.0\ninfo: {title: t, version: "1"}\npats: {}\n');
    const d = r.validation.diagnostics.find((x) => x.code === 'openapi/unknown-field');
    expect(d?.message).toContain('Did you mean "paths"');
  });

  it('converts YAML OpenAPI to JSON', async () => {
    const json = JSON.parse(ok(await convert('openapi', 'json', SAMPLES.openapi)));
    expect(json.paths['/pets/{petId}'].get.operationId).toBe('getPet');
  });
});

describe('JSON Schema', () => {
  it('validates the sample against draft 2020-12', async () => {
    const r = await check('jsonschema', SAMPLES.jsonschema);
    expect(r.validation.counts.error).toBe(0);
    expect(r.stats.facts.Draft).toBe('2020-12');
  });

  it('reports invalid keyword values at their position', async () => {
    const input = '{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "object",\n  "properties": {\n    "age": { "type": "integr", "minimum": "zero" }\n  }\n}';
    const errs = await errorsOf('jsonschema', input);
    expect(errs.length).toBeGreaterThanOrEqual(2);
    expect(errs.every((e) => e.range?.line === 5)).toBe(true);
    expect(errs.map((e) => e.message).join(' ')).toContain('"type" must be');
  });

  it('finds unresolved refs, typos, invalid patterns and impossible ranges', async () => {
    const input = JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', requried: ['a'], properties: { a: { $ref: '#/$defs/missing' }, b: { type: 'string', pattern: '([a-z]', minLength: 5, maxLength: 2, format: 'emial' } } }, null, 2);
    const codes = await codesOf('jsonschema', input);
    expect(codes).toEqual(expect.arrayContaining(['jsonschema/unknown-keyword', 'jsonschema/unresolved-ref', 'jsonschema/invalid-pattern', 'jsonschema/impossible-range', 'jsonschema/unknown-format']));
  });

  it('supports draft-04 and draft-06', async () => {
    expect((await check('jsonschema', '{"$schema": "http://json-schema.org/draft-04/schema#", "type": "object", "properties": {"a": {"type": "string"}}}')).validation.counts.error).toBe(0);
    expect((await errorsOf('jsonschema', '{"$schema": "http://json-schema.org/draft-06/schema#", "type": 5}')).length).toBe(1);
  });
});

describe('BSON & MessagePack', () => {
  it('decodes the BSON sample (hex)', async () => {
    const r = await check('bson', SAMPLES.bson);
    expect(r.validation.status).toBe('valid');
    const view = await beautify('bson', SAMPLES.bson);
    expect(JSON.parse(ok(view))).toEqual({ name: 'FormatX', version: 1, tags: ['fast', 'local'] });
    expect(view.outputFormatId).toBe('json');
  });

  it('reports corrupt BSON at the byte position', async () => {
    const corrupt = SAMPLES.bson.replace(/^48/, '4a');
    const [err] = await errorsOf('bson', corrupt);
    expect(err.code).toBe('bson/invalid');
    expect(err.range?.line).toBe(1);
    expect((await errorsOf('bson', 'not binary!'))[0].code).toBe('binary/encoding');
  });

  it('round-trips JSON → BSON → JSON with Extended JSON types', async () => {
    const r = await convert('json', 'bson', '{"_id": {"$oid": "65a1f2b3c4d5e6f708192a3b"}, "n": 1234567890123456789, "big": 123456789012345678901234, "when": {"$date": "2024-01-02T03:04:05Z"}}');
    expect(r.ok).toBe(true);
    expect(r.binary).toBeInstanceOf(Uint8Array);
    const back = await convert('bson', 'json', r.text!);
    const obj = JSON.parse(ok(back));
    expect(obj._id).toEqual({ $oid: '65a1f2b3c4d5e6f708192a3b' });
    expect(obj.when).toEqual({ $date: '2024-01-02T03:04:05Z' });
    // relaxed mode keeps int64 values exact (bson's own relaxed mode would round them)
    expect(ok(back)).toContain('"n": 1234567890123456789');
    void obj.n;
    expect(obj.big).toEqual({ $numberDecimal: '123456789012345678901234' });
    expect(r.warnings.some((w) => w.code === 'convert/decimal128')).toBe(true);
  });

  it('decodes MessagePack and converts both ways', async () => {
    expect(JSON.parse(ok(await beautify('msgpack', SAMPLES.msgpack)))).toEqual({ name: 'FormatX', version: 1, tags: ['fast', 'local'] });
    const r = await convert('yaml', 'msgpack', 'a: 1\nb: [true, null, "x"]\n', { binaryEncoding: 'base64' });
    expect(r.ok).toBe(true);
    expect(JSON.parse(ok(await convert('msgpack', 'json', r.text!)))).toEqual({ a: 1, b: [true, null, 'x'] });
    expect((await check('msgpack', '93 01 02')).validation.status).toBe('invalid');
  });
});

describe('Protocol Buffers', () => {
  it('validates the sample including well-known imports', async () => {
    const r = await check('protobuf', SAMPLES.protobuf);
    expect(r.validation.counts.error).toBe(0);
    expect(r.stats.facts).toMatchObject({ Syntax: 'proto3', Messages: 2, Services: 1 });
  });

  it('reports syntax errors and proto3 rules', async () => {
    expect((await errorsOf('protobuf', 'syntax = "proto3";\nmessage A { int32 x = 1 }'))[0].range?.line).toBe(2);
    const codes = await codesOf('protobuf', 'syntax = "proto3";\nenum E { A = 1; }\nmessage M { string name = 19500; Missing m = 2; }');
    expect(codes).toEqual(expect.arrayContaining(['protobuf/proto3-enum-zero', 'protobuf/reserved-number', 'protobuf/unresolved-type']));
  });

  it('formats .proto files without changing the schema', async () => {
    const out = ok(await beautify('protobuf', 'syntax="proto3";\nmessage A{int32 id=1;map<string,int32> m=2 [deprecated=true];}\nservice S{rpc Get(A) returns (A);}'));
    expect(out).toBe('syntax = "proto3";\nmessage A {\n  int32 id = 1;\n  map<string, int32> m = 2 [deprecated = true];\n}\nservice S {\n  rpc Get(A) returns (A);\n}\n');
  });

  it('converts to a JSON descriptor', async () => {
    const json = JSON.parse(ok(await convert('protobuf', 'json', 'syntax = "proto3";\nmessage A { int32 id = 1; }')));
    expect(json.nested.A.fields.id).toEqual({ type: 'int32', id: 1 });
  });
});

describe('PHP, Java, Python', () => {
  it('PHP: validates, formats and minifies', async () => {
    expect((await check('php', SAMPLES.php)).validation.counts.error).toBe(0);
    const [err] = await errorsOf('php', '<?php\n$a = ;\n');
    expect(err.range?.line).toBe(2);
    expect(ok(await beautify('php', '<?php\n$a=[1,2];echo $a[0];'))).toBe('<?php\n$a = [1, 2];\necho $a[0];\n');
    expect(ok(await minify('php', '<?php\n// comment\n$a = 1 ;\necho   $a;\n'))).toBe('<?php $a=1;echo $a;');
  });

  it('Java: validates and formats', async () => {
    expect((await check('java', SAMPLES.java)).validation.counts.error).toBe(0);
    const [err] = await errorsOf('java', 'class A {\n  void f() { int x = ; }\n}');
    expect(err.range).toMatchObject({ line: 2 });
    expect(err.message).toContain("Unexpected ';'");
    expect(ok(await beautify('java', 'class A{void f(){int x=1;}}'))).toBe('class A {\n\n  void f() {\n    int x = 1;\n  }\n}\n');
  });

  it('Python: Ruff validation, lint and formatting', async () => {
    expect((await check('python', SAMPLES.python)).validation.counts.error).toBe(0);
    const [err] = await errorsOf('python', 'def f(:\n    pass\n');
    expect(err.code).toBe('python/syntax-error');
    const lint = await check('python', 'import os\n');
    expect(lint.validation.diagnostics[0].code).toBe('python/f401');
    expect(lint.validation.diagnostics[0].fix).toBeDefined();
    expect(ok(await beautify('python', "x = {  'a':1 }\ndef f( a ):\n  return a"))).toBe('x = {"a": 1}\n\n\ndef f(a):\n    return a\n');
  });

  it('Python fallback checker catches structural errors', async () => {
    const { pythonFallbackCheck } = await import('../src/parsers/python/fallback');
    const { LineIndex } = await import('../src/utils/lineIndex');
    const { DEFAULT_OPTIONS } = await import('../src/types/options');
    const src = 'def f(x)\n    return (x\nif True:\nprint("y)\n';
    const codes = pythonFallbackCheck(src, { options: DEFAULT_OPTIONS, lines: new LineIndex(src) }).map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['python/missing-colon', 'python/unterminated-string']));
  });
});

describe('quick fixes are explicit edits', () => {
  it('applies an XML fix as a text edit', async () => {
    const input = '<a>x &nbsp; y</a>';
    const [err] = await errorsOf('xml', input);
    expect((await check('xml', applyFix(input, err.fix!))).validation.status).toBe('valid');
  });
});
