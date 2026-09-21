/**
 * Phase 2 — role presets for teams that write content. Fresh installs get Editor and Author from the setup step like every
 * other default role; this adds them to installs that already have roles, and only when no role by that name exists (data only, expand-only).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  if (!(await knex('roles').first())) return; // fresh database: setup creates the default roles
  const now = Date.now();
  const presets = [
    {
      name: 'Editor',
      description: 'Writes, publishes and organises content, media, menus and redirects.',
      permissions: [
        'admin.access',
        'content.*',
        'media.read',
        'media.upload',
        'media.delete',
        'menus.manage',
        'redirects.manage',
        'themes.read',
        'site.messages',
      ],
    },
    {
      name: 'Author',
      description: 'Writes pages and posts as drafts for an editor to publish, and uploads images.',
      permissions: [
        'admin.access',
        'content.page.read',
        'content.page.write',
        'content.post.read',
        'content.post.write',
        'media.read',
        'media.upload',
      ],
    },
  ];
  for (const p of presets)
    if (!(await knex('roles').where({ name: p.name }).first()))
      await knex('roles').insert({
        name: p.name,
        description: p.description,
        permissions: JSON.stringify(p.permissions),
        is_system: false,
        created_at: now,
        updated_at: now,
      });
}

export async function down() {
  // Roles may have been assigned to people; removing them is a decision for an administrator, not a rollback.
}
