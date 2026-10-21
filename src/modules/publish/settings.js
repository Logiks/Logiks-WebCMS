/** Settings → Publish (docs/DECISIONS.md D-117). The remote, branch and token are shared with the change history, under Settings → Assistant. */
export function definePublishSettings(registry) {
  registry.define('publish', {
    title: 'Publish & Git',
    description:
      'Automatic commits and the version stamp used to refresh caches. The remote repository, branch and token are under Assistant.',
    order: 35,
    fields: {
      auto_commit: {
        type: 'boolean',
        label: 'Commit automatically',
        default: true,
        help: 'Every so often the site is committed if anything changed since the last commit, including edits made by hand. Turn off to commit only when you choose to.',
      },
      auto_commit_minutes: {
        type: 'number',
        label: 'Commit every (minutes)',
        default: 30,
        min: 5,
        max: 1440,
      },
      auto_push: {
        type: 'boolean',
        label: 'Push after an automatic commit',
        default: false,
        help: 'Sends the new commit to the remote repository too. Needs a remote under Settings → Assistant.',
      },
      version: { type: 'number', label: 'Cache version', default: 1, hidden: true },
    },
  });
}
