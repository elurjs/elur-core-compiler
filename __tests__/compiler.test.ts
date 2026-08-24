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
