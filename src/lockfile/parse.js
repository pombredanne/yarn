/* @flow */
/* eslint quotes: 0 */

import util from 'util';

import {MessageError} from '../errors.js';
import map from '../util/map.js';

const LOCKFILE_VERSION = 1

type Token = {
  line: number,
  col: number,
  type: string,
  value: boolean | number | string | void,
};

export type ParseResultType = 'merge' | 'success' | 'conflict';

export type ParseResult = {
  type: ParseResultType,
  object: Object,
};

const VERSION_REGEX = /^yarn lockfile v(\d+)$/;

const TOKEN_TYPES = {
  boolean: 'BOOLEAN',
  string: 'STRING',
  identifier: 'IDENTIFIER',
  eof: 'EOF',
  colon: 'COLON',
  newline: 'NEWLINE',
  comment: 'COMMENT',
  indent: 'INDENT',
  invalid: 'INVALID',
  number: 'NUMBER',
  comma: 'COMMA',
};

const VALID_PROP_VALUE_TOKENS = [TOKEN_TYPES.boolean, TOKEN_TYPES.string, TOKEN_TYPES.number];

function isValidPropValueToken(token): boolean {
  return VALID_PROP_VALUE_TOKENS.indexOf(token.type) >= 0;
}

function* tokenise(input: string): Iterator<Token> {
  let lastNewline = false;
  let line = 1;
  let col = 0;

  function buildToken(type, value): Token {
    return {line, col, type, value};
  }

  while (input.length) {
    let chop = 0;

    if (input[0] === '\n' || input[0] === '\r') {
      chop++;
      // If this is a \r\n line, ignore both chars but only add one new line
      if (input[1] === '\n') {
        chop++;
      }
      line++;
      col = 0;
      yield buildToken(TOKEN_TYPES.newline);
    } else if (input[0] === '#') {
      chop++;

      let nextNewline = input.indexOf('\n', chop);
      if (nextNewline === -1) {
        nextNewline = input.length;
      }
      const val = input.substring(chop, nextNewline);
      chop = nextNewline;
      yield buildToken(TOKEN_TYPES.comment, val);
    } else if (input[0] === ' ') {
      if (lastNewline) {
        let indentSize = 1;
        for (let i = 1; input[i] === ' '; i++) {
          indentSize++;
        }

        if (indentSize % 2) {
          throw new TypeError('Invalid number of spaces');
        } else {
          chop = indentSize;
          yield buildToken(TOKEN_TYPES.indent, indentSize / 2);
        }
      } else {
        chop++;
      }
    } else if (input[0] === '"') {
      let i = 1;
      for (; i < input.length; i++) {
        if (input[i] === '"') {
          const isEscaped = input[i - 1] === '\\' && input[i - 2] !== '\\';
          if (!isEscaped) {
            i++;
            break;
          }
        }
      }
      const val = input.substring(0, i);

      chop = i;

      try {
        yield buildToken(TOKEN_TYPES.string, JSON.parse(val));
      } catch (err) {
        if (err instanceof SyntaxError) {
          yield buildToken(TOKEN_TYPES.invalid);
        } else {
          throw err;
        }
      }
    } else if (/^[0-9]/.test(input)) {
      const val = /^[0-9]+/.exec(input)[0];
      chop = val.length;

      yield buildToken(TOKEN_TYPES.number, +val);
    } else if (/^true/.test(input)) {
      yield buildToken(TOKEN_TYPES.boolean, true);
      chop = 4;
    } else if (/^false/.test(input)) {
      yield buildToken(TOKEN_TYPES.boolean, false);
      chop = 5;
    } else if (input[0] === ':') {
      yield buildToken(TOKEN_TYPES.colon);
      chop++;
    } else if (input[0] === ',') {
      yield buildToken(TOKEN_TYPES.comma);
      chop++;
    } else if (/^[a-zA-Z\/.-]/g.test(input)) {
      let i = 0;
      for (; i < input.length; i++) {
        const char = input[i];
        if (char === ':' || char === ' ' || char === '\n' || char === '\r' || char === ',') {
          break;
        }
      }
      const name = input.substring(0, i);
      chop = i;

      yield buildToken(TOKEN_TYPES.string, name);
    } else {
      yield buildToken(TOKEN_TYPES.invalid);
    }

    if (!chop) {
      // will trigger infinite recursion
      yield buildToken(TOKEN_TYPES.invalid);
    }

    col += chop;
    lastNewline = input[0] === '\n' || (input[0] === '\r' && input[1] === '\n');
    input = input.slice(chop);
  }

  yield buildToken(TOKEN_TYPES.eof);
}

class Parser {
  constructor(input: string, fileLoc: string = 'lockfile') {
    this.comments = [];
    this.tokens = tokenise(input);
    this.fileLoc = fileLoc;
  }

  fileLoc: string;
  token: Token;
  tokens: Iterator<Token>;
  comments: Array<string>;

  onComment(token: Token) {
    const value = token.value;

    const comment = value.trim();

    const versionMatch = comment.match(VERSION_REGEX);
    if (versionMatch) {
      const version = +versionMatch[1];
      if (version > LOCKFILE_VERSION) {
        throw new MessageError(
          `Unknown new lockfile format version ${version}. Supports versions are up to ${LOCKFILE_VERSION}.`,
        );
      }
    }

    this.comments.push(comment);
  }

  next(): Token {
    const item = this.tokens.next();

    const {done, value} = item;
    if (done || !value) {
      throw new Error('No more tokens');
    } else if (value.type === TOKEN_TYPES.comment) {
      this.onComment(value);
      return this.next();
    } else {
      return (this.token = value);
    }
  }

  unexpected(msg: string = 'Unexpected token') {
    throw new SyntaxError(`${msg} ${this.token.line}:${this.token.col} in ${this.fileLoc}`);
  }

  expect(tokType: string) {
    if (this.token.type === tokType) {
      this.next();
    } else {
      this.unexpected();
    }
  }

  eat(tokType: string): boolean {
    if (this.token.type === tokType) {
      this.next();
      return true;
    } else {
      return false;
    }
  }

  parse(indent: number = 0): Object {
    const obj = map();

    while (true) {
      const propToken = this.token;

      if (propToken.type === TOKEN_TYPES.newline) {
        const nextToken = this.next();
        if (!indent) {
          // if we have 0 indentation then the next token doesn't matter
          continue;
        }

        if (nextToken.type !== TOKEN_TYPES.indent) {
          // if we have no indentation after a newline then we've gone down a level
          break;
        }

        if (nextToken.value === indent) {
          // all is good, the indent is on our level
          this.next();
        } else {
          // the indentation is less than our level
          break;
        }
      } else if (propToken.type === TOKEN_TYPES.indent) {
        if (propToken.value === indent) {
          this.next();
        } else {
          break;
        }
      } else if (propToken.type === TOKEN_TYPES.eof) {
        break;
      } else if (propToken.type === TOKEN_TYPES.string) {
        // property key
        const key = propToken.value;

        const keys = [key];
        this.next();

        // support multiple keys
        while (this.token.type === TOKEN_TYPES.comma) {
          this.next(); // skip comma

          const keyToken = this.token;
          if (keyToken.type !== TOKEN_TYPES.string) {
            this.unexpected('Expected string');
          }

          const key = keyToken.value;
          keys.push(key);
          this.next();
        }

        const wasColon = this.token.type === TOKEN_TYPES.colon;
        if (wasColon) {
          this.next();
        }

        if (isValidPropValueToken(this.token)) {
          // plain value
          for (const key of keys) {
            obj[key] = this.token.value;
          }

          this.next();
        } else if (wasColon) {
          // parse object
          const val = this.parse(indent + 1);

          for (const key of keys) {
            obj[key] = val;
          }

          if (indent && this.token.type !== TOKEN_TYPES.indent) {
            break;
          }
        } else {
          this.unexpected('Invalid value type');
        }
      } else {
        this.unexpected(`Unknown token: ${util.inspect(propToken)}`);
      }
    }

    return obj;
  }
}

/**
 * Parse the lockfile.
 */
function parse(str: string, fileLoc: string): Object {
  const parser = new Parser(str, fileLoc);
  parser.next();
  return parser.parse();
}


export default function(str: string, fileLoc: string = 'lockfile'): ParseResult {
  return {type: 'success', object: parse(str, fileLoc)};
}
