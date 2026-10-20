/**
 * The features an administrator can switch on (Settings → Features, docs/DECISIONS.md D-100). A feature is a named
 * bundle: the modules whose manifest says `feature: '<id>'`, plus the parts of the site tree it gates.
 *
 *   whenOn / whenOff  one sentence each, shown when asking: what the administrator will notice
 *   requires   features that must be on first (switching this one on pulls them in)
 *   gates      what stops being served while the feature is off — by path, because a site tree seeded years ago
 *              carries no marker, and "off" must work on it too. Nothing is ever deleted (D-100).
 *     pages        site-tree paths; `**` = any depth, `*` = within one segment
 *     components   same; a gated component renders as nothing, so a page that includes it still works
 *     contentTypes entries of these types get no public address
 */
export const featureDefinitions = [
  {
    id: 'pages',
    label: 'Content pages',
    icon: 'bi-file-earmark-text',
    description:
      'Pages your editors write with the block editor (About, Terms, Privacy), shown under Content → Content pages.',
    whenOn: 'Adds Content pages to the Content menu, and serves the pages your editors publish.',
    whenOff:
      'Hides Content pages from the Content menu, and stops serving the pages your editors wrote. They are kept. Pages built under Webmaster → Site pages are not affected.',
    requires: [],
    gates: {
      pages: ['pages/[...path].html'],
      contentTypes: ['page'],
    },
  },
  {
    id: 'blog',
    label: 'Blog',
    icon: 'bi-journal-text',
    description: 'Posts, categories and tags, with the blog pages on your site.',
    whenOn:
      'Adds the blog pages to your site, and Posts and Categories and tags to the Content menu.',
    whenOff:
      'Hides the blog pages from your site, and Posts and Categories and tags from the Content menu. Your posts are kept.',
    requires: [],
    gates: {
      pages: ['pages/blog/**', 'pages/category/**', 'pages/tag/**'],
      components: [
        'components/post.html',
        'components/post-list.html',
        'components/term-posts.html',
      ],
      contentTypes: ['post'],
    },
  },
  {
    id: 'customer-accounts',
    label: 'Customer accounts',
    icon: 'bi-person-badge',
    description:
      'Visitors register and sign in with email or mobile, password and OTP. Suspicious accounts are locked until you review them.',
    whenOn: 'Visitors can register and sign in, and you review locked accounts in the admin.',
    whenOff: 'Visitors can no longer register or sign in. Existing accounts are kept.',
    requires: [],
    gates: {},
  },
  {
    id: 'ecommerce',
    label: 'eCommerce',
    icon: 'bi-bag',
    description:
      'Product catalog, downloads, quotes, cart, checkout, orders, invoices, shipping and returns.',
    whenOn:
      'Adds the product catalog and ordering to your site, and an eCatalog group to the admin menu.',
    whenOff:
      'Hides the shop from your site and the eCatalog group from the admin menu. Products and orders are kept.',
    requires: ['customer-accounts'],
    gates: {},
  },
  {
    id: 'payment-gateways',
    label: 'Payment gateways',
    icon: 'bi-credit-card',
    description: 'Take payments through Stripe, Razorpay or PayU, or cash on delivery.',
    whenOn: 'Customers can pay at checkout with the gateways you set up.',
    whenOff: 'Checkout stops taking payments. Gateway settings are kept.',
    requires: ['ecommerce'],
    gates: {},
  },
  {
    id: 'support',
    label: 'Support tickets',
    icon: 'bi-life-preserver',
    description:
      'A Contact Us form that raises tickets, and a simple desk for staff to answer them.',
    whenOn: 'Adds a Contact Us form to your site and a tickets desk to the admin.',
    whenOff: 'Hides the Contact Us form and the tickets desk. Existing tickets are kept.',
    requires: [],
    gates: {},
  },
];
