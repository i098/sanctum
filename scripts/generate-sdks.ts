/**
 * Generates the v1 OpenAPI document and the SDK operation tables and DTOs from `SanctumApi`
 * (plan section 13). Object schemas equal to an exported contract schema take its name.
 * Usage: node scripts/generate-sdks.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { OpenApiJsonSchema } from '@effect/platform';
import * as Contracts from '@sanctum/contracts';
import { Schema } from 'effect';
import { openApiDocument } from '../server/src/api.ts';

/** The JSON Schema subset Effect emits for wire contracts. */
export interface JsonSchema {
  readonly $ref?: string;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly type?: string;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean | JsonSchema;
}

type Content = { readonly content?: { readonly 'application/json': { readonly schema: JsonSchema } } };
interface Parameter {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly schema: JsonSchema;
}
interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters?: ReadonlyArray<Parameter>;
  readonly requestBody?: Content;
  readonly responses: Readonly<Record<string, Content>>;
}
// Effect's OpenAPISpec types every schema as a wide union; this is the same document, narrowed.
const spec = openApiDocument as unknown as {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: { readonly schemas: Readonly<Record<string, JsonSchema>> };
};

export interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: ReadonlyArray<string>;
  readonly queryParams: ReadonlyArray<string>;
  readonly body: boolean;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

const refName = (schema: JsonSchema) => schema.$ref?.split('/').pop();
export const deref = (schema: JsonSchema): JsonSchema => spec.components.schemas[refName(schema) ?? ''] ?? schema;

/** Flattens path, query and JSON body into one input object, as the SDKs and MCP tools accept it. */
export const operations: ReadonlyArray<Operation> = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => {
    const params = op.parameters ?? [];
    const body = deref(op.requestBody?.content?.['application/json'].schema ?? {});
    const properties: Record<string, JsonSchema> = { ...body.properties };
    const required = [...(body.required ?? [])];
    for (const param of params) {
      if (param.name in properties) throw new Error(`${op.operationId}: ${param.name} is both a parameter and a body field`);
      // Query strings carry numbers as text; SDK callers pass the number.
      properties[param.name] = refName(param.schema) === 'NumberFromString' ? { type: 'integer' } : param.schema;
      if (param.required) required.push(param.name);
    }
    const success = Object.entries(op.responses).find(([status]) => status.startsWith('2'))?.[1];
    return {
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      pathParams: params.filter(p => p.in === 'path').map(p => p.name),
      queryParams: params.filter(p => p.in === 'query').map(p => p.name),
      body: op.requestBody !== undefined,
      input: params.length === 0 && op.requestBody ? body : { type: 'object', properties, required, additionalProperties: false },
      output: success?.content?.['application/json'].schema ?? { type: 'null' },
    };
  }),
);

// Names: every component, then every exported contract schema that renders as an object.
const names = new Map(Object.entries(spec.components.schemas).map(([name, schema]) => [JSON.stringify(schema), name]));
for (const [name, value] of Object.entries(Contracts)) {
  if (!Schema.isSchema(value)) continue;
  const rendered = OpenApiJsonSchema.makeWithDefs(value, { defs: {} });
  if ('type' in rendered && rendered.type === 'object') names.set(JSON.stringify(rendered), name);
}

const pascal = (text: string) => text.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());
const snake = (text: string) => text.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

interface Syntax {
  readonly primitives: Readonly<Record<string, string>>;
  readonly unknown: string;
  readonly literals: (values: ReadonlyArray<unknown>) => string;
  readonly array: (item: string) => string;
  readonly record: string;
  readonly declare: (name: string, fields: ReadonlyArray<[key: string, type: string, required: boolean]>) => string;
}

/** Renders schemas as types, declaring named object types once, before first use in output order. */
function emitter(syntax: Syntax) {
  const declared = new Map<string, string>();
  const shapes = new Map<string, string>();
  const object = (schema: JsonSchema, hint: string) => {
    const shape = JSON.stringify(schema);
    let name = names.get(shape) ?? hint;
    for (let n = 2; shapes.has(name) && shapes.get(name) !== shape; n++) name = `${hint}${n}`;
    if (shapes.has(name)) return name;
    shapes.set(name, shape);
    declared.set(name, '');
    const required = new Set(schema.required);
    const fields = Object.entries(schema.properties ?? {}).map(
      ([key, value]): [string, string, boolean] => [key, type(value, name + pascal(key)), required.has(key)],
    );
    declared.set(name, syntax.declare(name, fields));
    return name;
  };
  const type = (schema: JsonSchema, hint: string): string => {
    if (schema.$ref) return type(deref(schema), refName(schema)!);
    if (schema.anyOf) return schema.anyOf.map(s => type(s, hint)).join(' | ');
    if (schema.enum) return syntax.literals(schema.enum);
    if (schema.type === 'array') return syntax.array(type(schema.items ?? {}, `${hint}Item`));
    if (schema.type === 'object') return Object.keys(schema.properties ?? {}).length > 0 ? object(schema, hint) : syntax.record;
    return syntax.primitives[schema.type ?? ''] ?? syntax.unknown;
  };
  return { declared, type };
}

const HEADER = 'Generated by scripts/generate-sdks.ts from the v1 OpenAPI document. Do not edit.';

function renderTypescript() {
  const emit = emitter({
    primitives: { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' },
    unknown: 'unknown',
    literals: values => values.map(v => JSON.stringify(v)).join(' | '),
    array: item => `ReadonlyArray<${item}>`,
    record: 'Readonly<Record<string, unknown>>',
    declare: (name, fields) =>
      `export type ${name} = {\n${fields.map(([key, type, required]) => `  readonly ${key}${required ? '' : '?'}: ${type};\n`).join('')}};`,
  });
  const entries = operations.map(op => {
    const base = pascal(op.id.split('.')[1]!);
    return `  '${op.id}': { input: ${emit.type(op.input, `${base}Input`)}; output: ${emit.type(op.output, `${base}Output`)} };`;
  });
  const table = operations.map(({ id, method, path, pathParams, queryParams, body }) =>
    `  '${id}': ${JSON.stringify({ method, path, pathParams, queryParams, body })},`,
  );
  return [
    `// ${HEADER}`,
    "import type { OperationSpec } from './client.ts';",
    '',
    [...emit.declared.values()].join('\n\n'),
    '',
    'export interface Operations {',
    ...entries,
    '}',
    '',
    'export const operations: Record<keyof Operations, OperationSpec> = {',
    ...table,
    '};',
    '',
  ].join('\n');
}

function renderPython() {
  const emit = emitter({
    primitives: { string: 'str', integer: 'int', number: 'float', boolean: 'bool', null: 'None' },
    unknown: 'Any',
    literals: values => `Literal[${values.map(v => JSON.stringify(v)).join(', ')}]`,
    declare: (name, fields) =>
      `class ${name}(TypedDict):\n${fields.map(([key, type, required]) => `    ${key}: ${required ? type : `NotRequired[${type}]`}`).join('\n')}`,
    array: item => `list[${item}]`,
    record: 'dict[str, Any]',
  });
  const sync = new Map<string, string[]>();
  const async = new Map<string, string[]>();
  const table = operations.map(op => {
    const [group, name] = op.id.split('.') as [string, string];
    const input = emit.type(op.input, `${pascal(name)}Input`);
    const output = emit.type(op.output, `${pascal(name)}Output`);
    const signature = `${snake(name)}(self, input: ${input}) -> ${output}:`;
    sync.set(group, [...(sync.get(group) ?? []), `    def ${signature}\n        return self._call("${op.id}", input)`]);
    async.set(group, [...(async.get(group) ?? []), `    async def ${signature}\n        return await self._call("${op.id}", input)`]);
    const tuple = (items: ReadonlyArray<string>) => `(${items.map(i => `"${i}", `).join('')})`;
    return `    "${op.id}": Operation("${op.method}", "${op.path}", ${tuple(op.pathParams)}, ${tuple(op.queryParams)}, ${op.body ? 'True' : 'False'}),`;
  });
  const classes = (groups: Map<string, string[]>, prefix: string) =>
    [...groups].map(([group, methods]) =>
      [`class ${prefix}${pascal(group)}Operations:`, '    def __init__(self, call: Callable[[str, Any], Any]) -> None:', '        self._call = call', '', methods.join('\n\n')].join('\n'),
    );
  const groupsClass = (prefix: string) =>
    [
      `class ${prefix}Groups:`,
      `    """Typed operation groups; \`${prefix}Client\` binds them to its \`call\`."""`,
      '',
      '    def __init__(self, call: Callable[[str, Any], Any]) -> None:',
      ...[...sync.keys()].map(g => `        self.${g} = ${prefix}${pascal(g)}Operations(call)`),
    ].join('\n');
  return `${[
    `# ${HEADER}\nfrom __future__ import annotations\n\nfrom typing import Any, Callable, Literal, NamedTuple, NotRequired, TypedDict`,
    'class Operation(NamedTuple):\n    method: str\n    path: str\n    path_params: tuple[str, ...]\n    query_params: tuple[str, ...]\n    body: bool',
    ...emit.declared.values(),
    `OPERATIONS: dict[str, Operation] = {\n${table.join('\n')}\n}`,
    ...classes(sync, ''),
    ...classes(async, 'Async'),
    groupsClass(''),
    groupsClass('Async'),
  ].join('\n\n\n')}\n`;
}

export const outputs = (): ReadonlyMap<string, string> =>
  new Map([
    ['sdk/openapi.json', `${JSON.stringify(openApiDocument, null, 2)}\n`],
    ['sdk/typescript/src/generated.ts', renderTypescript()],
    ['sdk/python/src/sanctum/_generated.py', renderPython()],
  ]);

const readOrNull = (file: string) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const stale = [...outputs()].filter(([file, text]) => readOrNull(file) !== text);
  if (check && stale.length > 0) {
    console.error(`Stale generated SDK files; run npm run sdk:generate: ${stale.map(([file]) => file).join(', ')}`);
    process.exitCode = 1;
  } else if (check) console.log('PASS: generated SDK files are current');
  else for (const [file, text] of stale) writeFileSync(file, text), console.log(`Wrote ${file}`);
}
