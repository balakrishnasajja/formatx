import { describe, expect, it } from 'vitest';
import { applyFix, beautify, check, codesOf, convert, errorsOf, minify, ok } from './helpers';

describe('CSV / TSV', () => {
  it('validates RFC 4180 with quoted delimiters, quotes and newlines', async () => {
    const r = await check('csv', 'a,b,c\n1,"x, y","say ""hi"""\n2,"multi\nline",3\n');
    expect(r.validation.status).toBe('valid');
    expect(r.stats.facts).toMatchObject({ Rows: 2, Columns: 3, Delimiter: 'comma' });
  });

  it('reports inconsistent column counts with exact positions', async () => {
    const errs = await errorsOf('csv', 'id,name\n1,Ada\n2,Grace,extra\n3\n');
    expect(errs.map((e) => e.code)).toEqual(['csv/too-many-fields', 'csv/too-few-fields']);
    expect(errs[0].range?.line).toBe(3);
    expect(errs[1].message).toContain('Row 4');
  });

  it('offers a fix for missing fields', async () => {
    const input = 'a,b,c\n1,2\n';
    const [err] = await errorsOf('csv', input);
    expect((await check('csv', applyFix(input, err.fix!))).validation.status).toBe('valid');
  });

  it('reports unclosed quotes and text after a closing quote', async () => {
    expect(await codesOf('csv', 'a,b\n"open,1\n')).toContain('csv/unclosed-quote');
    expect(await codesOf('csv', 'a,b\n"x"y,1\n')).toContain('csv/text-after-quote');
  });

  it('auto-detects semicolon delimiters', async () => {
    const r = await check('csv', 'a;b;c\n1;2;3\n4;5;6\n');
    expect(r.stats.facts.Delimiter).toBe('semicolon');
  });

  it('normalizes quoting without trimming values', async () => {
    const out = ok(await beautify('csv', '"a","b"\n"1"," spaced "\n\n"x,y","z"\n'));
    expect(out).toBe('a,b\n1, spaced \n"x,y",z\n');
  });

  it('keeps CRLF inside quoted fields when changing line endings', async () => {
    const out = ok(await minify('csv', 'a,b\r\n"l1\r\nl2",2\r\n', { lineEnding: 'lf' }));
    expect(out).toBe('a,b\n"l1\r\nl2",2');
  });

  it('CSV → JSON infers types conservatively', async () => {
    const out = ok(await convert('csv', 'json', 'zip,n,f,b,s\n007,42,1.5,true,1.50\n'));
    expect(JSON.parse(out)).toEqual([{ zip: '007', n: 42, f: 1.5, b: true, s: '1.50' }]);
  });

  it('JSON → CSV flattens nested data with warnings', async () => {
    const r = await convert('json', 'csv', '[{"id": 1, "user": {"name": "A"}, "tags": ["x", "y"]}, {"id": 2, "user": {"name": "B, Jr."}}]');
    expect(ok(r)).toBe('id,user.name,tags.0,tags.1\n1,A,x,y\n2,"B, Jr.",,\n');
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['convert/flattened', 'convert/sparse-rows']));
  });

  it('CSV → JSON unflattens dotted headers', async () => {
    const out = ok(await convert('csv', 'json', 'id,user.name,tags.0\n1,A,x\n'));
    expect(JSON.parse(out)).toEqual([{ id: 1, user: { name: 'A' }, tags: ['x'] }]);
  });

  it('handles TSV', async () => {
    expect((await check('tsv', 'a\tb\n1\t2\n')).validation.status).toBe('valid');
    const out = ok(await convert('tsv', 'json', 'a\tb\n1\thello world\n'));
    expect(JSON.parse(out)).toEqual([{ a: 1, b: 'hello world' }]);
  });
});

describe('INI', () => {
  it('validates sections and keys', async () => {
    expect((await check('ini', '[a]\nx = 1\n; c\n[b]\ny: 2\n')).validation.status).toBe('valid');
    expect(await codesOf('ini', '[a\nx=1')).toContain('ini/unclosed-section');
    expect(await codesOf('ini', '[a]\nthis is wrong\n')).toContain('ini/invalid-line');
    expect(await codesOf('ini', '[a]\nx=1\nx=2\n')).toContain('ini/duplicate-key');
  });

  it('beautifies and minifies', async () => {
    const input = '; head\nglobal=1\n[db]\nhost=localhost ; inline\nport   =  5432\n[paths]\ndir=/tmp';
    expect(ok(await beautify('ini', input))).toBe('; head\nglobal = 1\n\n[db]\nhost = localhost ; inline\nport = 5432\n\n[paths]\ndir = /tmp\n');
    expect(ok(await minify('ini', input))).toBe('global=1\n[db]\nhost=localhost\nport=5432\n[paths]\ndir=/tmp');
  });

  it('converts INI ↔ JSON', async () => {
    const json = ok(await convert('ini', 'json', 'name=app\n[db]\nport=5432\nhost="local host"\n'));
    expect(JSON.parse(json)).toEqual({ name: 'app', db: { port: 5432, host: 'local host' } });
    const ini = ok(await convert('json', 'ini', '{"name": "app", "db": {"port": 5432, "tags": ["a", "b"]}}'));
    expect(ini).toBe('name = app\n\n[db]\nport = 5432\ntags[] = a\ntags[] = b\n');
  });
});

describe('ENV', () => {
  it('validates dotenv syntax', async () => {
    expect((await check('env', 'A=1\nexport B="two words"\n# c\nC=\'lit\'\n')).validation.status).toBe('valid');
    expect(await codesOf('env', 'NOT_ASSIGNED\n')).toContain('env/missing-equals');
    expect(await codesOf('env', 'MY-VAR=1\n')).toContain('env/key-not-portable');
    expect(await codesOf('env', '1BAD=1\n')).toContain('env/invalid-key');
    expect(await codesOf('env', 'A="open\n')).toContain('env/unterminated-quote');
    expect(await codesOf('env', 'A=1\nA=2\n')).toContain('env/duplicate-key');
  });

  it('supports multi-line quoted values', async () => {
    const out = ok(await convert('env', 'json', 'KEY="line1\nline2"\nOTHER=x\n', { inferTypes: false }));
    expect(JSON.parse(out)).toEqual({ KEY: 'line1\nline2', OTHER: 'x' });
  });

  it('beautifies by removing spaces around =', async () => {
    expect(ok(await beautify('env', 'A = 1\n\n\n# c\nB=2 # note\n'))).toBe('A=1\n\n# c\nB=2 # note\n');
  });

  it('JSON → ENV flattens to UPPER_SNAKE_CASE', async () => {
    const out = ok(await convert('json', 'env', '{"database": {"host": "db", "port": 5432}, "apiKey": "a b"}'));
    expect(out).toBe('DATABASE_HOST=db\nDATABASE_PORT=5432\nAPI_KEY="a b"\n');
  });
});

describe('Properties', () => {
  it('implements java.util.Properties rules', async () => {
    const out = ok(await convert('properties', 'json', 'a=1\nb : two\nc three\nd=line \\\n    continued\ne=Caf\\u00e9\n! comment\nf=\n', { expandDottedKeys: false, inferTypes: false }));
    expect(JSON.parse(out)).toEqual({ a: '1', b: 'two', c: 'three', d: 'line continued', e: 'Café', f: '' });
  });

  it('reports malformed unicode escapes and duplicates', async () => {
    expect(await codesOf('properties', 'a=\\u12G4\n')).toContain('properties/malformed-unicode');
    expect(await codesOf('properties', 'a=1\na=2\n')).toContain('properties/duplicate-key');
  });

  it('expands dotted keys and Spring lists', async () => {
    const out = ok(await convert('properties', 'json', 'server.port=8080\nserver.host=x\napp.list[0]=a\napp.list[1]=b\n'));
    expect(JSON.parse(out)).toEqual({ server: { port: 8080, host: 'x' }, app: { list: ['a', 'b'] } });
  });

  it('JSON → properties escapes and flattens', async () => {
    const out = ok(await convert('json', 'properties', '{"server": {"port": 8080}, "list": ["a", "b"], "msg": "line\\nnext", "key with space": "v"}'));
    expect(out).toBe('server.port=8080\nlist[0]=a\nlist[1]=b\nmsg=line\\nnext\nkey\\ with\\ space=v\n');
  });

  it('beautify keeps trailing spaces and continuations; minify joins them', async () => {
    const input = 'a = 1  \nb=x\\\n   y\n';
    expect(ok(await beautify('properties', input))).toBe('a=1  \nb=x\\\n    y\n');
    expect(ok(await minify('properties', input))).toBe('a=1  \nb=xy');
  });
});
