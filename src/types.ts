// =============================================================================
// Shared types for the Elur compiler
// =============================================================================

export type BindingContext =
    | { type: "node" }
    | { type: "event"; eventName: string; modifiers: string[]; hadOpenQuote: boolean }
    | { type: "attr"; attrName: string; hadOpenQuote: boolean; url?: boolean; executable?: boolean };

export type ExpressionKind = "static" | "reactive" | "reactive-text" | "generic";

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
}

export interface ParsedNode {
    type: "element" | "comment" | "text";
    tag?: string;
    attrs?: Array<{ name: string; value: string }>;
    children: ParsedNode[];
    text?: string;
    void?: boolean;
}
