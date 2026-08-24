// =============================================================================
// index.ts — Public API for @deijose/nix-js-compiler
// =============================================================================

import { analyzeTemplate } from "./analyze.js";
import { parseHTML } from "./parse-dom.js";
import { walkTemplate, removeMarkerAttributes, optimizeTemplate } from "./walk.js";
import { genFactoryCode, genCallCode } from "./codegen.js";
import type { CompiledTemplate, ExpressionKind } from "./types.js";

export type {
    CompiledTemplate,
    CompiledBinding,
    BindingContext,
    ExpressionKind,
} from "./types.js";

export function compileTemplate(
    strings: readonly string[],
    expressionKinds: readonly ExpressionKind[] = [],
): CompiledTemplate {
    const { contexts, html: htmlWithMarkers } = analyzeTemplate(strings);
    const parsed = parseHTML(htmlWithMarkers);
    const { pathMap, accessPaths } = walkTemplate(parsed, contexts);
    const optimized = optimizeTemplate(parsed, contexts, expressionKinds);

    return {
        strings,
        htmlWithMarkers,
        htmlWithoutMarkers: removeMarkerAttributes(htmlWithMarkers),
        optimizedHtml: optimized.html,
        contexts,
        pathMap,
        accessPaths,
        bindings: optimized.bindings,
        singleRoot: optimized.singleRoot,
        specialized: optimized.specialized,
    };
}

export function compile(
    strings: readonly string[],
    id: string,
    expressionNames: string[],
    expressionKinds: readonly ExpressionKind[] = [],
): { factoryCode: string; callCode: string; runtimeImports: string[] } {
    const compiled = compileTemplate(strings, expressionKinds);
    const generated = genFactoryCode(id, compiled);
    return {
        factoryCode: generated.code,
        callCode: genCallCode(id, expressionNames),
        runtimeImports: generated.runtimeImports,
    };
}

export { analyzeTemplate, parseHTML, walkTemplate, removeMarkerAttributes, optimizeTemplate };
export { genFactoryCode, genCallCode };
