// =============================================================================
// codegen.ts — Generate imperative DOM renderers for compiled templates
// =============================================================================

import type { CompiledTemplate } from "./types.js";

export interface GeneratedFactory {
    code: string;
    runtimeImports: string[];
}

export function genFactoryCode(id: string, compiled: CompiledTemplate): GeneratedFactory {
    return compiled.specialized
        ? genSpecializedFactory(id, compiled)
        : genFallbackFactory(id, compiled);
}

export function genCallCode(id: string, expressionNames: string[]): string {
    return `${id}(${expressionNames.join(", ")})`;
}

function genSpecializedFactory(id: string, compiled: CompiledTemplate): GeneratedFactory {
    const cloneId = `${id}$clone`;
    const mountId = `${id}$mount`;
    const renderId = `${id}$render`;
    const protoId = `${id}$proto`;
    const args = compiled.contexts.map((_, index) => `v${index}`);
    const fields = args.map((arg) => `instance.${arg}=${arg};`).join("");
    const runtimeImports = new Set(["__nixCreateTemplate", "__nixCreateTemplatePrototype"]);
    const delegatedEvents = new Set<string>();
    const paths = uniqueBindingPaths(compiled);
    const pathVars = new Map<string, string>();
    pathVars.set("0", "root");

    const declarations: string[] = [];
    let refIndex = 0;
    for (const path of paths) {
        const key = path.join(",");
        if (key === "0") continue;
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

        if (useBindingGroup && ctx.type === "attr" && binding.expressionKind === "reactive") {
            runtimeImports.add("__nixEffect");
            const next = `g${binding.index}`;
            const previous = `p${binding.index}`;
            groupedSetup.push(`let ${next},${previous};`);
            // Inline attribute update — avoids __nixSetAttr function call
            if (ctx.attrName === "class") {
                groupedReads.push(`${next}=${value}();`);
                groupedApply.push(
                    `if(${next}!==${previous}){${previous}=${next};if(${next}==null||${next}===false)${nodeVar}.removeAttribute("class");else ${nodeVar}.className=${next};}`,
                );
            } else {
                runtimeImports.add("__nixSetAttr");
                groupedReads.push(`${next}=${value}();`);
                groupedApply.push(
                    `if(${next}!==${previous}){${previous}=${next};__nixSetAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${next},${ctx.url ?? false},${ctx.executable ?? false});}`,
                );
            }
            continue;
        }

        if (useBindingGroup && ctx.type === "node" && binding.expressionKind === "reactive-text") {
            runtimeImports.add("__nixEffect");
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
            runtimeImports.add("__nixDelegateEvents");
            delegatedEvents.add(ctx.eventName);
            const eventProp = `__nix_${ctx.eventName}`;
            if (ctx.modifiers.length > 0) {
                runtimeImports.add("__nixEvent");
                runtimeImports.add("__nixClearEvent");
                operations.push(
                    `__nixEvent(${nodeVar},${JSON.stringify(ctx.eventName)},${JSON.stringify(ctx.modifiers)},${value});`,
                );
                cleanupOperations.push(`__nixClearEvent(${nodeVar},${JSON.stringify(ctx.eventName)});`);
            } else {
                operations.push(`${nodeVar}.${eventProp}=${value};`);
                cleanupOperations.push(`${nodeVar}.${eventProp}=null;`);
            }
        } else if (ctx.type === "attr") {
            if (binding.expressionKind === "static") {
                // Inline static attribute — no runtime call needed
                const attrVal = ctx.attrName === "class" ? "className" : null;
                if (attrVal) {
                    operations.push(`${nodeVar}.${attrVal}=${value};`);
                } else {
                    operations.push(`${nodeVar}.setAttribute(${JSON.stringify(ctx.attrName)},${value});`);
                }
            } else {
                runtimeImports.add("__nixAttr");
                const dispose = `d${binding.index}`;
                operations.push(
                    `const ${dispose}=__nixAttr(${nodeVar},${JSON.stringify(ctx.attrName)},${value},${ctx.url ?? false},${ctx.executable ?? false});`,
                );
                cleanupOperations.push(`if(${dispose})${dispose}();`);
            }
        } else if (binding.expressionKind === "reactive-text") {
            runtimeImports.add("__nixReactiveText");
            const writer = `w${binding.index}`;
            operations.push(
                `const ${writer}=__nixReactiveText(${nodeVar},${value},${JSON.stringify(binding.target)},postMountHooks||(postMountHooks=[]));`,
            );
            cleanupOperations.push(`${writer}.dispose();`);
            mountedOperations.push(`${writer}.mounted();`);
        } else if (binding.expressionKind === "static" || binding.expressionKind === "generic") {
            // Inline primitive text — avoids __nixNode function call overhead
            // Fast path for string/number; fallback to __nixNode for complex values
            runtimeImports.add("__nixNode");
            const result = `r${binding.index}`;
            operations.push(
                `let ${result}=null;if(typeof ${value}==="string"||typeof ${value}==="number")${nodeVar}.textContent=${value};else if(${value}!=null&&${value}!==false){${result}=__nixNode(${nodeVar},${value},${binding.target === "node"},postMountHooks);if(${result}&&${result}.hooks.length)(postMountHooks||(postMountHooks=[])).push(...${result}.hooks);}`,
            );
            cleanupOperations.push(`if(${result}&&${result}.dispose)${result}.dispose();`);
        } else {
            runtimeImports.add("__nixNode");
            const result = `r${binding.index}`;
            operations.push(
                `const ${result}=__nixNode(${nodeVar},${value},${binding.target === "node"},postMountHooks);if(${result}&&${result}.hooks.length)(postMountHooks||(postMountHooks=[])).push(...${result}.hooks);`,
            );
            cleanupOperations.push(`if(${result}&&${result}.dispose)${result}.dispose();`);
        }
    }

    if (useBindingGroup) {
        operations.push(
            `const groupDispose=__nixEffect(()=>{${groupedReads.join("")}${groupedApply.join("")}});`,
        );
        cleanupOperations.push("groupDispose();", ...groupedCleanup);
    }

    const contextCode = serializeContexts(compiled.contexts);
    const keys = JSON.stringify(args);
    const code = [
        `const ${cloneId}=/*#__PURE__*/__nixCreateTemplate(${JSON.stringify(compiled.optimizedHtml)});`,
        delegatedEvents.size > 0 ? `__nixDelegateEvents(${JSON.stringify([...delegatedEvents])});` : "",
        `function ${mountId}(parent,before,${args.join(",")}){`,
        `const root=${cloneId}();`,
        ...declarations,
        `let postMountHooks=null;`,
        ...groupedSetup,
        ...operations,
        `parent.insertBefore(root,before);`,
        `if(postMountHooks)for(let i=0;i<postMountHooks.length;i++)postMountHooks[i]();`,
        ...mountedOperations,
        `return()=>{${[...cleanupOperations].reverse().join("")}root.parentNode?.removeChild(root);};`,
        `}`,
        `function ${renderId}(parent,before){return ${mountId}(parent,before,${args.map((arg) => `this.${arg}`).join(",")});}`,
        `const ${protoId}=/*#__PURE__*/__nixCreateTemplatePrototype(${renderId},${JSON.stringify(compiled.strings)},${contextCode},${keys});`,
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
        `const ${baseId}=__nixCompiledTemplate(${JSON.stringify(compiled.strings)},${JSON.stringify(compiled.htmlWithoutMarkers)},${serializeContexts(compiled.contexts)},${serializePathMap(compiled.pathMap)},${resolverId});`,
        `function ${id}(${args.join(",")}){return ${baseId}([${args.join(",")}]);}`,
    ].join("\n");
    return { code, runtimeImports: ["__nixCompiledTemplate"] };
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
    let expression = `${parent}.firstChild`;
    for (let i = 0; i < index; i++) expression += ".nextSibling";
    return expression;
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
