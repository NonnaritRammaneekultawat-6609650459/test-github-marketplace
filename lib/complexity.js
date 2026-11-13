'use strict';

const parser = require('@babel/parser');

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration','FunctionExpression','ArrowFunctionExpression',
  'ObjectMethod','ClassMethod','ClassPrivateMethod'
]);
const DECISION_TYPES = new Set([
  'IfStatement','ForStatement','ForInStatement','ForOfStatement',
  'WhileStatement','DoWhileStatement','CatchClause','ConditionalExpression'
]);

function isNode(value) {
  return value && typeof value === 'object' && typeof value.type === 'string';
}

function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (['loc','start','end','tokens','comments','leadingComments','trailingComments','innerComments'].includes(key)) continue;
    if (isNode(value)) result.push([value,key]);
    else if (Array.isArray(value)) for (const child of value) if (isNode(child)) result.push([child,key]);
  }
  return result;
}

function decisionWeight(node) {
  if (DECISION_TYPES.has(node.type)) return 1;
  if (node.type === 'SwitchCase') return node.test == null ? 0 : 1;
  if (node.type === 'LogicalExpression') return ['&&','||','??'].includes(node.operator) ? 1 : 0;
  if ((node.type === 'LogicalAssignmentExpression' || node.type === 'AssignmentExpression') && ['&&=','||=','??='].includes(node.operator)) return 1;
  if (node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression') return node.optional ? 1 : 0;
  if (node.type === 'AssignmentPattern') return 1;
  return 0;
}

function complexityOf(node) {
  let complexity = 1;
  function visit(current, root) {
    if (!isNode(current)) return;
    if (!root && FUNCTION_TYPES.has(current.type)) return;
    complexity += decisionWeight(current);
    for (const [child] of children(current)) visit(child,false);
  }
  visit(node,true);
  return complexity;
}

function propertyName(node) {
  if (!node) return '';
  if (node.type === 'Identifier' || node.type === 'PrivateName') return node.name || node.id?.name || '';
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return String(node.value);
  return '';
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (['ObjectMethod','ClassMethod','ClassPrivateMethod'].includes(node.type)) return propertyName(node.key) || '<computed method>';
  if (parent?.type === 'VariableDeclarator') return propertyName(parent.id) || '<anonymous>';
  if (parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty' || parent?.type === 'ClassMethod' || parent?.type === 'ClassPrivateMethod' || parent?.type === 'ObjectMethod') {
    return propertyName(parent.key) || '<computed method>';
  }
  if (parent?.type === 'AssignmentExpression') return propertyName(parent.left) || '<assigned function>';
  return `<anonymous${node.loc?.start?.line ? `@${node.loc.start.line}` : ''}>`;
}

function analyzeSource(source) {
  const ast = parser.parse(String(source), {
    sourceType:'unambiguous',
    plugins:['jsx'],
    allowReturnOutsideFunction:true
  });
  const functions = [];
  function collect(node,parent=null) {
    if (!isNode(node)) return;
    if (FUNCTION_TYPES.has(node.type)) {
      functions.push({
        name:functionName(node,parent),
        line:node.loc?.start?.line || 1,
        complexity:complexityOf(node)
      });
    }
    for (const [child] of children(node)) collect(child,node);
  }
  collect(ast.program);
  const moduleComplexity = complexityOf(ast.program);
  if (moduleComplexity > 1) functions.push({name:'<module>',line:1,complexity:moduleComplexity});
  return functions;
}

function cyclomaticComplexity(source) {
  return analyzeSource(source);
}

function measureFiles(files, readFile, config = {}) {
  const limit = config.complexity?.global ?? 10;
  const perFile = config.complexity?.files || {};
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !perFile || typeof perFile !== 'object' || Array.isArray(perFile) || Object.values(perFile).some(n => !Number.isInteger(n) || n < 1 || n > 1000)) {
    throw new Error('Invalid complexity configuration');
  }
  const results = {};
  let passed = true;
  for (const file of files) {
    const required = perFile[file] ?? limit;
    const functions = analyzeSource(readFile(file)).map(metric => ({...metric,required,pass:metric.complexity <= required}));
    const actual = functions.length ? Math.max(...functions.map(metric => metric.complexity)) : 1;
    const pass = functions.every(metric => metric.pass);
    results[file] = {actual,required,pass,functions};
    if (!pass) passed = false;
  }
  return {status:passed ? 'passed':'failed',required:limit,files:results};
}

module.exports = {cyclomaticComplexity, analyzeSource, measureFiles};
