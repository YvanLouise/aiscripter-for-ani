type Variables = { frame: number; time: number; fps: number; base: number; seed: number };
type Node = { kind: 'number'; value: number } | { kind: 'variable'; name: keyof Variables | 'pi' }
  | { kind: 'unary'; operator: string; value: Node } | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };
type Token = { kind: 'number' | 'name' | 'symbol'; value: string };

const functions: Record<string, (...values: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, sqrt: Math.sqrt,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max,
  clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
  lerp: (start, end, progress) => start + (end - start) * progress,
};
const cache = new Map<string, Node>();

function tokenize(source: string): Token[] {
  if (!source || source.length > 256) throw new Error('Expression must be 1–256 characters');
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index++; continue; }
    const match = /^(?:((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([()+\-*/%^,]))/.exec(source.slice(index));
    if (!match) throw new Error(`Invalid expression character at ${index + 1}`);
    tokens.push({ kind: match[1] ? 'number' : match[2] ? 'name' : 'symbol', value: match[0] });
    if (tokens.length > 128) throw new Error('Expression is too complex');
    index += match[0].length;
  }
  return tokens;
}

function parse(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position]?.value;
  const consume = (value: string) => { if (peek() === value) { position++; return true; } return false; };
  const expect = (value: string) => { if (!consume(value)) throw new Error(`Expected ${value}`); };
  const primary = (depth: number): Node => {
    if (depth > 32) throw new Error('Expression nesting is too deep');
    const token = tokens[position++];
    if (!token) throw new Error('Unexpected end of expression');
    if (token.kind === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new Error('Expression contains a non-finite number');
      return { kind: 'number', value };
    }
    if (token.value === '(') { const value = sum(depth + 1); expect(')'); return value; }
    if (token.kind === 'name') {
      if (consume('(')) {
        if (token.value !== 'noise' && !Object.hasOwn(functions, token.value)) throw new Error(`Unknown function: ${token.value}`);
        const args: Node[] = [];
        if (!consume(')')) { do { args.push(sum(depth + 1)); } while (consume(',')); expect(')'); }
        if (args.length > 8) throw new Error('Too many function arguments');
        return { kind: 'call', name: token.value, args };
      }
      if (!['frame', 'time', 'fps', 'base', 'seed', 'pi'].includes(token.value)) throw new Error(`Unknown variable: ${token.value}`);
      return { kind: 'variable', name: token.value as keyof Variables | 'pi' };
    }
    throw new Error(`Unexpected token: ${token.value}`);
  };
  const unary = (depth: number): Node => {
    if (consume('+')) return unary(depth + 1);
    if (consume('-')) return { kind: 'unary', operator: '-', value: unary(depth + 1) };
    return primary(depth);
  };
  const power = (depth: number): Node => {
    const left = unary(depth);
    return consume('^') ? { kind: 'binary', operator: '^', left, right: power(depth + 1) } : left;
  };
  const product = (depth: number): Node => {
    let left = power(depth);
    while (['*', '/', '%'].includes(peek() || '')) { const operator = tokens[position++].value; left = { kind: 'binary', operator, left, right: power(depth) }; }
    return left;
  };
  const sum = (depth: number): Node => {
    let left = product(depth);
    while (['+', '-'].includes(peek() || '')) { const operator = tokens[position++].value; left = { kind: 'binary', operator, left, right: product(depth) }; }
    return left;
  };
  const node = sum(0);
  if (position !== tokens.length) throw new Error(`Unexpected token: ${tokens[position].value}`);
  return node;
}

function compiled(source: string): Node {
  let found = cache.get(source);
  if (!found) {
    found = parse(source);
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(source, found);
  }
  return found;
}

export function validateExpression(source: string): void { compiled(source); }

export function evaluateExpression(source: string, variables: Variables): number {
  const evaluate = (node: Node): number => {
    if (node.kind === 'number') return node.value;
    if (node.kind === 'variable') return node.name === 'pi' ? Math.PI : variables[node.name];
    if (node.kind === 'unary') return -evaluate(node.value);
    if (node.kind === 'binary') {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      switch (node.operator) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        default: return left ** right;
      }
    }
    const args = node.args.map(evaluate);
    if (node.name === 'noise') {
      const value = Math.sin((args[0] ?? 0) * 12.9898 + variables.seed * 0.0001) * 43758.5453;
      return value - Math.floor(value);
    }
    return functions[node.name](...args);
  };
  const result = evaluate(compiled(source));
  if (!Number.isFinite(result)) throw new Error('Expression produced a non-finite value');
  return result;
}
