import { registerHooks } from 'node:module';

// The sources import each other as "./x.js", the form TypeScript expects
// for NodeNext modules. The tests run the .ts sources directly, so resolve
// such an import to the .ts file next to it. Import this module first,
// then load sources with a dynamic import() so the hook is in place when
// they resolve.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relativeJs = specifier.startsWith('.') && specifier.endsWith('.js');
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && relativeJs && context.parentURL?.endsWith('.ts')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
