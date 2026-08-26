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

    // Detect whether the attribute value has an open quote. The previous
    // implementation only checked if tagContent ended with a quote, which
    // fails for partial attribute interpolations like:
    //   class="feature-card reveal${...}"
    // where tagContent is 'div class="feature-card reveal' — the last char
    // is 'l', not '"', but there IS an open quote after '='. We need to look
    // for an opening quote between '=' and the end that has no matching close.
    const afterEq = tagContent.slice(eqIdx + 1);
    const quoteChar = afterEq[0];
    const hasOpenQuote =
        (quoteChar === '"' || quoteChar === "'") &&
        // The opening quote is "open" (unmatched) if it's the only quote in
        // afterEq, or if the last quote char differs from it (odd count).
        // For partial interpolation, afterEq is like '"feature-card reveal'
        // — starts with " and has no closing ".
        afterEq.lastIndexOf(quoteChar) === 0;
    const hadOpenQuote = hasOpenQuote;

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
                const attrPrefix = `@${full}=`;
                // Find the attribute assignment from the end of the string.
                // Using lastIndexOf instead of slice(0, -cut) handles partial
                // attribute interpolations where static content appears
                // between the opening quote and the interpolation hole:
                //   class="feature-card reveal${expr}"
                // The old slice(0, -cut) only worked when the string ended
                // right after the opening quote (post-Phase-1 clean strings).
                const eqPos = s.lastIndexOf(attrPrefix);
                if (eqPos !== -1) {
                    result += s.slice(0, eqPos) + ` data-nix-e-${i}="${ctx.eventName}"`;
                } else {
                    result += s + ` data-nix-e-${i}="${ctx.eventName}"`;
                }
                if (ctx.hadOpenQuote) skipLeading[i + 1] = 1;
            } else {
                const attrPrefix = `${ctx.attrName}=`;
                const eqPos = s.lastIndexOf(attrPrefix);
                if (eqPos !== -1) {
                    result += s.slice(0, eqPos) + ` data-nix-a-${i}="${ctx.attrName}"`;
                } else {
                    result += s + ` data-nix-a-${i}="${ctx.attrName}"`;
                }
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
