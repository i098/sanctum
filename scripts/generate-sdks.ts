/**
 * Generates the v1 OpenAPI document and the SDK operation tables and DTOs from `SanctumApi`
 * (plan section 13). Object schemas equal to an exported contract schema take its name.
 * Usage: node scripts/generate-sdks.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { HttpApi, OpenApiJsonSchema } from '@effect/platform';
import * as Contracts from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Option, Schema, SchemaAST } from 'effect';
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

type Content = { readonly content?: { readonly 'application/json'?: { readonly schema: JsonSchema } } };
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
const jsonOf = (content: Content | undefined) => content?.content?.['application/json']?.schema;

const isNumeric = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isNumberKeyword(ast) || (SchemaAST.isRefinement(ast) && isNumeric(ast.from)) || (SchemaAST.isUnion(ast) && ast.types.some(isNumeric));

/** `group.endpoint.param` of every query parameter that decodes to a number; the OpenAPI document only shows its text form. */
const numericQuery = new Set<string>();
HttpApi.reflect(SanctumApi, {
  onGroup: () => {},
  onEndpoint: ({ group, endpoint }) => {
    if (Option.isNone(endpoint.urlParamsSchema)) return;
    const { ast } = endpoint.urlParamsSchema.value;
    // A struct with defaulted fields is a transformation; callers send its encoded side.
    for (const p of SchemaAST.getPropertySignatures(SchemaAST.isTransformation(ast) ? ast.from : ast)) {
      if (isNumeric(SchemaAST.typeAST(p.type))) numericQuery.add(`${group.identifier}.${endpoint.name}.${String(p.name)}`);
    }
  },
});

/** Flattens path, query and JSON body into one input object, as the SDKs and MCP tools accept it. */
function inputOf(op: OpenApiOperation, params: ReadonlyArray<Parameter>): JsonSchema {
  const body = deref(jsonOf(op.requestBody) ?? {});
  if (params.length === 0 && op.requestBody) return body;
  const properties: Record<string, JsonSchema> = { ...body.properties };
  const required = [...(body.required ?? [])];
  for (const param of params) {
    if (param.name in properties) throw new Error(`${op.operationId}: ${param.name} is both a parameter and a body field`);
    // Query strings carry numbers as text; SDK callers pass the number.
    properties[param.name] = numericQuery.has(`${op.operationId}.${param.name}`) ? { type: 'integer' } : param.schema;
    if (param.required) required.push(param.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export const operations: ReadonlyArray<Operation> = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    // The SDKs speak JSON; binary uploads (the listener chunk PUT) stay with the device client.
    .filter(([, op]) => op.requestBody === undefined || op.requestBody.content?.['application/json'] !== undefined)
    .map(([method, op]) => {
      const params = op.parameters ?? [];
      const success = Object.entries(op.responses).find(([status]) => status.startsWith('2'))?.[1];
      return {
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        pathParams: params.filter(p => p.in === 'path').map(p => p.name),
        queryParams: params.filter(p => p.in === 'query').map(p => p.name),
        body: op.requestBody !== undefined,
        input: inputOf(op, params),
        output: jsonOf(success) ?? { type: 'null' },
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
    return container(schema, hint) ?? syntax.primitives[schema.type ?? ''] ?? syntax.unknown;
  };
  const container = (schema: JsonSchema, hint: string): string | undefined => {
    if (schema.type === 'array') return syntax.array(type(schema.items ?? {}, `${hint}Item`));
    if (schema.type !== 'object') return undefined;
    return Object.keys(schema.properties ?? {}).length > 0 ? object(schema, hint) : syntax.record;
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
    'export interface OperationSpec {',
    "  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';",
    '  readonly path: string;',
    '  readonly pathParams: ReadonlyArray<string>;',
    '  readonly queryParams: ReadonlyArray<string>;',
    '  readonly body: boolean;',
    '}',
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

const PYTHON_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

function renderPython() {
  const emit = emitter({
    primitives: { string: 'str', integer: 'int', number: 'float', boolean: 'bool', null: 'None' },
    unknown: 'Any',
    literals: values => `Literal[${values.map(v => JSON.stringify(v)).join(', ')}]`,
    declare: (name, fields) => {
      const typed = fields.map(([key, type, required]) => [key, required ? type : `NotRequired[${type}]`] as const);
      // A Python keyword (e.g. `from`) cannot be a class attribute; the functional form takes any key.
      return typed.some(([key]) => PYTHON_KEYWORDS.has(key))
        ? `${name} = TypedDict(${JSON.stringify(name)}, {\n${typed.map(([key, type]) => `    ${JSON.stringify(key)}: ${JSON.stringify(type)},`).join('\n')}\n})`
        : `class ${name}(TypedDict):\n${typed.map(([key, type]) => `    ${key}: ${type}`).join('\n')}`;
    },
    array: item => `list[${item}]`,
    record: 'dict[str, Any]',
  });
  const table = operations.map(op => {
    const name = op.id.split('.')[1]!;
    const types = `# ${emit.type(op.input, `${pascal(name)}Input`)} -> ${emit.type(op.output, `${pascal(name)}Output`)}`;
    const tuple = (items: ReadonlyArray<string>) => `(${items.map(i => `"${i}", `).join('')})`;
    return `    ${types}\n    "${op.id}": Operation("${op.method}", "${op.path}", ${tuple(op.pathParams)}, ${tuple(op.queryParams)}, ${op.body ? 'True' : 'False'}),`;
  });
  return `${[
    `# ${HEADER}\nfrom __future__ import annotations\n\nfrom typing import Any, Literal, NamedTuple, NotRequired, TypedDict`,
    'class Operation(NamedTuple):\n    method: str\n    path: str\n    path_params: tuple[str, ...]\n    query_params: tuple[str, ...]\n    body: bool',
    ...emit.declared.values(),
    `# Each entry: input TypedDict -> output TypedDict, then the route.\nOPERATIONS: dict[str, Operation] = {\n${table.join('\n')}\n}`,
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
