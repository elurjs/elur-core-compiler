// =============================================================================
// walk.ts — Build generic and optimized DOM access metadata
// =============================================================================

import type {
    ParsedNode,
    BindingContext,
    PathMapEntry,
    CompiledBinding,
    ExpressionKind,
} from "./types.js";

interface WalkResult {
    pathMap: Array<PathMapEntry | null>;
    accessPaths: Array<number[] | null>;
}

interface OptimizeResult {
    html: string;
    bindings: CompiledBinding[];
    singleRoot: boolean;
    specialized: boolean;
    /** Árbol parseado+compactado (placeholders node-binding conservados como
     * comments `elur-N`; targets "text" como text " "; "parent" removidos).
     * C.13: lo usa el codegen para emitir el walk de hidratación. */
    nodes: ParsedNode[];
    /** C.9: índices de interpolación plegados a literal en el HTML. */
    folded: Set<number>;
}

const STRUCTURAL_WHITESPACE_PARENTS = new Set([
    "table", "thead", "tbody", "tfoot", "tr", "colgroup",
]);

const STRUCTURAL_ROOTS = new Set([
    "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "col",
]);

// C.14: svg/math ya NO son unsafe — el clone vía <template> parsea foreign
// content correctamente y los paths childNodes funcionan igual; el runtime
// resuelve namespaces (className/setAttributeNS) por `namespaceURI`.
// Sigue siendo unsafe lo que rompe los paths: <template> (contenido en
// .content, no en childNodes), rawtext (script/style) y pre/textarea
// (semántica de whitespace inicial). Un binding dentro de estos subárboles
// degrada el template; tags unsafe estáticos no.
const UNSAFE_SPECIALIZED_TAGS = new Set([
    "template", "script", "style", "textarea", "pre",
]);

export const DELEGABLE_EVENTS = new Set([
    "click", "dblclick", "mousedown", "mouseup", "keydown", "keyup", "input", "change", "submit",
]);

export function walkTemplate(
    nodes: ParsedNode[],
    contexts: BindingContext[],
): WalkResult {
    const numBindings = contexts.length;
    const pathMap: Array<PathMapEntry | null> = new Array(numBindings).fill(null);
    const accessPaths: Array<number[] | null> = new Array(numBindings).fill(null);
    let nodeIndex = 0;

    function walkChildren(children: ParsedNode[], basePath: number[]): void {
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.type !== "element" && child.type !== "comment") continue;

            nodeIndex++;
            const childPath = [...basePath, i];

            if (child.type === "comment") {
                const text = child.text ?? "";
                if (text.startsWith("elur-")) {
                    const idx = parseInt(text.slice(5), 10);
                    if (!isNaN(idx) && idx < numBindings) {
                        pathMap[idx] = { nodeIndex, name: null };
                        accessPaths[idx] = childPath;
                    }
                }
            } else if (child.attrs) {
                for (const attr of child.attrs) {
                    if (attr.name.startsWith("data-elur-a-")) {
                        const idx = parseInt(attr.name.slice(12), 10);
                        if (!isNaN(idx) && idx < numBindings) {
                            pathMap[idx] = { nodeIndex, name: attr.value };
                            accessPaths[idx] = childPath;
                        }
                    } else if (attr.name.startsWith("data-elur-e-")) {
                        const idx = parseInt(attr.name.slice(12), 10);
                        if (!isNaN(idx) && idx < numBindings) {
                            pathMap[idx] = { nodeIndex, name: attr.value };
                            accessPaths[idx] = childPath;
                        }
                    }
                }
            }

            if (child.type === "element" && !child.void && child.children.length > 0) {
                walkChildren(child.children, childPath);
            }
        }
    }

    walkChildren(nodes, []);
    return { pathMap, accessPaths };
}

export function optimizeTemplate(
    sourceNodes: ParsedNode[],
    contexts: BindingContext[],
    expressionKinds: readonly ExpressionKind[],
    staticValues?: readonly unknown[],
): OptimizeResult {
    const nodes = cloneNodes(sourceNodes);
    compactWhitespace(nodes, null);

    // C.9 constant folding: una interpolación "static" cuyo valor es un
    // literal string/number se hornea directo en el HTML — sin arg de
    // factory, sin binding, sin operación DOM en mount. No se pliegan:
    // directivas (ref/show/hide/executable), attrs url (sanitizan en
    // runtime), eventos, ni valores boolean/null (semántica de presencia
    // y textos vacíos tienen edge cases — conservador).
    const folded = new Set<number>();
    const foldableValue = (i: number): string | null => {
        if (expressionKinds[i] !== "static" || !staticValues) return null;
        const v = staticValues[i];
        if (typeof v !== "string" && typeof v !== "number") return null;
        return String(v);
    };

    const targetNodes = new Map<number, { node: ParsedNode; target: "node" | "parent" | "text"; ns: "html" | "svg" | "mathml" }>();
    let specialized = true;

    // C.14: namespace efectivo del elemento — svg/math entran en foreign
    // content; foreignObject (dentro de svg) vuelve a html.
    const childNs = (tag: string, parentNs: "html" | "svg" | "mathml"): "html" | "svg" | "mathml" => {
        if (tag === "svg") return "svg";
        if (tag === "math") return "mathml";
        if (tag === "foreignobject" && parentNs === "svg") return "html";
        return parentNs;
    };

    function collect(children: ParsedNode[], parent: ParsedNode | null, parentNs: "html" | "svg" | "mathml", insideUnsafe: boolean): void {
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.type === "element") {
                const tag = child.tag?.toLowerCase() ?? "";
                const ns = childNs(tag, parentNs);
                const unsafe = insideUnsafe || UNSAFE_SPECIALIZED_TAGS.has(tag);
                const retainedAttrs: Array<{ name: string; value: string }> = [];
                for (const attr of child.attrs ?? []) {
                    const match = /^data-elur-[ae]-(\d+)$/.exec(attr.name);
                    if (match) {
                        const idx = Number(match[1]);
                        const ctx = contexts[idx];
                        const lit = foldableValue(idx);
                        if (
                            lit !== null &&
                            ctx?.type === "attr" &&
                            ctx.attrName !== "ref" &&
                            ctx.attrName !== "show" &&
                            ctx.attrName !== "hide" &&
                            !ctx.executable &&
                            !ctx.url &&
                            !ctx.attrName.startsWith("@") &&
                            !unsafe
                        ) {
                            // C.9: attr literal → horneado en el HTML (el
                            // literal es un string JS raw: escape completo).
                            retainedAttrs.push({ name: ctx.attrName, value: escapeBakedAttr(lit) });
                            folded.add(idx);
                            continue;
                        }
                        // C.14: binding dentro de subárbol unsafe → el
                        // path no lo alcanza; degrada el template.
                        if (unsafe) specialized = false;
                        targetNodes.set(idx, { node: child, target: "node", ns });
                    } else {
                        retainedAttrs.push(attr);
                    }
                }
                child.attrs = retainedAttrs;
                collect(child.children, child, ns, unsafe);
                continue;
            }

            if (child.type !== "comment") continue;
            const match = /^elur-(\d+)$/.exec(child.text ?? "");
            if (!match) continue;
            const index = Number(match[1]);
            {
                const lit = foldableValue(index);
                const parentTag = parent?.tag?.toLowerCase() ?? "";
                if (
                    lit !== null &&
                    contexts[index]?.type === "node" &&
                    !STRUCTURAL_WHITESPACE_PARENTS.has(parentTag) &&
                    !insideUnsafe
                ) {
                    // C.9: texto literal → nodo text escapado en el HTML.
                    // (En table/tbody/… el browser descarta texto suelto.)
                    children[i] = { type: "text", text: escapeText(lit), children: [] };
                    folded.add(index);
                    continue;
                }
            }
            if (insideUnsafe) specialized = false;
            if (parent && parent.children.length === 1) {
                // T1 ("signal") y T2 ("derived") comparten el target "text"
                // con reactive-text: el placeholder se reemplaza por un Text
                // node real.
                if (
                    expressionKinds[index] === "reactive-text" ||
                    expressionKinds[index] === "signal" ||
                    expressionKinds[index] === "derived"
                ) {
                    const placeholder: ParsedNode = { type: "text", text: " ", children: [] };
                    children[i] = placeholder;
                    targetNodes.set(index, { node: placeholder, target: "text", ns: parentNs });
                } else {
                    targetNodes.set(index, { node: parent, target: "parent", ns: parentNs });
                    children.splice(i--, 1);
                }
            } else {
                targetNodes.set(index, { node: child, target: "node", ns: parentNs });
            }
        }
    }

    collect(nodes, null, "html", false);

    // C.14 multi-root: bounds comments permanentes — dan first/last estable
    // al factory de fragmento para remove-por-rango, y cuentan en los paths.
    const singleRoot = nodes.length === 1 && nodes[0].type === "element";
    if (!singleRoot) {
        nodes.unshift({ type: "comment", text: "elur-fs", children: [] });
        nodes.push({ type: "comment", text: "elur-fe", children: [] });
    }

    const nodePaths = new Map<ParsedNode, number[]>();
    function indexNodes(children: ParsedNode[], base: number[]): void {
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const path = [...base, i];
            nodePaths.set(child, path);
            if (child.type === "element") indexNodes(child.children, path);
        }
    }
    indexNodes(nodes, []);

    const bindings: CompiledBinding[] = [];
    for (let i = 0; i < contexts.length; i++) {
        if (folded.has(i)) continue; // C.9: literal plegado — sin binding.
        // C.3: ref/show/hide/executable attrs y eventos no delegables
        // (capture/once/passive) ya no degradan el template — el codegen los
        // rutea a helpers genéricos por binding (`__elurGenericAttr` /
        // `__elurGenericEvent`).
        const context = contexts[i];
        const target = targetNodes.get(i);
        const path = target ? nodePaths.get(target.node) : undefined;
        if (!target || !path) {
            specialized = false;
            continue;
        }
        bindings.push({
            index: i,
            context: contexts[i],
            expressionKind: expressionKinds[i] ?? "generic",
            path,
            target: target.target,
            ns: target.ns,
        });
    }



    return {
        html: nodes.map(serializeNode).join(""),
        bindings,
        singleRoot,
        // C.9: los bindings plegados ya no existen — la condición de
        // especialización completa cuenta contexts no plegados.
        specialized: specialized && bindings.length + folded.size === contexts.length,
        nodes,
        folded,
    };
}

function compactWhitespace(children: ParsedNode[], parentTag: string | null): void {
    for (const child of children) {
        if (child.type === "element") compactWhitespace(child.children, child.tag?.toLowerCase() ?? null);
    }

    if (parentTag !== "pre" && parentTag !== "textarea") {
        while (children.length > 0 && isFormattingWhitespace(children[0])) children.shift();
        while (children.length > 0 && isFormattingWhitespace(children[children.length - 1])) children.pop();
    }

    if (parentTag && STRUCTURAL_WHITESPACE_PARENTS.has(parentTag)) {
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (child.type === "text" && /^\s+$/.test(child.text ?? "")) children.splice(i, 1);
        }
        return;
    }

    if (parentTag === null) {
        const meaningful = children.filter((node) => node.type !== "text" || !/^\s*$/.test(node.text ?? ""));
        if (
            meaningful.length === 1 &&
            meaningful[0].type === "element" &&
            STRUCTURAL_ROOTS.has(meaningful[0].tag?.toLowerCase() ?? "")
        ) {
            for (let i = children.length - 1; i >= 0; i--) {
                const child = children[i];
                if (child.type === "text" && /^\s+$/.test(child.text ?? "")) children.splice(i, 1);
            }
        }
    }
}

function isFormattingWhitespace(node: ParsedNode): boolean {
    return node.type === "text" && /^[\t\n\r ]+$/.test(node.text ?? "") && /[\n\r]/.test(node.text ?? "");
}

function cloneNodes(nodes: ParsedNode[]): ParsedNode[] {
    return nodes.map((node) => ({
        ...node,
        attrs: node.attrs?.map((attr) => ({ ...attr })),
        children: cloneNodes(node.children),
    }));
}

function serializeNode(node: ParsedNode): string {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "comment") return `<!--${node.text ?? ""}-->`;

    const attrs = (node.attrs ?? [])
        .map((attr) => attr.value === "" ? ` ${attr.name}` : ` ${attr.name}="${escapeAttribute(attr.value)}"`)
        .join("");
    const open = `<${node.tag}${attrs}>`;
    if (node.void) return open;
    return `${open}${node.children.map(serializeNode).join("")}</${node.tag}>`;
}

function escapeAttribute(value: string): string {
    return value.replace(/"/g, "&quot;");
}

// C.9: los literales plegados son strings JS raw — a diferencia de los attrs
// del source (que el parser conserva ya escapados), necesitan escape completo.
function escapeBakedAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function removeMarkerAttributes(html: string): string {
    return html.replace(/\s+data-elur-[ae]-\d+="[^"]*"/g, "");
}
