import { Hash } from 'liquidjs';

/**
 * The three tags the site tree adds to the sandbox. They talk to the per-request `_cms` state that the page renderer puts in
 * the globals (see sitepages.js); a template without it (the save-time syntax check) simply does nothing.
 *
 *   {% cms_api "id" %}   written by the platform at the top of a component that declares `api` endpoints: runs them and sets `api`
 *   {% seo title: t, description: d, image: i, type: "article", noindex: true, ... %}   what this page says about itself
 *   {% not_found %}      makes the whole page a 404
 *   {% redirect to: "/x", status: 301 %}   sends the visitor elsewhere (a page's own address that should live somewhere else)
 */
export function registerSiteTags(engine) {
  engine.registerTag('cms_api', {
    parse(token) {
      this.id = token.args.trim().replace(/^["']|["']$/g, '');
    },
    *render(ctx) {
      const cms = ctx.getSync(['_cms']);
      if (!cms) return;
      // The component's own arguments (slug, per_page…) and the page's globals (params, query) are both visible to the address.
      const vars = ctx.getAll();
      const out = {};
      for (const decl of cms.declared(this.id)) {
        const url = yield this.liquid.parseAndRender(decl.url, vars);
        out[decl.name] = yield cms.load(decl, String(url));
      }
      ctx.bottom().api = out;
    },
  });

  engine.registerTag('seo', {
    parse(token) {
      this.hash = new Hash(token.args);
    },
    *render(ctx) {
      const cms = ctx.getSync(['_cms']);
      const values = yield this.hash.render(ctx);
      if (cms) cms.setSeo(values);
    },
  });

  engine.registerTag('redirect', {
    parse(token) {
      this.hash = new Hash(token.args);
    },
    *render(ctx) {
      const cms = ctx.getSync(['_cms']);
      const values = yield this.hash.render(ctx);
      if (cms) cms.redirect(values.to, values.status);
    },
  });

  engine.registerTag('not_found', {
    parse() {},
    render(ctx) {
      const cms = ctx.getSync(['_cms']);
      if (cms) cms.markNotFound();
    },
  });
}
