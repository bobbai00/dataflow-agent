/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Parser for the debug-mode input format, which stands in for the model:
 *
 *   Function(name='toolName', arguments='<python-dict-literal>')
 *   Reply(text='<the agent's reply>')
 *
 * Either may follow lines of free text, the step's reasoning. The arguments
 * value is a Python repr of the tool input dict (single-quoted keys/values,
 * with `\'` and `\n` escapes). We do NOT use eval — we walk the input
 * character-by-character with a small recursive-descent parser that
 * understands Python literals (dict, list, string, number, True/False/None).
 */

export interface ParsedFunctionCall {
    name: string;
    arguments: any;
}

/** A debug input that stands for the agent: its reasoning, then one tool call or its reply. */
export interface DebugAgentInput {
    /** The lines before the call or reply, as the step's visible text. */
    thought?: string;
    call?: ParsedFunctionCall;
    /** `Reply(text='...')`: the agent's reply, which ends the task. */
    reply?: string;
}

const AGENT_INPUT = /^[ \t]*(Function|Reply)\s*\(/m;

/** Returns true when the input looks like a Function(...) call (debug action). */
export function looksLikeFunctionCall(input: string): boolean {
    return /^\s*Function\s*\(/.test(input);
}

/** Whether the input stands for the agent (a call or a reply, after any reasoning) rather than the user. */
export function looksLikeAgentInput(input: string): boolean {
    return AGENT_INPUT.test(input);
}

/** Parse an agent input: the reasoning before the first line that opens a
 * `Function(` or `Reply(`, then that call or reply. Throws on malformed input. */
export function parseDebugInput(input: string): DebugAgentInput {
    const match = AGENT_INPUT.exec(input);
    if (!match) throw new Error("Input is neither a Function(...) call nor a Reply(...)");
    const thought = input.slice(0, match.index).trim();
    const rest = input.slice(match.index);
    const parsed: DebugAgentInput = thought ? { thought } : {};
    if (match[1] === "Reply") parsed.reply = parseReply(rest);
    else parsed.call = parseFunctionCall(rest);
    return parsed;
}

/** Parse `Reply(text='...')`. Throws on malformed input. */
export function parseReply(input: string): string {
    const trimmed = input.trim();
    if (!/^Reply\s*\(/.test(trimmed)) throw new Error("Input is not a Reply(...)");
    if (!trimmed.endsWith(")")) throw new Error("Reply(...) is missing closing ')'");
    const parser = new PyParser(trimmed.substring(trimmed.indexOf("(") + 1, trimmed.length - 1));
    parser.skipWs();
    parser.expectIdent("text");
    parser.skipWs();
    parser.expectChar("=");
    parser.skipWs();
    const text = parser.parseString();
    parser.skipWs();
    if (parser.peek() === ",") {
        parser.advance();
        parser.skipWs();
    }
    if (!parser.eof()) throw new Error(`Unexpected trailing input at offset ${parser.pos()}`);
    return text;
}

/**
 * Parse a Function(name='...', arguments='...') call. Throws on malformed input.
 */
export function parseFunctionCall(input: string): ParsedFunctionCall {
    const trimmed = input.trim();
    if (!looksLikeFunctionCall(trimmed)) {
        throw new Error("Input is not a Function(...) call");
    }
    if (!trimmed.endsWith(")")) {
        throw new Error("Function(...) call is missing closing ')'");
    }

    const openParen = trimmed.indexOf("(");
    const inner = trimmed.substring(openParen + 1, trimmed.length - 1);

    const parser = new PyParser(inner);
    parser.skipWs();

    // name=
    parser.expectIdent("name");
    parser.skipWs();
    parser.expectChar("=");
    parser.skipWs();
    const name = parser.parseString();
    parser.skipWs();
    parser.expectChar(",");
    parser.skipWs();

    // arguments=
    parser.expectIdent("arguments");
    parser.skipWs();
    parser.expectChar("=");
    parser.skipWs();
    const argsStr = parser.parseString();
    parser.skipWs();

    // Trailing comma allowed (Python style)
    if (parser.peek() === ",") {
        parser.advance();
        parser.skipWs();
    }
    if (!parser.eof()) {
        throw new Error(`Unexpected trailing input at offset ${parser.pos()}`);
    }

    // Now parse the arguments string itself as a Python literal (typically a dict).
    const argsParser = new PyParser(argsStr);
    argsParser.skipWs();
    const args = argsParser.parseValue();
    argsParser.skipWs();
    if (!argsParser.eof()) {
        throw new Error("Trailing data after Function(...) arguments dict");
    }

    return { name, arguments: args };
}

// ============================================================================
// Python-literal recursive-descent parser
// ============================================================================

class PyParser {
    private readonly s: string;
    private i: number = 0;

    constructor(s: string) {
        this.s = s;
    }

    pos(): number {
        return this.i;
    }
    eof(): boolean {
        return this.i >= this.s.length;
    }
    peek(): string {
        return this.s[this.i];
    }
    advance(): void {
        this.i++;
    }

    skipWs(): void {
        while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
    }

    expectChar(ch: string): void {
        if (this.s[this.i] !== ch) {
            throw new Error(`Expected '${ch}' at offset ${this.i}, got '${this.s[this.i] ?? "EOF"}'`);
        }
        this.i++;
    }

    expectIdent(ident: string): void {
        if (!this.s.startsWith(ident, this.i)) {
            throw new Error(`Expected identifier '${ident}' at offset ${this.i}`);
        }
        this.i += ident.length;
    }

    parseValue(): any {
        this.skipWs();
        if (this.eof()) throw new Error("Unexpected EOF while parsing value");
        const ch = this.s[this.i];
        if (ch === "{") return this.parseDict();
        if (ch === "[") return this.parseList();
        if (ch === "(") return this.parseTuple();
        if (ch === "'" || ch === '"') return this.parseString();
        if (ch === "T" || ch === "F" || ch === "N") return this.parseLiteral();
        if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9")) return this.parseNumber();
        throw new Error(`Unexpected character '${ch}' at offset ${this.i}`);
    }

    parseString(): string {
        const quote = this.s[this.i];
        if (quote !== "'" && quote !== '"') {
            throw new Error(`Expected string quote at offset ${this.i}`);
        }
        this.i++;
        let out = "";
        while (this.i < this.s.length) {
            const ch = this.s[this.i];
            if (ch === "\\") {
                const next = this.s[this.i + 1];
                if (next === undefined) throw new Error("Dangling backslash in string");
                out += unescapeChar(next, () => this.readHexEscape(next));
                // readHexEscape advances internally for \x..; otherwise advance 2 chars.
                if (next !== "x" && next !== "u" && next !== "U") {
                    this.i += 2;
                }
            } else if (ch === quote) {
                this.i++;
                return out;
            } else {
                out += ch;
                this.i++;
            }
        }
        throw new Error("Unterminated string literal");
    }

    /** Read \xNN, \uNNNN, or \UNNNNNNNN, advancing past the entire escape. Returns the decoded char. */
    private readHexEscape(kind: string): string {
        // Called with this.i pointing at the backslash.
        const len = kind === "x" ? 2 : kind === "u" ? 4 : 8;
        const hexStart = this.i + 2;
        const hex = this.s.substring(hexStart, hexStart + len);
        if (hex.length < len || !/^[0-9a-fA-F]+$/.test(hex)) {
            throw new Error(`Bad \\${kind} escape at offset ${this.i}`);
        }
        this.i = hexStart + len;
        return String.fromCodePoint(parseInt(hex, 16));
    }

    parseDict(): Record<string, any> {
        this.expectChar("{");
        const obj: Record<string, any> = {};
        this.skipWs();
        if (this.peek() === "}") {
            this.advance();
            return obj;
        }
        while (true) {
            this.skipWs();
            // Key: in Python repr these are typically strings, but allow numbers as keys too (coerced to string).
            let key: string;
            const ch = this.peek();
            if (ch === "'" || ch === '"') {
                key = this.parseString();
            } else {
                const v = this.parseValue();
                key = String(v);
            }
            this.skipWs();
            this.expectChar(":");
            this.skipWs();
            obj[key] = this.parseValue();
            this.skipWs();
            const sep = this.peek();
            if (sep === ",") {
                this.advance();
                this.skipWs();
                if (this.peek() === "}") {
                    this.advance();
                    return obj;
                }
                continue;
            }
            if (sep === "}") {
                this.advance();
                return obj;
            }
            throw new Error(`Expected ',' or '}' in dict at offset ${this.i}`);
        }
    }

    parseList(): any[] {
        this.expectChar("[");
        const arr: any[] = [];
        this.skipWs();
        if (this.peek() === "]") {
            this.advance();
            return arr;
        }
        while (true) {
            this.skipWs();
            arr.push(this.parseValue());
            this.skipWs();
            const sep = this.peek();
            if (sep === ",") {
                this.advance();
                this.skipWs();
                if (this.peek() === "]") {
                    this.advance();
                    return arr;
                }
                continue;
            }
            if (sep === "]") {
                this.advance();
                return arr;
            }
            throw new Error(`Expected ',' or ']' in list at offset ${this.i}`);
        }
    }

    /** Tuples are accepted and decoded as plain arrays. */
    parseTuple(): any[] {
        this.expectChar("(");
        const arr: any[] = [];
        this.skipWs();
        if (this.peek() === ")") {
            this.advance();
            return arr;
        }
        while (true) {
            this.skipWs();
            arr.push(this.parseValue());
            this.skipWs();
            const sep = this.peek();
            if (sep === ",") {
                this.advance();
                this.skipWs();
                if (this.peek() === ")") {
                    this.advance();
                    return arr;
                }
                continue;
            }
            if (sep === ")") {
                this.advance();
                return arr;
            }
            throw new Error(`Expected ',' or ')' in tuple at offset ${this.i}`);
        }
    }

    parseLiteral(): boolean | null {
        if (this.s.startsWith("True", this.i)) {
            this.i += 4;
            return true;
        }
        if (this.s.startsWith("False", this.i)) {
            this.i += 5;
            return false;
        }
        if (this.s.startsWith("None", this.i)) {
            this.i += 4;
            return null;
        }
        throw new Error(`Unknown literal at offset ${this.i}`);
    }

    parseNumber(): number {
        const m = this.s.substring(this.i).match(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/);
        if (!m) throw new Error(`Invalid number at offset ${this.i}`);
        this.i += m[0].length;
        return Number(m[0]);
    }
}

/** Map a single character following a `\` to its decoded form. */
function unescapeChar(next: string, readHex: () => string): string {
    switch (next) {
        case "n":
            return "\n";
        case "t":
            return "\t";
        case "r":
            return "\r";
        case "b":
            return "\b";
        case "f":
            return "\f";
        case "v":
            return "\v";
        case "0":
            return "\0";
        case "a":
            return "\x07";
        case "\\":
            return "\\";
        case "'":
            return "'";
        case '"':
            return '"';
        case "x":
        case "u":
        case "U":
            return readHex();
        default:
            // Unknown escape: keep the character literally (Python is lenient too).
            return next;
    }
}
