// =============================================================================
// analyze.ts — detectContext + buildHTML ported from @deijose/nix-js core
// =============================================================================
// These are pure string-manipulation functions with no DOM dependencies.
// Ported from nix-js-microframework/src/nix/template/bindings.ts and html.ts
// to keep the compiler standalone.

import type { BindingContext } from "./types.js";

// --- Sanitize helpers (ported from sanitize.ts) ---

const URL_ATTRS = new Set([
    "href", "src", "action", "formaction", "xlink:href",
    "poster", "background", "cite", "ping", "data",
]);

export function isUrlAttrName(name: string): boolean {
    return URL_ATTRS.has(name.toLowerCase());
}

export function isExecutableAttrName(name: string): boolean {
    const n = name.toLowerCase();
    return n.startsWith("on") || n === "srcdoc";
}

// --- detectContext (ported from bindings.ts) ---

export function detectContext(prevString: string): BindingContext {
    const lastClose = prevString.lastIndexOf(">");
    const lastOpen = prevString.lastIndexOf("<");

    if (lastOpen <= lastClose) {
        return { type: "node" };
    }

    const tagContent = prevString.slice(lastOpen + 1);

    const eqIdx = tagContent.lastIndexOf("=");
    if (eqIdx === -1) {
        return { type: "node" };
    }

    const hadOpenQuote =
        tagContent.endsWith('"') ||
        tagContent.endsWith("'") ||
        tagContent[tagContent.length - 1] === '"' ||
        tagContent[tagContent.length - 1] === "'";

    let startIdx = eqIdx - 1;
    while (startIdx >= 0 && /\S/.test(tagContent[startIdx])) {
        startIdx--;
    }
    startIdx++;

    const fullAttr = tagContent.slice(startIdx, eqIdx);

    if (fullAttr[0] === "@") {
        const parts = fullAttr.slice(1).split(".");
        return {
            type: "event",
            eventName: parts[0],
            modifiers: parts.slice(1),
            hadOpenQuote,
        };
    }

    return {
        type: "attr",
        attrName: fullAttr,
        hadOpenQuote,
        url: isUrlAttrName(fullAttr),
        executable: isExecutableAttrName(fullAttr),
    };
}

// --- buildHTML (ported from html.ts) ---

export function buildHTML(
    strings: readonly string[],
    contexts: BindingContext[],
): string {
    const skipLeading = new Uint8Array(strings.length);
    let result = "";

    for (let i = 0; i < strings.length; i++) {
        let s = strings[i];

        if (skipLeading[i] === 1 && (s[0] === '"' || s[0] === "'")) {
            s = s.slice(1);
        }

        if (i < contexts.length) {
            const ctx = contexts[i];

            if (ctx.type === "node") {
                result += s + `<!--nix-${i}-->`;
            } else if (ctx.type === "event") {
                const full = ctx.modifiers.length
                    ? `${ctx.eventName}.${ctx.modifiers.join(".")}`
                    : ctx.eventName;
                const cut = `@${full}=`.length + (ctx.hadOpenQuote ? 1 : 0);
                result += s.slice(0, -cut) + ` data-nix-e-${i}="${ctx.eventName}"`;
                if (ctx.hadOpenQuote) skipLeading[i + 1] = 1;
            } else {
                const cut =
                    `${ctx.attrName}=`.length + (ctx.hadOpenQuote ? 1 : 0);
                result += s.slice(0, -cut) + ` data-nix-a-${i}="${ctx.attrName}"`;
                if (ctx.hadOpenQuote) skipLeading[i + 1] = 1;
            }
        } else {
            result += s;
        }
    }

    return result;
}

// --- analyzeTemplate: run detectContext + buildHTML ---

export function analyzeTemplate(strings: readonly string[]): {
    contexts: BindingContext[];
    html: string;
} {
    const contexts: BindingContext[] = [];
    let accumulated = "";
    for (let i = 0; i < strings.length - 1; i++) {
        accumulated += strings[i];
        contexts.push(detectContext(accumulated));
        accumulated += "__nix__";
    }
    const html = buildHTML(strings, contexts);
    return { contexts, html };
}
