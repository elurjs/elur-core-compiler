// =============================================================================
// parse-dom.ts — Lightweight HTML parser for template strings
// =============================================================================
// Parses well-formed HTML (output of buildHTML) into a tree of ParsedNode.
// Handles: elements with attributes, comments, text, void elements, self-closing.
// Does NOT handle: CDATA, processing instructions (except doctype skip).

import type { ParsedNode } from "./types.js";

const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Parses an HTML string into a tree of ParsedNode.
 * Returns the top-level children (as if children of a DocumentFragment).
 */
export function parseHTML(html: string): ParsedNode[] {
    const root: ParsedNode = { type: "element", tag: "#root", children: [] };
    const stack: ParsedNode[] = [root];
    let i = 0;
    const len = html.length;

    while (i < len) {
        if (html[i] === "<") {
            if (html.startsWith("<!--", i)) {
                // Comment
                const end = html.indexOf("-->", i + 4);
                if (end === -1) {
                    // Malformed — treat rest as text
                    const text = html.slice(i);
                    pushText(stack, text);
                    break;
                }
                const text = html.slice(i + 4, end);
                stack[stack.length - 1].children.push({
                    type: "comment",
                    text,
                    children: [],
                });
                i = end + 3;
            } else if (html[i + 1] === "/") {
                // Closing tag
                const end = html.indexOf(">", i);
                if (end === -1) break;
                // Pop the stack — find matching tag
                const closeTag = html.slice(i + 2, end).trim().toLowerCase();
                // Pop until we find the matching tag (handles minor nesting issues)
                for (let j = stack.length - 1; j >= 1; j--) {
                    if (stack[j].tag?.toLowerCase() === closeTag) {
                        stack.length = j;
                        break;
                    }
                }
                i = end + 1;
            } else if (html[i + 1] === "!") {
                // Doctype or other declaration — skip to >
                const end = html.indexOf(">", i);
                if (end === -1) break;
                i = end + 1;
            } else {
                // Opening tag
                const end = findTagEnd(html, i);
                if (end === -1) break;
                const tagContent = html.slice(i + 1, end);
                const selfClosing = tagContent.endsWith("/");
                const tagStr = selfClosing ? tagContent.slice(0, -1).trim() : tagContent.trim();

                const { tag, attrs } = parseTagContent(tagStr);
                if (!tag || !/^[a-zA-Z]/.test(tag)) {
                    // Not a valid tag — treat as text
                    pushText(stack, html.slice(i, end + 1));
                    i = end + 1;
                    continue;
                }

                const isVoid = VOID_ELEMENTS.has(tag.toLowerCase());
                const element: ParsedNode = {
                    type: "element",
                    tag,
                    attrs,
                    children: [],
                    void: isVoid || selfClosing,
                };
                stack[stack.length - 1].children.push(element);

                if (!isVoid && !selfClosing) {
                    stack.push(element);
                }
                i = end + 1;
            }
        } else {
            // Text content
            const end = html.indexOf("<", i);
            const text = html.slice(i, end === -1 ? len : end);
            pushText(stack, text);
            i = end === -1 ? len : end;
        }
    }

    return root.children;
}

function pushText(stack: ParsedNode[], text: string): void {
    if (text.length === 0) return;
    stack[stack.length - 1].children.push({
        type: "text",
        text,
        children: [],
    });
}

/** Find the end of a tag, respecting quoted attribute values. */
function findTagEnd(html: string, start: number): number {
    let i = start + 1;
    let inQuote: string | null = null;
    while (i < html.length) {
        const ch = html[i];
        if (inQuote) {
            if (ch === inQuote) inQuote = null;
        } else {
            if (ch === '"' || ch === "'") {
                inQuote = ch;
            } else if (ch === ">") {
                return i;
            }
        }
        i++;
    }
    return -1;
}

/** Parse tag name and attributes from the content between < and >. */
function parseTagContent(s: string): {
    tag: string;
    attrs: Array<{ name: string; value: string }>;
} {
    // Extract tag name
    let idx = 0;
    while (idx < s.length && /[a-zA-Z0-9-]/.test(s[idx])) idx++;
    const tag = s.slice(0, idx);
    const attrStr = s.slice(idx).trim();

    const attrs: Array<{ name: string; value: string }> = [];
    if (attrStr.length === 0) return { tag, attrs };

    // Parse attributes
    let j = 0;
    while (j < attrStr.length) {
        // Skip whitespace
        while (j < attrStr.length && /\s/.test(attrStr[j])) j++;
        if (j >= attrStr.length) break;

        // Read attribute name
        let nameStart = j;
        while (j < attrStr.length && /[a-zA-Z0-9-:_@.]/.test(attrStr[j])) j++;
        const name = attrStr.slice(nameStart, j);

        if (name.length === 0) {
            j++;
            continue;
        }

        // Skip whitespace
        while (j < attrStr.length && /\s/.test(attrStr[j])) j++;

        // Check for =
        if (attrStr[j] === "=") {
            j++; // skip =
            while (j < attrStr.length && /\s/.test(attrStr[j])) j++;

            if (attrStr[j] === '"' || attrStr[j] === "'") {
                const quote = attrStr[j];
                j++;
                let valStart = j;
                while (j < attrStr.length && attrStr[j] !== quote) j++;
                attrs.push({ name, value: attrStr.slice(valStart, j) });
                j++; // skip closing quote
            } else {
                let valStart = j;
                while (j < attrStr.length && !/\s/.test(attrStr[j])) j++;
                attrs.push({ name, value: attrStr.slice(valStart, j) });
            }
        } else {
            // Boolean attribute
            attrs.push({ name, value: "" });
        }
    }

    return { tag, attrs };
}
