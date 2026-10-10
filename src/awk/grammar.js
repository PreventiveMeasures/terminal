// gawk 5.2.1's grammar (awkgram.y), rule for rule and in its order — the
// order decides which of two reductions wins and which one a state takes by
// default, and so what gawk has said by the time it stops at an error —
// with what each rule's action does here (./actions.js, ./build.js). A
// mid-rule action is a rule of its own for an empty `$@n`, numbered just
// before the rule it sits in, as Bison numbers it. The rules for what this
// terminal refuses as it reads it (`@include`, typed regexes, indirect
// calls) and Bison's `error` recovery rules (gawk exits at its first syntax
// error) stay in for the tables' sake and are never reduced.

import * as A from './actions.js'
import * as B from './build.js'

const none = () => null
const same = (p, v) => v[0]
const list = (p, v) => [v[0]]
const push = (n) => (p, v) => { v[0].push(v[n]); return v[0] }
const empty = () => []
const never = () => { throw new Error('unreachable grammar rule') }
const binary = (p, v) => B.binary(p, v[0], v[1], v[2])
const section = (name) => (p) => { p.rule = name; return { section: name } }
const unary = (type, i) => (p, v) => ({ type, expr: v[i] })
const incdec = (type, op, i) => (p, v) => ({ type, op, target: B.assignable(p, v[i]) })

const R = (spec, action = same) => {
  const lhs = spec.slice(0, spec.indexOf(':'))
  const rest = spec.slice(spec.indexOf(':') + 1)
  const prec = /%prec (\S+)/u.exec(rest)?.[1] ?? null
  return { lhs, rhs: rest.replace(/%prec \S+/u, '').split(' ').filter(Boolean), prec, action }
}

const RULES = [
  R('program:', none), R('program: program rule', (p) => { p.rule = null }), R('program: program nls', none),
  R('program: program LEX_EOF', (p) => p.lexer.nextSource()), R('program: program error', never),
  R('rule: pattern action', A.rule), R('rule: pattern statement_term', A.patternOnly), R('rule: function_prologue action', A.functionRule),
  R('rule: @ LEX_INCLUDE source statement_term', never), R('rule: @ LEX_LOAD library statement_term', never),
  R('rule: @ LEX_NAMESPACE namespace statement_term', never),
  R('source: FILENAME', never), R('source: FILENAME error', never), R('source: error', never),
  R('library: FILENAME', never), R('library: FILENAME error', never), R('library: error', never),
  R('namespace: FILENAME', never), R('namespace: FILENAME error', never), R('namespace: error', never),
  R('pattern:', (p) => { p.rule = 'Rule'; return null }), R('pattern: exp', (p, v) => { p.rule = 'Rule'; return v[0] }),
  R('pattern: exp comma exp', (p, v) => { p.rule = 'Rule'; return { type: 'range', from: v[0], to: v[2] } }),
  R('pattern: LEX_BEGIN', section('BEGIN')), R('pattern: LEX_END', section('END')),
  R('pattern: LEX_BEGINFILE', section('BEGINFILE')), R('pattern: LEX_ENDFILE', section('ENDFILE')),
  R('action: l_brace statements r_brace opt_semi opt_nls', (p, v) => v[1]),
  R('func_name: NAME'), R('func_name: FUNC_CALL'),
  R('func_name: lex_builtin', (p, v) => p.lexer.syntaxError(`\`${v[0].value}' is a built-in function, it cannot be redefined`)),
  R('func_name: @ LEX_EVAL', never), R('lex_builtin: LEX_BUILTIN'), R('lex_builtin: LEX_LENGTH'),
  R('$@1:', (p) => { p.wantParamNames = 'header' }),
  R('function_prologue: LEX_FUNCTION func_name ( $@1 opt_param_list r_paren opt_nls', A.prologue),
  R('$@2:', (p) => { p.wantRegexp = true }), R('regexp: a_slash $@2 REGEXP', (p, v) => B.regex(p, v[2])),
  R('typed_regexp: TYPED_REGEXP', never), R('a_slash: /'), R('a_slash: SLASH_BEFORE_EQUAL'),
  R('statements:', empty), R('statements: statements statement', push(1)), R('statements: statements error', never),
  R('statement_term: nls', none), R('statement_term: semi opt_nls', none),
  R('statement: semi opt_nls', (p, v, first) => A.at({ type: 'empty' }, first)),
  R('statement: l_brace statements r_brace', (p, v, first) => A.at({ type: 'block', body: v[1] }, first)),
  R('statement: if_statement'),
  R('statement: LEX_SWITCH ( exp r_paren opt_nls l_brace case_statements opt_nls r_brace', A.switchStatement),
  R('statement: LEX_WHILE ( exp r_paren opt_nls statement', (p, v, first) => {
    A.loopDone(p)
    return A.at({ type: 'while', test: v[2], body: v[5] }, first)
  }),
  R('statement: LEX_DO opt_nls statement LEX_WHILE ( exp r_paren opt_nls', (p, v, first) => {
    A.loopDone(p)
    return A.at({ type: 'do', body: v[2], test: v[5] }, first)
  }),
  R('statement: LEX_FOR ( NAME LEX_IN simple_variable r_paren opt_nls statement', A.forIn),
  R('statement: LEX_FOR ( opt_simple_stmt semi opt_nls exp semi opt_nls opt_simple_stmt r_paren opt_nls statement', (p, v, first) => {
    A.loopDone(p)
    return A.at({ type: 'for', init: v[2], test: v[5], step: v[8], body: v[11] }, first)
  }),
  R('statement: LEX_FOR ( opt_simple_stmt semi opt_nls semi opt_nls opt_simple_stmt r_paren opt_nls statement', (p, v, first) => {
    A.loopDone(p)
    return A.at({ type: 'for', init: v[2], test: null, step: v[7], body: v[10] }, first)
  }),
  R('statement: non_compound_stmt'),
  R('non_compound_stmt: LEX_BREAK statement_term', A.jump('break', A.breakCheck)),
  R('non_compound_stmt: LEX_CONTINUE statement_term', A.jump('continue', A.continueCheck)),
  R('non_compound_stmt: LEX_NEXT statement_term', A.jump('next', A.nextCheck)),
  R('non_compound_stmt: LEX_NEXTFILE statement_term', A.jump('nextfile', A.nextfileCheck)),
  R('non_compound_stmt: LEX_EXIT opt_exp statement_term', (p, v, first) => A.at({ type: 'exit', value: v[1] }, first)),
  R('$@3:', (p) => { if (!p.inFunction) p.lexer.syntaxError("`return' used outside function context") }),
  R('non_compound_stmt: LEX_RETURN $@3 opt_fcall_exp statement_term', (p, v, first) => A.at({ type: 'return', value: v[2] }, first)),
  R('non_compound_stmt: simple_stmt statement_term'),
  R('$@4:', (p) => { p.inPrint = true; p.inParens = 0 }),
  R('simple_stmt: print $@4 print_expression_list output_redir', A.print),
  R('$@5:', none),
  R('simple_stmt: LEX_DELETE NAME $@5 delete_subscript_list', (p, v, first) => {
    p.variable(v[1])
    return A.at({ type: 'delete', name: v[1].value, subs: v[3] }, first)
  }),
  R('simple_stmt: LEX_DELETE ( NAME )', (p, v, first) => {
    p.variable(v[2])
    return A.at({ type: 'delete', name: v[2].value, subs: null }, first)
  }),
  R('simple_stmt: exp', (p, v, first) => A.at({ type: 'expr', expr: v[0] }, first)),
  R('opt_simple_stmt:', none), R('opt_simple_stmt: simple_stmt'),
  R('case_statements:', empty), R('case_statements: case_statements case_statement', push(1)), R('case_statements: case_statements error', never),
  R('case_statement: LEX_CASE case_value colon opt_nls statements', (p, v) => ({ test: v[1], body: v[4], at: v[0] })),
  R('case_statement: LEX_DEFAULT colon opt_nls statements', (p, v) => ({ test: null, body: v[3], at: v[0] })),
  R('case_value: YNUMBER', (p, v) => ({ type: 'num', value: v[0].value })),
  R('case_value: - YNUMBER %prec UNARY', (p, v) => ({ type: 'num', value: -v[1].value })),
  R('case_value: + YNUMBER %prec UNARY', (p, v) => ({ type: 'num', value: v[1].value })),
  R('case_value: YSTRING', (p, v) => ({ type: 'str', value: v[0].value })),
  R('case_value: regexp'), R('case_value: typed_regexp', never),
  R('print: LEX_PRINT', (p, v) => { p.printKind = 'print'; return v[0] }),
  R('print: LEX_PRINTF', (p, v) => { p.printKind = 'printf'; return v[0] }),
  R('print_expression_list: opt_expression_list', (p, v) => v[0] ?? []),
  R('print_expression_list: ( expression_list r_paren', (p, v) => v[1]),
  R('output_redir:', (p) => { p.inPrint = false; p.inParens = 0; return null }),
  R('$@6:', (p) => { p.inPrint = false; p.inParens = 0 }),
  R('output_redir: IO_OUT $@6 common_exp', (p, v) => B.redirect(p, v[0], v[2])),
  R('if_statement: LEX_IF ( exp r_paren opt_nls statement', (p, v, first) => A.at({ type: 'if', test: v[2], consequent: v[5], alternate: null }, first)),
  R('if_statement: LEX_IF ( exp r_paren opt_nls statement LEX_ELSE opt_nls statement', (p, v, first) => {
    return A.at({ type: 'if', test: v[2], consequent: v[5], alternate: v[8] }, first)
  }),
  R('nls: NEWLINE', none), R('nls: nls NEWLINE', none), R('opt_nls:', none), R('opt_nls: nls', none),
  R('input_redir:', none), R('input_redir: < simp_exp', (p, v) => v[1]),
  R('opt_param_list:', empty), R('opt_param_list: param_list'),
  R('param_list: NAME', list), R('param_list: param_list comma NAME', push(2)),
  R('param_list: error', never), R('param_list: param_list error', never), R('param_list: param_list comma error', never),
  R('opt_exp:', none), R('opt_exp: exp'), R('opt_expression_list:', none), R('opt_expression_list: expression_list'),
  R('expression_list: exp', list), R('expression_list: expression_list comma exp', push(2)),
  R('expression_list: error', never), R('expression_list: expression_list error', never),
  R('expression_list: expression_list error exp', never), R('expression_list: expression_list comma error', never),
  R('opt_fcall_expression_list:', empty), R('opt_fcall_expression_list: fcall_expression_list'),
  R('fcall_expression_list: fcall_exp', list), R('fcall_expression_list: fcall_expression_list comma fcall_exp', push(2)),
  R('fcall_expression_list: error', never), R('fcall_expression_list: fcall_expression_list error', never),
  R('fcall_expression_list: fcall_expression_list error fcall_exp', never), R('fcall_expression_list: fcall_expression_list comma error', never),
  R('fcall_exp: exp'), R('fcall_exp: typed_regexp', never), R('opt_fcall_exp:', none), R('opt_fcall_exp: fcall_exp'),
  R('exp: variable assign_operator exp %prec ASSIGNOP', (p, v) => ({ type: 'assign', op: v[1], target: B.assignable(p, v[0]), value: v[2] })),
  R('exp: variable ASSIGN typed_regexp %prec ASSIGNOP', never),
  R('exp: exp LEX_AND exp', (p, v) => ({ type: 'and', left: v[0], right: v[2] })),
  R('exp: exp LEX_OR exp', (p, v) => ({ type: 'or', left: v[0], right: v[2] })),
  R('exp: exp MATCHOP typed_regexp', never), R('exp: exp MATCHOP exp', A.match),
  R('exp: exp LEX_IN simple_variable', (p, v) => A.membership([v[0]], v[2])),
  R('exp: exp a_relop exp %prec RELOP', (p, v) => ({ type: 'compare', op: v[1].type === 'RELOP' ? v[1].value : v[1].type, left: v[0], right: v[2] })),
  R('exp: exp ? exp : exp', (p, v) => ({ type: 'cond', test: v[0], consequent: v[2], alternate: v[4] })),
  R('exp: common_exp'),
  R('assign_operator: ASSIGN', () => '='), R('assign_operator: ASSIGNOP', (p, v) => v[0].value),
  R('assign_operator: SLASH_BEFORE_EQUAL ASSIGN', () => '/='),
  R('relop_or_less: RELOP'), R('relop_or_less: <'), R('a_relop: relop_or_less'), R('a_relop: >'),
  R('common_exp: simp_exp'), R('common_exp: simp_exp_nc'),
  R('common_exp: common_exp simp_exp %prec CONCAT_OP', (p, v) => B.concat(v[0], v[1])),
  R('simp_exp: non_post_simp_exp'),
  R('simp_exp: simp_exp ^ simp_exp', binary), R('simp_exp: simp_exp * simp_exp', binary), R('simp_exp: simp_exp / simp_exp', binary),
  R('simp_exp: simp_exp % simp_exp', binary), R('simp_exp: simp_exp + simp_exp', binary), R('simp_exp: simp_exp - simp_exp', binary),
  R('simp_exp: LEX_GETLINE opt_variable input_redir', A.getline),
  R('simp_exp: variable INCREMENT', incdec('postinc', '++', 0)), R('simp_exp: variable DECREMENT', incdec('postinc', '--', 0)),
  R('simp_exp: ( expression_list r_paren LEX_IN simple_variable', (p, v) => A.membership(v[1], v[4])),
  R('simp_exp_nc: common_exp IO_IN LEX_GETLINE opt_variable', (p, v) => B.pipeGetline(v[1])),
  R('simp_exp_nc: simp_exp_nc ^ simp_exp', binary), R('simp_exp_nc: simp_exp_nc * simp_exp', binary),
  R('simp_exp_nc: simp_exp_nc / simp_exp', binary), R('simp_exp_nc: simp_exp_nc % simp_exp', binary),
  R('simp_exp_nc: simp_exp_nc + simp_exp', binary), R('simp_exp_nc: simp_exp_nc - simp_exp', binary),
  R('non_post_simp_exp: regexp'), R('non_post_simp_exp: ! simp_exp %prec UNARY', unary('not', 1)),
  R('non_post_simp_exp: ( exp r_paren', A.parens),
  R('non_post_simp_exp: LEX_BUILTIN ( opt_fcall_expression_list r_paren', (p, v) => B.builtin(p, v[0], v[2])),
  R('non_post_simp_exp: LEX_LENGTH ( opt_fcall_expression_list r_paren', (p, v) => B.builtin(p, v[0], v[2])),
  R('non_post_simp_exp: LEX_LENGTH', (p, v) => B.builtin(p, v[0], [])),
  R('non_post_simp_exp: func_call'), R('non_post_simp_exp: variable'),
  R('non_post_simp_exp: INCREMENT variable', incdec('preinc', '++', 1)), R('non_post_simp_exp: DECREMENT variable', incdec('preinc', '--', 1)),
  R('non_post_simp_exp: YNUMBER', (p, v) => ({ type: 'num', value: v[0].value })),
  R('non_post_simp_exp: YSTRING', (p, v) => ({ type: 'str', value: v[0].value })),
  R('non_post_simp_exp: - simp_exp %prec UNARY', unary('neg', 1)), R('non_post_simp_exp: + simp_exp %prec UNARY', unary('plus', 1)),
  R('func_call: direct_func_call'), R('func_call: @ direct_func_call', (p, v) => B.indirectCall(v[0])),
  R('direct_func_call: FUNC_CALL ( opt_fcall_expression_list r_paren', (p, v) => B.call(p, v[0], v[2])),
  R('opt_variable:', none), R('opt_variable: variable'),
  R('delete_subscript_list:', none), R('delete_subscript_list: delete_subscript SUBSCRIPT'),
  R('delete_subscript: delete_exp_list'), R('delete_subscript: delete_subscript delete_exp_list', () => B.arraysOfArrays(null)),
  R('delete_exp_list: bracketed_exp_list'), R('bracketed_exp_list: [ expression_list ]', (p, v) => v[1]),
  R('subscript: bracketed_exp_list'), R('subscript: subscript bracketed_exp_list', () => B.arraysOfArrays(null)),
  R('subscript_list: subscript SUBSCRIPT'),
  R('simple_variable: NAME', A.simpleVariable), R('simple_variable: NAME subscript_list', A.simpleVariable),
  R('variable: simple_variable'), R('variable: $ non_post_simp_exp opt_incdec', A.field),
  R('opt_incdec: INCREMENT'), R('opt_incdec: DECREMENT'), R('opt_incdec:', none),
  R('l_brace: { opt_nls', none), R('r_brace: } opt_nls', none), R('r_paren: )'),
  R('opt_semi:', none), R('opt_semi: semi', none), R('semi: ;', none), R('colon: :', none), R('comma: , opt_nls', none),
]

export const GRAMMAR = {
  start: 'program',
  rules: RULES,
  precedence: [
    ['right', 'ASSIGNOP', 'ASSIGN', 'SLASH_BEFORE_EQUAL'], ['right', '?', ':'], ['left', 'LEX_OR'], ['left', 'LEX_AND'],
    ['left', 'LEX_GETLINE'], ['nonassoc', 'LEX_IN'], ['left', 'FUNC_CALL', 'LEX_BUILTIN', 'LEX_LENGTH'], ['nonassoc', ','],
    ['left', 'MATCHOP'], ['nonassoc', 'RELOP', '<', '>', 'IO_IN', 'IO_OUT'], ['left', 'CONCAT_OP'],
    ['left', 'YSTRING', 'YNUMBER', 'TYPED_REGEXP'], ['left', '+', '-'], ['left', '*', '/', '%'], ['right', '!', 'UNARY'],
    ['right', '^'], ['left', 'INCREMENT', 'DECREMENT'], ['left', '$'], ['left', '(', ')'],
  ],
}
