import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/parsers/samples';
import type { FormatId } from '../src/types/formats';
import { check } from './helpers';

async function detect(input: string, fileName?: string) {
  const { analyze } = await import('../src/engines/engine');
  const { DEFAULT_OPTIONS } = await import('../src/types/options');
  return analyze({ input, formatId: 'auto', options: DEFAULT_OPTIONS, hint: { fileName } });
}

describe('format detection — every sample', () => {
  const ids = Object.keys(SAMPLES) as FormatId[];
  // MessagePack bytes are indistinguishable from arbitrary hex without a file extension.
  for (const id of ids.filter((x) => x !== 'msgpack')) {
    it(`detects the ${id} sample`, async () => {
      const r = await detect(SAMPLES[id]);
      expect(r.formatId, JSON.stringify(r.detection.candidates.slice(0, 3))).toBe(id);
    });
  }
  it('detects MessagePack from the file extension', async () => {
    expect((await detect(SAMPLES.msgpack, 'data.msgpack')).formatId).toBe('msgpack');
  });
});

describe('format detection — ambiguous and incomplete input', () => {
  const cases: [string, string, FormatId | null][] = [
    ['strict JSON beats YAML (JSON is valid YAML)', '{"a": [1, 2], "b": {"c": null}}', 'json'],
    ['JSON with comments', '{\n  // c\n  "a": 1\n}', 'jsonc'],
    ['JSON5 with unquoted keys', "{a: 1, b: 'two'}", 'json5'],
    ['incomplete JSON is still JSON', '{"name": "Krish", "age": ', 'json'],
    ['invalid JSON with a trailing comma stays JSON', '{\n  "name": "Krish"\n  "tags": [1, 2,]\n', 'json'],
    ['JSON array of objects', '[{"id": 1}, {"id": 2}]', 'json'],
    ['YAML mapping', 'name: app\nversion: 2\nitems:\n  - a\n  - b\n', 'yaml'],
    ['TOML with typed values', 'title = "x"\n[owner]\nname = "y"\nage = 3\n', 'toml'],
    ['INI with bare values', '[db]\nhost=localhost\nport=5432\n', 'ini'],
    ['ENV file', 'NODE_ENV=production\nPORT=3000\nAPI_URL=https://x\n', 'env'],
    ['Properties with dotted keys', 'server.port=8080\nspring.datasource.url=jdbc:x\n', 'properties'],
    ['CSV', 'a,b,c\n1,2,3\n4,5,6\n', 'csv'],
    ['TSV', 'a\tb\tc\n1\t2\t3\n', 'tsv'],
    ['XML with declaration', '<?xml version="1.0"?><r/>', 'xml'],
    ['custom-tag XML without declaration', '<order id="1"><item sku="x"/></order>', 'xml'],
    ['HTML fragment', '<div class="a"><p>Hello <b>x</b></p><br></div>', 'html'],
    ['unclosed XML still XML', '<config><server port="80">', 'xml'],
    ['CSS', '.a { color: red; }\n#b > p { margin: 0 }', 'css'],
    ['SCSS', '$x: 1px;\n.a { &:hover { margin: $x; } }', 'scss'],
    ['JavaScript', 'const x = (a) => a * 2;\nexport default x;', 'javascript'],
    ['TypeScript', 'interface A { x: number }\nexport const f = (a: A): number => a.x;', 'typescript'],
    ['SQL', 'select * from users where id = 1', 'sql'],
    ['GraphQL anonymous query', '{ user(id: 1) { name } }', 'graphql'],
    ['Python', 'def f(x):\n    return x * 2\n\nprint(f(2))\n', 'python'],
    ['Markdown', '# Title\n\nSome **bold** text and a [link](https://x.y).\n\n- a\n- b\n', 'markdown'],
    ['plain prose is not classified', 'Hello there, this is just a sentence.', null],
  ];
  for (const [label, input, expected] of cases) {
    it(label, async () => {
      const r = await detect(input);
      expect(r.formatId, JSON.stringify(r.detection.candidates.slice(0, 3))).toBe(expected);
    });
  }

  it('reports confidence and alternatives', async () => {
    const r = await detect('{"name":"Krish","age":25}');
    expect(r.detection.best?.confidence).toBeGreaterThan(0.9);
    expect(r.detection.candidates.length).toBeGreaterThan(1);
  });

  it('uses the file extension as a strong hint', async () => {
    expect((await detect('a = 1', 'config.toml')).formatId).toBe('toml');
  });

  it('manual mode validates with the forced parser', async () => {
    const r = await check('yaml', '{"a": 1}');
    expect(r.formatId).toBe('yaml');
    expect(r.mode).toBe('manual');
    expect(r.validation.status).toBe('valid');
  });
});
