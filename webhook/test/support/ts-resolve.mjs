import { registerHooks } from 'node:module';

// The sources import each other as "./x.js", the form TypeScript expects
// for NodeNext modules. The tests run the .ts sources directly, so resolve
// such an import to the .ts file next to it. Import this module first,
// then load sources with a dynamic import() so the hook is in place when
// they resolve. A source imported with a query string, to load a second
// copy under other settings, resolves the same way.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relativeJs = specifier.startsWith('.') && specifier.endsWith('.js');
      const parentIsTs = context.parentURL !== undefined && new URL(context.parentURL).pathname.endsWith('.ts');
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && relativeJs && parentIsTs) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
