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
        expect(html).toBe("<div><!--nix-0--></div>");
    });

    it("builds HTML with attribute markers", () => {
        const { html } = analyzeTemplate(['<div class="', '"></div>']);
        // buildHTML cuts `class="` from the string, leaving `<div ` then adds ` data-nix-a-0="class"`
        expect(html).toBe('<div  data-nix-a-0="class"></div>');
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
        const nodes = parseHTML("<!--nix-0-->");
        expect(nodes).toHaveLength(1);
        expect(nodes[0].type).toBe("comment");
        expect(nodes[0].text).toBe("nix-0");
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
        const html = "<div><!--nix-0--></div>";
        const parsed = parseHTML(html);
        const contexts = [{ type: "node" as const }];
        const { pathMap, accessPaths } = walkTemplate(parsed, contexts);
        expect(pathMap[0]).toEqual({ nodeIndex: 2, name: null });
        expect(accessPaths[0]).toEqual([0, 0]);
    });

    it("builds pathMap for attribute binding", () => {
        const html = '<div data-nix-a-0="class"></div>';
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
        expect(compiled.htmlWithoutMarkers).toBe("<div><!--nix-0--></div>");
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
        // Both class and id are bindings, so both data-nix-a-* are removed (with leading whitespace)
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
        expect(compiled.optimizedHtml).not.toContain("nix-");
        expect(compiled.bindings[1]).toMatchObject({ target: "parent", path: [0, 0] });
    });

    it("generates an imperative renderer with positional values", () => {
        const compiled = compileTemplate(
            ["<tr><td>", "</td><td class=", "></td></tr>"],
            ["generic", "reactive"],
        );
        const generated = genFactoryCode("_factory", compiled);

        expect(generated.code).toContain("function _factory(v0,v1)");
        expect(generated.code).toContain(".firstChild.nextSibling");
        expect(generated.code).toContain("__nixNode");
        expect(generated.code).toContain("__nixAttr");
        expect(generated.code).not.toContain("_activateBindingsWithNodes");
        expect(generated.runtimeImports).toContain("__nixCreateTemplate");
    });

    it("falls back for namespace-sensitive templates", () => {
        const compiled = compileTemplate(["<svg><text>", "</text></svg>"], ["reactive"]);
        const generated = genFactoryCode("_factory", compiled);
        expect(compiled.specialized).toBe(false);
        expect(generated.runtimeImports).toEqual(["__nixCompiledTemplate"]);
    });
});

describe("hadOpenQuote detection (partial attribute interpolation bug)", () => {
    // Bug: detectContext only checked if tagContent ended with a quote.
    // For partial interpolation like class="prefix${expr}", tagContent is
    // 'div class="prefix' — ends with 'x', not '"', but there IS an open
    // quote after '='. This produced broken HTML:
    //   <div class="prefix data-nix-a-0="class"">
    // instead of:
    //   <div data-nix-a-0="class">

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
        //   class="feature-card  data-nix-a-0="class""
        expect(html).toContain('data-nix-a-0="class"');
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
        expect(html).toContain('data-nix-a-0="class"');
        expect(html).toContain('data-nix-a-1="class"');
        expect(html).not.toContain('class=""');
    });
});
