import { describe, expect, it } from 'vitest';
import { applyFix, beautify, check, codesOf, convert, errorsOf, minify, ok } from './helpers';

describe('JSON validation', () => {
  it('accepts the example from the spec and detects it as JSON', async () => {
    const r = await check('auto', '{\n"name":"Krish",\n"age":25\n}');
    expect(r.formatId).toBe('json');
    expect(r.validation.status).toBe('valid');
    expect(r.detection.best?.confidence).toBeGreaterThan(0.9);
  });

  it('reports a missing comma at the end of the previous value', async () => {
    const errs = await errorsOf('json', '{\n  "name": "Krish"\n  "age": 25\n}');
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe('json/missing-comma');
    expect(errs[0].range).toMatchObject({ line: 2, column: 17 });
    expect(errs[0].fix).toBeDefined();
  });

  it('quick fix for missing comma produces valid JSON', async () => {
    const input = '{\n  "name": "Krish"\n  "age": 25\n}';
    const [err] = await errorsOf('json', input);
    const fixed = applyFix(input, err.fix!);
    expect((await check('json', fixed)).validation.status).toBe('valid');
  });

  it('reports a missing colon', async () => {
    const errs = await errorsOf('json', '{"a" 1}');
    expect(errs.map((e) => e.code)).toEqual(['json/missing-colon']);
  });

  it('reports a missing closing brace at the opening brace and offers a fix', async () => {
    const input = '{\n  "a": {\n    "b": 1\n  }\n';
    const errs = await errorsOf('json', input);
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe('json/unclosed-object');
    expect(errs[0].range?.line).toBe(1);
    expect((await check('json', applyFix(input, errs[0].fix!))).validation.status).toBe('valid');
  });

  it('reports mismatched brackets', async () => {
    const errs = await errorsOf('json', '{"a": [1, 2}');
    expect(errs[0].code).toBe('json/mismatched-bracket');
  });

  it('reports a missing opening bracket / unexpected closer', async () => {
    const errs = await errorsOf('json', '[1, 2]]');
    expect(errs[0].code).toBe('json/trailing-content');
  });

  it('treats trailing commas per dialect', async () => {
    expect(await codesOf('json', '{"a": 1,}')).toEqual(['json/trailing-comma']);
    const jsonc = await check('jsonc', '{"a": 1,}');
    expect(jsonc.validation.counts).toMatchObject({ error: 0, warning: 1 });
    expect((await check('json5', '{"a": 1,}')).validation.status).toBe('valid');
  });

  it('rejects single quotes in JSON with a conversion fix', async () => {
    const input = "{'name': 'Krish'}";
    const errs = await errorsOf('json', input);
    expect(errs.every((e) => e.code === 'json/single-quotes')).toBe(true);
    let fixed = input;
    for (const e of [...errs].reverse()) fixed = applyFix(fixed, e.fix!);
    expect(fixed).toBe('{"name": "Krish"}');
  });

  it('rejects comments in strict JSON but accepts them in JSONC', async () => {
    const input = '{\n  // comment\n  "a": 1 /* x */\n}';
    expect(await codesOf('json', input)).toEqual(['json/comment-not-allowed', 'json/comment-not-allowed']);
    expect((await check('jsonc', input)).validation.status).toBe('valid');
  });

  it('rejects unquoted keys in JSON but accepts them in JSON5', async () => {
    expect(await codesOf('json', '{a: 1}')).toEqual(['json/unquoted-key']);
    expect((await check('json5', "{a: 1, b: 'x', c: 0xFF, d: .5, e: +1, f: Infinity}")).validation.status).toBe('valid');
  });

  it('warns about duplicate keys with the first location', async () => {
    const r = await check('json', '{"a": 1,\n "a": 2}');
    expect(r.validation.status).toBe('warnings');
    const d = r.validation.diagnostics[0];
    expect(d.code).toBe('json/duplicate-key');
    expect(d.related?.[0].line).toBe(1);
  });

  it('suggests fixes for Python/JS literals', async () => {
    const errs = await errorsOf('json', '{"a": True, "b": None, "c": undefined, "d": NaN}');
    expect(errs.map((e) => e.fix?.edits[0].text)).toEqual(['true', 'null', 'null', 'null']);
  });

  it('detects invalid escapes and control characters', async () => {
    const errs = await errorsOf('json', '{"a": "bad \\x escape", "b": "tab\there"}');
    expect(errs.map((e) => e.code)).toEqual(['json/invalid-escape', 'json/control-character']);
  });

  it('reports unterminated strings without cascading', async () => {
    const errs = await errorsOf('json', '{\n  "a": "abc,\n  "b": 1\n}');
    expect(errs[0].code).toBe('json/unterminated-string');
    expect(errs[0].range?.line).toBe(2);
  });

  it('flags invalid numbers', async () => {
    expect(await codesOf('json', '[01, .5, 5., +1, 0x1F, 12px]')).toEqual([
      'json/leading-zero',
      'json/leading-dot',
      'json/trailing-dot',
      'json/leading-plus',
      'json/hex-number',
      'json/invalid-number',
    ]);
  });

  it('handles empty input and comment-only input', async () => {
    expect((await check('json', '   \n ')).validation.status).toBe('empty');
    expect(await codesOf('jsonc', '// only a comment')).toEqual(['json/no-value']);
  });

  it('survives extremely deep nesting without crashing', async () => {
    const deep = '['.repeat(5000) + ']'.repeat(5000);
    const r = await check('json', deep);
    expect(r.validation.diagnostics[0].code).toBe('json/too-deep');
    expect(r.validation.diagnostics[0].severity).toBe('warning');
    expect((await convert('json', 'yaml', deep)).ok).toBe(false);
    expect(ok(await beautify('json', deep)).length).toBeGreaterThan(10000);
  });

  it('validates a large document quickly', async () => {
    const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `user-${i}`, tags: ['a', 'b'], score: i / 7 })));
    const t0 = performance.now();
    const r = await check('json', big);
    expect(r.validation.status).toBe('valid');
    expect(performance.now() - t0).toBeLessThan(4000);
  });

  it('agrees with JSON.parse on a corpus of valid documents', async () => {
    const corpus = ['0', '-0.5e-10', '"\\u00e9\\n"', '[]', '{}', '[[],[{}]]', '{"":""}', '"\\ud83d\\ude00"', 'null', '  true  ', '{"a":[1,2,{"b":null}]}'];
    for (const c of corpus) {
      expect(JSON.parse(c)).toBeDefined;
      expect((await check('json', c)).validation.counts.error, c).toBe(0);
    }
  });
});

describe('JSON formatting', () => {
  const ugly = '{"name":"Krish","age":25,"big":12345678901234567890,"dec":0.10000000000000000555,"nested":{"arr":[1,2,{"x":[]}],"empty":{}},"uni":"café ☕ 日本語"}';

  it('beautifies with 2 spaces and preserves exact number literals', async () => {
    const out = ok(await beautify('json', ugly));
    expect(out).toContain('"big": 12345678901234567890');
    expect(out).toContain('"dec": 0.10000000000000000555');
    expect(out).toContain('"uni": "café ☕ 日本語"');
    expect(out).toContain('"empty": {}');
    expect(out.startsWith('{\n  "name": "Krish",')).toBe(true);
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('supports 4 spaces and tabs', async () => {
    expect(ok(await beautify('json', '{"a":1}', { indent: 'spaces4' }))).toBe('{\n    "a": 1\n}\n');
    expect(ok(await beautify('json', '{"a":1}', { indent: 'tab' }))).toBe('{\n\t"a": 1\n}\n');
  });

  it('is idempotent', async () => {
    const once = ok(await beautify('json', ugly));
    expect(ok(await beautify('json', once))).toBe(once);
  });

  it('minifies without touching literals', async () => {
    const pretty = ok(await beautify('json', ugly));
    expect(ok(await minify('json', pretty))).toBe(ugly);
  });

  it('sorts keys when requested', async () => {
    const out = ok(await beautify('json', '{"b":1,"a":{"d":1,"c":2}}', { sortKeys: true }));
    expect(out).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  });

  it('respects CRLF line endings', async () => {
    expect(ok(await beautify('json', '{"a":1}', { lineEnding: 'crlf' }))).toBe('{\r\n  "a": 1\r\n}\r\n');
  });

  it('refuses to format invalid JSON', async () => {
    const r = await beautify('json', '{"a": 1');
    expect(r.ok).toBe(false);
    expect(r.blockedBy?.error).toBe(1);
  });

  it('keeps JSONC comments in place', async () => {
    const out = ok(await beautify('jsonc', '{\n// leading\n"a":1, // trailing a\n/* block */ "b":[1,2,],\n\n"c":{}}'));
    expect(out).toBe('{\n  // leading\n  "a": 1, // trailing a\n  /* block */ "b": [\n    1,\n    2,\n  ],\n\n  "c": {}\n}\n');
  });

  it('keeps JSON5 syntax as written', async () => {
    const out = ok(await beautify('json5', "{a:'x',b:0xFF,c:.5,}"));
    expect(out).toBe("{\n  a: 'x',\n  b: 0xFF,\n  c: .5,\n}\n");
  });

  it('removes comments when minifying JSONC and reports it', async () => {
    const r = await minify('jsonc', '{ /* c */ "a": 1 // d\n}');
    expect(ok(r)).toBe('{"a":1}');
    expect(r.warnings[0].code).toBe('json/minify-removed-comments');
  });
});

describe('JSON conversion basics', () => {
  it('JSON5 → JSON produces strict JSON', async () => {
    const out = ok(await convert('json5', 'json', "{a: 'x', b: [1, 2,], c: 0x10}"));
    expect(JSON.parse(out)).toEqual({ a: 'x', b: [1, 2], c: 16 });
  });

  it('preserves big integers through conversion', async () => {
    const out = ok(await convert('jsonc', 'json', '{"id": 12345678901234567890}'));
    expect(out).toContain('12345678901234567890');
  });

  it('warns about precision loss for long decimals', async () => {
    const r = await convert('json', 'json5', '{"x": 0.1234567890123456789}');
    expect(r.warnings.some((w) => w.code === 'convert/number-precision')).toBe(true);
  });

  it('keeps integer-like key order', async () => {
    const out = ok(await convert('jsonc', 'json', '{"b": 1, "2": 2, "a": 3}'));
    expect(out.indexOf('"b"')).toBeLessThan(out.indexOf('"2"'));
  });
});
