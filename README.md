# @deijose/nix-js-compiler

Build-time compiler for [Nix.js](https://github.com/DeijoseDevelop/nix-js) `html\`\`` templates.

## What it does

- Parses `html\`\`` tagged template literals at build time
- Analyzes binding contexts (nodes, attributes, events)
- Generates direct DOM manipulation code (firstChild/nextSibling navigation)
- Eliminates runtime TreeWalker, detectContext, and buildHTML overhead
- Produces specialized factories that clone templates and set up bindings directly
- Falls back to generic compiled templates when specialization is unsafe

## Performance

Benchmarked against the [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) methodology (5 runs, 15 iterations each):

- **create 1k**: -24.7% vs runtime-only
- **replace 1k**: -26.8%
- **update 10th**: -39.4%
- **clear 1k**: -44.0%
- **create 10k**: -25.1%

Nix.js + compiler matches or beats Solid on 6 of 9 CPU benchmarks, with lower memory and faster startup.

## Usage

This compiler is used internally by [`@deijose/vite-plugin-nix-js`](https://github.com/DeijoseDevelop/vite-plugin-nix-js). You don't typically use it directly.

```ts
import { compileTemplate, genFactoryCode } from "@deijose/nix-js-compiler";

const compiled = compileTemplate(strings, expressionKinds);
const factory = genFactoryCode("_nixFactory$1", compiled);
// factory.code → generated JS string
// factory.runtimeImports → runtime helpers needed
```

## License

MIT
