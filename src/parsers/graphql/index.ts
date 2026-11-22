import {
  buildASTSchema,
  buildSchema,
  GraphQLError,
  KnownFragmentNamesRule,
  Kind,
  LoneAnonymousOperationRule,
  NoFragmentCyclesRule,
  NoUndefinedVariablesRule,
  NoUnusedFragmentsRule,
  NoUnusedVariablesRule,
  parse,
  stripIgnoredCharacters,
  UniqueArgumentNamesRule,
  UniqueFragmentNamesRule,
  UniqueInputFieldNamesRule,
  UniqueOperationNamesRule,
  UniqueVariableNamesRule,
  validate,
  validateSchema,
  type DefinitionNode,
  type DocumentNode,
} from 'graphql';
import { validateSDL } from 'graphql/validation/validate';
import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAtLineCol } from '../../utils/diag';
import { prettierErrorDiagnostic, prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';

const EXECUTABLE = new Set<string>([Kind.OPERATION_DEFINITION, Kind.FRAGMENT_DEFINITION]);

function toDiags(errors: readonly GraphQLError[], ctx: ModuleContext, code: string, type: string, severity: 'error' | 'warning' = 'error'): Diagnostic[] {
  return errors.slice(0, 200).map((e) => {
    const loc = e.locations?.[0];
    return diagAtLineCol(ctx.lines, loc?.line ?? 1, loc?.column ?? 1, {
      severity,
      code,
      type,
      message: e.message.replace(/^Syntax Error:\s*/, ''),
      source: 'graphql-js',
      related: e.locations?.slice(1).map((l) => ({ message: 'Related location', line: l.line, column: l.column })),
    });
  });
}

let placeholderSchema: ReturnType<typeof buildSchema> | null = null;

/** Rules that do not depend on the schema's types (used when no schema is available). */
const SCHEMA_FREE_RULES = [
  UniqueOperationNamesRule,
  LoneAnonymousOperationRule,
  UniqueFragmentNamesRule,
  KnownFragmentNamesRule,
  NoUnusedFragmentsRule,
  NoFragmentCyclesRule,
  UniqueVariableNamesRule,
  NoUndefinedVariablesRule,
  NoUnusedVariablesRule,
  UniqueArgumentNamesRule,
  UniqueInputFieldNamesRule,
];

function detectGraphql(ctx: DetectContext): DetectScore | null {
  const h = ctx.head;
  const t = ctx.trimmed;
  if (/^\s*(query|mutation|subscription)\b\s*[A-Za-z_]*\s*(\([^)]*\))?\s*(@\w+[^{]*)?\{/m.test(h)) return { score: 0.9, reasons: ['GraphQL operation (query/mutation/subscription)'] };
  if (/^\s*fragment\s+\w+\s+on\s+\w+/m.test(h)) return { score: 0.9, reasons: ['GraphQL fragment'] };
  const sdl = (h.match(/^\s*(extend\s+)?(type|interface|input|enum|union|scalar|schema|directive\s+@)\b/gm) ?? []).length;
  if (sdl) {
    // TypeScript also has `type X =` and `interface X {` with ';' separated members
    const tsLike = /^\s*(export\s+)?type\s+\w+\s*(<[^>]*>)?\s*=|^\s*(export\s+)?interface\s+\w+[^{]*\{[^}]*;/m.test(h);
    const gqlFields = (h.match(/^\s+\w+(\([^)]*\))?\s*:\s*\[?\w+!?\]?!?\s*(@\w+.*)?$/gm) ?? []).length;
    if (tsLike && !gqlFields) return null;
    return { score: Math.min(0.88, 0.5 + sdl * 0.05 + gqlFields * 0.03), reasons: ['GraphQL schema definitions (type/input/enum...)'] };
  }
  if (t[0] === '{' && /^\{\s*\w+(\s*\([^)]*\))?\s*\{/.test(t) && !/"\s*:/.test(t.slice(0, 200))) return { score: 0.7, reasons: ['Anonymous GraphQL query { field { ... } }'] };
  return null;
}

export const graphqlModule: FormatModule = {
  descriptor: DESCRIPTORS.graphql,
  sample: SAMPLES.graphql,
  detect: detectGraphql,
  validate(input, ctx) {
    let doc: DocumentNode;
    try {
      doc = parse(input);
    } catch (e) {
      if (e instanceof GraphQLError) return { diagnostics: toDiags([e], ctx, 'graphql/syntax-error', 'Syntax error') };
      throw e;
    }
    const sdlDefs: DefinitionNode[] = [];
    const execDefs: DefinitionNode[] = [];
    for (const d of doc.definitions) (EXECUTABLE.has(d.kind) ? execDefs : sdlDefs).push(d);
    const diagnostics: Diagnostic[] = [];
    let schema = null;
    if (sdlDefs.length) {
      const sdlDoc: DocumentNode = { kind: Kind.DOCUMENT, definitions: sdlDefs };
      const sdlErrors = validateSDL(sdlDoc);
      diagnostics.push(...toDiags(sdlErrors, ctx, 'graphql/schema-error', 'Schema error'));
      if (!sdlErrors.length) {
        try {
          schema = buildASTSchema(sdlDoc, { assumeValidSDL: true });
          const schemaErrors = validateSchema(schema).filter((e) => !/Query root type must be provided/.test(e.message));
          diagnostics.push(...toDiags(schemaErrors, ctx, 'graphql/schema-error', 'Schema error'));
          if (schemaErrors.length) schema = null;
        } catch (e) {
          if (e instanceof GraphQLError) diagnostics.push(...toDiags([e], ctx, 'graphql/schema-error', 'Schema error'));
          schema = null;
        }
      }
    }
    if (execDefs.length) {
      const execDoc: DocumentNode = { kind: Kind.DOCUMENT, definitions: execDefs };
      if (schema && schema.getQueryType()) {
        diagnostics.push(...toDiags(validate(schema, execDoc), ctx, 'graphql/validation-error', 'Validation error'));
      } else {
        placeholderSchema ??= buildSchema('type Query { _placeholder: Boolean }');
        diagnostics.push(...toDiags(validate(placeholderSchema, execDoc, SCHEMA_FREE_RULES), ctx, 'graphql/validation-error', 'Validation error'));
      }
    }
    const count = (k: string) => doc.definitions.filter((d) => d.kind === k).length;
    return {
      diagnostics,
      facts: {
        Operations: count(Kind.OPERATION_DEFINITION),
        Fragments: count(Kind.FRAGMENT_DEFINITION),
        'Type definitions': sdlDefs.length,
        Validation: schema && execDefs.length ? 'operations checked against the schema in this document' : execDefs.length ? 'schema-independent rules (no schema in document)' : 'SDL rules',
      },
    };
  },
  async beautify(input, ctx) {
    try {
      return { text: await prettierFormat(input, { parser: 'graphql', plugins: ['graphql'], options: ctx.options }) };
    } catch (e) {
      throw new Error(prettierErrorDiagnostic(e, ctx.lines, 'Prettier', 'graphql/prettier').message);
    }
  },
  minify(input) {
    return { text: stripIgnoredCharacters(input), notes: ['Comments and insignificant whitespace removed; descriptions (string literals) are kept.'] };
  },
};
