// =============================================================================
// index.ts — Public API for @elurjs/core-compiler
// =============================================================================

import { analyzeTemplate } from "./analyze.js";
import { parseHTML } from "./parse-dom.js";
import { walkTemplate, removeMarkerAttributes, optimizeTemplate } from "./walk.js";
import { genFactoryCode, genCallCode } from "./codegen.js";
import type { CompiledTemplate, ExpressionKind } from "./types.js";

/**
 * ABI del código generado (C.17). Se emite como `__elurAbi(N)` al inicio de
 * cada módulo compilado; `@elurjs/vite-plugin-elur/runtime/compiler` valida
 * que coincida con su `ELUR_COMPILER_ABI`. Bump cuando el contrato del
 * código emitido cambie (firma de helpers, shape del descriptor, proto).
 */
export const COMPILER_ABI_VERSION = 1;

export type {
    CompiledTemplate,
    CompiledBinding,
    BindingContext,
    ExpressionKind,
} from "./types.js";

/** Opciones de `compileTemplate` (todas opcionales — compat con callers viejos). */
export interface CompileOptions {
    /** C.9: valores literales para constant folding, alineados con las interpolaciones. */
    staticValues?: readonly unknown[];
    /**
     * C.12: hints de bloque por índice de interpolación ("each" para
     * `repeat(…)` especializado, "portal" para `portal(…)`). Se exponen en
     * `descriptor.blocks` como metadata serializable — la semántica runtime
     * ya va por el objeto dual/protocol; esto es la vista estructural para
     * dev metadata y tooling.
     */
    blockKinds?: readonly ("each" | "portal" | null | undefined)[];
    /** C.12 dev metadata: id lógico del template (factory id estable). */
    devId?: string;
}

export function compileTemplate(
    strings: readonly string[],
    expressionKinds: readonly ExpressionKind[] = [],
    staticValues?: readonly unknown[],
    options?: CompileOptions,
): CompiledTemplate {
    const { contexts, html: htmlWithMarkers } = analyzeTemplate(strings);
    const parsed = parseHTML(htmlWithMarkers);
    const { pathMap, accessPaths } = walkTemplate(parsed, contexts);
    const optimized = optimizeTemplate(parsed, contexts, expressionKinds, staticValues ?? options?.staticValues);

    const blocks = options?.blockKinds
        ?.map((kind, index) => (kind ? { index, kind } : null))
        .filter((b): b is { index: number; kind: "each" | "portal" } => b !== null);

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
        nodes: optimized.nodes,
        foldedIndices: optimized.folded.size ? [...optimized.folded] : undefined,
        blocks: blocks?.length ? blocks : undefined,
        devId: options?.devId,
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
