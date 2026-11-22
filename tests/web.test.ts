import { describe, expect, it } from 'vitest';
import { beautify, check, codesOf, errorsOf, minify, ok, opts } from './helpers';
import { runAction } from '../src/engines/engine';

describe('HTML', () => {
  it('accepts valid documents with optional end tags', async () => {
    const r = await check('html', '<!DOCTYPE html><html lang="en"><head><title>x</title><body><ul><li>a<li>b</ul><p>one<p>two<table><tr><td>1<td>2</table></body></html>');
    expect(r.validation.counts.error).toBe(0);
  });

  it('reports unclosed and mismatched elements', async () => {
    const errs = await errorsOf('html', '<div><span>hi</div>');
    expect(errs.map((e) => e.code)).toEqual(['html/unclosed-element']);
    expect(errs[0].message).toContain('<span>');
    expect(await codesOf('html', '<div></span></div>')).toContain('html/unmatched-end-tag');
    expect(await codesOf('html', '<section><div>')).toEqual(['html/unclosed-element', 'html/unclosed-element']);
  });

  it('reports tokenizer errors from parse5', async () => {
    expect(await codesOf('html', '<div id="a" id="b"></div>')).toContain('html/duplicate-attribute');
    expect(await codesOf('html', '<div class="x"')).toContain('html/eof-in-tag');
  });

  it('flags stray </p>, void end tags, duplicate ids and missing alt', async () => {
    const codes = await codesOf('html', '<p>a<div>b</div></p><br></br><a id="x"></a><b id="x"></b><img src="a.png">');
    expect(codes).toEqual(expect.arrayContaining(['html/stray-p-end', 'html/void-end-tag', 'html/duplicate-id', 'html/img-alt']));
  });

  it('handles raw text, svg and comments without false positives', async () => {
    const r = await check('html', '<script>if (a < b && c > d) { document.write("</div>") }</script><svg><path d="M0 0"/><circle r="1"/></svg><!-- <div> --><textarea><b></textarea>');
    expect(r.validation.counts.error).toBe(0);
  });

  it('beautifies with Prettier and minifies conservatively', async () => {
    const out = ok(await beautify('html', '<div><p>Hello <b>world</b></p><ul><li>a</li></ul></div>'));
    expect(out).toContain('<p>Hello <b>world</b></p>');
    const min = ok(await minify('html', '<div>\n  <p>  Hello   <b>world</b>  !</p>\n  <!-- remove me -->\n  <pre>  keep\n   this </pre>\n  <input type="text"  value=" a  b "  />\n</div>'));
    expect(min).toBe('<div><p>Hello <b>world</b> !</p><pre>  keep\n   this </pre><input type="text" value=" a  b "></div>');
  });
});

describe('CSS / SCSS', () => {
  it('reports syntax errors with suggestions', async () => {
    const [err] = await errorsOf('css', 'a { color: red;\n\nb { x: y }');
    expect(err.type).toBe('Unclosed block');
    const [semi] = await errorsOf('css', 'a { color: red\n background: blue }');
    expect(semi.type).toBe('Missed semicolon');
    expect(semi.fix).toBeDefined();
  });

  it('lints empty rules and duplicate properties', async () => {
    const r = await check('css', 'a {}\nb { color: red; color: red; margin: 0; margin: 1px }');
    expect(r.validation.diagnostics.map((d) => d.code)).toEqual(['css/empty-rule', 'css/duplicate-property', 'css/duplicate-property']);
  });

  it('beautifies with Prettier', async () => {
    const out = ok(await beautify('css', 'a{color:red;margin:0 auto}'));
    expect(out).toBe('a {\n  color: red;\n  margin: 0 auto;\n}\n');
  });

  it('minifies safely', async () => {
    const out = ok(await minify('css', '/* c */\n/*! keep */\n.a , .b > .c  {\n  color : red ;\n  font-family: "Open  Sans", sans-serif;\n  width: calc(100% - 2 * 10px) !important;\n  background: url( "a b.png" );\n}\n@media screen and (max-width: 640px) {\n  .a { display : none }\n}'));
    expect(out).toBe('/*! keep */.a,.b>.c{color:red;font-family:"Open  Sans",sans-serif;width:calc(100% - 2 * 10px)!important;background:url( "a b.png" )}@media screen and (max-width:640px){.a{display:none}}');
  });

  it('handles SCSS features', async () => {
    const input = '$c: red;\n@mixin m($x) { color: $x; }\n.a { @include m($c); &:hover { color: blue; } // comment\n}';
    expect((await check('scss', input)).validation.counts.error).toBe(0);
    expect(ok(await beautify('scss', input))).toContain('&:hover {');
    const min = ok(await minify('scss', input));
    expect(min).toBe('$c:red;@mixin m($x){color:$x}.a{@include m($c);&:hover{color:blue}}');
  });
});

describe('JavaScript / TypeScript', () => {
  it('reports multiple syntax errors with 1-based columns', async () => {
    const errs = await errorsOf('javascript', 'const a = {\n  b: 1\n  c: 2\n};');
    expect(errs[0].range).toMatchObject({ line: 3, column: 3 });
    expect((await check('javascript', 'export const x = <div className="a">{1}</div>;')).validation.status).toBe('valid');
  });

  it('beautifies and respects quote style', async () => {
    const out = ok(await beautify('javascript', 'const greet=(n)=>{return "hi "+n}', { quoteStyle: 'single' }));
    expect(out).toBe("const greet = (n) => {\n  return 'hi ' + n;\n};\n");
  });

  it('minifies with Terser', async () => {
    const out = ok(await minify('javascript', 'function add(first, second) {\n  // sum\n  return first + second;\n}\nconsole.log(add(1, 2));'));
    expect(out.length).toBeLessThan(60);
    expect(out).toContain('console.log');
  });

  it('validates TypeScript and TSX', async () => {
    expect((await check('typescript', 'interface A { x: number }\nconst f = <T,>(v: T): T => v;\nenum E { A }')).validation.status).toBe('valid');
    expect((await check('typescript', 'const el = <div>{(x as number) + 1}</div>;')).validation.status).toBe('valid');
    expect((await errorsOf('typescript', 'let x: = 1;')).length).toBeGreaterThan(0);
    expect(ok(await beautify('typescript', 'type A={a:string}'))).toBe('type A = { a: string };\n');
  });

  it('does not offer minify for TypeScript', async () => {
    const r = await minify('typescript', 'const a: number = 1;');
    expect(r.ok).toBe(false);
  });
});

describe('SQL', () => {
  it('validates per dialect', async () => {
    expect((await check('sql', 'SELECT a, b FROM t WHERE x = 1;')).validation.status).toBe('valid');
    const [err] = await errorsOf('sql', 'SELECT a, b FORM t', { sqlDialect: 'postgresql' });
    expect(err.code).toBe('sql/syntax-error');
    expect(err.range?.line).toBe(1);
    expect((await check('sql', 'SELECT TOP 5 * FROM [dbo].[Users]', { sqlDialect: 'tsql' })).validation.status).toBe('valid');
  });

  it('beautifies with keyword case', async () => {
    const out = ok(await beautify('sql', 'select a,b from t where x=1', { sqlKeywordCase: 'upper' }));
    expect(out).toBe('SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n');
  });

  it('allows "Format anyway" for advisory validators only', async () => {
    const input = 'SELECT a FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a) = 1';
    const blocked = await runAction({ input, action: 'beautify', formatId: 'sql', options: opts({ sqlDialect: 'mysql' }) });
    expect(blocked.ok).toBe(false);
    expect(blocked.canForce).toBe(true);
    const forced = await runAction({ input, action: 'beautify', formatId: 'sql', options: opts({ sqlDialect: 'mysql' }), force: true });
    expect(forced.ok).toBe(true);
    expect(forced.notes[0]).toContain('Formatted anyway');
    const json = await runAction({ input: '{"a": 1', action: 'beautify', formatId: 'json', options: opts(), force: true });
    expect(json.ok).toBe(false);
    expect(json.canForce).toBe(false);
  });

  it('minifies without touching strings or comments-in-strings', async () => {
    const out = ok(await minify('sql', "SELECT  a ,  b -- comment\nFROM  t\nWHERE s = 'a  --  b' /* c */ AND n = - -1 ;"));
    expect(out).toBe("SELECT a,b FROM t WHERE s='a  --  b' AND n=- -1;".replace("s='a", "s = 'a").replace("n=- -1", "n = - -1"));
  });
});
