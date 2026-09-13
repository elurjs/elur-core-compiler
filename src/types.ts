// =============================================================================
// Shared types for the Elur compiler
// =============================================================================

export type BindingContext =
    | { type: "node" }
    | { type: "event"; eventName: string; modifiers: string[]; hadOpenQuote: boolean }
    | { type: "attr"; attrName: string; hadOpenQuote: boolean; url?: boolean; executable?: boolean };

/**
 * Tier del binding (C.8):
 *  - "static"        → literal constante (cero effect)
 *  - "signal"        → T1: `() => <path>.value` — la SEÑAL viaja como arg,
 *                      edge directa sin getter ni tracking
 *  - "reactive-text" → getter que produce texto (effect + write)
 *  - "reactive"      → getter genérico (effect con dispatch por tipo)
 *  - "generic"       → valor opaco no-reactivo
 */
export type ExpressionKind = "static" | "reactive" | "reactive-text" | "signal" | "derived" | "generic";

export interface PathMapEntry {
    nodeIndex: number;
    name: string | null;
}

export interface CompiledBinding {
    index: number;
    context: BindingContext;
    expressionKind: ExpressionKind;
    path: number[];
    target: "node" | "parent" | "text";
    /** C.14: namespace del target — svg/mathml para foreign content. */
    ns?: "html" | "svg" | "mathml";
}

export interface CompiledTemplate {
    /** Original template strings (for SSR descriptor compatibility). */
    strings: readonly string[];
    /** HTML with data-elur-* markers (used for walking at build time). */
    htmlWithMarkers: string;
    /** HTML with data-elur-* attributes removed (used by the generic fallback). */
    htmlWithoutMarkers: string;
    /** Compact HTML used by the imperative renderer. */
    optimizedHtml: string;
    /** Binding contexts for each interpolation. */
    contexts: BindingContext[];
    /** Path map retained for generic runtime compatibility. */
    pathMap: Array<PathMapEntry | null>;
    /** Access paths retained for generic runtime compatibility. */
    accessPaths: Array<number[] | null>;
    /** Imperative binding operations and their optimized DOM targets. */
    bindings: CompiledBinding[];
    /** True when the optimized template has one stable root element. */
    singleRoot: boolean;
    /** True when the template can use the imperative renderer safely. */
    specialized: boolean;
    /**
     * C.13: árbol parseado+compactado — el codegen lo recorre para emitir la
     * función de hidratación posicional (cursor sobre el DOM SSR).
     */
    nodes?: ParsedNode[];
    /**
     * C.9: índices de interpolación plegados a constante — el literal se
     * horneó en `optimizedHtml` y el binding desapareció del mount. El arg
     * y el contexto SE CONSERVAN (paridad del descriptor SSR/hydrate, que
     * resuelve values por posición sobre `strings`/`contexts` completos).
     */
    foldedIndices?: number[];
    /**
     * C.12: bloques estructurales detectados por el plugin — "each" para
     * `repeat(…)` especializado, "portal" para `portal(…)`. Metadata
     * serializable expuesta en `descriptor.blocks` (dev tooling / IR).
     */
    blocks?: Array<{ index: number; kind: "each" | "portal" }>;
    /** C.12 dev metadata: id lógico estable del template (factory name). */
    devId?: string;
}

export interface ParsedNode {
    type: "element" | "comment" | "text";
    tag?: string;
    attrs?: Array<{ name: string; value: string }>;
    children: ParsedNode[];
    text?: string;
    void?: boolean;
}
