import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { applyFix, beautify, check, codesOf, convert, errorsOf, minify, ok } from './helpers';

describe('XML validation', () => {
  it('accepts a well-formed document', async () => {
    const r = await check('xml', '<?xml version="1.0"?>\n<root a="1"><child>text &amp; more</child><empty/></root>');
    expect(r.validation.status).toBe('valid');
    expect(r.stats.facts.Elements).toBe(3);
  });

  it('reports mismatched closing tags with the opening location', async () => {
    const errs = await errorsOf('xml', '<root>\n  <a>\n    <b>x</a>\n</root>');
    expect(errs.map((e) => e.code)).toEqual(['xml/unclosed-element']);
    expect(errs[0].range?.line).toBe(3);
    expect(errs[0].fix?.edits[0].text).toBe('</b>');
  });

  it('reports unclosed elements at end of input with a fix', async () => {
    const input = '<root><a>1</a>';
    const errs = await errorsOf('xml', input);
    expect(errs[0].code).toBe('xml/unclosed-element');
    expect((await check('xml', applyFix(input, errs[0].fix!))).validation.status).toBe('valid');
  });

  it('reports a closing tag without opening tag', async () => {
    expect(await codesOf('xml', '<root></a></root>')).toEqual(['xml/unexpected-end-tag']);
  });

  it('reports attribute problems', async () => {
    const codes = await codesOf('xml', '<r a=1 b="2" b="3" c d="x"e="y"></r>');
    expect(codes).toEqual(expect.arrayContaining(['xml/unquoted-attribute', 'xml/duplicate-attribute', 'xml/attribute-without-value', 'xml/missing-attribute-whitespace']));
  });

  it('reports unescaped special characters and undefined entities', async () => {
    const codes = await codesOf('xml', '<r>a & b < c &nbsp; &#x41;</r>');
    expect(codes).toEqual(['xml/unescaped-ampersand', 'xml/unescaped-lt', 'xml/undeclared-entity']);
  });

  it('accepts entities declared in an internal DTD subset', async () => {
    const r = await check('xml', '<!DOCTYPE r [<!ENTITY co "Company">]>\n<r>&co;</r>');
    expect(r.validation.status).toBe('valid');
  });

  it('enforces a single root and no text outside it', async () => {
    expect(await codesOf('xml', '<a/><b/>')).toEqual(['xml/multiple-roots']);
    expect(await codesOf('xml', 'hello <a/>')).toEqual(['xml/text-outside-root']);
  });

  it('checks declaration position, comments and CDATA', async () => {
    expect(await codesOf('xml', '\n<?xml version="1.0"?><r/>')).toEqual(['xml/decl-position']);
    expect(await codesOf('xml', '<r><!-- a -- b --></r>')).toEqual(['xml/double-hyphen-in-comment']);
    expect(await codesOf('xml', '<r><![CDATA[ unclosed </r>')).toContain('xml/unterminated-cdata');
  });

  it('warns about undeclared namespace prefixes', async () => {
    const r = await check('xml', '<soap:Envelope><soap:Body/></soap:Envelope>');
    expect(r.validation.counts).toMatchObject({ error: 0 });
    expect(r.validation.diagnostics[0].code).toBe('xml/undeclared-prefix');
  });

  it('agrees with fast-xml-parser on a corpus', async () => {
    const corpus = [
      '<a><b c="1"/><d>x</d></a>',
      '<a><b></a>',
      '<a b="1" b="2"/>',
      '<?xml version="1.0" encoding="UTF-8"?><root><x>&lt;&gt;</x></root>',
      '<a><![CDATA[<not markup>]]></a>',
      '<a></b>',
      '<a b=c/>',
    ];
    for (const c of corpus) {
      const ours = (await check('xml', c)).validation.counts.error === 0;
      const theirs = XMLValidator.validate(c) === true;
      expect(ours, c).toBe(theirs);
    }
  });
});

describe('XML formatting', () => {
  it('indents element-only content and keeps text-only elements inline', async () => {
    const out = ok(await beautify('xml', '<?xml version="1.0"?><root><a x="1"><b>hello</b><c/></a><!-- note --></root>'));
    expect(out).toBe('<?xml version="1.0"?>\n<root>\n  <a x="1">\n    <b>hello</b>\n    <c />\n  </a>\n  <!-- note -->\n</root>\n');
  });

  it('never re-indents mixed content or xml:space="preserve"', async () => {
    const input = '<doc><p>Hello <b>world</b>, again</p><pre xml:space="preserve">  a\n    b</pre></doc>';
    const out = ok(await beautify('xml', input));
    expect(out).toContain('<p>Hello <b>world</b>, again</p>');
    expect(out).toContain('<pre xml:space="preserve">  a\n    b</pre>');
  });

  it('is idempotent and minifies back', async () => {
    const input = '<r>\n  <a k="v">1</a>\n  <!-- c -->\n  <b>\n    <c/>\n  </b>\n</r>';
    const once = ok(await beautify('xml', input));
    expect(ok(await beautify('xml', once))).toBe(once);
    const min = await minify('xml', input);
    expect(ok(min)).toBe('<r><a k="v">1</a><b><c/></b></r>');
  });

  it('wraps long attribute lists', async () => {
    const out = ok(await beautify('xml', '<r><element-with-long-name attribute-one="value-one" attribute-two="value-two" attribute-three="3"/></r>', { printWidth: 60 }));
    expect(out).toContain('<element-with-long-name\n    attribute-one="value-one"');
  });

  it('preserves unicode', async () => {
    expect(ok(await beautify('xml', '<r><n>日本語 café</n></r>'))).toContain('<n>日本語 café</n>');
  });
});

describe('XML conversion', () => {
  it('XML → JSON uses @_ attributes, #text and arrays', async () => {
    const out = ok(await convert('xml', 'json', '<lib><book id="1"><t>A</t></book><book id="2"><t>B</t></book><price cur="USD">9.5</price></lib>'));
    expect(JSON.parse(out)).toEqual({ lib: { book: [{ '@_id': 1, t: 'A' }, { '@_id': 2, t: 'B' }], price: { '@_cur': 'USD', '#text': 9.5 } } });
  });

  it('keeps leading zeros as strings when inferring types', async () => {
    const out = ok(await convert('xml', 'json', '<r><zip>007</zip><n>42</n><b>true</b></r>'));
    expect(JSON.parse(out)).toEqual({ r: { zip: '007', n: 42, b: true } });
  });

  it('JSON → XML round-trips with warnings for nulls', async () => {
    const r = await convert('json', 'xml', '{"r": {"@_id": "x", "name": "A & B", "tags": ["a", "b"], "none": null}}');
    const xml = ok(r);
    expect(xml).toContain('<r id="x">');
    expect(xml).toContain('<name>A &amp; B</name>');
    expect(xml).toContain('<tags>a</tags>\n  <tags>b</tags>');
    expect(r.warnings.some((w) => w.code === 'convert/null-as-empty')).toBe(true);
    expect((await check('xml', xml)).validation.status).toBe('valid');
  });

  it('wraps multi-key objects in <root> and sanitizes names', async () => {
    const r = await convert('json', 'xml', '{"first name": 1, "2nd": 2}');
    const xml = ok(r);
    expect(xml).toContain('<root>');
    expect(xml).toContain('<first_name>1</first_name>');
    expect(r.warnings.some((w) => w.code === 'convert/renamed-keys')).toBe(true);
  });
});
