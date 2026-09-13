// =============================================================================
// codegen.ts — Generate imperative DOM renderers for compiled templates
// =============================================================================

import type { CompiledBinding, CompiledTemplate, ParsedNode } from "./types.js";
import { DELEGABLE_EVENTS } from "./walk.js";

interface GeneratedFactory {
    code: string;
    runtimeImports: string[];
}

/**
 * Qué renderers emitir junto al cliente. `undefined` → ambos (default del
 * API standalone `compile()`, que no conoce el target del build). El plugin
 * pasa flags explícitos: `ssr` solo en builds SSR, `hydrate` solo cuando la
 * app habilita hidratación — así un bundle CSR no carga el código de
 * hidratación/SSR (es ~la mitad del runtime de helpers).
 */
export interface EmitTargets {
    hydrate?: boolean;
    ssr?: boolean;
}

export function genFactoryCode(id: string, compiled: CompiledTemplate, emit?: EmitTargets): GeneratedFactory {
    return compiled.specialized
        ? genSpecializedFactory(id, compiled, emit)
        : genFallbackFactory(id, compiled);
}

export function genCallCode(id: string, expressionNames: string[]): string {
    return `${id}(${expressionNames.join(", ")})`;
}

function genSpecializedFactory(id: string, compiled: CompiledTemplate, emit?: EmitTargets): GeneratedFactory {
    const cloneId = `${id}$clone`;
    const mountId = `${id}$mount`;
    const renderId = `${id}$render`;
    const protoId = `${id}$proto`;
    const args = compiled.contexts.map((_, index) => `v${index}`);
    const fields = args.map((arg) => `instance.${arg}=${arg};`).join("");
    // C.14: multi-root → factory de fragmento. `frag` es el DocumentFragment;
    // los paths se resuelven como frag.childNodes[i]… (los bounds comments
    // `elur-fs`/`elur-fe` ya están horneados en optimizedHtml y contados en
    // los paths). Dispose = remove por rango entre los bounds.
    const multi = !compiled.singleRoot;
    const rootVar = multi ? "frag" : "root";
    const runtimeImports = new Set([
        multi ? "__elurCreateFragment" : "__elurCreateTemplate",
        "__elurCreateTemplatePrototype",
    ]);
    const delegatedEvents = new Set<string>();
    const paths = uniqueBindingPaths(compiled);
    const pathVars = new Map<string, string>();
    if (multi) pathVars.set("", "frag");
    else pathVars.set("0", "root");

    const declarations: string[] = [];
    let refIndex = 0;
    for (const path of paths) {
        const key = path.join(",");
        if (!multi && key === "0") continue;
        const parentPath = path.slice(0, -1);
        const parentKey = parentPath.join(",");
        const parentVar = pathVars.get(parentKey);
        if (!parentVar) throw new Error(`Missing parent path for ${key}`);
        const varName = `n${refIndex++}`;
        pathVars.set(key, varName);
        declarations.push(`const ${varName}=${childExpression(parentVar, path[path.length - 1])};`);
    }

    const operations: string[] = [];
    const cleanupOperations: string[] = [];
    const mountedOperations: string[] = [];
    const groupedBindings = compiled.bindings.filter((binding) =>
        (binding.context.type === "attr" && binding.expressionKind === "reactive") ||
        (binding.context.type === "node" && binding.expressionKind === "reactive-text")
    );
    const useBindingGroup = groupedBindings.length > 1;
    const groupedSetup: string[] = [];
    const groupedReads: string[] = [];
    const groupedApply: string[] = [];
    const groupedFallbackChecks: string[] = [];
    const groupedCleanup: string[] = [];
    for (const binding of compiled.bindings) {
        const nodeVar = pathVars.get(binding.path.join(","));
        if (!nodeVar) throw new Error(`Missing binding path ${binding.path.join(",")}`);
        const value = `v${binding.index}`;
        const ctx = binding.context;

        // C.3: fallback por binding — contextos que el path especializado no
        // soporta degradan a helpers genéricos SIN matar el template:
        // ref/show/hide/executable attrs y eventos no delegables
        // (capture/once/passive — el dispatcher delegado no puede honrarlos).
        if (ctx.type === "attr" && (ctx.attrName === "ref" || ctx.attrName === "show" || ctx.attrName === "hide" || ctx.executable)) {
            runtimeImports.add("__elurGenericAttr");
            const bind = `b${binding.index}`;
            operations.push(
                `const ${bind}=__elurGenericAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${value},${ctx.url ?? false},${ctx.executable ?? false});`,
            );
            cleanupOperations.push(`${bind}();`);
            continue;
        }
        if (
            ctx.type === "event" &&
            (!DELEGABLE_EVENTS.has(ctx.eventName) ||
                ctx.modifiers.includes("capture") ||
                ctx.modifiers.includes("once") ||
                ctx.modifiers.includes("passive"))
        ) {
            runtimeImports.add("__elurGenericEvent");
            const bind = `b${binding.index}`;
            operations.push(
                `const ${bind}=__elurGenericEvent(${nodeVar},${JSON.stringify(ctx.eventName)},${JSON.stringify(ctx.modifiers)},${value});`,
            );
            cleanupOperations.push(`${bind}();`);
            continue;
        }

        // C.6/C.8 tier T1: lectura directa de señal — el arg ES la señal.
        // Edge permanente en runtime: sin effect, sin getter, sin tracking.
        if (binding.expressionKind === "signal" && ctx.type === "node") {
            runtimeImports.add("__elurBindSignalText");
            const text = `t${binding.index}`;
            const bind = `b${binding.index}`;
            const textSetup = binding.target === "text"
                ? `const ${text}=${nodeVar};`
                : `const ${text}=document.createTextNode("");${binding.target === "node" ? `${nodeVar}.parentNode.replaceChild(${text},${nodeVar});` : `${nodeVar}.appendChild(${text});`}`;
            operations.push(`${textSetup}const ${bind}=__elurBindSignalText(${text},${value});`);
            cleanupOperations.push(`${bind}();`);
            continue;
        }

        if (binding.expressionKind === "signal" && ctx.type === "attr") {
            const bind = `b${binding.index}`;
            // F4: ns html + attr no-URL (executable ya cayó a GenericAttr)
            // → writer resuelto en build, sin namespace/URL checks por write.
            if ((binding.ns ?? "html") === "html" && !ctx.url) {
                runtimeImports.add("__elurBindSignalAttrHtml");
                operations.push(
                    `const ${bind}=__elurBindSignalAttrHtml(${nodeVar},${JSON.stringify(ctx.attrName)},${value});`,
                );
            } else {
                runtimeImports.add("__elurBindSignalAttr");
                operations.push(
                    `const ${bind}=__elurBindSignalAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${value},${ctx.url ?? false},${ctx.executable ?? false});`,
                );
            }
            cleanupOperations.push(`${bind}();`);
            continue;
        }

        // C.7 tier T2: expresión pura con deps estáticas — el arg es
        // `__elurDerive(dep1,…,getter)`; edges permanentes a cada dep, sin
        // tracking dinámico ni sweep. El writer compara antes de tocar DOM.
        if (binding.expressionKind === "derived" && ctx.type === "node") {
            runtimeImports.add("__elurBindDerivedText");
            const text = `t${binding.index}`;
            const bind = `b${binding.index}`;
            const textSetup = binding.target === "text"
                ? `const ${text}=${nodeVar};`
                : `const ${text}=document.createTextNode("");${binding.target === "node" ? `${nodeVar}.parentNode.replaceChild(${text},${nodeVar});` : `${nodeVar}.appendChild(${text});`}`;
            operations.push(`${textSetup}const ${bind}=__elurBindDerivedText(${text},${value});`);
            cleanupOperations.push(`${bind}();`);
            continue;
        }

        if (binding.expressionKind === "derived" && ctx.type === "attr") {
            const bind = `b${binding.index}`;
            if ((binding.ns ?? "html") === "html" && !ctx.url) {
                runtimeImports.add("__elurBindDerivedAttrHtml");
                operations.push(
                    `const ${bind}=__elurBindDerivedAttrHtml(${nodeVar},${JSON.stringify(ctx.attrName)},${value});`,
                );
            } else {
                runtimeImports.add("__elurBindDerivedAttr");
                operations.push(
                    `const ${bind}=__elurBindDerivedAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${value},${ctx.url ?? false},${ctx.executable ?? false});`,
                );
            }
            cleanupOperations.push(`${bind}();`);
            continue;
        }

        if (useBindingGroup && ctx.type === "attr" && binding.expressionKind === "reactive") {
            runtimeImports.add("__elurEffect");
            const next = `g${binding.index}`;
            const previous = `p${binding.index}`;
            groupedSetup.push(`let ${next},${previous};`);
            // Inline attribute update — avoids __elurSetAttr function call
            // C.14: en foreign content `className` es SVGAnimatedString
            // (readonly) → cae al helper namespace-aware.
            if ((binding.ns ?? "html") === "html" && ctx.attrName === "class") {
                groupedReads.push(`${next}=${value}();`);
                groupedApply.push(
                    `if(${next}!==${previous}){${previous}=${next};if(${next}==null||${next}===false)${nodeVar}.removeAttribute("class");else ${nodeVar}.className=${next};}`,
                );
            } else {
                runtimeImports.add("__elurSetAttr");
                groupedReads.push(`${next}=${value}();`);
                groupedApply.push(
                    `if(${next}!==${previous}){${previous}=${next};__elurSetAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${next},${ctx.url ?? false},${ctx.executable ?? false});}`,
                );
            }
            continue;
        }

        if (useBindingGroup && ctx.type === "node" && binding.expressionKind === "reactive-text") {
            runtimeImports.add("__elurEffect");
            const text = `t${binding.index}`;
            const next = `g${binding.index}`;
            const previous = `p${binding.index}`;
            const textSetup = binding.target === "text"
                ? `const ${text}=${nodeVar};`
                : `const ${text}=document.createTextNode("");${binding.target === "node" ? `${nodeVar}.parentNode.replaceChild(${text},${nodeVar});` : `${nodeVar}.appendChild(${text});`}`;
            groupedSetup.push(
                `${textSetup}let ${next},${previous};`,
            );
            groupedReads.push(`${next}=${value}();`);
            groupedApply.push(
                `if(${next}!==${previous}){${previous}=${next};${text}.data=${next};}`,
            );
            continue;
        }

        if (ctx.type === "event") {
            runtimeImports.add("__elurDelegateEvents");
            delegatedEvents.add(ctx.eventName);
            const eventProp = `__elur_${ctx.eventName}`;
            if (ctx.modifiers.length > 0) {
                runtimeImports.add("__elurEvent");
                runtimeImports.add("__elurClearEvent");
                operations.push(
                    `__elurEvent(${nodeVar},${JSON.stringify(ctx.eventName)},${JSON.stringify(ctx.modifiers)},${value});`,
                );
                cleanupOperations.push(`__elurClearEvent(${nodeVar},${JSON.stringify(ctx.eventName)});`);
            } else {
                operations.push(`${nodeVar}.${eventProp}=${value};`);
                cleanupOperations.push(`${nodeVar}.${eventProp}=null;`);
            }
        } else if (ctx.type === "attr") {
            if (binding.expressionKind === "static") {
                // Inline static attribute — no runtime call needed
                // C.14: className no existe como prop writable fuera de html.
                const attrVal = (binding.ns ?? "html") === "html" && ctx.attrName === "class" ? "className" : null;
                if (attrVal) {
                    operations.push(`${nodeVar}.${attrVal}=${value};`);
                } else if ((binding.ns ?? "html") === "html") {
                    operations.push(`${nodeVar}.setAttribute(${JSON.stringify(ctx.attrName)},${value});`);
                } else {
                    // Foreign ns: xlink:href etc. necesitan setAttributeNS —
                    // lo resuelve el helper por namespaceURI del target.
                    runtimeImports.add("__elurSetAttr");
                    operations.push(`__elurSetAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${value},${ctx.url ?? false},${ctx.executable ?? false});`);
                }
            } else {
                runtimeImports.add("__elurAttr");
                const dispose = `d${binding.index}`;
                operations.push(
                    `const ${dispose}=__elurAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${value},${ctx.url ?? false},${ctx.executable ?? false});`,
                );
                cleanupOperations.push(`if(${dispose})${dispose}();`);
            }
        } else if (binding.expressionKind === "reactive-text") {
            runtimeImports.add("__elurReactiveText");
            const writer = `w${binding.index}`;
            operations.push(
                `const ${writer}=__elurReactiveText(${nodeVar},${value},${JSON.stringify(binding.target)},postMountHooks||(postMountHooks=[]));`,
            );
            cleanupOperations.push(`${writer}.dispose();`);
            mountedOperations.push(`${writer}.mounted();`);
        } else if (binding.expressionKind === "static" || binding.expressionKind === "generic") {
            // Inline primitive text — avoids __elurNode function call overhead
            // Fast path for string/number; fallback to __elurNode for complex values
            runtimeImports.add("__elurNode");
            const result = `r${binding.index}`;
            operations.push(
                `let ${result}=null;if(typeof ${value}==="string"||typeof ${value}==="number")${nodeVar}.textContent=${value};else if(${value}!=null&&${value}!==false){${result}=__elurNode(${nodeVar},${value},${binding.target === "node"},postMountHooks);if(${result}&&${result}.hooks.length)(postMountHooks||(postMountHooks=[])).push(...${result}.hooks);}`,
            );
            cleanupOperations.push(`if(${result}&&${result}.dispose)${result}.dispose();`);
        } else {
            runtimeImports.add("__elurNode");
            const result = `r${binding.index}`;
            operations.push(
                `const ${result}=__elurNode(${nodeVar},${value},${binding.target === "node"},postMountHooks);if(${result}&&${result}.hooks.length)(postMountHooks||(postMountHooks=[])).push(...${result}.hooks);`,
            );
            cleanupOperations.push(`if(${result}&&${result}.dispose)${result}.dispose();`);
        }
    }

    if (useBindingGroup) {
        operations.push(
            `const groupDispose=__elurEffect(()=>{${groupedReads.join("")}${groupedApply.join("")}});`,
        );
        cleanupOperations.push("groupDispose();", ...groupedCleanup);
    }

    // C.13: hydrate compilada — activación por posición sobre el DOM SSR.
    // Solo se emite cuando el target lo necesita (apps que hidratan); el
    // descriptor cae al hydrate genérico por markers cuando falta.
    const emitHydrate = emit === undefined || emit.hydrate === true;
    const emitSsr = emit === undefined || emit.ssr === true;
    const hydrateId = `${id}$hydrate`;
    const hydrateGen = emitHydrate ? genHydrateCode(hydrateId, compiled, args) : null;
    const hydrateCode = hydrateGen?.code ?? null;
    for (const imp of hydrateGen?.runtimeImports ?? []) runtimeImports.add(imp);

    // C.12 fase 2: renderer SSR especializado — la misma IR (strings +
    // contexts) alimenta cliente, hydrate y SSR desde un solo artefacto.
    // Solo se emite en builds SSR; el runtime SSR cae al renderer genérico.
    const ssrId = `${id}$ssr`;
    const ssrCode = emitSsr ? genSsrCode(ssrId, compiled) : null;

    const contextCode = serializeContexts(compiled.contexts);
    const keys = JSON.stringify(args);
    // C.12: metadata serializable del template (bloques + devId) — cuarto
    // backend de la IR (dev metadata) sin tocar la semántica runtime.
    const meta: Record<string, unknown> = {};
    if (compiled.blocks?.length) meta.blocks = compiled.blocks;
    if (compiled.devId) meta.dev = compiled.devId;
    if (compiled.foldedIndices?.length) meta.folded = compiled.foldedIndices;
    const metaCode = Object.keys(meta).length ? `,${JSON.stringify(meta)}` : "";
    const code = [
        `const ${cloneId}=/*#__PURE__*/${multi ? "__elurCreateFragment" : "__elurCreateTemplate"}(${JSON.stringify(compiled.optimizedHtml)});`,
        delegatedEvents.size > 0 ? `__elurDelegateEvents(${JSON.stringify([...delegatedEvents])});` : "",
        `function ${mountId}(parent,before,${args.join(",")}){`,
        `const ${rootVar}=${cloneId}();`,
        ...declarations,
        `let postMountHooks=null;`,
        ...groupedSetup,
        ...operations,
        // Bounds del fragmento: los comments elur-fs/elur-fe son first/last
        // child — nunca son target de bindings, sobreviven al insert.
        ...(multi ? [`const _fs=${rootVar}.firstChild,_fe=${rootVar}.lastChild;`] : []),
        `parent.insertBefore(${rootVar},before);`,
        `if(postMountHooks)for(let i=0;i<postMountHooks.length;i++)postMountHooks[i]();`,
        ...mountedOperations,
        multi
            ? `return()=>{${[...cleanupOperations].reverse().join("")}const _r=document.createRange();_r.setStartBefore(_fs);_r.setEndAfter(_fe);_r.deleteContents();};`
            : `return()=>{${[...cleanupOperations].reverse().join("")}root.parentNode?.removeChild(root);};`,
        `}`,
        `function ${renderId}(parent,before){return ${mountId}(parent,before,${args.map((arg) => `this.${arg}`).join(",")});}`,
        hydrateCode ?? "",
        ssrCode ?? "",
        `const ${protoId}=/*#__PURE__*/__elurCreateTemplatePrototype(${renderId},${JSON.stringify(compiled.strings)},${contextCode},${keys}${hydrateCode ? `,${hydrateId}` : ",undefined"}${ssrCode ? `,${ssrId}` : ",undefined"}${metaCode});`,
        `function ${id}(${args.join(",")}){const instance=Object.create(${protoId});${fields}return instance;}`,
    ].join("\n");

    return {
        code,
        runtimeImports: [...runtimeImports],
    };
}

function genFallbackFactory(id: string, compiled: CompiledTemplate): GeneratedFactory {
    const baseId = `${id}$base`;
    const resolverId = `${id}$resolve`;
    const args = compiled.contexts.map((_, index) => `v${index}`);
    const code = [
        `const ${resolverId}=${genResolverFunction(id, compiled)};`,
        `const ${baseId}=__elurCompiledTemplate(${JSON.stringify(compiled.strings)},${JSON.stringify(compiled.htmlWithoutMarkers)},${serializeContexts(compiled.contexts)},${serializePathMap(compiled.pathMap)},${resolverId});`,
        `function ${id}(${args.join(",")}){return ${baseId}([${args.join(",")}]);}`,
    ].join("\n");
    return { code, runtimeImports: ["__elurCompiledTemplate"] };
}

function uniqueBindingPaths(compiled: CompiledTemplate): number[][] {
    const paths = new Map<string, number[]>();
    paths.set("0", [0]);
    for (const binding of compiled.bindings) {
        const path = binding.path;
        for (let length = 1; length <= path.length; length++) {
            const prefix = path.slice(0, length);
            paths.set(prefix.join(","), prefix);
        }
    }
    return [...paths.values()].sort((a, b) => a.length - b.length);
}

function childExpression(parent: string, index: number): string {
    // C.15: `childNodes[i]` es acceso O(1) directo — antes se emitían cadenas
    // `.firstChild.nextSibling…` cuadráticas en templates con muchos hermanos.
    // childNodes enumera el mismo conjunto (elementos + texto + comentarios)
    // en el mismo orden que el walk firstChild/nextSibling.
    return `${parent}.childNodes[${index}]`;
}

function genResolverFunction(factoryId: string, compiled: CompiledTemplate): string {
    const { accessPaths } = compiled;
    const prefix = factoryId.replace(/[^a-zA-Z0-9_$]/g, "_");
    const values: string[] = [];
    const lines: string[] = [];

    for (let i = 0; i < accessPaths.length; i++) {
        const path = accessPaths[i];
        if (!path) {
            values.push("null");
            continue;
        }
        let expression = "frag";
        for (const index of path) expression = childExpression(expression, index);
        const name = `${prefix}_v${i}`;
        lines.push(`const ${name}=${expression};`);
        values.push(name);
    }

    return `function(frag){${lines.join("")}return[${values.join(",")}];}`;
}

function serializeContexts(contexts: CompiledTemplate["contexts"]): string {
    return `[${contexts.map((ctx) => {
        if (ctx.type === "node") return `{type:"node"}`;
        if (ctx.type === "event") {
            return `{type:"event",eventName:${JSON.stringify(ctx.eventName)},modifiers:${JSON.stringify(ctx.modifiers)},hadOpenQuote:${ctx.hadOpenQuote}}`;
        }
        return `{type:"attr",attrName:${JSON.stringify(ctx.attrName)},hadOpenQuote:${ctx.hadOpenQuote},url:${ctx.url ?? false},executable:${ctx.executable ?? false}}`;
    }).join(",")}]`;
}

function serializePathMap(pathMap: CompiledTemplate["pathMap"]): string {
    return `[${pathMap.map((entry) => entry
        ? `{nodeIndex:${entry.nodeIndex},name:${entry.name === null ? "null" : JSON.stringify(entry.name)}}`
        : "null").join(",")}]`;
}

// =============================================================================
// --- C.13: hidratación compilada ----------------------------------------------
// =============================================================================

/**
 * Emite `hydrate${id}(root, opts, v0…vN)`: activa los bindings caminando el
 * DOM SSR por posición — un cursor que sólo avanza, sin TreeWalker global ni
 * maps ni `data-elur-*`. Las boundaries dinámicas se localizan con scans
 * acotados a hermanos (`__elurMarkers`/`__elurMarkersIn`).
 *
 * El cursor es target-directed porque el árbol compactado (paths del
 * factory de mount) no incluye los textos de whitespace que SSR sí emite:
 * `__elurNextEl` salta textos/comments hasta el siguiente Element y
 * `__elurMarkers` busca el comment `elur-N` entre hermanos.
 */
function genHydrateCode(
    hydrateId: string,
    compiled: CompiledTemplate,
    args: string[],
): GeneratedFactory | null {
    const nodes = compiled.nodes;
    if (!nodes || nodes.length !== 1 || nodes[0].type !== "element") return null;

    // Bindings por posición en el árbol parseado:
    // - attr/event → keyed by element path (su target "node" es el elemento)
    // - node target "node"   → keyed by placeholder-comment child path
    // - node target "parent" → keyed by element path (contenido = binding)
    // - node target "text"   → keyed by element path (path = elemPath + [i])
    const byElem = new Map<string, CompiledBinding[]>();
    const insideBind = new Map<string, CompiledBinding>();
    const commentBind = new Map<string, CompiledBinding>();
    for (const b of compiled.bindings) {
        if (b.context.type === "node") {
            if (b.target === "node") commentBind.set(b.path.join(","), b);
            else if (b.target === "parent") insideBind.set(b.path.join(","), b);
            else insideBind.set(b.path.slice(0, -1).join(","), b);
            continue;
        }
        const key = b.path.join(",");
        const list = byElem.get(key) ?? [];
        list.push(b);
        byElem.set(key, list);
    }

    const ops: string[] = [];
    const cleanups: string[] = [];
    const imports = new Set<string>();

    function emitNodeBinding(rangeExpr: string, b: CompiledBinding): void {
        imports.add("__elurHydrateRange");
        ops.push(`const b${b.index}=__elurHydrateRange(${rangeExpr},v${b.index},opts);`);
        cleanups.push(`b${b.index}();`);
    }

    function emitElementBinding(elVar: string, b: CompiledBinding): void {
        const ctx = b.context;
        const v = `v${b.index}`;
        if (ctx.type === "event") {
            const nonDelegable =
                !DELEGABLE_EVENTS.has(ctx.eventName) ||
                ctx.modifiers.includes("capture") ||
                ctx.modifiers.includes("once") ||
                ctx.modifiers.includes("passive");
            if (nonDelegable) {
                imports.add("__elurGenericEvent");
                ops.push(`const b${b.index}=__elurGenericEvent(${elVar},${JSON.stringify(ctx.eventName)},${JSON.stringify(ctx.modifiers)},${v});`);
                cleanups.push(`b${b.index}();`);
            } else if (ctx.modifiers.length > 0) {
                imports.add("__elurEvent");
                imports.add("__elurClearEvent");
                ops.push(`__elurEvent(${elVar},${JSON.stringify(ctx.eventName)},${JSON.stringify(ctx.modifiers)},${v});`);
                cleanups.push(`__elurClearEvent(${elVar},${JSON.stringify(ctx.eventName)});`);
            } else {
                ops.push(`${elVar}.__elur_${ctx.eventName}=${v};`);
                cleanups.push(`${elVar}.__elur_${ctx.eventName}=null;`);
            }
            return;
        }
        if (ctx.type !== "attr") return;
        const name = JSON.stringify(ctx.attrName);
        const url = ctx.url ?? false;
        const exec = ctx.executable ?? false;
        // C.3: ref/show/hide/executable siempre por el helper genérico.
        if (ctx.attrName === "ref" || ctx.attrName === "show" || ctx.attrName === "hide" || ctx.executable) {
            imports.add("__elurGenericAttr");
            ops.push(`const b${b.index}=__elurGenericAttr(${elVar},${name},${v},${url},${exec});`);
            cleanups.push(`b${b.index}();`);
            return;
        }
        // F4: mismo criterio que el mount — ns html + no-URL → writer
        // resuelto (la primera escritura re-aplica el valor SSR, idempotente).
        const htmlSpecialized = (b.ns ?? "html") === "html" && !url;
        if (b.expressionKind === "signal") {
            if (htmlSpecialized) {
                imports.add("__elurBindSignalAttrHtml");
                ops.push(`const b${b.index}=__elurBindSignalAttrHtml(${elVar},${name},${v});`);
            } else {
                imports.add("__elurBindSignalAttr");
                ops.push(`const b${b.index}=__elurBindSignalAttr(${elVar},${name},${v},${url},${exec});`);
            }
            cleanups.push(`b${b.index}();`);
            return;
        }
        if (b.expressionKind === "derived") {
            if (htmlSpecialized) {
                imports.add("__elurBindDerivedAttrHtml");
                ops.push(`const b${b.index}=__elurBindDerivedAttrHtml(${elVar},${name},${v});`);
            } else {
                imports.add("__elurBindDerivedAttr");
                ops.push(`const b${b.index}=__elurBindDerivedAttr(${elVar},${name},${v},${url},${exec});`);
            }
            cleanups.push(`b${b.index}();`);
            return;
        }
        // static → el valor ya está en el HTML SSR; nada que activar.
        if (b.expressionKind === "static") return;
        imports.add("__elurAttr");
        ops.push(`const d${b.index}=__elurAttr(${elVar},${name},${v},${url},${exec});`);
        cleanups.push(`if(d${b.index})d${b.index}();`);
    }

    function emitElement(elVar: string, node: ParsedNode, path: number[]): void {
        const pkey = path.join(",");
        for (const b of byElem.get(pkey) ?? []) emitElementBinding(elVar, b);
        const inside = insideBind.get(pkey);
        if (inside) {
            imports.add("__elurMarkersIn");
            emitNodeBinding(`__elurMarkersIn(${elVar},${inside.index})`, inside);
            return; // el contenido del elemento ES el binding
        }
        let cur = `${elVar}.firstChild`;
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            if (child.type === "element") {
                const eVar = `e${[...path, i].join("_")}`;
                imports.add("__elurNextEl");
                ops.push(`const ${eVar}=__elurNextEl(${cur});`);
                emitElement(eVar, child, [...path, i]);
                cur = `${eVar}.nextSibling`;
                continue;
            }
            if (child.type !== "comment") continue; // textos estáticos: el cursor los salta solo
            const b = commentBind.get([...path, i].join(","));
            if (!b) continue; // comment literal del usuario: también se salta
            imports.add("__elurMarkers");
            ops.push(`const r${b.index}=__elurMarkers(${cur},${b.index});`);
            emitNodeBinding(`r${b.index}`, b);
            cur = `r${b.index}.end.nextSibling`;
        }
    }

    emitElement("root", nodes[0], [0]);

    const code = `function ${hydrateId}(root,opts,${args.join(",")}){\n${ops.join("\n")}\nreturn()=>{${[...cleanups].reverse().join("")}};\n}`;
    return { code, runtimeImports: [...imports] };
}

// =============================================================================
// --- C.12 fase 2: renderer SSR especializado -----------------------------------
// =============================================================================

/**
 * Emite `async function* ssr${id}(emit, v0…vN)`: la misma secuencia de chunks
 * que el intérprete genérico de `renderDescriptorChunks`, pero con
 * `bindingCut`/`skipLeading` resueltos en build — los strings llegan ya
 * cortados a los helpers `emit.*` del core (que conservan toda la semántica:
 * resolución de valores, sanitize, markers, abort).
 */
function genSsrCode(id: string, compiled: CompiledTemplate): string | null {
    const { strings, contexts } = compiled;
    if (!contexts.length) return null;
    const args = contexts.map((_, index) => `v${index}`);
    const lines: string[] = [];

    // skipLeading: si el contexto previo abrió comilla, este string la pierde.
    const stripped = (i: number): string => {
        const prev = contexts[i - 1];
        let s = strings[i];
        if (
            prev && prev.type !== "node" && prev.hadOpenQuote &&
            (s[0] === '"' || s[0] === "'")
        ) {
            s = s.slice(1);
        }
        return s;
    };

    for (let i = 0; i < strings.length; i++) {
        const ctx = i < contexts.length ? contexts[i] : undefined;
        const s = stripped(i);
        if (!ctx) {
            if (s) lines.push(`yield emit.m(${JSON.stringify(s)});`);
            break;
        }
        if (ctx.type === "node") {
            if (s) lines.push(`yield emit.m(${JSON.stringify(s)});`);
            lines.push(`yield* emit.node(${i},v${i});`);
            continue;
        }
        if (ctx.type === "event") {
            const full = ctx.modifiers.length
                ? `${ctx.eventName}.${ctx.modifiers.join(".")}`
                : ctx.eventName;
            const cut = `@${full}=`.length + (ctx.hadOpenQuote ? 1 : 0);
            const prefix = s.slice(0, s.length - cut);
            lines.push(`yield emit.event(${i},${JSON.stringify(prefix)},${JSON.stringify(ctx.eventName)});`);
            continue;
        }
        // attr
        const cut = ctx.attrName.length + 1 + (ctx.hadOpenQuote ? 1 : 0);
        const prefix = s.slice(0, s.length - cut);
        lines.push(
            `yield* await emit.attr(${JSON.stringify(prefix)},${i},${JSON.stringify(ctx.attrName)},${ctx.url ?? false},${ctx.executable ?? false},v${i});`,
        );
    }

    return `async function* ${id}(emit,${args.join(",")}){\n${lines.join("\n")}\n}`;
}
