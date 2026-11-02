// A small checker for the JSON Schema keywords content.schema.json uses
// (type object/array/string, required, properties, additionalProperties false,
// items, minItems, enum, minLength, maxLength, pattern). It refuses any other
// keyword, so the schema can't quietly use one this checker ignores.
const KNOWN = new Set(['$schema', '$id', 'title', 'type', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'enum', 'minLength', 'maxLength', 'pattern']);

export function check(schema, value, path = '$') {
  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) errors.push(`${path}: schema keyword "${key}" is not supported by this checker`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [...errors, `${path}: expected an object`];
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing "${key}"`);
    for (const [key, child] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...check(sub, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected "${key}"`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [...errors, `${path}: expected an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    value.forEach((item, i) => errors.push(...check(schema.items, item, `${path}[${i}]`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [...errors, `${path}: expected a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: doesn't match ${schema.pattern}`);
  }
  return errors;
}
