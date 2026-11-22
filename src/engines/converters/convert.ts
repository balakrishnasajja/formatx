import type { Diagnostic } from '../../types/diagnostics';
import type { FormatId } from '../../types/formats';
import type { ModuleContext } from '../../types/module';
import { DESCRIPTORS } from '../catalog';
import { getModule } from '../registry';
import { hasIntegerLikeKeys } from './dataModel';
import { notice } from '../../utils/diag';

export interface ConvertOutcome {
  text?: string;
  binary?: Uint8Array;
  warnings: Diagnostic[];
  notes: string[];
}

export class ConversionError extends Error {}

/** Converts between formats via the neutral data model (or a module's special conversion). */
export async function convertFormat(input: string, from: FormatId, to: FormatId, ctx: ModuleContext): Promise<ConvertOutcome> {
  if (from === to) throw new ConversionError('Source and target formats are the same. Use Beautify instead.');
  const src = getModule(from);
  const dst = getModule(to);
  if (!src) throw new ConversionError(`Unknown source format "${from}".`);
  if (!dst) throw new ConversionError(`Unknown target format "${to}".`);

  if (src.specialTargets?.includes(to) && src.convertSpecial) {
    const r = await src.convertSpecial(input, to, ctx);
    return { text: r.text, binary: r.binary, warnings: r.warnings, notes: r.notes ?? [] };
  }

  if (!src.toData) {
    throw new ConversionError(`${DESCRIPTORS[from].name} is source code, not a data format, so it cannot be converted to ${DESCRIPTORS[to].name}.`);
  }
  if (!dst.fromData) {
    const why = DESCRIPTORS[to].category === 'data' ? '' : ` ${DESCRIPTORS[to].name} is not a data serialization format.`;
    throw new ConversionError(`Conversion to ${DESCRIPTORS[to].name} is not supported.${why}`);
  }

  const parsed = await src.toData(input, ctx);
  const out = await dst.fromData(parsed.data, ctx);
  const warnings = [...parsed.warnings, ...out.warnings];
  const notes = [...(out.notes ?? [])];
  if (['toml', 'json5'].includes(from) && hasIntegerLikeKeys(parsed.data)) {
    warnings.push(
      notice({
        severity: 'info',
        code: 'convert/key-order',
        type: 'Key order',
        message: 'Keys that look like integers may appear in ascending numeric order instead of source order.',
        source: 'Converter',
      }),
    );
  }
  return { text: out.text, binary: out.binary, warnings, notes };
}
