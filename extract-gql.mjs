// Extract GraphQL DocumentNode literals from minified Vite/webpack bundles
// and reconstruct readable GraphQL text.
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
const outDir = 'gql-out';
fs.mkdirSync(outDir, { recursive: true });

// Extract a balanced-brace object literal starting at index of '{'
function extractObject(src, startIdx) {
  let depth = 0, i = startIdx, inStr = null;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i); if (nl === -1) break; i = nl; continue;
    }
    i++;
  }
  throw new Error('unbalanced');
}

function parseObj(objSrc) {
  // objSrc is a JS object literal made of data only. Evaluate via Function.
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + objSrc + ')')();
}

// Reconstruct GraphQL from Apollo AST
function astToGql(node) {
  if (!node) return '';
  switch (node.kind) {
    case 'Document':
      return node.definitions.map(astToGql).join('\n\n');
    case 'OperationDefinition': {
      const op = node.operation;
      const name = node.name ? node.name.value : '';
      const vars = node.variableDefinitions
        ? '(' + node.variableDefinitions.map(astToGql).join(', ') + ')'
        : '';
      const dirs = dirsToGql(node.directives);
      return `${op} ${name}${vars}${dirs} ${astToGql(node.selectionSet)}`;
    }
    case 'VariableDefinition': {
      let s = '$' + node.variable.name.value + ': ' + typeToGql(node.type);
      if (node.defaultValue) s += ' = ' + valueToGql(node.defaultValue);
      return s;
    }
    case 'SelectionSet':
      return '{\n' + node.selections.map(sel => '  ' + indent(astToGql(sel))).join('\n') + '\n}';
    case 'Field': {
      const name = (node.alias ? node.alias.value + ': ' : '') + node.name.value;
      const args = node.arguments && node.arguments.length
        ? '(' + node.arguments.map(astToGql).join(', ') + ')'
        : '';
      const dirs = dirsToGql(node.directives);
      const sel = node.selectionSet ? ' ' + astToGql(node.selectionSet) : '';
      return name + args + dirs + sel;
    }
    case 'FragmentSpread':
      return '...' + node.name.value + dirsToGql(node.directives);
    case 'InlineFragment':
      return '... on ' + node.typeCondition.name.value + ' ' + astToGql(node.selectionSet);
    case 'FragmentDefinition': {
      return `fragment ${node.name.value} on ${node.typeCondition.name.value} ${astToGql(node.selectionSet)}`;
    }
    case 'Argument':
      return node.name.value + ': ' + valueToGql(node.value);
    case 'ListType': return '[' + typeToGql(node.type) + ']';
    case 'NonNullType': return typeToGql(node.type) + '!';
    case 'NamedType': return node.name.value;
    default:
      return '/* unknown kind ' + node.kind + ' */';
  }
}

function dirsToGql(dirs) {
  if (!dirs || !dirs.length) return '';
  return ' ' + dirs.map(d => '@' + d.name.value +
    (d.arguments && d.arguments.length ? '(' + d.arguments.map(astToGql).join(', ') + ')' : '')).join(' ');
}

function typeToGql(t) {
  if (!t) return '';
  return astToGql(t);
}

function indent(s) { return s.split('\n').join('\n  '); }

function valueToGql(v) {
  if (!v) return '';
  switch (v.kind) {
    case 'Variable': return '$' + v.name.value;
    case 'IntValue': case 'FloatValue': case 'EnumValue': case 'BooleanValue': return v.value;
    case 'StringValue': return JSON.stringify(v.value);
    case 'NullValue': return 'null';
    case 'ListValue': return '[' + v.values.map(valueToGql).join(', ') + ']';
    case 'ObjectValue': return '{' + v.fields.map(f => f.name.value + ': ' + valueToGql(f.value)).join(', ') + '}';
    default: return '/* ?' + v.kind + ' */';
  }
}

let count = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let idx = 0;
  const base = path.basename(file).replace(/\.js$/, '');
  while ((idx = src.indexOf('kind:"Document"', idx)) !== -1) {
    const brace = src.lastIndexOf('{', idx);
    try {
      const objSrc = extractObject(src, brace);
      const ast = parseObj(objSrc);
      const gql = astToGql(ast);
      const m = /(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(gql);
      const name = m ? m[1] : `Doc${count}`;
      const out = path.join(outDir, `${base}__${name}.graphql`);
      fs.writeFileSync(out, gql + '\n');
      count++;
    } catch (e) {
      console.error(`SKIP ${base}@${idx}: ${e.message}`);
    }
    idx += 10;
  }
}
console.log(`extracted ${count} documents`);
