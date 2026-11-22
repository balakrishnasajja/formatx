import type { FormatId } from '../types/formats';
import type { FormatModule } from '../types/module';
import { bsonModule, msgpackModule } from '../parsers/binary';
import { cssModule, scssModule } from '../parsers/css';
import { csvModule, tsvModule } from '../parsers/csv';
import { envModule } from '../parsers/env';
import { graphqlModule } from '../parsers/graphql';
import { htmlModule } from '../parsers/html';
import { iniModule } from '../parsers/ini';
import { javaModule } from '../parsers/java';
import { javascriptModule, typescriptModule } from '../parsers/javascript';
import { json5Module, jsoncModule, jsonModule } from '../parsers/json';
import { jsonschemaModule } from '../parsers/jsonschema';
import { markdownModule } from '../parsers/markdown';
import { openapiModule } from '../parsers/openapi';
import { phpModule } from '../parsers/php';
import { propertiesModule } from '../parsers/properties';
import { protobufModule } from '../parsers/protobuf';
import { pythonModule } from '../parsers/python';
import { sqlModule } from '../parsers/sql';
import { tomlModule } from '../parsers/toml';
import { xmlModule } from '../parsers/xml';
import { yamlModule } from '../parsers/yaml';

/**
 * All format modules. This file is imported by the engine (worker side) only.
 * To add a format: implement a FormatModule and append it here.
 */
const MODULES: FormatModule[] = [
  jsonModule,
  jsoncModule,
  json5Module,
  xmlModule,
  yamlModule,
  tomlModule,
  csvModule,
  tsvModule,
  iniModule,
  envModule,
  propertiesModule,
  htmlModule,
  cssModule,
  scssModule,
  javascriptModule,
  typescriptModule,
  markdownModule,
  phpModule,
  pythonModule,
  javaModule,
  sqlModule,
  graphqlModule,
  openapiModule,
  jsonschemaModule,
  bsonModule,
  msgpackModule,
  protobufModule,
];

const BY_ID = new Map<FormatId, FormatModule>(MODULES.map((m) => [m.descriptor.id, m]));

export function getModule(id: FormatId): FormatModule | undefined {
  return BY_ID.get(id);
}

export function allModules(): readonly FormatModule[] {
  return MODULES;
}

export function registerModule(m: FormatModule): void {
  if (!BY_ID.has(m.descriptor.id)) MODULES.push(m);
  BY_ID.set(m.descriptor.id, m);
}
