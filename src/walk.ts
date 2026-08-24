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
}

const STRUCTURAL_WHITESPACE_PARENTS = new Set([
    "table", "thead", "tbody", "tfoot", "tr", "colgroup",
]);

const STRUCTURAL_ROOTS = new Set([
    "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "col",
]);

const UNSAFE_SPECIALIZED_TAGS = new Set([
    "svg", "math", "template", "script", "style", "textarea", "pre",
]);

const DELEGABLE_EVENTS = new Set([
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
                if (text.startsWith("nix-")) {
                    const idx = parseInt(text.slice(4), 10);
                    if (!isNaN(idx) && idx < numBindings) {
                        pathMap[idx] = { nodeIndex, name: null };
                        accessPaths[idx] = childPath;
                    }
                }
            } else if (child.attrs) {
                for (const attr of child.attrs) {
                    if (attr.name.startsWith("data-nix-a-")) {
                        const idx = parseInt(attr.name.slice(11), 10);
                        if (!isNaN(idx) && idx < numBindings) {
                            pathMap[idx] = { nodeIndex, name: attr.value };
                            accessPaths[idx] = childPath;
                        }
                    } else if (attr.name.startsWith("data-nix-e-")) {
                        const idx = parseInt(attr.name.slice(11), 10);
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
): OptimizeResult {
    const nodes = cloneNodes(sourceNodes);
    compactWhitespace(nodes, null);

    const targetNodes = new Map<number, { node: ParsedNode; target: "node" | "parent" | "text" }>();
    let specialized = true;

    function collect(children: ParsedNode[], parent: ParsedNode | null): void {
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.type === "element") {
                const tag = child.tag?.toLowerCase() ?? "";
                if (UNSAFE_SPECIALIZED_TAGS.has(tag)) specialized = false;
                const retainedAttrs: Array<{ name: string; value: string }> = [];
                for (const attr of child.attrs ?? []) {
                    const match = /^data-nix-[ae]-(\d+)$/.exec(attr.name);
                    if (match) {
                        targetNodes.set(Number(match[1]), { node: child, target: "node" });
                    } else {
                        retainedAttrs.push(attr);
                    }
                }
                child.attrs = retainedAttrs;
                collect(child.children, child);
                continue;
            }

            if (child.type !== "comment") continue;
            const match = /^nix-(\d+)$/.exec(child.text ?? "");
            if (!match) continue;
            const index = Number(match[1]);
            if (parent && parent.children.length === 1) {
                if (expressionKinds[index] === "reactive-text") {
                    const placeholder: ParsedNode = { type: "text", text: " ", children: [] };
                    children[i] = placeholder;
                    targetNodes.set(index, { node: placeholder, target: "text" });
                } else {
                    targetNodes.set(index, { node: parent, target: "parent" });
                    children.splice(i--, 1);
                }
            } else {
                targetNodes.set(index, { node: child, target: "node" });
            }
        }
    }

    collect(nodes, null);

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
        const context = contexts[i];
        if (context.type === "attr" && (context.attrName === "ref" || context.attrName === "show" || context.attrName === "hide" || context.executable)) {
            specialized = false;
        }
        if (
            context.type === "event" &&
            (!DELEGABLE_EVENTS.has(context.eventName) || context.modifiers.includes("capture") || context.modifiers.includes("once"))
        ) {
            specialized = false;
        }
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
        });
    }

    const singleRoot = nodes.length === 1 && nodes[0].type === "element";
    if (!singleRoot) specialized = false;

    return {
        html: nodes.map(serializeNode).join(""),
        bindings,
        singleRoot,
        specialized: specialized && bindings.length === contexts.length,
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

export function removeMarkerAttributes(html: string): string {
    return html.replace(/\s+data-nix-[ae]-\d+="[^"]*"/g, "");
}
