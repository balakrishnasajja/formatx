import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { applyFix, beautify, check, codesOf, convert, minify, ok } from './helpers';

describe('YAML', () => {
  it('validates and reports structural errors with positions', async () => {
    expect((await check('yaml', 'a: 1\nb:\n  - x\n  - y\n')).validation.status).toBe('valid');
    const r = await check('yaml', 'a: 1\n  b: 2\n');
    expect(r.validation.status).toBe('invalid');
    // the library anchors this error at the start of the offending implicit key ("1" on line 1)
    expect(r.validation.diagnostics[0].range?.line).toBe(1);
    expect(r.validation.diagnostics.some((d) => d.range && d.range.endLine >= 2)).toBe(true);
    const flow = await check('yaml', 'a: [1, 2\nb: 3\n');
    expect(flow.validation.status).toBe('invalid');
  });

  it('rejects duplicate keys and tab indentation (with a fix)', async () => {
    expect(await codesOf('yaml', 'a: 1\na: 2\n')).toContain('yaml/duplicate-key');
    const input = 'a:\n\t- x\n';
    const r = await check('yaml', input);
    const tab = r.validation.diagnostics.find((d) => d.code === 'yaml/tab-as-indent')!;
    expect(tab).toBeDefined();
    expect((await check('yaml', applyFix(input, tab.fix!))).validation.status).toBe('valid');
  });

  it('beautifies with comments preserved and re-indents', async () => {
    const out = ok(await beautify('yaml', '# top\nroot:\n    child: 1   # inline\n    list:\n    -   a\n    -   b\n'));
    expect(out).toBe('# top\nroot:\n  child: 1 # inline\n  list:\n    - a\n    - b\n');
  });

  it('keeps multi-document streams', async () => {
    const out = ok(await beautify('yaml', 'a: 1\n---\nb: 2\n'));
    expect(out).toBe('a: 1\n---\nb: 2\n');
  });

  it('minifies to flow style', async () => {
    const out = ok(await minify('yaml', 'a: 1\nb:\n  - x\n  - y\nc:\n  d: true\n'));
    expect(out).toBe('{a: 1, b: [x, y], c: {d: true}}');
    expect(parseYaml(out)).toEqual({ a: 1, b: ['x', 'y'], c: { d: true } });
  });

  it('converts YAML ↔ JSON preserving types and order', async () => {
    const json = ok(await convert('yaml', 'json', 'name: Krish\nage: 25\nbig: 12345678901234567890\nflag: yes\nempty: null\nlist: [1, "2", 3.5]\n'));
    expect(json).toContain('"big": 12345678901234567890');
    expect(JSON.parse(json)).toMatchObject({ name: 'Krish', age: 25, flag: 'yes', empty: null, list: [1, '2', 3.5] });
    const yaml = ok(await convert('json', 'yaml', '{"s": "true", "n": "123", "e": "", "x": null, "nested": {"k": [1, {"a": "b"}]}}'));
    expect(parseYaml(yaml)).toEqual({ s: 'true', n: '123', e: '', x: null, nested: { k: [1, { a: 'b' }] } });
  });

  it('expands aliases with a notice when converting', async () => {
    const r = await convert('yaml', 'json', 'base: &b {x: 1}\nother: *b\n');
    expect(JSON.parse(ok(r))).toEqual({ base: { x: 1 }, other: { x: 1 } });
    expect(r.warnings.some((w) => w.code === 'convert/aliases-expanded')).toBe(true);
  });
});

describe('TOML', () => {
  it('validates with line/column from smol-toml', async () => {
    const r = await check('toml', 'a = 1\nname = John\n');
    expect(r.validation.status).toBe('invalid');
    expect(r.validation.diagnostics[0].range?.line).toBe(2);
    expect(await codesOf('toml', 'a = 1\na = 2')).toEqual(['toml/parse-error']);
  });

  it('beautifies while preserving comments and data', async () => {
    const input = '# config\ntitle="x"   # the title\n[server]\nports=[ 8000,8001 ]\nlimits = {cpu=1,mem="2G"}\n[[users]]\nname="a"\n[[users]]\nname="b"\n';
    const out = ok(await beautify('toml', input));
    expect(out).toBe('# config\ntitle = "x" # the title\n\n[server]\nports = [8000, 8001]\nlimits = { cpu = 1, mem = "2G" }\n\n[[users]]\nname = "a"\n\n[[users]]\nname = "b"\n');
    expect(parseToml(out)).toEqual(parseToml(input));
  });

  it('formats multi-line arrays with comments', async () => {
    const out = ok(await beautify('toml', 'a = [\n  1, # one\n  # before two\n  2\n]\n'));
    expect(out).toBe('a = [\n  1, # one\n  # before two\n  2,\n]\n');
  });

  it('keeps multi-line strings and dates verbatim', async () => {
    const input = 'text = """\nline 1\n  line 2"""\nwhen = 1979-05-27 07:32:00Z\nlit = \'\'\'raw\\n\'\'\'\n';
    const out = ok(await beautify('toml', input));
    expect(out).toContain('"""\nline 1\n  line 2"""');
    expect(out).toContain('when = 1979-05-27 07:32:00Z');
    expect(parseToml(out)).toEqual(parseToml(input));
  });

  it('minifies', async () => {
    const out = ok(await minify('toml', '# c\na = [ 1, 2 ]\n\n[t]\nb = { x = 1 }\n'));
    expect(out).toBe('a=[1,2]\n[t]\nb={x=1}');
  });

  it('converts TOML → JSON (dates become strings) and JSON → TOML', async () => {
    const json = ok(await convert('toml', 'json', 'd = 1979-05-27T07:32:00-08:00\n[t]\nn = 1\n'));
    expect(JSON.parse(json)).toEqual({ d: '1979-05-27T07:32:00.000-08:00', t: { n: 1 } });
    const r = await convert('json', 'toml', '{"title": "x", "nested": {"a": [1, 2], "inner": {"k": "v"}}, "servers": [{"name": "a"}, {"name": "b"}], "nothing": null, "weird key": true}');
    const toml = ok(r);
    expect(parseToml(toml)).toEqual({ title: 'x', nested: { a: [1, 2], inner: { k: 'v' } }, servers: [{ name: 'a' }, { name: 'b' }], 'weird key': true });
    expect(r.warnings.some((w) => w.code === 'convert/null-dropped')).toBe(true);
  });

  it('wraps a root array when converting to TOML', async () => {
    const r = await convert('json', 'toml', '[{"a": 1}, {"a": 2}]');
    expect(parseToml(ok(r))).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });
});
