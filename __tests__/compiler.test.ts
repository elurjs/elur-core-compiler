import { describe, it, expect } from "vitest";
import { compileTemplate, analyzeTemplate, parseHTML, walkTemplate, genFactoryCode } from "../src/index.js";

describe("analyzeTemplate", () => {
    it("detects node context", () => {
        const { contexts } = analyzeTemplate(["<div>", "</div>"]);
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toEqual({ type: "node" });
    });

    it("detects attribute context", () => {
        const { contexts } = analyzeTemplate(['<div class="', '"></div>']);
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toMatchObject({ type: "attr", attrName: "class" });
    });

    it("detects event context", () => {
        const { contexts } = analyzeTemplate(['<button @click="', '"></button>']);
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toMatchObject({ type: "event", eventName: "click" });
    });

    it("detects event with modifiers", () => {
        const { contexts } = analyzeTemplate(['<button @click.prevent="', '"></button>']);
        expect(contexts[0]).toMatchObject({ type: "event", eventName: "click", modifiers: ["prevent"] });
    });

    it("precomputes url flag for href", () => {
        const { contexts } = analyzeTemplate(['<a href="', '"></a>']);
        expect(contexts[0]).toMatchObject({ type: "attr", attrName: "href", url: true });
    });

    it("builds HTML with markers", () => {
        const { html } = analyzeTemplate(["<div>", "</div>"]);
        expect(html).toBe("<div><!--elur-0--></div>");
    });

    it("builds HTML with attribute markers", () => {
        const { html } = analyzeTemplate(['<div class="', '"></div>']);
        // buildHTML cuts `class="` from the string, leaving `<div ` then adds ` data-elur-a-0="class"`
        expect(html).toBe('<div  data-elur-a-0="class"></div>');
    });
});

describe("parseHTML", () => {
    it("parses simple element", () => {
        const nodes = parseHTML("<div>hello</div>");
        expect(nodes).toHaveLength(1);
        expect(nodes[0].type).toBe("element");
        expect(nodes[0].tag).toBe("div");
        expect(nodes[0].children).toHaveLength(1);
        expect(nodes[0].children[0].type).toBe("text");
    });

    it("parses comment", () => {
        const nodes = parseHTML("<!--elur-0-->");
        expect(nodes).toHaveLength(1);
        expect(nodes[0].type).toBe("comment");
        expect(nodes[0].text).toBe("elur-0");
    });

    it("parses nested elements", () => {
        const nodes = parseHTML("<div><span>text</span></div>");
        expect(nodes[0].children).toHaveLength(1);
        expect(nodes[0].children[0].tag).toBe("span");
    });

    it("parses void elements", () => {
        const nodes = parseHTML('<input type="text"/>');
        expect(nodes[0].tag).toBe("input");
        expect(nodes[0].void).toBe(true);
    });

    it("parses attributes with quotes", () => {
        const nodes = parseHTML('<div class="foo" id="bar"></div>');
        expect(nodes[0].attrs).toHaveLength(2);
        expect(nodes[0].attrs![0]).toEqual({ name: "class", value: "foo" });
        expect(nodes[0].attrs![1]).toEqual({ name: "id", value: "bar" });
    });
});

describe("walkTemplate", () => {
    it("builds pathMap for node binding", () => {
        const html = "<div><!--elur-0--></div>";
        const parsed = parseHTML(html);
        const contexts = [{ type: "node" as const }];
        const { pathMap, accessPaths } = walkTemplate(parsed, contexts);
        expect(pathMap[0]).toEqual({ nodeIndex: 2, name: null });
        expect(accessPaths[0]).toEqual([0, 0]);
    });

    it("builds pathMap for attribute binding", () => {
        const html = '<div data-elur-a-0="class"></div>';
        const parsed = parseHTML(html);
        const contexts = [{ type: "attr" as const, attrName: "class", hadOpenQuote: false }];
        const { pathMap, accessPaths } = walkTemplate(parsed, contexts);
        expect(pathMap[0]).toEqual({ nodeIndex: 1, name: "class" });
        expect(accessPaths[0]).toEqual([0]);
    });
});

describe("compileTemplate", () => {
    it("compiles a simple template", () => {
        const compiled = compileTemplate(["<div>", "</div>"]);
        expect(compiled.contexts).toHaveLength(1);
        expect(compiled.contexts[0]).toEqual({ type: "node" });
        // Comment markers are kept — they're replaced at render time
        expect(compiled.htmlWithoutMarkers).toBe("<div><!--elur-0--></div>");
        expect(compiled.pathMap[0]).toEqual({ nodeIndex: 2, name: null });
        expect(compiled.accessPaths[0]).toEqual([0, 0]);
    });

    it("compiles a template with attribute binding", () => {
        const compiled = compileTemplate(['<div class="', '"></div>']);
        expect(compiled.contexts[0]).toMatchObject({ type: "attr", attrName: "class" });
        expect(compiled.htmlWithoutMarkers).toBe("<div></div>");
        expect(compiled.pathMap[0]).toEqual({ nodeIndex: 1, name: "class" });
        expect(compiled.accessPaths[0]).toEqual([0]);
    });

    it("compiles a template with multiple bindings", () => {
        const compiled = compileTemplate(['<div class="', '">', "</div>"]);
        expect(compiled.contexts).toHaveLength(2);
        expect(compiled.contexts[0]).toMatchObject({ type: "attr", attrName: "class" });
        expect(compiled.contexts[1]).toEqual({ type: "node" });
        expect(compiled.pathMap[0]).toEqual({ nodeIndex: 1, name: "class" });
        expect(compiled.pathMap[1]).toEqual({ nodeIndex: 2, name: null });
    });

    it("compiles a template with event binding", () => {
        const compiled = compileTemplate(['<button @click="', '">Click</button>']);
        expect(compiled.contexts[0]).toMatchObject({ type: "event", eventName: "click" });
        expect(compiled.pathMap[0]).toEqual({ nodeIndex: 1, name: "click" });
    });

    it("removes marker attributes from HTML", () => {
        const compiled = compileTemplate(['<div class="', '" id="', '"></div>']);
        // Both class and id are bindings, so both data-elur-a-* are removed (with leading whitespace)
        expect(compiled.htmlWithoutMarkers).toBe('<div></div>');
    });

    it("compacts structural whitespace and removes sole node markers", () => {
        const compiled = compileTemplate([
            "\n<tr class=",
            ">\n<td>",
            "</td>\n<td><a @click=",
            ">",
            "</a></td>\n</tr>\n",
        ], ["reactive", "generic", "generic", "reactive"]);

        expect(compiled.specialized).toBe(true);
        expect(compiled.singleRoot).toBe(true);
        expect(compiled.optimizedHtml).toBe("<tr><td></td><td><a></a></td></tr>");
        expect(compiled.optimizedHtml).not.toContain("elur-");
        expect(compiled.bindings[1]).toMatchObject({ target: "parent", path: [0, 0] });
    });

    it("generates an imperative renderer with positional values", () => {
        const compiled = compileTemplate(
            ["<tr><td>", "</td><td class=", "></td></tr>"],
            ["generic", "reactive"],
        );
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain("function _factory(v0,v1)");
        // C.15: acceso childNodes[i] O(1) — ya no cadenas .nextSibling.
        expect(generated.code).toContain(".childNodes[1]");
        expect(generated.code).toContain("__elurNode");
        expect(generated.code).toContain("__elurAttr");
        expect(generated.code).not.toContain("_activateBindingsWithNodes");
        expect(generated.runtimeImports).toContain("__elurCreateTemplate");
    });

    it("C.14: svg/math se especializan (namespace-aware en runtime)", () => {
        const compiled = compileTemplate(["<svg><text>", "</text></svg>"], ["reactive"]);
        const generated = genFactoryCode("_factory", compiled);
        expect(compiled.specialized).toBe(true);
        expect(compiled.bindings[0].ns).toBe("svg");
        expect(generated.runtimeImports).not.toContain("__elurCompiledTemplate");
    });

    it("C.14: template/script/style/pre con bindings siguen siendo fallback", () => {
        const tpl = compileTemplate(["<div><template><b>", "</b></template></div>"], ["reactive"]);
        expect(tpl.specialized).toBe(false);
        const scr = compileTemplate(["<div><script>", "</script></div>"], ["reactive"]);
        expect(scr.specialized).toBe(false);
    });

    it("emits __elurBindSignalText for T1 signal node bindings (C.6)", () => {
        const compiled = compileTemplate(["<td>", "</td>"], ["signal"]);
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain("__elurBindSignalText(");
        expect(generated.code).not.toContain("__elurNode(");
        expect(generated.code).not.toContain("__elurReactiveText");
        expect(generated.runtimeImports).toContain("__elurBindSignalText");
    });

    it("emits __elurBindSignalAttrHtml for T1 signal attribute bindings (F4)", () => {
        const compiled = compileTemplate(['<div class="', '"></div>'], ["signal"]);
        const generated = genFactoryCode("_factory", compiled);

        // F4: attr HTML resuelto en build — writer dedicado sin checks runtime.
        expect(generated.code).toContain('__elurBindSignalAttrHtml(');
        expect(generated.code).toContain('"class"');
        expect(generated.runtimeImports).toContain("__elurBindSignalAttrHtml");
        expect(generated.runtimeImports).not.toContain("__elurBindSignalAttr");
    });

    it("F4: URL attrs caen al writer genérico (sanitización preservada)", () => {
        const compiled = compileTemplate(['<a href="', '"></a>'], ["signal"]);
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain('__elurBindSignalAttr(');
        expect(generated.code).not.toContain("__elurBindSignalAttrHtml");
    });

    it("F4: attrs en namespace SVG caen al writer genérico", () => {
        const compiled = compileTemplate(
            ['<svg><circle fill="', '"></circle></svg>'],
            ["signal"],
        );
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain('__elurBindSignalAttr(');
        expect(generated.code).not.toContain("__elurBindSignalAttrHtml");
    });

    it("does NOT route signal-kind event bindings through signal helpers", () => {
        // Event context keeps the arrow as handler — the plugin only lowers
        // node/attr contexts; if a "signal" kind ever reaches an event
        // binding the factory must not emit a binding helper for it.
        const compiled = compileTemplate(['<button @click="', '"></button>'], ["signal"]);
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).not.toContain("__elurBindSignalText");
        expect(generated.code).not.toContain("__elurBindSignalAttr");
    });

    it("mixes T1 signal bindings with generic ones in one template", () => {
        const compiled = compileTemplate(
            ["<tr><td>", '</td><td class="', '">x</td></tr>'],
            ["signal", "reactive"],
        );
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain("__elurBindSignalText(");
        // The reactive class binding still uses the generic attr path
        expect(generated.code).toMatch(/__elurAttr\(|__elurSetAttr\(|__elurEffect/);
        expect(generated.code).not.toContain("__elurBindSignalAttr");
    });

    it("emits __elurBindDerivedText for T2 derived node bindings (C.7)", () => {
        const compiled = compileTemplate(["<td>", "</td>"], ["derived"]);
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain("__elurBindDerivedText(");
        expect(generated.code).not.toContain("__elurNode(");
        expect(generated.runtimeImports).toContain("__elurBindDerivedText");
    });

    it("emits __elurBindDerivedAttrHtml for T2 derived attribute bindings (F4)", () => {
        const compiled = compileTemplate(['<div class="', '"></div>'], ["derived"]);
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain('__elurBindDerivedAttrHtml(');
        expect(generated.code).toContain('"class"');
        expect(generated.runtimeImports).toContain("__elurBindDerivedAttrHtml");
        expect(generated.runtimeImports).not.toContain("__elurBindDerivedAttr");
    });
});

describe("hadOpenQuote detection (partial attribute interpolation bug)", () => {
    // Bug: detectContext only checked if tagContent ended with a quote.
    // For partial interpolation like class="prefix${expr}", tagContent is
    // 'div class="prefix' — ends with 'x', not '"', but there IS an open
    // quote after '='. This produced broken HTML:
    //   <div class="prefix data-elur-a-0="class"">
    // instead of:
    //   <div data-elur-a-0="class">

    it("detects hadOpenQuote when string ends right after opening quote", () => {
        // class="${expr}" — tagContent = 'div class="'
        const { contexts } = analyzeTemplate(['<div class="', '"></div>']);
        expect(contexts[0]).toMatchObject({ type: "attr", attrName: "class", hadOpenQuote: true });
    });

    it("detects hadOpenQuote with static content between quote and interpolation", () => {
        // class="feature-card reveal${expr}" — the bug pattern
        // tagContent = 'div class="feature-card reveal'
        const { contexts } = analyzeTemplate(['<div class="feature-card reveal', '">x</div>']);
        expect(contexts[0]).toMatchObject({ type: "attr", attrName: "class", hadOpenQuote: true });
    });

    it("detects hadOpenQuote with single quotes", () => {
        const { contexts } = analyzeTemplate(["<div class='feature-card ", "'>x</div>"]);
        expect(contexts[0]).toMatchObject({ type: "attr", attrName: "class", hadOpenQuote: true });
    });

    it("does NOT set hadOpenQuote for unquoted attribute", () => {
        // class=btn-${expr} — no quote at all
        const { contexts } = analyzeTemplate(["<div class=btn-", ">x</div>"]);
        expect(contexts[0]).toMatchObject({ type: "attr", attrName: "class", hadOpenQuote: false });
    });

    it("does NOT set hadOpenQuote when quotes are already closed", () => {
        // class="static" ${expr} — the attribute is fully closed, expr is a node
        const { contexts } = analyzeTemplate(['<div class="static"> ', "</div>"]);
        expect(contexts[0]).toMatchObject({ type: "node" });
    });

    it("buildHTML produces valid output for partial with static prefix", () => {
        // The exact bug pattern: class="feature-card reveal${expr}"
        const { html } = analyzeTemplate(['<div class="feature-card reveal', '">x</div>']);
        // Should NOT contain broken HTML like:
        //   class="feature-card  data-elur-a-0="class""
        expect(html).toContain('data-elur-a-0="class"');
        expect(html).not.toContain('class=""');
        // The static prefix "feature-card reveal" should be consumed by
        // buildHTML (it becomes part of the attribute value at runtime,
        // not part of the marker HTML).
        expect(html).not.toContain('feature-card');
    });

    it("buildHTML produces valid output for two partials in same template", () => {
        // Two attributes with nested templates (the real-world pattern)
        const { html } = analyzeTemplate([
            '<div class="feature-card reveal',
            '"><div class="feature-icon',
            '">x</div></div>',
        ]);
        expect(html).toContain('data-elur-a-0="class"');
        expect(html).toContain('data-elur-a-1="class"');
        expect(html).not.toContain('class=""');
    });
});

describe("C.3 per-binding fallback", () => {
    it("ref attr degrada sólo ese binding — el template sigue especializado", () => {
        const compiled = compileTemplate(
            ['<div ref="', '" class="', '">x</div>'],
            ["generic", "signal"],
        );
        expect(compiled.specialized).toBe(true);
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).toContain("__elurGenericAttr");
        expect(generated.code).toContain('"ref"');
        // F4: el signal attr html usa el writer resuelto, no el genérico.
        expect(generated.code).toContain("__elurBindSignalAttrHtml");
        expect(generated.runtimeImports).toContain("__elurGenericAttr");
        expect(generated.runtimeImports).toContain("__elurBindSignalAttrHtml");
    });

    it("show/hide attrs rutean al genérico sin matar la especialización", () => {
        const compiled = compileTemplate(
            ['<div show="', '"><span>', '</span></div>'],
            ["reactive", "signal"],
        );
        expect(compiled.specialized).toBe(true);
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).toContain('__elurGenericAttr');
        expect(generated.code).toContain('"show"');
        // El binding de nodo T1 dentro sigue especializado.
        expect(generated.code).toContain("__elurBindSignalText");
    });

    it("eventos no delegables y capture/once/passive → listener directo", () => {
        for (const decl of ["focus", "click.capture", "click.once", "click.passive"]) {
            const compiled = compileTemplate(
                [`<button @${decl}="`, '">x</button>'],
                ["reactive"],
            );
            expect(compiled.specialized).toBe(true);
            const generated = genFactoryCode("_f", compiled);
            expect(generated.code).toContain("__elurGenericEvent");
            expect(generated.code).not.toContain("__elurDelegateEvents");
        }
    });

    it("eventos delegables sin mods conflictivos siguen delegando", () => {
        const compiled = compileTemplate(
            ['<button @click="', '">x</button>'],
            ["reactive"],
        );
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).toContain("__elur_click");
        expect(generated.code).not.toContain("__elurGenericEvent");
    });

    it("click con prevent/self (delegable) conserva la delegación", () => {
        const compiled = compileTemplate(
            ['<button @click.prevent.self="', '">x</button>'],
            ["reactive"],
        );
        expect(compiled.specialized).toBe(true);
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).toContain("__elurEvent");
        expect(generated.code).not.toContain("__elurGenericEvent");
    });

    it("C.14: multi-root emite factory de fragmento con bounds", () => {
        const multi = compileTemplate(["<div>", "</div><span>x</span>"], ["static"]);
        expect(multi.specialized).toBe(true);
        const generated = genFactoryCode("_f", multi);
        expect(generated.runtimeImports).toContain("__elurCreateFragment");
        expect(generated.code).toContain("elur-fs");
        expect(generated.code).toContain("deleteContents");
    });
});

describe("C.13 hidratación compilada", () => {
    it("emite hydrate$N posicional para templates especializados", () => {
        const compiled = compileTemplate(
            ['<tr class="', '"><td>', '</td><td><a @click="', '">x</a></td></tr>'],
            ["derived", "signal", "reactive"],
        );
        const generated = genFactoryCode("_f", compiled);
        // La función hydrate recibe (root, opts, v0…vN) y activa por posición.
        expect(generated.code).toContain("function _f$hydrate(root,opts,v0,v1,v2)");
        expect(generated.code).toContain("__elurBindDerivedAttrHtml(root,\"class\",v0");
        expect(generated.code).toContain("__elurMarkersIn(");
        expect(generated.code).toContain("__elurHydrateRange(");
        expect(generated.code).toContain("__elurNextEl(");
        expect(generated.code).toContain(".__elur_click=v2");
        // El proto recibe la hydrate fn como 5º argumento.
        expect(generated.code).toContain("__elurCreateTemplatePrototype(_f$render,");
        expect(generated.code).toContain(",_f$hydrate,_f$ssr)");
        // Imports de runtime necesarios.
        for (const imp of ["__elurNextEl", "__elurMarkersIn", "__elurHydrateRange"]) {
            expect(generated.runtimeImports).toContain(imp);
        }
    });

    it("node bindings entre hermanos usan __elurMarkers con scan acotado", () => {
        const compiled = compileTemplate(
            ["<div><b>a</b>", "<b>c</b></div>"],
            ["signal"],
        );
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).toContain("__elurMarkers(");
        expect(generated.code).toContain(".end.nextSibling");
    });

    it("attrs estáticos no emiten activación en hydrate", () => {
        const compiled = compileTemplate(
            ['<div class="', '" title="', '"><i>', '</i></div>'],
            ["static", "signal", "signal"],
        );
        const generated = genFactoryCode("_f", compiled);
        const hydrateBody = generated.code.match(/function _f\$hydrate[\s\S]*?\n\}/)![0];
        expect(hydrateBody).toContain('__elurBindSignalAttrHtml(root,"title"');
        expect(hydrateBody).not.toContain('"class"');
    });

    it("eventos no delegables van por __elurGenericEvent en hydrate", () => {
        const compiled = compileTemplate(
            ['<button @focus="', '">x</button>'],
            ["reactive"],
        );
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).toContain("__elurGenericEvent(root,\"focus\"");
    });

    it("C.14: svg emite hydrate posicional; multi-root no (bounds)", () => {
        const svg = compileTemplate(["<svg><text>", "</text></svg>"], ["reactive"]);
        expect(genFactoryCode("_f", svg).code).toContain("$hydrate");
        const multi = compileTemplate(["<div>", "</div><span>x</span>"], ["reactive"]);
        const gen = genFactoryCode("_f", multi);
        expect(gen.code).not.toContain("$hydrate");
    });
});

describe("C.9 constant folding", () => {
    it("literal en attr se hornea en optimizedHtml y no emite binding", () => {
        const compiled = compileTemplate(
            ['<div class="', '" title="', '">x</div>'],
            ["static", "signal"],
            ["active", undefined],
        );
        // class horneado; title queda para el binding runtime
        expect(compiled.optimizedHtml).toBe('<div class="active">x</div>');
        // contexts conservados para paridad SSR; bindings sin el plegado
        expect(compiled.contexts.length).toBe(2);
        expect(compiled.bindings.length).toBe(1);
        expect(compiled.bindings[0].index).toBe(1);
        expect(compiled.foldedIndices).toEqual([0]);
        const generated = genFactoryCode("_f", compiled);
        expect(generated.code).not.toContain('BindAttr(root,"class"');
    });

    it("literal en posición texto se hornea escapado", () => {
        const compiled = compileTemplate(
            ["<p>", " <b>", "</b></p>"],
            ["static", "signal"],
            ["<script>&", undefined],
        );
        expect(compiled.optimizedHtml).toContain("&lt;script&gt;&amp;");
        expect(compiled.foldedIndices).toEqual([0]);
    });

    it("no pliega directivas/url/eventos ni valores no-string", () => {
        const compiled = compileTemplate(
            ['<div ref="', '" href="', '" @click="', '">', "</div>"],
            ["static", "static", "static", "static"],
            ["x", "http://a", "f", true],
        );
        expect(compiled.foldedIndices).toBeUndefined();
        expect(compiled.optimizedHtml).not.toContain('ref="x"');
        expect(compiled.bindings.length).toBe(4);
    });

    it("no pliega texto dentro de tags estructurales", () => {
        const compiled = compileTemplate(
            ["<table><tbody>", "</tbody></table>"],
            ["static"],
            ["hola"],
        );
        expect(compiled.foldedIndices).toBeUndefined();
    });
});
